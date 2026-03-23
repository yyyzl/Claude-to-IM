/**
 * Prompt Assembler — renders structured data into final prompt text.
 *
 * Converts {@link SpecReviewPack} and {@link ClaudeDecisionInput} into
 * complete prompt strings by loading Markdown templates and performing
 * simple `{{var}}` placeholder replacement.
 *
 * No external template engine is used; all rendering is done via
 * `String.prototype.replace` with regex matching.
 *
 * @module workflow/prompt-assembler
 */

import { WorkflowStore } from './workflow-store.js';
import type {
  SpecReviewPack,
  ClaudeDecisionInput,
  CodeReviewPack,
  ClaudeCodeReviewInput,
  ChangedFile,
  CodeFinding,
  Issue,
  RejectedIssueSummary,
  ResolvedIssueSummary,
  AcceptedIssueSummary,
  ContextFile,
  Finding,
} from './types.js';

/** Template file name for the Codex spec-review prompt. */
const SPEC_REVIEW_TEMPLATE = 'spec-review-pack.md';

/** Template file name for the Claude decision prompt. */
const CLAUDE_DECISION_TEMPLATE = 'claude-decision.md';

/** Template file name for the Claude decision system prompt. */
const CLAUDE_DECISION_SYSTEM_TEMPLATE = 'claude-decision-system.md';

/** Template file name for the Codex code-review prompt. */
const CODE_REVIEW_TEMPLATE = 'code-review-pack.md';

/** Template file name for the Claude code-review decision prompt. */
const CLAUDE_CODE_REVIEW_TEMPLATE = 'code-review-decision.md';

/** Template file name for the Claude code-review system prompt. */
const CLAUDE_CODE_REVIEW_SYSTEM_TEMPLATE = 'code-review-decision-system.md';

/** Separated prompt components for Claude API calls. */
export interface ClaudePromptParts {
  /** System prompt (role definition, decision framework). */
  system: string;
  /** User prompt (actual task content). */
  user: string;
}

/**
 * Assembles final prompt text from structured workflow data.
 *
 * Usage:
 * ```ts
 * const assembler = new PromptAssembler(store);
 * const codexPrompt = await assembler.renderSpecReviewPrompt(pack);
 * const claudePrompt = await assembler.renderClaudeDecisionPrompt(input);
 * ```
 */
export class PromptAssembler {
  constructor(private readonly store: WorkflowStore) {}

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Render a {@link SpecReviewPack} into the final Codex prompt text.
   *
   * Loads the `spec-review-pack.md` template and replaces all placeholders
   * with formatted data from the pack.
   */
  async renderSpecReviewPrompt(pack: SpecReviewPack): Promise<string> {
    const template = await this.store.loadTemplate(SPEC_REVIEW_TEMPLATE);

    let result = template;
    result = this.replacePlaceholder(result, 'spec', pack.spec);
    result = this.replacePlaceholder(result, 'plan', pack.plan);
    result = this.replacePlaceholder(
      result,
      'unresolved_issues',
      this.renderUnresolvedIssues(pack.unresolved_issues),
    );
    result = this.replacePlaceholder(
      result,
      'rejected_issues',
      this.renderRejectedIssues(pack.rejected_issues),
    );
    result = this.replacePlaceholder(
      result,
      'resolved_issues',
      this.renderResolvedIssues(pack.resolved_issues ?? []),
    );
    result = this.replacePlaceholder(
      result,
      'accepted_issues',
      this.renderAcceptedIssues(pack.accepted_issues ?? []),
    );
    result = this.replacePlaceholder(
      result,
      'round_summary',
      pack.round_summary || 'First round',
    );
    result = this.replacePlaceholder(result, 'round', pack.round.toString());
    result = this.replacePlaceholder(
      result,
      'context_files',
      this.renderContextFiles(pack.context_files),
    );

    return result;
  }

  /**
   * Render a {@link ClaudeDecisionInput} into separated system + user prompts.
   *
   * Two rendering variants for the user prompt:
   * - **Normal** (`hasNewFindings=true`): standard decision prompt with numbered findings.
   * - **No findings** (`hasNewFindings=false`): alternate prompt directing Claude to
   *   address remaining open issues in the ledger.
   *
   * The system prompt is loaded from a dedicated template file and returned
   * separately so it can be passed as the `system` parameter to the Claude API.
   */
  async renderClaudeDecisionPrompt(input: ClaudeDecisionInput): Promise<ClaudePromptParts> {
    const template = await this.store.loadTemplate(CLAUDE_DECISION_TEMPLATE);

    let result = template;
    result = this.replacePlaceholder(result, 'round', input.round.toString());
    result = this.replacePlaceholder(
      result,
      'codex_findings_with_ids',
      this.renderCodexFindings(input.codexFindingsWithIds, input.hasNewFindings),
    );
    result = this.replacePlaceholder(
      result,
      'previous_decisions',
      input.previousDecisions || 'First round - no previous decisions.',
    );
    result = this.replacePlaceholder(result, 'ledger_summary', input.ledgerSummary);
    result = this.replacePlaceholder(result, 'current_spec', input.currentSpec);
    result = this.replacePlaceholder(result, 'current_plan', input.currentPlan);

    // Load system prompt template
    const system = await this.store.loadTemplate(CLAUDE_DECISION_SYSTEM_TEMPLATE);

    return { system, user: result };
  }

