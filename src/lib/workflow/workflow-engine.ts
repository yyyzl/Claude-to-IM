/**
 * Workflow Engine -- Core orchestrator for the dual-model collaboration workflow.
 *
 * Manages the lifecycle of workflows through a 5-step round loop:
 *   `codex_review` -> `issue_matching` -> `pre_termination` -> `claude_decision` -> `post_decision`
 *
 * Supports multiple workflow types via {@link WorkflowProfile}:
 * - **spec-review**: Codex reviews spec/plan, Claude decides + patches documents
 * - **code-review**: Codex blind-reviews code diff, Claude arbitrates findings (review-only)
 *
 * Key design decisions:
 * - **Crash-safe resume**: each step persists its output before advancing; the meta
 *   checkpoint is written LAST so a crash always replays at most one step.
 * - **Write ordering**: raw output -> ledger -> spec/plan -> checkpoint event -> meta.
 * - **Event-driven**: all transitions emit typed events, persisted to an append-only
 *   ndjson log for observability and replay.
 * - **Abort support**: external callers can pause a running workflow via `pause()`,
 *   which triggers an AbortController that propagates to model invocations.
 * - **Profile-driven**: step behavior is parameterized via WorkflowProfile.behavior
 *   flags, eliminating hardcoded workflow-type checks.
 *
 * @module workflow/workflow-engine
 */

import { WorkflowStore } from './workflow-store.js';
import { PackBuilder } from './pack-builder.js';
import { PromptAssembler } from './prompt-assembler.js';
import { ModelInvoker } from './model-invoker.js';
import { TerminationJudge } from './termination-judge.js';
import { JsonParser } from './json-parser.js';
import { IssueMatcher } from './issue-matcher.js';
import { PatchApplier } from './patch-applier.js';
import { DecisionValidator } from './decision-validator.js';
import { ReportGenerator } from './report-generator.js';
import {
  TimeoutError,
  AbortError,
  ModelInvocationError,
  DEFAULT_CONFIG,
  SPEC_REVIEW_PROFILE,
  type WorkflowMeta,
  type WorkflowConfig,
  type WorkflowProfile,
  type WorkflowEvent,
  type WorkflowEventType,
  type WorkflowStep,
  type ContextFile,
  type IssueLedger,
  type CodexReviewOutput,
  type ClaudeDecisionOutput,
  type TerminationResult,
  type TerminationReason,
  type ProcessFindingsResult,
  type Decision,
  type DecisionAction,
  type ChangedFile,
  type CodeFinding,
} from './types.js';

// ── Decision validation constants ────────────────────────────────

/** Set of valid decision actions for quick lookup during filtering. */
const VALID_ACTIONS_SET = new Set<DecisionAction>(['accept', 'reject', 'defer', 'accept_and_resolve']);

// ── Run ID generation ────────────────────────────────────────────

/**
 * Generate a unique run ID: ISO date prefix + random hex suffix.
 * Format: `YYYYMMDD-xxxxxx` (e.g. `20260320-a3f1b2`).
 */
function generateRunId(): string {
  const now = new Date();
  const datePrefix =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  const randomSuffix = Math.random().toString(16).slice(2, 8);
  return `${datePrefix}-${randomSuffix}`;
}

// ── WorkflowEngine ──────────────────────────────────────────────

export class WorkflowEngine {
  private abortController: AbortController | null = null;
  private listeners: Map<WorkflowEventType, Array<(e: WorkflowEvent) => void>> = new Map();

  constructor(
    private readonly store: WorkflowStore,
    private readonly packBuilder: PackBuilder,
    private readonly promptAssembler: PromptAssembler,
    private readonly modelInvoker: ModelInvoker,
    private readonly terminationJudge: TerminationJudge,
    private readonly jsonParser: JsonParser,
    private readonly issueMatcher: IssueMatcher,
    private readonly patchApplier: PatchApplier,
    private readonly decisionValidator: DecisionValidator,
  ) {}

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Start a new workflow.
   *
   * Creates all initial artifacts (meta, spec, plan, ledger), emits the
   * `workflow_started` event, and enters the main round loop.
   *
   * The workflow type is determined by the `profile` parameter. If omitted,
   * defaults to {@link SPEC_REVIEW_PROFILE} for backward compatibility.
   *
   * @param params.spec - The spec document to review.
   * @param params.plan - The plan document to review.
   * @param params.config - Optional partial config overrides.
   * @param params.contextFiles - Optional additional context files.
   *   **Deprecated**: prefer `config.context_files` instead. If both are
   *   provided, they are merged (contextFiles first, then config.context_files).
   *   This ensures consistency with resume(), which only reads from
   *   `meta.config.context_files`.
   * @param params.profile - Workflow profile (defaults to SPEC_REVIEW_PROFILE).
   * @returns The generated `run_id`.
   */
  async start(params: {
    spec: string;
    plan: string;
    config?: Partial<WorkflowConfig>;
    contextFiles?: ContextFile[];
    profile?: WorkflowProfile;
    /** Pre-built review snapshot for code-review workflows (persisted before runLoop). */
    snapshot?: import('./types.js').ReviewSnapshot;
  }): Promise<string> {
    const profile = params.profile ?? SPEC_REVIEW_PROFILE;
    const runId = generateRunId();

    // Merge context files from both sources into config.context_files
    // so that resume() will have the same set available (ISS-025).
    const mergedContextFiles = [
      ...(params.contextFiles ?? []),
      ...(params.config?.context_files ?? []),
    ];

    // Merge config: defaults <- profile overrides <- user overrides <- unified context_files
    const config: WorkflowConfig = {
      ...DEFAULT_CONFIG,
      ...profile.configOverrides,
      ...params.config,
      context_files: mergedContextFiles,
    };

    // Create initial meta
    const now = new Date().toISOString();
    const meta: WorkflowMeta = {
      run_id: runId,
      workflow_type: profile.type,
      status: 'running',
      current_round: 1,
      current_step: 'codex_review',
      created_at: now,
      updated_at: now,
      config,
      last_completed: null,
      termination_state: { consecutive_parse_failures: 0, zero_progress_rounds: 0 },
    };

    // Persist initial state (order: meta -> spec -> plan -> ledger -> snapshot)
    await this.store.createRun(meta);
    await this.store.saveSpec(runId, params.spec, 1);
    await this.store.savePlan(runId, params.plan, 1);
    await this.store.saveLedger(runId, { run_id: runId, issues: [] });
    if (params.snapshot) {
      await this.store.saveSnapshot(runId, params.snapshot);
    }

    // Emit workflow_started event
    await this.emit(runId, 1, 'workflow_started', {
      workflow_type: profile.type,
    });

    // Initialize abort controller and enter the main loop
    this.abortController = new AbortController();
    await this.runLoop(runId, meta, profile);

    return runId;
  }

