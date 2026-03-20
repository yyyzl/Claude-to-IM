/**
 * Pack Builder — assembles input packs for Codex and Claude.
 *
 * Reads data from {@link WorkflowStore} and composes:
 * - {@link SpecReviewPack} for Codex (blind review input)
 * - {@link ClaudeDecisionInput} for Claude (structured decision input)
 *
 * The builder is stateless — all state comes from the store.
 * Context compression is triggered internally when payload exceeds threshold.
 *
 * @module workflow/pack-builder
 */

import { WorkflowStore } from './workflow-store.js';
import type {
  SpecReviewPack,
  ClaudeDecisionInput,
  IssueLedger,
  Issue,
  Finding,
  WorkflowConfig,
  RejectedIssueSummary,
  RoundData,
} from './types.js';
import { SPEC_REVIEW_OVERRIDES } from './types.js';

// ── Context Compressor interface ────────────────────────────────

/**
 * Interface for the context compressor dependency.
 *
 * Defined here (not imported) to avoid circular dependency with
 * the concrete ContextCompressor class.
 */
export interface IContextCompressor {
  compress(ctx: {
    spec: string;
    plan: string;
    ledger: IssueLedger;
    rounds: RoundData[];
    currentRound: number;
    windowTokens: number;
  }): { text: string; estimatedTokens: number; droppedRounds: number[] };
}

// ── PackBuilder ─────────────────────────────────────────────────

export class PackBuilder {
  constructor(
    private readonly store: WorkflowStore,
    private readonly compressor: IContextCompressor,
  ) {}

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Read from Artifact Store, assemble {@link SpecReviewPack}.
   *
   * Internally calls ContextCompressor when payload exceeds threshold
   * (round >= context_compress_round OR estimated tokens > threshold ratio).
   *
   * @param runId - Workflow run identifier.
   * @param round - Current round number (1-based).
   * @param config - Workflow configuration.
   * @returns Assembled SpecReviewPack ready for prompt rendering.
   */
  async buildSpecReviewPack(
    runId: string,
    round: number,
    config: WorkflowConfig,
  ): Promise<SpecReviewPack> {
    // Load latest spec and plan from store
    const spec = (await this.store.loadSpec(runId)) ?? '';
    const plan = (await this.store.loadPlan(runId)) ?? '';

    // Load ledger (empty if first round)
    const ledger = (await this.store.loadLedger(runId)) ?? {
      run_id: runId,
      issues: [],
    };

    // Filter unresolved issues: open or deferred
    const unresolvedIssues = this.filterUnresolvedIssues(ledger.issues);

    // Build rejected issue summaries
    const rejectedIssues = this.buildRejectedIssues(ledger.issues);

    // Generate round summary
    const roundSummary = this.generateRoundSummary(round, ledger);

    // Context files come from config (already inlined)
    const contextFiles = config.context_files;

    // Attempt context compression if conditions are met
    this.tryCompress(spec, plan, ledger, round, config);

    return {
      spec,
      plan,
      unresolved_issues: unresolvedIssues,
      rejected_issues: rejectedIssues,
      context_files: contextFiles,
      round_summary: roundSummary,
      round,
    };
  }

  /**
   * Assemble Claude decision input data (structured, NOT rendered prompt text).
   *
   * Includes Codex findings with issue IDs, ledger summary, spec/plan,
   * and previous decisions for context continuity.
   *
   * @param runId - Workflow run identifier.
   * @param round - Current round number (1-based).
   * @param matchedFindings - Findings enriched with issue IDs from IssueMatcher.
   * @returns Structured input for Claude decision prompt rendering.
   */
  async buildClaudeDecisionInput(
    runId: string,
    round: number,
    matchedFindings: Array<{ issueId: string; finding: Finding; isNew: boolean }>,
  ): Promise<ClaudeDecisionInput> {
    // Load latest spec and plan
    const currentSpec = (await this.store.loadSpec(runId)) ?? '';
    const currentPlan = (await this.store.loadPlan(runId)) ?? '';

    // Load ledger
    const ledger = (await this.store.loadLedger(runId)) ?? {
      run_id: runId,
      issues: [],
    };

    // Build ledger summary as markdown table
    const ledgerSummary = this.buildLedgerSummary(ledger);

    // Build previous decisions summary
    const previousDecisions = await this.buildPreviousDecisionsSummary(runId, round);

    // Determine if there are new findings
    const hasNewFindings = matchedFindings.some((f) => f.isNew);

    return {
      round,
      codexFindingsWithIds: matchedFindings,
      ledgerSummary,
      currentSpec,
      currentPlan,
      previousDecisions,
      hasNewFindings,
    };
  }