  // ── Code Review Prompts (P1b-CR-0) ──────────────────────────────

  /**
   * Render a {@link CodeReviewPack} into the final Codex code-review prompt.
   *
   * Loads the `code-review-pack.md` template and replaces placeholders.
   */
  async renderCodeReviewPrompt(pack: CodeReviewPack): Promise<string> {
    const template = await this.store.loadTemplate(CODE_REVIEW_TEMPLATE);

    let result = template;
    result = this.replacePlaceholder(result, 'diff', pack.diff);
    result = this.replacePlaceholder(
      result,
      'changed_files',
      this.renderChangedFiles(pack.changed_files),
    );
    result = this.replacePlaceholder(
      result,
      'unresolved_issues',
      this.renderUnresolvedIssues(pack.unresolved_issues),
    );
    result = this.replacePlaceholder(
      result,
      'accepted_issues',
      this.renderAcceptedIssues(pack.accepted_issues),
    );
    result = this.replacePlaceholder(
      result,
      'rejected_issues',
      this.renderRejectedIssues(pack.rejected_issues),
    );
    result = this.replacePlaceholder(
      result,
      'round_summary',
      pack.round_summary || 'First round',
    );
    result = this.replacePlaceholder(result, 'round', pack.round.toString());
    result = this.replacePlaceholder(
      result,
      'context_files',
      this.renderContextFiles(pack.context_files),
    );
    result = this.replacePlaceholder(
      result,
      'review_scope',
      this.renderReviewScope(pack.review_scope),
    );

    return result;
  }

  /**
   * Render a {@link ClaudeCodeReviewInput} into separated system + user prompts.
   *
   * Fresh context — no previousDecisions field.
   */
  async renderClaudeCodeReviewPrompt(input: ClaudeCodeReviewInput): Promise<ClaudePromptParts> {
    const template = await this.store.loadTemplate(CLAUDE_CODE_REVIEW_TEMPLATE);

    let result = template;
    result = this.replacePlaceholder(result, 'round', input.round.toString());
    result = this.replacePlaceholder(
      result,
      'codex_findings_with_ids',
      this.renderCodeReviewFindings(input.codexFindingsWithIds, input.hasNewFindings),
    );
    result = this.replacePlaceholder(result, 'ledger_summary', input.ledgerSummary);
    result = this.replacePlaceholder(result, 'diff', input.diff);
    result = this.replacePlaceholder(
      result,
      'changed_files',
      this.renderChangedFiles(input.changed_files),
    );

    // Load system prompt template
    const system = await this.store.loadTemplate(CLAUDE_CODE_REVIEW_SYSTEM_TEMPLATE);

    return { system, user: result };
  }

  // ── Private: placeholder replacement ───────────────────────────

  /**
   * Replace all occurrences of `{{name}}` in the template with the given value.
   *
   * Uses a global regex so that if a placeholder appears multiple times
   * in the template, all instances are replaced.
   */
  private replacePlaceholder(template: string, name: string, value: string): string {
    const pattern = new RegExp(`\\{\\{${name}\\}\\}`, 'g');
    return template.replace(pattern, value);
  }

  // ── Private: data formatters ───────────────────────────────────

  /**
   * Render unresolved issues as a Markdown bullet list.
   *
   * Each issue is formatted as:
   * ```
   * - [ISS-001] (critical) description
   * ```
   *
   * @returns Formatted string, or `"None"` if the array is empty.
   */
  private renderUnresolvedIssues(issues: Issue[]): string {
    if (issues.length === 0) return 'None';

    return issues
      .map((issue) => `- [${issue.id}] (${issue.severity}) ${issue.description}`)
      .join('\n');
  }

  /**
   * Render rejected issue summaries as a Markdown bullet list.
   *
   * Each rejected issue is formatted as:
   * ```
   * - [ISS-002] description (rejected in round 1)
   * ```
   *
   * @returns Formatted string, or `"None"` if the array is empty.
   */
  private renderRejectedIssues(rejected: RejectedIssueSummary[]): string {
    if (rejected.length === 0) return 'None';

    return rejected
      .map((item) => `- [${item.id}] ${item.description} (rejected in round ${item.round_rejected})`)
      .join('\n');
  }