  /**
   * Resume a paused, failed, or human_review workflow from its last checkpoint.
   *
   * Reads the persisted meta to determine the current round and step,
   * recomputes transient state (e.g. `previousRoundHadNewHighCritical`)
   * from the event log and ledger, then re-enters the main loop.
   *
   * The workflow profile is resolved from `meta.workflow_type`. If an explicit
   * profile is provided, it takes precedence (useful for testing or migration).
   *
   * @param runId - The workflow run to resume.
   * @param profile - Optional explicit profile override.
   * @throws If the run does not exist or is not in a resumable state.
   */
  async resume(runId: string, profile?: WorkflowProfile): Promise<void> {
    const meta = await this.store.getMeta(runId);
    if (!meta) {
      throw new Error(`[WorkflowEngine] Run not found: ${runId}`);
    }

    const resumableStatuses = new Set(['paused', 'failed', 'human_review']);
    if (!resumableStatuses.has(meta.status)) {
      throw new Error(
        `[WorkflowEngine] Cannot resume run ${runId} in status '${meta.status}'. ` +
        `Expected one of: ${[...resumableStatuses].join(', ')}`,
      );
    }

    // Resolve profile: explicit > lookup by workflow_type > default
    const resolvedProfile = profile ?? resolveProfileFromType(meta.workflow_type);

    // Transition to running
    meta.status = 'running';
    await this.store.updateMeta(runId, { status: 'running' });

    // Emit workflow_resumed event
    await this.emit(runId, meta.current_round, 'workflow_resumed', {
      resumed_from_step: meta.current_step,
      resumed_from_round: meta.current_round,
    });

    // Initialize abort controller and enter the main loop
    this.abortController = new AbortController();
    await this.runLoop(runId, meta, resolvedProfile);
  }

  /**
   * Gracefully pause a running workflow.
   *
   * Triggers the AbortController, which causes any in-flight model call
   * to throw an `AbortError`. The running step's catch handler will
   * save a checkpoint and exit cleanly, after which this method updates
   * meta to `paused`.
   *
   * @param runId - The workflow run to pause.
   */
  async pause(runId: string): Promise<void> {
    // Signal the abort controller -- this will cause the model invoker
    // to throw AbortError, which is caught in the runLoop and triggers
    // a checkpoint save before exiting.
    if (this.abortController) {
      this.abortController.abort();
    }

    // Update meta to paused status. The checkpoint has already been
    // saved by the runLoop's AbortError handler by the time we get here,
    // or will be saved shortly. We update meta as a safety net.
    await this.store.updateMeta(runId, { status: 'paused' });
  }

  /**
   * Register an event callback for a specific event type.
   *
   * Callbacks are invoked synchronously in registration order when the
   * corresponding event is emitted. They receive the full persisted
   * {@link WorkflowEvent} object.
   *
   * @param event - The event type to listen for.
   * @param cb - Callback function invoked with the event.
   */
  on(event: WorkflowEventType, cb: (e: WorkflowEvent) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(cb);
    this.listeners.set(event, existing);
  }

  // ── Private: Main Round Loop ────────────────────────────────────