  /**
   * Render {@link IssueLedger} as a Markdown table.
   *
   * Table columns: `| ID | Description | Status | Severity | Round |`
   *
   * @param ledger - The issue ledger to render.
   * @returns Markdown table string, or a placeholder message if empty.
   */
  buildLedgerSummary(ledger: IssueLedger): string {
    if (!ledger.issues || ledger.issues.length === 0) {
      return 'No issues recorded yet.';
    }

    const header = '| ID | Description | Status | Severity | Round |';
    const separator = '|---|---|---|---|---|';
    const rows = ledger.issues.map(
      (issue) =>
        `| ${issue.id} | ${issue.description} | ${issue.status} | ${issue.severity} | ${issue.round} |`,
    );

    return [header, separator, ...rows].join('\n');
  }

  /**
   * Build summary of previous rounds' decisions for context continuity.
   *
   * Loads `R{N}-claude-raw.md` artifacts for rounds 1 through upToRound-1.
   * If an artifact exists, generates a short summary reference.
   * If it does not exist, skips that round.
   *
   * @param runId - Workflow run identifier.
   * @param upToRound - Current round number (summaries are built for rounds before this).
   * @returns Concatenated summary text, or empty string if no prior decisions exist.
   */
  async buildPreviousDecisionsSummary(runId: string, upToRound: number): Promise<string> {
    if (upToRound <= 1) {
      return '';
    }

    const summaries: string[] = [];

    for (let r = 1; r < upToRound; r++) {
      const artifact = await this.store.loadRoundArtifact(runId, r, 'claude-raw.md');
      if (artifact !== null) {
        // Extract a brief summary from the artifact
        const briefSummary = this.extractBriefSummary(artifact, r);
        summaries.push(briefSummary);
      }
    }

    return summaries.length > 0
      ? summaries.join('\n\n')
      : '';
  }

  // ── Private: issue filtering ────────────────────────────────────

  /**
   * Filter issues to include only unresolved ones (open or deferred).
   *
   * Deferred issues are subject to `max_deferred_issues` limit:
   * - If there are more deferred issues than the limit, only the most
   *   recent ones (by round) are kept.
   * - Open issues are always included.
   */
  private filterUnresolvedIssues(issues: Issue[]): Issue[] {
    const openIssues = issues.filter((issue) => issue.status === 'open');

    let deferredIssues = issues.filter((issue) => issue.status === 'deferred');

    // Apply max_deferred_issues limit: keep the most recent (highest round),
    // drop the oldest if we exceed the limit.
    const maxDeferred = SPEC_REVIEW_OVERRIDES.max_deferred_issues;
    if (deferredIssues.length > maxDeferred) {
      // Sort by round descending (most recent first), then take the limit
      deferredIssues = deferredIssues
        .sort((a, b) => b.round - a.round)
        .slice(0, maxDeferred);
    }

    return [...openIssues, ...deferredIssues];
  }

  /**
   * Build rejected issue summaries from the issue list.
   *
   * Only includes issues with status `rejected`.
   * Each summary contains: id, description, round_rejected (= issue.round).
   */
  private buildRejectedIssues(issues: Issue[]): RejectedIssueSummary[] {
    return issues
      .filter((issue) => issue.status === 'rejected')
      .map((issue) => ({
        id: issue.id,
        description: issue.description,
        round_rejected: issue.round,
      }));
  }

  // ── Private: round summary generation ───────────────────────────

