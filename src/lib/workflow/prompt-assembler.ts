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

/**
 * Prompt character budget for Codex CLI calls.
 *
 * Codex has a hard input limit of 1,048,576 characters.  We use 900K to leave
 * headroom for the wrapper's own system prompt and metadata.
 */
const CODEX_PROMPT_BUDGET = 900_000;

/**
 * Prompt character budget for Claude Agent SDK code-review calls.
 *
 * Claude models have a large context window, but the Agent SDK subprocess
 * can crash when input exceeds ~900KB (P1-1). We set a budget of 800K
 * as the safe threshold, with the same full → hunks → truncate degradation.
 */
const CLAUDE_PROMPT_BUDGET = 800_000;

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

    return this.replaceAllPlaceholders(template, {
      spec: pack.spec,
      plan: pack.plan,
      unresolved_issues: this.renderUnresolvedIssues(pack.unresolved_issues),
      rejected_issues: this.renderRejectedIssues(pack.rejected_issues),
      resolved_issues: this.renderResolvedIssues(pack.resolved_issues ?? []),
      accepted_issues: this.renderAcceptedIssues(pack.accepted_issues ?? []),
      round_summary: pack.round_summary || 'First round',
      round: pack.round.toString(),
      context_files: this.renderContextFiles(pack.context_files),
    });
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

    const user = this.replaceAllPlaceholders(template, {
      round: input.round.toString(),
      codex_findings_with_ids: this.renderCodexFindings(input.codexFindingsWithIds, input.hasNewFindings),
      previous_decisions: input.previousDecisions || 'First round - no previous decisions.',
      ledger_summary: input.ledgerSummary,
      current_spec: input.currentSpec,
      current_plan: input.currentPlan,
    });

    // Load system prompt template
    const system = await this.store.loadTemplate(CLAUDE_DECISION_SYSTEM_TEMPLATE);

    return { system, user };
  }

  // ── Code Review Prompts (P1b-CR-0) ──────────────────────────────

  /**
   * Render a {@link CodeReviewPack} into the final Codex code-review prompt.
   *
   * Loads the `code-review-pack.md` template and replaces placeholders.
   *
   * Implements a **context budget** to stay within the Codex CLI input limit
   * (1,048,576 chars). When the full-content render exceeds the budget:
   *   1. Changed files are downgraded to diff-hunk context (much smaller).
   *   2. If still over, the diff itself is truncated with a notice.
   */
  async renderCodeReviewPrompt(pack: CodeReviewPack): Promise<string> {
    const template = await this.store.loadTemplate(CODE_REVIEW_TEMPLATE);

    // First pass: render with full file content
    let result = this.renderCodeReviewFromTemplate(template, pack, 'full');

    // Check against budget — Codex CLI hard limit is 1,048,576 chars.
    // Use 900K as the budget to leave headroom for Codex's own system prompt.
    if (result.length > CODEX_PROMPT_BUDGET) {
      console.warn(
        `[PromptAssembler] Code-review prompt exceeds budget ` +
        `(${result.length} > ${CODEX_PROMPT_BUDGET} chars). ` +
        `Downgrading changed_files from full content to diff-hunk context.`,
      );
      result = this.renderCodeReviewFromTemplate(template, pack, 'hunks');
    }

    // Safety valve: if still over budget after hunk downgrade, truncate the diff
    if (result.length > CODEX_PROMPT_BUDGET) {
      console.warn(
        `[PromptAssembler] Code-review prompt STILL exceeds budget after hunk downgrade ` +
        `(${result.length} > ${CODEX_PROMPT_BUDGET} chars). Truncating diff.`,
      );
      const overshoot = result.length - CODEX_PROMPT_BUDGET;
      const truncatedDiff = pack.diff.substring(0, Math.max(0, pack.diff.length - overshoot - 200))
        + `\n\n... [diff truncated — ${overshoot + 200} chars removed to fit Codex input limit] ...`;
      result = this.renderCodeReviewFromTemplate(template, pack, 'hunks', truncatedDiff);
    }

    return result;
  }

  /**
   * Internal helper: render code-review template with configurable file detail level.
   *
   * Uses single-pass placeholder replacement to prevent cascade expansion
   * (the diff often contains `{{placeholder}}` strings when reviewing
   * template or assembler source code).
   *
   * @param mode - `'full'`: render full file content; `'hunks'`: render diff hunks only.
   * @param diffOverride - Optional pre-truncated diff string.
   */
  private renderCodeReviewFromTemplate(
    template: string,
    pack: CodeReviewPack,
    mode: 'full' | 'hunks',
    diffOverride?: string,
  ): string {
    return this.replaceAllPlaceholders(template, {
      diff: diffOverride ?? pack.diff,
      changed_files: mode === 'full'
        ? this.renderChangedFiles(pack.changed_files)
        : this.renderChangedFilesHunksOnly(pack.changed_files),
      unresolved_issues: this.renderUnresolvedIssues(pack.unresolved_issues),
      accepted_issues: this.renderAcceptedIssues(pack.accepted_issues),
      rejected_issues: this.renderRejectedIssues(pack.rejected_issues),
      round_summary: pack.round_summary || 'First round',
      round: pack.round.toString(),
      context_files: this.renderContextFiles(pack.context_files),
      review_scope: this.renderReviewScope(pack.review_scope),
    });
  }

  /**
   * Render a {@link ClaudeCodeReviewInput} into separated system + user prompts.
   *
   * Fresh context — no previousDecisions field.
   */
  async renderClaudeCodeReviewPrompt(input: ClaudeCodeReviewInput): Promise<ClaudePromptParts> {
    const template = await this.store.loadTemplate(CLAUDE_CODE_REVIEW_TEMPLATE);

    // P1-1: Budget control for Claude prompt — same full → hunks → truncate
    // degradation as Codex, but with a separate budget constant.
    const commonValues = {
      round: input.round.toString(),
      codex_findings_with_ids: this.renderCodeReviewFindings(input.codexFindingsWithIds, input.hasNewFindings),
      ledger_summary: input.ledgerSummary,
    };

    // First pass: full content
    let user = this.replaceAllPlaceholders(template, {
      ...commonValues,
      diff: input.diff,
      changed_files: this.renderChangedFiles(input.changed_files),
    });

    // Check budget — downgrade to hunks-only if over
    if (user.length > CLAUDE_PROMPT_BUDGET) {
      console.warn(
        `[PromptAssembler] Claude code-review prompt exceeds budget ` +
        `(${user.length} > ${CLAUDE_PROMPT_BUDGET} chars). ` +
        `Downgrading changed_files from full content to diff-hunk context.`,
      );
      user = this.replaceAllPlaceholders(template, {
        ...commonValues,
        diff: input.diff,
        changed_files: this.renderChangedFilesHunksOnly(input.changed_files),
      });
    }

    // Safety valve: truncate diff if still over budget
    if (user.length > CLAUDE_PROMPT_BUDGET) {
      console.warn(
        `[PromptAssembler] Claude code-review prompt STILL exceeds budget after hunk downgrade ` +
        `(${user.length} > ${CLAUDE_PROMPT_BUDGET} chars). Truncating diff.`,
      );
      const overshoot = user.length - CLAUDE_PROMPT_BUDGET;
      const truncatedDiff = input.diff.substring(0, Math.max(0, input.diff.length - overshoot - 200))
        + `\n\n... [diff truncated — ${overshoot + 200} chars removed to fit Claude input limit] ...`;
      user = this.replaceAllPlaceholders(template, {
        ...commonValues,
        diff: truncatedDiff,
        changed_files: this.renderChangedFilesHunksOnly(input.changed_files),
      });
    }

    // ISS-006 fix: final length check after all degradation attempts.
    // If the prompt is STILL over budget (e.g. hunks alone exceed the limit),
    // hard-truncate the user prompt to prevent Agent SDK crash.
    if (user.length > CLAUDE_PROMPT_BUDGET) {
      console.error(
        `[PromptAssembler] Claude code-review prompt STILL exceeds budget after all degradation ` +
        `(${user.length} > ${CLAUDE_PROMPT_BUDGET} chars). Hard-truncating to budget.`,
      );
      user = user.substring(0, CLAUDE_PROMPT_BUDGET - 100)
        + `\n\n... [prompt hard-truncated to fit ${CLAUDE_PROMPT_BUDGET} char budget] ...`;
    }

    // Load system prompt template
    const system = await this.store.loadTemplate(CLAUDE_CODE_REVIEW_SYSTEM_TEMPLATE);

    return { system, user };
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
    // Use a function replacer to avoid $-backreference expansion.
    // String.prototype.replace interprets $', $`, $&, $1 etc. in the
    // replacement string, which inflates prompts containing source code
    // (e.g. template literals, regex, jQuery selectors).
    return template.replace(pattern, () => value);
  }

  /**
   * Replace **all** `{{key}}` placeholders in a single pass.
   *
   * Unlike calling {@link replacePlaceholder} sequentially (which can cascade
   * — if the value for `{{diff}}` itself contains `{{changed_files}}`, the next
   * replacement will expand it), this method scans the original template once
   * and substitutes every known key from the map.  Values inserted by one
   * placeholder are never re-scanned.
   *
   * @param template - The template string with `{{key}}` placeholders.
   * @param values   - Map of placeholder name → replacement value.
   * @returns Fully rendered string.
   */
  private replaceAllPlaceholders(template: string, values: Record<string, string>): string {
    // Match any {{word}} — only replace if the key exists in the map.
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) =>
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] : `{{${key}}}`,
    );
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
   * Render changed files using **diff hunks only** (no full file content).
   *
   * Used as a fallback when the full-content render exceeds the Codex prompt
   * budget.  Each file shows its header + diff hunks instead of the entire
   * source, dramatically reducing prompt size for large reviews.
   */
  private renderChangedFilesHunksOnly(files: ChangedFile[]): string {
    if (files.length === 0) return 'No changed files.';

    return files
      .map((file) => {
        const header = `### \`${file.path}\` (${file.change_type}, +${file.stats.additions}/-${file.stats.deletions})`;
        const body = file.diff_hunks
          ? `\`\`\`diff\n${file.diff_hunks}\n\`\`\``
          : `\`\`\`${file.language}\n${file.content}\n\`\`\``; // fallback if no hunks
        return `${header}\n${body}`;
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