  /**
   * The main round loop implementing the 5-step state machine.
   *
   * Each round executes steps A through D in sequence:
   *   A. codex_review    -- invoke Codex to review the spec/plan
   *   B1. issue_matching  -- match findings against the issue ledger
   *   B2. pre_termination -- check if we should stop before Claude decides
   *   C. claude_decision  -- invoke Claude to make decisions on issues
   *   D. post_decision    -- check termination and advance to the next round
   *
   * Step behavior is parameterized by the workflow profile:
   * - `profile.behavior.applyPatches` controls PatchApplier execution in Step C
   * - `profile.behavior.trackResolvesIssues` controls resolves_issues processing
   * - `profile.behavior.acceptedIsTerminal` is forwarded to TerminationJudge
   *
   * The loop supports resume by checking `meta.current_step` and skipping
   * already-completed steps. Transient variables (codexOutput, matchResult)
   * are reloaded from the store when resuming mid-round.
   *
   * @param runId - The workflow run identifier.
   * @param meta - The current workflow metadata (mutated during execution).
   * @param profile - Workflow profile controlling step behavior.
   */
  private async runLoop(runId: string, meta: WorkflowMeta, profile: WorkflowProfile): Promise<void> {
    const config = meta.config;

    // Compute initial previousRoundHadNewHighCritical for resume support.
    // For round 1, assume true (so the "no new high/critical for 2 rounds"
    // rule cannot trigger prematurely). For resume, compute from the ledger.
    let previousRoundHadNewHighCritical = await this.computePreviousRoundHadNewHighCritical(
      runId, meta.current_round,
    );

    let round = meta.current_round;

    // P2-1/P2-2: Track consecutive Claude failures to enable short-circuit and degradation.
    // When Claude fails N consecutive rounds with the same deterministic error, skip
    // Claude in subsequent rounds (Codex-only degradation mode).
    let claudeConsecutiveFailures = 0;
    const CLAUDE_FAILURE_THRESHOLD = 2; // Skip Claude after 2 consecutive failures

    while (round <= config.max_rounds) {
      // Emit round_started (only when starting the first step of the round)
      if (meta.current_step === 'codex_review') {
        await this.emit(runId, round, 'round_started', { round });
      }

      // Determine the starting step (for resume support)
      let step: WorkflowStep = meta.current_step;

      // Transient variables that must be available across steps.
      // These are reloaded from the store when resuming mid-round.
      let codexOutput: CodexReviewOutput | null = null;
      let matchResult: ProcessFindingsResult | null = null;
      let ledger: IssueLedger = { run_id: runId, issues: [] };

      // ════════════════════════════════════════════════════════════
      // Step A: codex_review
      // ════════════════════════════════════════════════════════════
      if (step === 'codex_review') {
        // Check if we already have a saved codex output (resume case)
        let codexRaw = await this.store.loadRoundArtifact(runId, round, 'codex-review.md');

        if (!codexRaw) {
          await this.emit(runId, round, 'codex_review_started', { round });

          // Build the review pack and render the prompt.
          // Route by profile type: spec-review uses spec/plan, code-review uses diff/snapshot.
          let prompt: string;
          if (profile.type === 'code-review') {
            const snapshot = await this.store.loadSnapshot(runId);
            const { changedFiles, diff } = await this.loadCodeReviewContext(runId, snapshot);
            const pack = await this.packBuilder.buildCodeReviewPack(
              runId, round, config, snapshot!, changedFiles, diff,
            );
            await this.store.saveRoundArtifact(
              runId, round, 'pack.json', JSON.stringify(pack, null, 2),
            );
            prompt = await this.promptAssembler.renderCodeReviewPrompt(pack);
          } else {
            const pack = await this.packBuilder.buildSpecReviewPack(runId, round, config);
            await this.store.saveRoundArtifact(
              runId, round, 'pack.json', JSON.stringify(pack, null, 2),
            );
            prompt = await this.promptAssembler.renderSpecReviewPrompt(pack);
          }

          try {
            codexRaw = await this.modelInvoker.invokeCodex(prompt, {
              timeoutMs: config.codex_timeout_ms,
              maxRetries: config.codex_max_retries,
              signal: this.abortController?.signal,
              backend: config.codex_backend,
            });
          } catch (err: unknown) {
            if (err instanceof AbortError) {
              console.warn(
                `[WorkflowEngine] Codex review aborted (run=${runId}, round=${round}). Saving checkpoint.`,
              );
              await this.saveCheckpoint(runId, round, 'codex_review');
              return; // Exit loop -- workflow has been paused
            }
            // Non-retryable API/config error — terminate immediately with clear message
            if (err instanceof ModelInvocationError) {
              console.error(
                `[WorkflowEngine] Codex review API ERROR (run=${runId}, round=${round}, ` +
                `status=${err.statusCode ?? 'n/a'}): ${err.message}`,
              );
              await this.terminateWorkflowWithError(runId, round, err);
              return;
            }
            if (err instanceof TimeoutError) {
              console.error(
                `[WorkflowEngine] Codex review TIMEOUT (run=${runId}, round=${round}, ` +
                `retries=${err.retriesExhausted}). Skipping to next round.`,
              );
              await this.emit(runId, round, 'codex_review_timeout', {
                round,
                retries_exhausted: err.retriesExhausted,
                message: err.message,
              });

              // TIMEOUT GUARD: skip to next round
              round++;
              if (round > config.max_rounds) {
                console.error(
                  `[WorkflowEngine] Max rounds (${config.max_rounds}) reached after Codex timeout. Terminating workflow.`,
                );
                await this.terminateWorkflow(runId, round - 1, 'max_rounds_reached');
                return;
              }
              // Timeout round: DO NOT modify previousRoundHadNewHighCritical
              // Skipped rounds should not affect the "2 consecutive no-high" termination logic
              step = 'codex_review';
              meta.current_round = round;
              meta.current_step = 'codex_review';
              await this.store.updateMeta(runId, {
                current_round: round,
                current_step: 'codex_review',
              });
              continue;
            }
            // Unexpected error -- mark workflow as failed
            const errMsg = err instanceof Error ? err.message : String(err);
            const errStack = err instanceof Error ? err.stack : undefined;
            console.error(
              `[WorkflowEngine] Codex review UNEXPECTED ERROR (run=${runId}, round=${round}): ${errMsg}` +
              `${errStack ? `\n${errStack}` : ''}`,
            );
            await this.terminateWorkflowWithError(runId, round, err);
            return;
          }

          // Persist raw output FIRST (crash-safe ordering)
          await this.store.saveRoundArtifact(runId, round, 'codex-review.md', codexRaw);
        }

        // Parse the Codex output
        codexOutput = this.jsonParser.parse<CodexReviewOutput>(codexRaw);
        if (!codexOutput) {
          await this.emit(runId, round, 'codex_parse_error', {
            round,
            raw: codexRaw.substring(0, 500),
          });
          // Create a fallback empty output so subsequent steps can proceed
          codexOutput = {
            findings: [],
            overall_assessment: 'major_issues',
            summary: 'Failed to parse Codex output (conservative fallback — not LGTM)',
          };
        }

        await this.emit(runId, round, 'codex_review_completed', {
          round,
          findings_count: codexOutput.findings.length,
          overall_assessment: codexOutput.overall_assessment,
        });

        // Advance to next step
        step = 'issue_matching';
        meta.current_step = 'issue_matching';
        await this.store.updateMeta(runId, { current_step: 'issue_matching' });
      }

      // ════════════════════════════════════════════════════════════
      // Step B1: issue_matching
      // ════════════════════════════════════════════════════════════
      if (step === 'issue_matching') {
        // Reload codex output if we are resuming into this step
        if (!codexOutput) {
          codexOutput = await this.reloadCodexOutput(runId, round);
        }

        // Load the current ledger
        ledger = (await this.store.loadLedger(runId)) ?? { run_id: runId, issues: [] };

        // Process findings: match against existing issues, create new ones
        matchResult = this.issueMatcher.processFindings(
          codexOutput.findings ?? [],
          ledger,
          round,
        );

        // Emit events for newly created issues
        for (const newIssue of matchResult.newIssues) {
          await this.emit(runId, round, 'issue_created', {
            issue_id: newIssue.id,
            severity: newIssue.severity,
            description: newIssue.description,
          });
        }

        // Persist ledger (crash-safe ordering: ledger before meta)
        await this.store.saveLedger(runId, ledger);

        await this.emit(runId, round, 'issue_matching_completed', {
          round,
          new_issues: matchResult.newTotalCount,
          new_high_critical: matchResult.newHighCriticalCount,
        });

        // Advance to next step
        step = 'pre_termination';
        meta.current_step = 'pre_termination';
        await this.store.updateMeta(runId, { current_step: 'pre_termination' });
      }

      // ════════════════════════════════════════════════════════════
      // Step B2: pre_termination
      // ════════════════════════════════════════════════════════════
      if (step === 'pre_termination') {
        // Reload transient state if resuming into this step
        if (!codexOutput) {
          codexOutput = await this.reloadCodexOutput(runId, round);
        }
        if (!matchResult) {
          // Re-run issue matching to get matchResult (idempotent by design)
          ledger = (await this.store.loadLedger(runId)) ?? { run_id: runId, issues: [] };
          matchResult = this.issueMatcher.processFindings(
            codexOutput.findings ?? [],
            ledger,
            round,
          );
          // Ledger mutations from processFindings are idempotent -- save again
          await this.store.saveLedger(runId, ledger);
        } else {
          // Ensure ledger is up-to-date
          ledger = (await this.store.loadLedger(runId)) ?? { run_id: runId, issues: [] };
        }

        const termResult = this.terminationJudge.judge({
          round,
          config,
          ledger,
          latestOutput: codexOutput,
          previousRoundHadNewHighCritical,
          isSkippedRound: false,
          isPreTermination: true,
          acceptedIsTerminal: profile.behavior.acceptedIsTerminal,
        });

        if (termResult) {
          if (termResult.action === 'terminate') {
            await this.terminateWorkflow(runId, round, termResult.reason);
            return;
          }
          if (termResult.action === 'pause_for_human') {
            await this.pauseForHuman(runId, round, termResult);
            return;
          }
        }

        // No termination -- continue to Claude decision
        step = 'claude_decision';
        meta.current_step = 'claude_decision';
        await this.store.updateMeta(runId, { current_step: 'claude_decision' });
      }

      // ════════════════════════════════════════════════════════════
      // Step C: claude_decision
      // ════════════════════════════════════════════════════════════
      if (step === 'claude_decision') {
        // P2-1/P2-2: If Claude has failed consecutively, skip Claude decision step
        // entirely (Codex-only degradation). Codex findings become the final output.
        if (claudeConsecutiveFailures >= CLAUDE_FAILURE_THRESHOLD) {
          console.warn(
            `[WorkflowEngine] Claude skipped (run=${runId}, round=${round}) — ` +
            `${claudeConsecutiveFailures} consecutive failures. Running in Codex-only mode.`,
          );
          await this.emit(runId, round, 'claude_decision_skipped', {
            round,
            skipped: true,
            reason: `Claude skipped after ${claudeConsecutiveFailures} consecutive failures (Codex-only degradation)`,
          });

          // Skip to post_decision — do NOT call saveCheckpoint() here,
          // as that sets status='paused' which is incorrect for degradation.
          step = 'post_decision';
          // Fall through to post_decision below
        }
      }

      if (step === 'claude_decision') {
        // Reload transient state if resuming into this step
        if (!codexOutput) {
          codexOutput = await this.reloadCodexOutput(runId, round);
        }
        if (!matchResult) {
          ledger = (await this.store.loadLedger(runId)) ?? { run_id: runId, issues: [] };
          matchResult = this.issueMatcher.processFindings(
            codexOutput.findings ?? [],
            ledger,
            round,
          );
          await this.store.saveLedger(runId, ledger);
        } else {
          ledger = (await this.store.loadLedger(runId)) ?? { run_id: runId, issues: [] };
        }

        let claudeRaw = await this.store.loadRoundArtifact(runId, round, 'claude-raw.md');

        if (!claudeRaw) {
          await this.emit(runId, round, 'claude_decision_started', { round });

          // Build Claude decision input from matched issues.
          // Route by profile type: code-review uses fresh context (no previousDecisions).
          let claudePrompt: { user: string; system: string };
          if (profile.type === 'code-review') {
            const snapshot = await this.store.loadSnapshot(runId);
            const { changedFiles, diff } = await this.loadCodeReviewContext(runId, snapshot);
            const crInput = await this.packBuilder.buildClaudeCodeReviewInput(
              runId, round,
              matchResult.matchedIssues as Array<{ issueId: string; finding: CodeFinding; isNew: boolean }>,
              changedFiles, diff,
            );
            claudePrompt = await this.promptAssembler.renderClaudeCodeReviewPrompt(crInput);
          } else {
            const input = await this.packBuilder.buildClaudeDecisionInput(
              runId, round, matchResult.matchedIssues,
            );
            claudePrompt = await this.promptAssembler.renderClaudeDecisionPrompt(input);
          }
          await this.store.saveRoundArtifact(runId, round, 'claude-input.md', claudePrompt.user);

          try {
            claudeRaw = await this.modelInvoker.invokeClaude(claudePrompt.user, {
              timeoutMs: config.claude_timeout_ms,
              maxRetries: config.claude_max_retries,
              signal: this.abortController?.signal,
              systemPrompt: claudePrompt.system,
              model: config.claude_model,
              maxOutputTokens: config.claude_max_output_tokens,
            });
          } catch (err: unknown) {
            if (err instanceof AbortError) {
              console.warn(
                `[WorkflowEngine] Claude decision aborted (run=${runId}, round=${round}). Saving checkpoint.`,
              );
              await this.saveCheckpoint(runId, round, 'claude_decision');
              return; // Exit loop -- workflow has been paused
            }
            // Non-retryable API/config error — P2-1: increment failure counter
            // and skip to next round instead of terminating immediately.
            // Subsequent rounds will enter Codex-only mode if threshold is reached.
            if (err instanceof ModelInvocationError) {
              claudeConsecutiveFailures++;
              console.error(
                `[WorkflowEngine] Claude decision API ERROR (run=${runId}, round=${round}, ` +
                `status=${err.statusCode ?? 'n/a'}): ${err.message}` +
                ` [consecutive failures: ${claudeConsecutiveFailures}]`,
              );
              await this.emit(runId, round, 'claude_decision_skipped', {
                round,
                error_type: 'model_invocation_error',
                message: err.message,
                consecutive_failures: claudeConsecutiveFailures,
              });

              // Skip Claude decision, advance to next round
              round++;
              if (round > config.max_rounds) {
                await this.terminateWorkflow(runId, round - 1, 'max_rounds_reached');
                return;
              }
              step = 'codex_review';
              meta.current_round = round;
              meta.current_step = 'codex_review';
              await this.store.updateMeta(runId, {
                current_round: round,
                current_step: 'codex_review',
              });
              continue;
            }
            if (err instanceof TimeoutError) {
              claudeConsecutiveFailures++;
              console.error(
                `[WorkflowEngine] Claude decision TIMEOUT (run=${runId}, round=${round}, ` +
                `retries=${err.retriesExhausted}). Skipping to next round.` +
                ` [consecutive failures: ${claudeConsecutiveFailures}]`,
              );
              await this.emit(runId, round, 'claude_decision_timeout', {
                round,
                retries_exhausted: err.retriesExhausted,
                message: err.message,
                consecutive_failures: claudeConsecutiveFailures,
              });

              // TIMEOUT GUARD: skip Claude decision, advance to next round
              round++;
              if (round > config.max_rounds) {
                console.error(
                  `[WorkflowEngine] Max rounds (${config.max_rounds}) reached after Claude timeout. Terminating workflow.`,
                );
                await this.terminateWorkflow(runId, round - 1, 'max_rounds_reached');
                return;
              }
              // Timeout round: DO NOT modify previousRoundHadNewHighCritical
              // Skipped rounds should not affect the "2 consecutive no-high" termination logic
              step = 'codex_review';
              meta.current_round = round;
              meta.current_step = 'codex_review';
              await this.store.updateMeta(runId, {
                current_round: round,
                current_step: 'codex_review',
              });
              continue;
            }
            // Unexpected error
            const errMsg = err instanceof Error ? err.message : String(err);
            const errStack = err instanceof Error ? err.stack : undefined;
            console.error(
              `[WorkflowEngine] Claude decision UNEXPECTED ERROR (run=${runId}, round=${round}): ${errMsg}` +
              `${errStack ? `\n${errStack}` : ''}`,
            );
            await this.terminateWorkflowWithError(runId, round, err);
            return;
          }

          // Claude succeeded — reset consecutive failure counter
          claudeConsecutiveFailures = 0;

          // Persist raw output FIRST (crash-safe ordering)
          await this.store.saveRoundArtifact(runId, round, 'claude-raw.md', claudeRaw);
        }

        // Parse Claude output
        const claudeOutput = this.jsonParser.parse<ClaudeDecisionOutput>(claudeRaw);
        if (!claudeOutput) {
          await this.emit(runId, round, 'claude_parse_error', {
            round,
            raw: claudeRaw.substring(0, 500),
          });

          // Track consecutive parse failures (P0 fix: prevent silent empty loops)
          const currentMeta = await this.store.getMeta(runId);
          const parseFailures = (currentMeta?.termination_state?.consecutive_parse_failures ?? 0) + 1;
          await this.store.updateMeta(runId, {
            termination_state: {
              ...(currentMeta?.termination_state ?? { consecutive_parse_failures: 0, zero_progress_rounds: 0 }),
              consecutive_parse_failures: parseFailures,
            },
          });

          if (parseFailures >= 2) {
            console.error(
              `[WorkflowEngine] Claude parse failed ${parseFailures} consecutive times (run=${runId}). Pausing for human review.`,
            );
            await this.pauseForHuman(runId, round, {
              reason: 'deadlock_detected',
              action: 'pause_for_human',
              details: `Claude output parse failed ${parseFailures} consecutive times. Manual intervention required.`,
            });
            return;
          }

          // Skip to next round (single parse failure is tolerable)
          round++;
          if (round > config.max_rounds) {
            await this.terminateWorkflow(runId, round - 1, 'max_rounds_reached');
            return;
          }
          step = 'codex_review';
          meta.current_round = round;
          meta.current_step = 'codex_review';
          await this.store.updateMeta(runId, {
            current_round: round,
            current_step: 'codex_review',
          });
          continue;
        }

        // Parse succeeded — reset consecutive parse failure counter
        const currentMetaForReset = await this.store.getMeta(runId);
        if (currentMetaForReset?.termination_state?.consecutive_parse_failures) {
          await this.store.updateMeta(runId, {
            termination_state: {
              ...currentMetaForReset.termination_state,
              consecutive_parse_failures: 0,
            },
          });
        }

        // Extract patches (works even if claudeOutput is null -- falls back to markers)
        const patches = this.jsonParser.extractPatches(claudeRaw, claudeOutput);

        // Validate decisions before processing (H-NEW-4)
        if (claudeOutput?.decisions) {
          const validationResult = this.decisionValidator.validate(
            claudeOutput.decisions,
            claudeOutput.resolves_issues,
            ledger,
            profile,
          );
          if (!validationResult.valid) {
            console.warn(
              `[WorkflowEngine] Decision validation warnings (run=${runId}, round=${round}):`,
              validationResult.errors,
            );
            await this.emit(runId, round, 'decision_validation_failed', {
              round,
              errors: validationResult.errors,
            });
            // Filter out invalid decisions: unknown issue_ids, invalid actions, duplicates (graceful degradation)
            const knownIds = new Set(ledger.issues.map((i) => i.id));
            const seenIds = new Set<string>();
            claudeOutput.decisions = claudeOutput.decisions.filter((d) => {
              if (!knownIds.has(d.issue_id) || !VALID_ACTIONS_SET.has(d.action)) return false;
              if (seenIds.has(d.issue_id)) return false; // Remove duplicates (keep first)
              seenIds.add(d.issue_id);
              return true;
            });
          }
        }

        // Process decisions -> update ledger
        const pendingAcceptAndResolve: string[] = [];
        if (claudeOutput?.decisions) {
          for (const decision of claudeOutput.decisions) {
            const issue = ledger.issues.find((i) => i.id === decision.issue_id);
            if (!issue) continue;

            switch (decision.action) {
              case 'accept':
                issue.status = 'accepted';
                break;
              case 'accept_and_resolve':
                // Defer resolution until after patch application (H-NEW-2 fix)
                issue.status = 'accepted';  // Temporarily set as accepted
                pendingAcceptAndResolve.push(issue.id);
                break;
              case 'reject':
                issue.status = 'rejected';
                break;
              case 'defer':
                issue.status = 'deferred';
                break;
              default:
                console.warn(
                  `[WorkflowEngine] Unknown decision action '${decision.action}' for issue ${decision.issue_id}. Skipping.`,
                );
                await this.emit(runId, round, 'claude_parse_error', {
                  round,
                  issue_id: decision.issue_id,
                  unknown_action: decision.action,
                });
                continue; // Skip decided_by/decision_reason assignment
            }
            issue.decided_by = 'claude';
            issue.decision_reason = decision.reason;

            // Code-review §6.2: store fix_instruction separately from decision_reason
            // when accept action has a fix_instruction field (requireFixInstruction profile).
            if (
              profile.behavior.requireFixInstruction &&
              decision.action === 'accept'
            ) {
              issue.fix_instruction =
                (decision as Decision & { fix_instruction?: string }).fix_instruction;
            }

            await this.emit(runId, round, 'issue_status_changed', {
              issue_id: issue.id,
              new_status: issue.status,
              action: decision.action,
            });
          }
        }

        // ── Patch application (spec-review only) ──────────────────
        // When profile.behavior.applyPatches is false (e.g. code-review),
        // skip all patch extraction, application, and resolves_issues logic.
        let hasPatchFailure = false;

        if (profile.behavior.applyPatches) {
          // Guard: Claude claims patch exists but extraction failed → treat as patch failure
          // Prevents false-positive resolves when markers don't match or extraction breaks
          if (claudeOutput?.spec_updated && !patches.specPatch) {
            hasPatchFailure = true;
            await this.emit(runId, round, 'patch_extraction_failed', {
              target: 'spec',
              reason: 'Claude reported spec_updated=true but no spec patch could be extracted',
            });
          }
          if (claudeOutput?.plan_updated && !patches.planPatch) {
            hasPatchFailure = true;
            await this.emit(runId, round, 'patch_extraction_failed', {
              target: 'plan',
              reason: 'Claude reported plan_updated=true but no plan patch could be extracted',
            });
          }

          if (patches.specPatch) {
            const currentSpec = await this.store.loadSpec(runId);
            if (currentSpec) {
              const result = this.patchApplier.apply(currentSpec, patches.specPatch);
              await this.store.saveSpec(runId, result.merged);
              await this.emit(runId, round, 'spec_updated', {
                applied_sections: result.appliedSections,
                failed_sections: result.failedSections,
              });
              if (result.failedSections.length > 0) {
                hasPatchFailure = true;
                await this.emit(runId, round, 'patch_apply_failed', {
                  target: 'spec',
                  failed_sections: result.failedSections,
                });
              }
            }
          }

          // Apply plan patch
          if (patches.planPatch) {
            const currentPlan = await this.store.loadPlan(runId);
            if (currentPlan) {
              const result = this.patchApplier.apply(currentPlan, patches.planPatch);
              await this.store.savePlan(runId, result.merged);
              await this.emit(runId, round, 'plan_updated', {
                applied_sections: result.appliedSections,
                failed_sections: result.failedSections,
              });
              if (result.failedSections.length > 0) {
                hasPatchFailure = true;
                await this.emit(runId, round, 'patch_apply_failed', {
                  target: 'plan',
                  failed_sections: result.failedSections,
                });
              }
            }
          }

          // Finalize accept_and_resolve decisions based on patch results (H-NEW-2)
          for (const issueId of pendingAcceptAndResolve) {
            const issue = ledger.issues.find((i) => i.id === issueId);
            if (!issue) continue;
            if (hasPatchFailure) {
              // Patch failed — keep as accepted, do not auto-resolve
              console.warn(
                `[WorkflowEngine] accept_and_resolve for ${issueId} downgraded to accepted due to patch failure`,
              );
              await this.emit(runId, round, 'issue_status_changed', {
                issue_id: issueId,
                new_status: 'accepted',
                action: 'accept_and_resolve_downgraded',
                reason: 'patch_apply_failed',
              });
            } else {
              issue.status = 'resolved';
              issue.resolved_in_round = round;
              await this.emit(runId, round, 'issue_status_changed', {
                issue_id: issueId,
                new_status: 'resolved',
                action: 'accept_and_resolve',
              });
            }
          }
        }

        // ── Resolves_issues tracking (spec-review only) ──────────
        if (profile.behavior.trackResolvesIssues) {
          // Handle resolves_issues — block resolution when patches failed
          if (claudeOutput?.resolves_issues) {
            if (hasPatchFailure) {
              // Patches partially failed — do NOT mark issues as resolved
              // to prevent ledger/document state divergence (ISS-002)
              console.warn(
                `[WorkflowEngine] Skipping resolves_issues (run=${runId}, round=${round}): ` +
                `patch apply had failures, cannot confirm issues are truly resolved`,
              );
              await this.emit(runId, round, 'resolves_issues_missing', {
                round,
                reason: 'patch_apply_failed',
                blocked_issue_ids: claudeOutput.resolves_issues,
              });
            } else {
              for (const issueId of claudeOutput.resolves_issues) {
                const issue = ledger.issues.find(
                  (i) => i.id === issueId && i.status === 'accepted',
                );
                if (issue) {
                  issue.status = 'resolved';
                  issue.resolved_in_round = round;

                  await this.emit(runId, round, 'issue_status_changed', {
                    issue_id: issue.id,
                    new_status: 'resolved',
                    action: 'resolve_via_patch',
                  });
                }
              }
            }
          } else if (claudeOutput?.decisions?.some((d) => d.action === 'accept')) {
            // Claude accepted issues but did not specify which are resolved by patches
            await this.emit(runId, round, 'resolves_issues_missing', {
              round,
              accepted_issue_ids: claudeOutput.decisions
                .filter((d) => d.action === 'accept')
                .map((d) => d.issue_id),
            });
          }
        }

        // Persist updated ledger (crash-safe ordering: ledger -> spec/plan -> meta)
        await this.store.saveLedger(runId, ledger);

        // Compute decision statistics for the event payload
        const decisionStats = {
          accepted: 0,
          rejected: 0,
          deferred: 0,
          resolved: 0,
        };
        if (claudeOutput?.decisions) {
          for (const d of claudeOutput.decisions) {
            switch (d.action) {
              case 'accept': decisionStats.accepted++; break;
              case 'accept_and_resolve': decisionStats.resolved++; break;
              case 'reject': decisionStats.rejected++; break;
              case 'defer': decisionStats.deferred++; break;
            }
          }
        }

        await this.emit(runId, round, 'claude_decision_completed', {
          round,
          ...decisionStats,
          spec_updated: !!patches.specPatch,
          plan_updated: !!patches.planPatch,
        });

        // Advance to next step
        step = 'post_decision';
        meta.current_step = 'post_decision';
        await this.store.updateMeta(runId, { current_step: 'post_decision' });
      }

      // ════════════════════════════════════════════════════════════
      // Step D: post_decision
      // ════════════════════════════════════════════════════════════
      if (step === 'post_decision') {
        // Reload transient state if resuming into this step
        if (!codexOutput) {
          codexOutput = await this.reloadCodexOutput(runId, round);
        }
        ledger = (await this.store.loadLedger(runId)) ?? { run_id: runId, issues: [] };

        // Count new high/critical issues from THIS round
        const currentRoundNewHighCritical = ledger.issues.filter(
          (issue) =>
            issue.round === round &&
            (issue.severity === 'critical' || issue.severity === 'high'),
        ).length;

        // Run post-decision termination check
        const termResult = this.terminationJudge.judge({
          round,
          config,
          ledger,
          latestOutput: codexOutput,
          previousRoundHadNewHighCritical,
          acceptedIsTerminal: profile.behavior.acceptedIsTerminal,
        });

        if (termResult) {
          if (termResult.action === 'terminate') {
            await this.terminateWorkflow(runId, round, termResult.reason);
            return;
          }
          if (termResult.action === 'pause_for_human') {
            await this.pauseForHuman(runId, round, termResult);
            return;
          }
        }

        // Zero-progress safety net (P0 fix: prevent wasting API calls)
        // Count issues that were decided by Claude THIS round (not first-raised round).
        // An issue's .round is the round it was first raised; we need to check
        // decision_reason presence + resolved_in_round to detect this-round activity.
        const thisRoundResolved = ledger.issues.filter(
          (i) => i.resolved_in_round === round,
        ).length;
        const thisRoundDecided = ledger.issues.filter(
          (i) => i.decided_by === 'claude' &&
            (i.status === 'accepted' || i.status === 'rejected' || i.status === 'deferred') &&
            i.decision_reason != null,
        ).length;

        const currentMetaZP = await this.store.getMeta(runId);
        const ts = currentMetaZP?.termination_state ?? { consecutive_parse_failures: 0, zero_progress_rounds: 0 };

        if (thisRoundDecided === 0 && thisRoundResolved === 0) {
          const zeroProgressCount = ts.zero_progress_rounds + 1;
          await this.store.updateMeta(runId, {
            termination_state: { ...ts, zero_progress_rounds: zeroProgressCount },
          });

          if (zeroProgressCount >= 2) {
            console.error(
              `[WorkflowEngine] Zero progress for ${zeroProgressCount} consecutive rounds (run=${runId}). Pausing.`,
            );
            await this.pauseForHuman(runId, round, {
              reason: 'deadlock_detected',
              action: 'pause_for_human',
              details: `No issues accepted or resolved for ${zeroProgressCount} consecutive rounds.`,
            });
            return;
          }
        } else {
          // Reset counter on progress
          if (ts.zero_progress_rounds > 0) {
            await this.store.updateMeta(runId, {
              termination_state: { ...ts, zero_progress_rounds: 0 },
            });
          }
        }

        // Update transient state for next round
        previousRoundHadNewHighCritical = currentRoundNewHighCritical > 0;

        // Advance to the next round
        round++;
        step = 'codex_review';
        meta.current_round = round;
        meta.current_step = 'codex_review';
        await this.store.updateMeta(runId, {
          current_round: round,
          current_step: 'codex_review',
          last_completed: { round: round - 1, step: 'post_decision' },
        });
      }
    }

    // Loop exhausted: max_rounds reached
    await this.terminateWorkflow(runId, round - 1, 'max_rounds_reached');
  }