  /**
   * Generate a round summary string from ledger statistics.
   *
   * Round 1 returns an empty string (no prior data to summarize).
   * Subsequent rounds produce: `"Round {N-1}: {open} open, {accepted} accepted,
   * {rejected} rejected, {deferred} deferred, {resolved} resolved"`.
   */
  private generateRoundSummary(round: number, ledger: IssueLedger): string {
    if (round === 1) {
      return '';
    }

    const stats = this.computeLedgerStats(ledger.issues);

    return (
      `Round ${round - 1}: ` +
      `${stats.open} open, ` +
      `${stats.accepted} accepted, ` +
      `${stats.rejected} rejected, ` +
      `${stats.deferred} deferred, ` +
      `${stats.resolved} resolved`
    );
  }

  /**
   * Count issues by status for summary generation.
   */
  private computeLedgerStats(issues: Issue[]): Record<string, number> {
    const stats: Record<string, number> = {
      open: 0,
      accepted: 0,
      rejected: 0,
      deferred: 0,
      resolved: 0,
    };

    for (const issue of issues) {
      if (issue.status in stats) {
        stats[issue.status]++;
      }
    }

    return stats;
  }

  // ── Private: context compression ────────────────────────────────

  /**
   * Attempt context compression if conditions are met.
   *
   * Triggers when:
   * - Round >= `SPEC_REVIEW_OVERRIDES.context_compress_round` (4), OR
   * - Estimated tokens > `context_compress_threshold` (60%) of `codex_context_window_tokens`
   *
   * This is a side-effect call: the compressor may log or cache compression
   * results. The actual pack fields (spec, plan) are not modified here
   * because compression affects the overall context, not individual fields.
   *
   * Note: In the current implementation, compression is logged but the
   * compressed text is not substituted into the pack — the prompt assembler
   * and model invoker handle the final context window management.
   */
  private tryCompress(
    spec: string,
    plan: string,
    ledger: IssueLedger,
    round: number,
    config: WorkflowConfig,
  ): void {
    const windowTokens = config.codex_context_window_tokens;
    const estimatedTokens = this.estimateTokens(spec + plan);
    const threshold = windowTokens * SPEC_REVIEW_OVERRIDES.context_compress_threshold;

    const shouldCompress =
      round >= SPEC_REVIEW_OVERRIDES.context_compress_round ||
      estimatedTokens > threshold;

    if (shouldCompress) {
      // Build round data for compressor (best-effort, sync-safe)
      // Round data loading is async in theory, but the compressor
      // receives what we have available synchronously.
      this.compressor.compress({
        spec,
        plan,
        ledger,
        rounds: [], // Rounds data would be loaded async; empty for now
        currentRound: round,
        windowTokens,
      });
    }
  }

  /**
   * Rough token estimation: characters / 4.
   *
   * This is a simple heuristic for English text. Good enough for
   * threshold comparison without pulling in a tokenizer dependency.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  // ── Private: artifact summary extraction ────────────────────────

  /**
   * Extract a brief summary from a Claude decision artifact.
   *
   * Attempts to locate a `"summary"` field in the artifact text.
   * Falls back to a generic reference if extraction fails.
   *
   * @param artifact - Raw artifact content (R{N}-claude-raw.md).
   * @param round - The round number for labeling.
   * @returns A brief summary string for the round.
   */
  private extractBriefSummary(artifact: string, round: number): string {
    // Try to extract a JSON summary field from the artifact
    const summaryMatch = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/s.exec(artifact);
    if (summaryMatch) {
      // Unescape JSON string escapes
      const summary = summaryMatch[1]
        .replace(/\\"/g, '"')
        .replace(/\\n/g, ' ')
        .replace(/\\\\/g, '\\');

      // Truncate if excessively long (keep under ~200 chars for context)
      const truncated =
        summary.length > 200 ? summary.slice(0, 197) + '...' : summary;

      return `**Round ${round}**: ${truncated}`;
    }

    // Fallback: indicate the artifact exists without detailed content
    return `**Round ${round}**: [Claude decision recorded]`;
  }
}
