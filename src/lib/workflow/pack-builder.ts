/**
 * Pack Builder — assembles input packs for Codex and Claude.
 *
 * Reads data from {@link WorkflowStore} and composes:
 * - {@link SpecReviewPack} for Codex spec-review (blind review input)
 * - {@link ClaudeDecisionInput} for Claude spec-review (structured decision input)
 * - {@link CodeReviewPack} for Codex code-review (blind code review input)
 * - {@link ClaudeCodeReviewInput} for Claude code-review (fresh context, no prior decisions)
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
  CodeReviewPack,
  ClaudeCodeReviewInput,
  ReviewSnapshot,
  ChangedFile,
  CodeFinding,
  IssueLedger,
  Issue,
  Finding,
  WorkflowConfig,
  RejectedIssueSummary,
  ResolvedIssueSummary,
  AcceptedIssueSummary,
  RoundData,
} from './types.js';
import { SPEC_REVIEW_OVERRIDES } from './types.js';
import { estimateTokens } from './context-compressor.js';

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

    // Build resolved and accepted issue summaries (for dedup context)
    const resolvedIssues = this.buildResolvedIssues(ledger.issues);
    const acceptedIssues = this.buildAcceptedIssues(ledger.issues);

    // Generate round summary
    const roundSummary = this.generateRoundSummary(round, ledger);

    // Context files come from config (already inlined)
    const contextFiles = config.context_files;

    // Attempt context compression if conditions are met.
    // When triggered, the compressor returns a condensed version of spec+plan
    // that fits within the Codex context window budget.
    const compressed = await this.tryCompress(runId, spec, plan, ledger, round, config);

    return {
      spec: compressed.spec,
      plan: compressed.plan,
      unresolved_issues: unresolvedIssues,
      rejected_issues: rejectedIssues,
      resolved_issues: resolvedIssues,
      accepted_issues: acceptedIssues,
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

  // ── Code Review Pack Builders (P1b-CR-0) ────────────────────────

  /**
   * Assemble {@link CodeReviewPack} for Codex blind code review.
   *
   * Reads the frozen snapshot and file contents, then composes the pack
   * with unresolved/rejected/accepted issue summaries.
   *
   * @param runId - Workflow run identifier.
   * @param round - Current round number (1-based).
   * @param config - Workflow configuration.
   * @param snapshot - Frozen review snapshot.
   * @param changedFiles - Pre-loaded changed files with content.
   * @param diff - Full diff text.
   * @returns Assembled CodeReviewPack ready for prompt rendering.
   */
  async buildCodeReviewPack(
    runId: string,
    round: number,
    config: WorkflowConfig,
    snapshot: ReviewSnapshot,
    changedFiles: ChangedFile[],
    diff: string,
  ): Promise<CodeReviewPack> {
    // Load ledger
    const ledger = (await this.store.loadLedger(runId)) ?? {
      run_id: runId,
      issues: [],
    };

    // Filter issues by status
    const unresolvedIssues = this.filterUnresolvedIssues(ledger.issues);
    const rejectedIssues = this.buildRejectedIssues(ledger.issues);
    // INV-7: accepted_issues is a formal field (not optional) for code-review
    const acceptedIssues = this.buildAcceptedIssues(ledger.issues);

    // Round summary
    const roundSummary = this.generateCodeReviewRoundSummary(round, ledger);

    return {
      diff,
      changed_files: changedFiles,
      review_scope: snapshot.scope,
      context_files: config.context_files,
      unresolved_issues: unresolvedIssues,
      rejected_issues: rejectedIssues,
      accepted_issues: acceptedIssues,
      round_summary: roundSummary,
      round,
    };
  }

  /**
   * Assemble {@link ClaudeCodeReviewInput} for Claude code-review decision.
   *
   * Unlike {@link buildClaudeDecisionInput}, this uses FRESH context:
   * - No previousDecisions (avoids confirmation bias)
   * - No currentSpec/currentPlan (reviewing code, not documents)
   * - Ledger summary contains status only, no decision reasons
   *
   * @param runId - Workflow run identifier.
   * @param round - Current round number (1-based).
   * @param matchedFindings - Findings enriched with issue IDs from IssueMatcher.
   * @param changedFiles - Changed files with content.
   * @param diff - Full diff text.
   * @returns Structured input for Claude code-review decision prompt rendering.
   */
  async buildClaudeCodeReviewInput(
    runId: string,
    round: number,
    matchedFindings: Array<{ issueId: string; finding: CodeFinding; isNew: boolean }>,
    changedFiles: ChangedFile[],
    diff: string,
  ): Promise<ClaudeCodeReviewInput> {
    // Load ledger
    const ledger = (await this.store.loadLedger(runId)) ?? {
      run_id: runId,
      issues: [],
    };

    // Build ledger summary (status only, no decision_reason — fresh review)
    const ledgerSummary = this.buildCodeReviewLedgerSummary(ledger);

    // Determine if there are new findings
    const hasNewFindings = matchedFindings.some((f) => f.isNew);

    return {
      round,
      codexFindingsWithIds: matchedFindings,
      ledgerSummary,
      diff,
      changed_files: changedFiles,
      hasNewFindings,
    };
  }

  /**
   * Build ledger summary for code-review (fresh context — no decision reasons).
   *
   * Table columns: `| ID | Description | Status | Severity | File | Category |`
   * Intentionally omits `decision_reason` to avoid biasing Claude.
   */
  private buildCodeReviewLedgerSummary(ledger: IssueLedger): string {
    if (!ledger.issues || ledger.issues.length === 0) {
      return 'No issues recorded yet.';
    }

    const header = '| ID | Description | Status | Severity | File | Category |';
    const separator = '|---|---|---|---|---|---|';
    const rows = ledger.issues.map(
      (issue) =>
        `| ${issue.id} | ${issue.description} | ${issue.status} | ${issue.severity} | ${issue.source_file ?? '-'} | ${issue.category ?? '-'} |`,
    );

    return [header, separator, ...rows].join('\n');
  }

  /**
   * Generate round summary for code-review workflows.
   */
  private generateCodeReviewRoundSummary(round: number, ledger: IssueLedger): string {
    if (round === 1) {
      return 'First code review round. Focus on comprehensive coverage of all changed files.';
    }

    const stats = this.computeLedgerStats(ledger.issues);
    return (
      `Round ${round - 1}: ` +
      `${stats.open} open, ` +
      `${stats.accepted} accepted, ` +
      `${stats.rejected} rejected, ` +
      `${stats.deferred} deferred`
    );
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

  /**
   * Build resolved issue summaries for dedup context.
   *
   * Only includes issues with status `resolved`.
   * Each summary contains: id, description, resolved_in_round, severity.
   */
  private buildResolvedIssues(issues: Issue[]): ResolvedIssueSummary[] {
    return issues
      .filter((i) => i.status === 'resolved')
      .map((i) => ({
        id: i.id,
        description: i.description,
        resolved_in_round: i.resolved_in_round ?? i.round,
        severity: i.severity,
      }));
  }

  /**
   * Build accepted issue summaries for dedup context.
   *
   * Only includes issues with status `accepted`.
   * Each summary contains: id, description, round, severity.
   */
  private buildAcceptedIssues(issues: Issue[]): AcceptedIssueSummary[] {
    return issues
      .filter((i) => i.status === 'accepted')
      .map((i) => ({
        id: i.id,
        description: i.description,
        round: i.round,
        severity: i.severity,
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
      return 'First review round. No prior issues or decisions exist. Focus on comprehensive coverage of the entire spec and plan.';
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
   * Attempt context compression when the spec + plan payload grows too large.
   *
   * Triggers when:
   * - Round >= `SPEC_REVIEW_OVERRIDES.context_compress_round` (4), OR
   * - Estimated tokens > `context_compress_threshold` (60%) of `codex_context_window_tokens`
   *
   * When compression fires, the compressor drops intermediate round data and
   * filters the ledger to open+accepted issues only, producing a condensed
   * text blob.  We inject that blob as a replacement `spec` (the condensed
   * text already contains spec + plan + ledger summary) and blank out `plan`
   * to avoid double-injection.
   *
   * When compression is NOT triggered, the original spec and plan are
   * returned verbatim.
   *
   * @returns `{ spec, plan }` — possibly compressed.
   */
  private async tryCompress(
    runId: string,
    spec: string,
    plan: string,
    ledger: IssueLedger,
    round: number,
    config: WorkflowConfig,
  ): Promise<{ spec: string; plan: string }> {
    const windowTokens = config.codex_context_window_tokens;
    const estimatedTokens = estimateTokens(spec + plan);
    const threshold = windowTokens * SPEC_REVIEW_OVERRIDES.context_compress_threshold;

    const shouldCompress =
      round >= SPEC_REVIEW_OVERRIDES.context_compress_round ||
      estimatedTokens > threshold;

    if (!shouldCompress) {
      return { spec, plan };
    }

    // Load historical rounds data for the compressor (H-NEW-3 fix)
    const rounds: RoundData[] = [];
    for (let r = 1; r < round; r++) {
      const packJson = await this.store.loadRoundArtifact(runId, r, 'pack.json');
      const codexOutput = await this.store.loadRoundArtifact(runId, r, 'codex-review.md');
      const claudeDecision = await this.store.loadRoundArtifact(runId, r, 'claude-raw.md');
      rounds.push({
        round: r,
        packJson: packJson ?? undefined,
        codexOutput: codexOutput ?? undefined,
        claudeDecision: claudeDecision ?? undefined,
      });
    }

    const result = this.compressor.compress({
      spec,
      plan,
      ledger,
      rounds,
      currentRound: round,
      windowTokens,
    });

    if (result.droppedRounds.length > 0) {
      console.log(
        `[PackBuilder] Context compressed: ${estimatedTokens} → ${result.estimatedTokens} est. tokens ` +
        `(dropped rounds: ${result.droppedRounds.join(', ')})`,
      );
    }

    // The compressed text is a self-contained blob (spec + plan + ledger
    // summary + last round).  Inject it as `spec` and blank `plan` so the
    // prompt template's {{spec}} placeholder carries the full compressed
    // context without duplicating content via {{plan}}.
    return {
      spec: result.text,
      plan: '(included in compressed context above)',
    };
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