  // ── Private: Event emission ─────────────────────────────────────

  /**
   * Create, persist, and broadcast a workflow event.
   *
   * Events are written to the ndjson event log before notifying listeners,
   * ensuring persistence even if a listener throws.
   *
   * @param runId - The workflow run identifier.
   * @param round - The current round number.
   * @param eventType - The discriminated event type.
   * @param data - Event-specific payload.
   */
  private async emit(
    runId: string,
    round: number,
    eventType: WorkflowEventType,
    data: Record<string, unknown>,
  ): Promise<void> {
    const event: WorkflowEvent = {
      timestamp: new Date().toISOString(),
      run_id: runId,
      round,
      event_type: eventType,
      data,
    };

    // Persist before notifying listeners (crash safety)
    await this.store.appendEvent(event);

    // Notify registered listeners
    const callbacks = this.listeners.get(eventType);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(event);
        } catch {
          // Listener errors are swallowed to prevent cascading failures.
          // In production, this should be logged to a monitoring system.
        }
      }
    }
  }

  // ── Private: Termination helpers ────────────────────────────────

  /**
   * Terminate the workflow with a specific reason.
   *
   * Updates meta to `completed` status and emits `termination_triggered`
   * and `workflow_completed` events.
   *
   * @param runId - The workflow run identifier.
   * @param round - The round at which termination occurred.
   * @param reason - The termination reason.
   */
  private async terminateWorkflow(
    runId: string,
    round: number,
    reason: string,
  ): Promise<void> {
    // Check auto_terminate config — if disabled, pause for human instead
    const meta = await this.store.getMeta(runId);
    if (meta && !meta.config.auto_terminate) {
      await this.pauseForHuman(runId, round, {
        reason: reason as TerminationReason,
        action: 'pause_for_human',
        details: `Termination condition '${reason}' met, but auto_terminate is disabled. Pausing for human review.`,
      });
      return;
    }

    await this.emit(runId, round, 'termination_triggered', { reason, round });

    // Load ledger for final summary statistics
    const finalLedger = await this.store.loadLedger(runId);
    const allIssues = finalLedger?.issues ?? [];
    const severityCounts = {
      critical: allIssues.filter((i) => i.severity === 'critical').length,
      high: allIssues.filter((i) => i.severity === 'high').length,
      medium: allIssues.filter((i) => i.severity === 'medium').length,
      low: allIssues.filter((i) => i.severity === 'low').length,
    };
    const statusCounts = {
      open: allIssues.filter((i) => i.status === 'open').length,
      accepted: allIssues.filter((i) => i.status === 'accepted').length,
      rejected: allIssues.filter((i) => i.status === 'rejected').length,
      deferred: allIssues.filter((i) => i.status === 'deferred').length,
      resolved: allIssues.filter((i) => i.status === 'resolved').length,
    };

    // P1-3: Update current_step to match last_completed.step, preventing
    // contradictory meta like status=completed + current_step=claude_decision.
    await this.store.updateMeta(runId, {
      status: 'completed',
      current_round: round,
      current_step: 'post_decision',
      last_completed: { round, step: 'post_decision' },
    });

    let reportPaths: { markdown?: string; json?: string } = {};
    if (meta?.workflow_type === 'code-review') {
      reportPaths = await this.persistCodeReviewReport(runId);
    }

    await this.emit(runId, round, 'workflow_completed', {
      reason,
      final_round: round,
      total_rounds: round,
      total_issues: allIssues.length,
      severity: severityCounts,
      status: statusCounts,
      report_markdown_path: reportPaths.markdown,
      report_json_path: reportPaths.json,
    });
  }

  /**
   * Terminate the workflow due to an unexpected error.
   *
   * Updates meta to `failed` status and emits a `workflow_failed` event.
   *
   * @param runId - The workflow run identifier.
   * @param round - The round at which the error occurred.
   * @param err - The error that caused the failure.
   */
  private async terminateWorkflowWithError(
    runId: string,
    round: number,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;

    console.error(
      `[WorkflowEngine] Workflow FAILED (run=${runId}, round=${round}): ${message}` +
      `${stack ? `\n${stack}` : ''}`,
    );

    await this.emit(runId, round, 'workflow_failed', {
      error: message,
      stack: stack?.substring(0, 2000),
      round,
    });

    await this.store.updateMeta(runId, {
      status: 'failed',
      current_round: round,
    });
  }

  /**
   * Pause the workflow for human review.
   *
   * Updates meta to `human_review` status and emits a `human_review_requested`
   * event with the termination details.
   *
   * @param runId - The workflow run identifier.
   * @param round - The current round number.
   * @param termResult - The termination result that triggered the pause.
   */
  private async pauseForHuman(
    runId: string,
    round: number,
    termResult: TerminationResult,
  ): Promise<void> {
    await this.emit(runId, round, 'human_review_requested', {
      reason: termResult.reason,
      details: termResult.details,
      round,
    });

    await this.store.updateMeta(runId, {
      status: 'human_review',
      current_round: round,
    });
  }

  /**
   * Save a checkpoint when the workflow is paused or interrupted.
   *
   * Persists the current step as the checkpoint in meta, allowing
   * the workflow to resume from exactly this point.
   *
   * @param runId - The workflow run identifier.
   * @param round - The current round number.
   * @param step - The step that was in progress when paused.
   */
  private async saveCheckpoint(
    runId: string,
    round: number,
    step: WorkflowStep,
  ): Promise<void> {
    await this.store.updateMeta(runId, {
      status: 'paused',
      current_round: round,
      current_step: step,
    });
  }

  // ── Private: State recovery helpers ─────────────────────────────

  /**
   * Reload the parsed Codex output for a given round from the store.
   *
   * Used when resuming into a step that requires the Codex output
   * (issue_matching, pre_termination, claude_decision, post_decision).
   *
   * @param runId - The workflow run identifier.
   * @param round - The round number to load.
   * @returns The parsed CodexReviewOutput, or a fallback empty output.
   */
  private async reloadCodexOutput(
    runId: string,
    round: number,
  ): Promise<CodexReviewOutput> {
    const codexRaw = await this.store.loadRoundArtifact(runId, round, 'codex-review.md');

    if (!codexRaw) {
      // This should not happen in a well-formed workflow, but we
      // return a safe fallback rather than crashing.
      return {
        findings: [],
        overall_assessment: 'major_issues',
        summary: 'No Codex output found for this round (conservative fallback — not LGTM)',
      };
    }

    const parsed = this.jsonParser.parse<CodexReviewOutput>(codexRaw);
    if (!parsed) {
      return {
        findings: [],
        overall_assessment: 'major_issues',
        summary: 'Failed to parse Codex output on reload (conservative fallback — not LGTM)',
      };
    }

    return parsed;
  }

  /**
   * Load code-review context (changed files + diff) from the persisted snapshot.
   *
   * The review snapshot already contains the frozen diff and preloaded
   * changed file context created at workflow start. This keeps every
   * round and resume path on the exact same input.
   */
  private async loadCodeReviewContext(
    _runId: string,
    snapshot: import('./types.js').ReviewSnapshot | null,
  ): Promise<{ changedFiles: ChangedFile[]; diff: string }> {
    if (!snapshot) {
      return { changedFiles: [], diff: '' };
    }

    return { changedFiles: snapshot.changed_files, diff: snapshot.diff };
  }

  /**
   * Generate and persist final code-review report artifacts.
   *
   * The report is stored as both Markdown and JSON under the run directory.
   * Relative paths are returned so IM/UI layers can surface them directly.
   */
  private async persistCodeReviewReport(
    runId: string,
  ): Promise<{ markdown: string; json: string }> {
    const reporter = new ReportGenerator(this.store);
    const { markdown, data } = await reporter.generate(runId);

    const markdownName = 'code-review-report.md';
    const jsonName = 'code-review-report.json';

    await this.store.saveRunArtifact(runId, markdownName, markdown);
    await this.store.saveRunArtifact(runId, jsonName, JSON.stringify(data, null, 2));

    return {
      markdown: `${runId}/${markdownName}`,
      json: `${runId}/${jsonName}`,
    };
  }

  /**
   * Compute the `previousRoundHadNewHighCritical` flag from persisted state.
   *
   * For round 1, always returns `true` (conservative default prevents
   * premature termination via the "no new high/critical for 2 rounds" rule).
   *
   * For round N > 1, checks whether round N-1 introduced any high/critical
   * issues by scanning the issue ledger.
   *
   * @param runId - The workflow run identifier.
   * @param currentRound - The round we are about to execute.
   * @returns Whether the previous round had new high/critical issues.
   */
  private async computePreviousRoundHadNewHighCritical(
    runId: string,
    currentRound: number,
  ): Promise<boolean> {
    // Round 1 has no "previous round" -- default to true to prevent
    // the "no new high/critical for 2 consecutive rounds" rule from
    // triggering on round 1.
    if (currentRound <= 1) {
      return true;
    }

    const ledger = await this.store.loadLedger(runId);
    if (!ledger) {
      return true; // No ledger yet -- be conservative
    }

    const previousRound = currentRound - 1;
    return ledger.issues.some(
      (issue) =>
        issue.round === previousRound &&
        (issue.severity === 'critical' || issue.severity === 'high'),
    );
  }
}

// ── Module-level helpers ──────────────────────────────────────────

import { CODE_REVIEW_PROFILE } from './types.js';
import type { WorkflowType } from './types.js';

/**
 * Resolve a {@link WorkflowProfile} from a persisted {@link WorkflowType}.
 *
 * Used by `resume()` to reconstruct the profile from meta.workflow_type
 * without requiring callers to pass it explicitly.
 *
 * @param workflowType - The workflow type string from persisted meta.
 * @returns The corresponding profile (defaults to SPEC_REVIEW_PROFILE).
 */
function resolveProfileFromType(workflowType: WorkflowType): WorkflowProfile {
  switch (workflowType) {
    case 'code-review':
      return CODE_REVIEW_PROFILE;
    case 'spec-review':
    case 'dev':
    default:
      return SPEC_REVIEW_PROFILE;
  }
}