  /**
   * Render resolved issue summaries as a Markdown bullet list.
   *
   * Each resolved issue is formatted as:
   * ```
   * - [ISS-003] (high, resolved in R2) description
   * ```
   *
   * @returns Formatted string, or `"None"` if the array is empty.
   */
  private renderResolvedIssues(issues: ResolvedIssueSummary[]): string {
    if (issues.length === 0) return 'None';
    return issues
      .map((i) => `- [${i.id}] (${i.severity}, resolved in R${i.resolved_in_round}) ${i.description}`)
      .join('\n');
  }

  /**
   * Render accepted issue summaries as a Markdown bullet list.
   *
   * Each accepted issue is formatted as:
   * ```
   * - [ISS-004] (medium, raised in R1) description
   * ```
   *
   * @returns Formatted string, or `"None"` if the array is empty.
   */
  private renderAcceptedIssues(issues: AcceptedIssueSummary[]): string {
    if (issues.length === 0) return 'None';
    return issues
      .map((i) => `- [${i.id}] (${i.severity}, raised in R${i.round}) ${i.description}`)
      .join('\n');
  }

  /**
   * Render context files as Markdown sections with fenced code blocks.
   *
   * Each file is formatted as:
   * ```
   * ### filename
   * ```
   * content
   * ```
   * ```
   *
   * @returns Formatted string, or `"None"` if the array is empty.
   */
  private renderContextFiles(files: ContextFile[]): string {
    if (files.length === 0) return 'None';

    return files
      .map((file) => `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
      .join('\n\n');
  }

  /**
   * Render Codex findings as a numbered list with issue IDs and metadata.
   *
   * Each finding is formatted as:
   * ```
   * 1. [ISS-001] (NEW) (critical) issue description
   *    Evidence: evidence
   *    Suggestion: suggestion
   * ```
   *
   * The `(NEW)` marker is only shown when `isNew` is true.
   *
   * When `hasNewFindings` is false (no findings to render), returns
   * a message indicating Codex found no new issues.
   *
   * @param findings - Array of findings enriched with issue IDs and new/existing classification.
   * @param hasNewFindings - Whether any new findings exist in this round.
   * @returns Formatted string.
   */
  private renderCodexFindings(
    findings: ClaudeDecisionInput['codexFindingsWithIds'],
    hasNewFindings: boolean,
  ): string {
    if (!hasNewFindings) {
      return 'No new findings from Codex.';
    }

    return findings
      .map((item, index) => {
        const newMarker = item.isNew ? ' (NEW)' : '';
        const header = `${index + 1}. [${item.issueId}]${newMarker} (${item.finding.severity}) ${item.finding.issue}`;
        const evidence = `   Evidence: ${item.finding.evidence}`;
        const suggestion = `   Suggestion: ${item.finding.suggestion}`;
        return `${header}\n${evidence}\n${suggestion}`;
      })
      .join('\n');
  }

  // ── Private: Code Review formatters ─────────────────────────────

  /**
   * Render changed files as Markdown sections with fenced code blocks.
   *
   * Each file shows its change type, language, and content.
   */
  private renderChangedFiles(files: ChangedFile[]): string {
    if (files.length === 0) return 'No changed files.';

    return files
      .map((file) => {
        const header = `### \`${file.path}\` (${file.change_type}, +${file.stats.additions}/-${file.stats.deletions})`;
        const content = `\`\`\`${file.language}\n${file.content}\n\`\`\``;
        return `${header}\n${content}`;
      })
      .join('\n\n');
  }

  /**
   * Render a ReviewScope as a human-readable string.
   */
  private renderReviewScope(scope: import('./types.js').ReviewScope): string {
    switch (scope.type) {
      case 'staged':
        return 'Staged changes (git diff --cached)';
      case 'unstaged':
        return 'Unstaged working tree changes (git diff)';
      case 'commit':
        return `Single commit: ${scope.base_ref ?? 'HEAD'}`;
      case 'commit_range':
        return `Commit range: ${scope.base_ref}..${scope.head_ref}`;
      case 'branch':
        return `Branch diff: ${scope.base_ref}...${scope.head_ref}`;
      default:
        return scope.type;
    }
  }

  /**
   * Render code-review findings with file/line/category information.
   *
   * Richer format than spec-review findings — includes file location and category.
   */
  private renderCodeReviewFindings(
    findings: ClaudeCodeReviewInput['codexFindingsWithIds'],
    hasNewFindings: boolean,
  ): string {
    if (!hasNewFindings) {
      return 'No new findings from Codex in this round.';
    }

    return findings
      .map((item, index) => {
        const f = item.finding;
        const newMarker = item.isNew ? ' (NEW)' : '';
        const lineInfo = f.line_range
          ? ` L${f.line_range.start}-${f.line_range.end}`
          : '';
        const header = `${index + 1}. [${item.issueId}]${newMarker} (${f.severity}, ${f.category}) \`${f.file}${lineInfo}\`: ${f.issue}`;
        const evidence = `   Evidence: ${f.evidence}`;
        const suggestion = `   Suggestion: ${f.suggestion}`;
        return `${header}\n${evidence}\n${suggestion}`;
      })
      .join('\n');
  }
}
