/**
 * Workflow Engine — Core Type Definitions
 *
 * All interfaces and types for the dual-model collaboration workflow engine.
 * Covers P0 protocol + P1a Spec-Review MVP + P1b Code-Review extension.
 *
 * @module workflow/types
 */

// === Severity & Status Enums (as union types) ===

/** Issue severity level, ordered from most to least impactful. */
export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** Lifecycle status of an issue in the ledger. */
export type IssueStatus = 'open' | 'accepted' | 'rejected' | 'deferred' | 'resolved';

/** Action that Claude (or a human) can take on an issue. */
export type DecisionAction = 'accept' | 'reject' | 'defer' | 'accept_and_resolve';

/** High-level assessment produced by Codex after reviewing a spec/plan. */
export type OverallAssessment = 'lgtm' | 'minor_issues' | 'major_issues';

/** Who raised an issue — the reviewing model, the orchestrator, or a human. */
export type RaisedBy = 'codex' | 'claude' | 'human';

/** Who made the decision on an issue. */
export type DecidedBy = 'claude' | 'human';

// === Workflow Step (5-state machine for crash-safe resume) ===

/**
 * Fine-grained step states for crash-safe resume.
 *
 * Step ordering per round:
 *   `codex_review` -> `issue_matching` -> `pre_termination` -> `claude_decision` -> `post_decision`
 *
 * If the process crashes mid-round, the engine can resume from `last_completed`
 * without re-running already-finished steps.
 */
export type WorkflowStep =
  | 'codex_review'
  | 'issue_matching'
  | 'pre_termination'
  | 'claude_decision'
  | 'post_decision';

// === Workflow Event Types ===

/**
 * Discriminated union of every event the workflow engine can emit.
 *
 * Events are persisted in an append-only log for observability and replay.
 */
export type WorkflowEventType =
  | 'workflow_started' | 'round_started'
  | 'codex_review_started' | 'codex_review_completed'
  | 'codex_review_timeout' | 'codex_review_retried'
  | 'codex_parse_error'
  | 'claude_decision_started' | 'claude_decision_completed'
  | 'claude_decision_timeout' | 'claude_decision_retried' | 'claude_decision_skipped'
  | 'claude_parse_error'
  | 'decision_validation_failed'
  | 'issue_created' | 'issue_status_changed'
  | 'issue_matching_completed'
  | 'spec_updated' | 'plan_updated'
  | 'patch_apply_failed' | 'patch_extraction_failed'
  | 'resolves_issues_missing'
  | 'termination_triggered' | 'human_review_requested'
  | 'workflow_completed' | 'workflow_failed' | 'workflow_resumed';

// === Workflow Type / Status ===

/** Kind of workflow being executed. */
export type WorkflowType = 'spec-review' | 'dev' | 'code-review';

/** Top-level lifecycle status of a workflow run. */
export type WorkflowStatus = 'running' | 'paused' | 'completed' | 'failed' | 'human_review';

// === Context & Pack Types ===

/** A file path + content pair passed as context to the reviewing model. */
export interface ContextFile {
  /** Relative or absolute path to the file. */
  path: string;
  /** Full text content of the file. */
  content: string;
}

/** Compact summary of a previously rejected issue, included in subsequent packs. */
export interface RejectedIssueSummary {
  /** Unique issue identifier (matches {@link Issue.id}). */
  id: string;
  /** Human-readable description of the rejected issue. */
  description: string;
  /** The round number in which this issue was rejected. */
  round_rejected: number;
}

/** Summary of a resolved issue shown to Codex for dedup purposes. */
export interface ResolvedIssueSummary {
  /** Issue identifier. */
  id: string;
  /** Brief description of the issue. */
  description: string;
  /** Round in which the issue was resolved. */
  resolved_in_round: number;
  /** Severity level. */
  severity: Severity;
}

/** Summary of an accepted issue shown to Codex for dedup purposes. */
export interface AcceptedIssueSummary {
  /** Issue identifier. */
  id: string;
  /** Brief description of the issue. */
  description: string;
  /** Round in which the issue was first raised. */
  round: number;
  /** Severity level. */
  severity: Severity;
}

/**
 * The "review pack" sent to Codex at the start of each round.
 *
 * Contains the latest spec, plan, unresolved issues, and context files
 * so the reviewer has full information to produce findings.
 */
export interface SpecReviewPack {
  /** Current spec document content. */
  spec: string;
  /** Current plan document content. */
  plan: string;
  /** Issues that remain unresolved from previous rounds. */
  unresolved_issues: Issue[];
  /** Issues that were explicitly rejected (for context, to avoid re-raising). */
  rejected_issues: RejectedIssueSummary[];
  /** Issues that have been resolved in previous rounds (for dedup context). */
  resolved_issues?: ResolvedIssueSummary[];
  /** Issues that have been accepted and are being addressed (for dedup context). */
  accepted_issues?: AcceptedIssueSummary[];
  /** Additional files provided as context for the review. */
  context_files: ContextFile[];
  /** Natural-language summary of the previous round's outcomes. */
  round_summary: string;
  /** Current round number (1-based). */
  round: number;
}

// === Issue Ledger Types ===

/**
 * The issue ledger — a persistent, append-only registry of all issues
 * discovered across all rounds of a workflow run.
 */
export interface IssueLedger {
  /** Workflow run identifier this ledger belongs to. */
  run_id: string;
  /** All issues tracked in this workflow run. */
  issues: Issue[];
}

/**
 * A single issue raised during a review round.
 *
 * Issues are immutable once created; only their {@link status},
 * {@link decided_by}, {@link decision_reason}, and {@link resolved_in_round}
 * fields are updated as decisions are made.
 */
export interface Issue {
  /** Unique issue identifier (e.g. `"ISS-001"`). */
  id: string;
  /** The round in which this issue was first raised. */
  round: number;
  /** Who raised this issue. */
  raised_by: RaisedBy;
  /** Severity assessment of the issue. */
  severity: Severity;
  /** Human-readable description of the problem. */
  description: string;
  /** Evidence or excerpt supporting the finding. */
  evidence: string;
  /** Current lifecycle status. */
  status: IssueStatus;
  /** Who decided on this issue (set when a decision is made). */
  decided_by?: DecidedBy;
  /** Rationale for the decision (set when a decision is made). */
  decision_reason?: string;
  /** The round in which this issue was marked resolved. */
  resolved_in_round?: number;
  /** Number of times this issue has been re-raised across rounds. */
  repeat_count: number;
  /** Round in which IssueMatcher last processed this issue (idempotency guard). */
  last_processed_round?: number;

  // === Code-review optional fields (P1b-CR-0) ===
  // These are undefined/omitted for spec-review workflows (backward-compatible).

  /** Source file path (written by IssueMatcher from CodeFinding.file). */
  source_file?: string;
  /** Source line range (written by IssueMatcher from CodeFinding.line_range). */
  source_line_range?: { start: number; end: number };
  /** Issue category (written by IssueMatcher from CodeFinding.category). */
  category?: CodeReviewCategory;
  /**
   * Fix instruction (written by Claude decision, only when action=accept in code-review).
   *
   * Stored separately from {@link decision_reason}:
   * - decision_reason: "why accepted" (rationale)
   * - fix_instruction: "how to fix" (actionable instruction)
   */
  fix_instruction?: string;
}

// === Codex Output Types ===

/**
 * Structured output returned by Codex after reviewing a spec/plan.
 *
 * Parsed from Codex's JSON response; validated against a JSON schema
 * before being consumed by the engine.
 */
export interface CodexReviewOutput {
  /** Individual findings from the review. */
  findings: Finding[];
  /** High-level assessment of the spec/plan quality. */
  overall_assessment: OverallAssessment;
  /** Free-text summary of the review. */
  summary: string;
}

/** A single finding produced by Codex during review. */
export interface Finding {
  /** Description of the issue found. */
  issue: string;
  /** Severity of this finding. */
  severity: Severity;
  /** Evidence or excerpt supporting this finding. */
  evidence: string;
  /** Suggested fix or improvement. */
  suggestion: string;
}

// === Claude Decision Types ===

/**
 * Structured output returned by Claude after reviewing Codex's findings
 * and making decisions on each issue.
 */
export interface ClaudeDecisionOutput {
  /** Per-issue decisions made in this round. */
  decisions: Decision[];
  /** Whether the spec document was updated in this round. */
  spec_updated: boolean;
  /** Whether the plan document was updated in this round. */
  plan_updated: boolean;
  /** Unified-diff patch to apply to the spec (present when `spec_updated` is true). */
  spec_patch?: string;
  /** Unified-diff patch to apply to the plan (present when `plan_updated` is true). */
  plan_patch?: string;
  /** Issue IDs that are resolved by the spec/plan changes in this round. */
  resolves_issues?: string[];
  /** Free-text summary of decisions and rationale. */
  summary: string;
}

/** A single decision on a specific issue. */
export interface Decision {
  /** The issue ID this decision applies to. */
  issue_id: string;
  /** The action taken on this issue. */
  action: DecisionAction;
  /** Rationale for this decision. */
  reason: string;
}

/**
 * Input payload assembled by the engine and passed to the Claude decision prompt.
 *
 * Contains all context Claude needs to make informed decisions on the
 * current round's findings.
 */
export interface ClaudeDecisionInput {
  /** Current round number (1-based). */
  round: number;
  /** Codex findings enriched with issue IDs and new/existing classification. */
  codexFindingsWithIds: Array<{
    /** Assigned issue ID for this finding. */
    issueId: string;
    /** The original Codex finding. */
    finding: Finding;
    /** Whether this is a newly raised issue (true) or a repeat from a prior round (false). */
    isNew: boolean;
  }>;
  /** Summary of the current issue ledger state. */
  ledgerSummary: string;
  /** Current spec document content. */
  currentSpec: string;
  /** Current plan document content. */
  currentPlan: string;
  /** Formatted string of decisions from prior rounds. */
  previousDecisions: string;
  /** Whether any of the findings in this round are new (convenience flag). */
  hasNewFindings: boolean;
}

// === Workflow Meta Types ===

/**
 * Runtime configuration for a workflow run.
 *
 * Merged from defaults + per-workflow overrides at creation time.
 */
export interface WorkflowConfig {
  /** Maximum number of review rounds before forced termination. */
  max_rounds: number;
  /** Whether the engine should auto-terminate when termination conditions are met. */
  auto_terminate: boolean;
  /** Whether to pause for human review when a deadlock is detected. */
  human_review_on_deadlock: boolean;
  /** Timeout in milliseconds for each Codex API call. */
  codex_timeout_ms: number;
  /** Timeout in milliseconds for each Claude API call. */
  claude_timeout_ms: number;
  /** Maximum retry attempts for a failed Codex call within a single step. */
  codex_max_retries: number;
  /** Maximum retry attempts for a failed Claude call within a single step. */
  claude_max_retries: number;
  /** Token budget for the Codex context window (used by the context compressor). */
  codex_context_window_tokens: number;
  /** Claude model identifier (e.g. 'claude-sonnet-4-20250514'). */
  claude_model: string;
  /** Maximum output tokens for Claude API calls. */
  claude_max_output_tokens: number;
  /** Codex CLI backend name (e.g. 'codex', 'gemini'). */
  codex_backend: string;
  /** Additional files to include in every review pack. */
  context_files: ContextFile[];
}

/**
 * Persistent metadata for a workflow run.
 *
 * Serialised to `<run_dir>/meta.json` and updated after every step
 * to support crash-safe resume.
 */
export interface WorkflowMeta {
  /** Unique identifier for this workflow run. */
  run_id: string;
  /** The kind of workflow being executed. */
  workflow_type: WorkflowType;
  /** Current lifecycle status of the run. */
  status: WorkflowStatus;
  /** Current round number (1-based). */
  current_round: number;
  /** Current step within the round. */
  current_step: WorkflowStep;
  /** ISO 8601 timestamp of when the run was created. */
  created_at: string;
  /** ISO 8601 timestamp of the last metadata update. */
  updated_at: string;
  /** Merged configuration for this run. */
  config: WorkflowConfig;
  /**
   * Checkpoint of the last fully completed step.
   * `null` when the workflow has just been created and no step has completed yet.
   */
  last_completed: {
    /** Round number of the last completed step. */
    round: number;
    /** The step that was completed. */
    step: WorkflowStep;
  } | null;
  /** Counters for detecting stuck/spinning workflows. */
  termination_state: {
    /** Consecutive Claude parse failures (triggers pause_for_human at 2). */
    consecutive_parse_failures: number;
    /** Consecutive rounds with zero progress (triggers pause_for_human at 2). */
    zero_progress_rounds: number;
  };
}

// === Workflow Event ===

/** A single event emitted by the workflow engine, persisted to the event log. */
export interface WorkflowEvent {
  /** ISO 8601 timestamp of when the event occurred. */
  timestamp: string;
  /** Workflow run identifier. */
  run_id: string;
  /** Round number during which the event occurred. */
  round: number;
  /** Discriminator for the event payload. */
  event_type: WorkflowEventType;
  /** Event-specific payload (shape varies by `event_type`). */
  data: Record<string, unknown>;
}

// === Termination Types ===

/** Reason why the engine decided to terminate or pause the workflow. */
export type TerminationReason =
  | 'lgtm'
  | 'no_new_high_severity'
  | 'only_style_issues'
  | 'deadlock_detected'
  | 'max_rounds_reached';

/** Action the engine takes upon termination. */
export type TerminationAction = 'terminate' | 'pause_for_human';

/** Result of the pre-termination check performed before each Claude decision step. */
export interface TerminationResult {
  /** Why termination was triggered. */
  reason: TerminationReason;
  /** Whether to fully terminate or pause for human review. */
  action: TerminationAction;
  /** Human-readable explanation of the termination decision. */
  details: string;
}

// === Context Compressor Types ===

/**
 * Data from a single round, used by the context compressor to decide
 * what to summarise vs. keep verbatim.
 */
export interface RoundData {
  /** Round number (1-based). */
  round: number;
  /** Serialised review pack JSON (may be absent for the current round). */
  packJson?: string;
  /** Raw Codex output (may be absent if Codex hasn't run yet). */
  codexOutput?: string;
  /** Raw Claude decision output (may be absent if Claude hasn't decided yet). */
  claudeDecision?: string;
}

// === IssueMatcher Result Types ===

/**
 * Result of matching Codex findings against the existing issue ledger.
 *
 * Returned by the issue matcher after comparing new findings with
 * previously known issues.
 */
export interface ProcessFindingsResult {
  /** Issues that were created as new entries in the ledger. */
  newIssues: Issue[];
  /** All findings (new and matched) enriched with issue IDs. */
  matchedIssues: Array<{
    /** Assigned issue ID. */
    issueId: string;
    /** The original Codex finding. */
    finding: Finding;
    /** Whether this is a newly created issue. */
    isNew: boolean;
  }>;
  /** Count of new issues with severity `critical` or `high`. */
  newHighCriticalCount: number;
  /** Total count of new issues created in this round. */
  newTotalCount: number;
}

// === PatchApplier Result Types ===

/**
 * Result of applying a unified-diff patch to a document.
 *
 * Supports partial application — some sections may succeed while others fail.
 */
export interface PatchResult {
  /** The merged document content after applying successful patches. */
  merged: string;
  /** Section headers or identifiers of successfully applied patch hunks. */
  appliedSections: string[];
  /** Section headers or identifiers of patch hunks that failed to apply. */
  failedSections: string[];
}

// === Configuration Defaults ===

/**
 * Default workflow configuration values.
 *
 * These are merged with per-workflow overrides at creation time.
 * All timeouts are in milliseconds.
 */
export const DEFAULT_CONFIG: WorkflowConfig = {
  max_rounds: 3,
  auto_terminate: true,
  human_review_on_deadlock: true,
  codex_timeout_ms: 5_400_000,
  claude_timeout_ms: 5_400_000,
  codex_max_retries: 2,
  claude_max_retries: 2,
  codex_context_window_tokens: 1_000_000,
  claude_model: 'claude-sonnet-4-20250514',
  claude_max_output_tokens: 64_000,
  codex_backend: 'codex',
  context_files: [],
};

/**
 * Spec-review-specific overrides layered on top of {@link DEFAULT_CONFIG}.
 *
 * The spec-review workflow allows more rounds and enables context compression
 * to stay within token budgets on longer reviews.
 */
export const SPEC_REVIEW_OVERRIDES = {
  /** Extended round limit for spec-review workflows. */
  max_rounds_extended: 5,
  /** Ratio threshold (0-1) at which context compression kicks in. */
  context_compress_threshold: 0.6,
  /** Round number at which context compression begins. */
  context_compress_round: 4,
  /** Maximum number of deferred issues before forcing a decision. */
  max_deferred_issues: 10,
} as const;

// === Custom Error Types ===

/**
 * Thrown when a model call exceeds its configured timeout and all retries
 * have been exhausted.
 */
export class TimeoutError extends Error {
  constructor(
    /** Which model timed out. */
    public readonly model: 'codex' | 'claude',
    /** Number of retries that were attempted before giving up. */
    public readonly retriesExhausted: number,
    message?: string,
  ) {
    super(message ?? `${model} timed out after ${retriesExhausted} retries`);
    this.name = 'TimeoutError';
  }
}

/**
 * Thrown when a model call is explicitly aborted (e.g. by a cancellation signal
 * or workflow shutdown).
 */
export class AbortError extends Error {
  constructor(
    /** Which model's call was aborted. */
    public readonly model: 'codex' | 'claude',
    message?: string,
  ) {
    super(message ?? `${model} call aborted`);
    this.name = 'AbortError';
  }
}

/**
 * Thrown when a model API call fails with a non-retryable client error
 * (e.g. 400 Bad Request, 401 Unauthorized, 404 Not Found, 422 Unprocessable).
 *
 * These errors indicate a configuration or authentication problem that will
 * NOT be resolved by retrying the same request.
 */
export class ModelInvocationError extends Error {
  constructor(
    /** Which model's call failed. */
    public readonly model: 'codex' | 'claude',
    /** HTTP status code (if available). */
    public readonly statusCode: number | undefined,
    /** The original error that caused this failure. */
    public readonly cause: unknown,
    message?: string,
  ) {
    super(
      message ??
        `${model} invocation failed` +
        `${statusCode ? ` (HTTP ${statusCode})` : ''}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'ModelInvocationError';
  }
}

// ═══════════════════════════════════════════════════════════════
// P1b-CR-0: Code Review Types
// ═══════════════════════════════════════════════════════════════

// === Code Review Enums ===

/** File change type (corresponds to git diff --name-status). */
export type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

/** Code review issue category. */
export type CodeReviewCategory =
  | 'bug'
  | 'security'
  | 'performance'
  | 'error_handling'
  | 'type_safety'
  | 'concurrency'
  | 'style'
  | 'architecture'
  | 'test_coverage'
  | 'documentation';

// === Code Review Pack Types ===

/**
 * The "review pack" sent to Codex for code review (blind review).
 *
 * Unlike {@link SpecReviewPack}, the review target is code diff + files
 * rather than spec + plan documents.
 */
export interface CodeReviewPack {
  /** Full git diff text. */
  diff: string;
  /** Changed files with full content (for context understanding). */
  changed_files: ChangedFile[];
  /** Review scope description. */
  review_scope: ReviewScope;
  /** Additional context files (configs, type definitions, etc.). */
  context_files: ContextFile[];
  /** Unresolved issues from previous rounds. */
  unresolved_issues: Issue[];
  /** Rejected issues (summary only, no rejection reason — avoids bias). */
  rejected_issues: RejectedIssueSummary[];
  /**
   * Accepted issues (for dedup — code-review doesn't modify code,
   * so accepted issues still exist in the codebase).
   */
  accepted_issues: AcceptedIssueSummary[];
  /** Previous round summary. */
  round_summary: string;
  /** Current round number (1-based). */
  round: number;
}

/** Details of a changed file in the review. */
export interface ChangedFile {
  /** File path (relative to project root). */
  path: string;
  /** Old path for rename/copy operations. */
  old_path?: string;
  /** File content (current version; deleted files use git show for original). */
  content: string;
  /** Diff hunks for this file. */
  diff_hunks: string;
  /** File language (inferred from extension). */
  language: string;
  /** Change statistics. */
  stats: { additions: number; deletions: number };
  /** Change type (corresponds to git diff --name-status). */
  change_type: ChangeType;
}

/** Review scope description. */
export interface ReviewScope {
  /** Scope type. */
  type: 'staged' | 'unstaged' | 'commit' | 'commit_range' | 'branch';
  /** Base ref for diff (e.g. main, HEAD~3). */
  base_ref?: string;
  /** Head ref for diff (e.g. HEAD, feature-branch). */
  head_ref?: string;
  /** File filter patterns (glob). */
  file_patterns?: string[];
  /** Exclude file patterns. */
  exclude_patterns?: string[];
  /** Whether to include sensitive files (default false). */
  include_sensitive?: boolean;
}

// === Code Finding Types ===

/**
 * A single finding produced by Codex during code review.
 *
 * Extends the base {@link Finding} with file location and category.
 */
export interface CodeFinding extends Finding {
  /** File path where the issue was found. */
  file: string;
  /** Line range for precise location (optional). */
  line_range?: { start: number; end: number };
  /** Issue category. */
  category: CodeReviewCategory;
}

/** Codex code review structured output. */
export interface CodexCodeReviewOutput {
  /** Review findings. */
  findings: CodeFinding[];
  /** Overall assessment. */
  overall_assessment: OverallAssessment;
  /** Review summary. */
  summary: string;
  /** Per-file assessments (optional, for report generation). */
  file_assessments?: FileAssessment[];
}

/** Single file assessment from Codex. */
export interface FileAssessment {
  /** File path. */
  path: string;
  /** Risk level for this file. */
  risk_level: 'high' | 'medium' | 'low' | 'clean';
  /** Short assessment note. */
  note: string;
}

// === Claude Code Review Decision Types ===

/** Claude code review decision structured output. */
export interface ClaudeCodeReviewDecision {
  /** Per-issue decisions. */
  decisions: CodeReviewDecisionItem[];
  /** Decision summary. */
  summary: string;
}

/** A single code review decision item. */
export interface CodeReviewDecisionItem {
  /** Issue ID (assigned by IssueMatcher in Step B1). */
  issue_id: string;
  /** Decision action (no accept_and_resolve — code-review doesn't auto-fix). */
  action: 'accept' | 'reject' | 'defer';
  /** Decision rationale. */
  reason: string;
  /** Fix instruction (required when action=accept). */
  fix_instruction?: string;
}

/**
 * Input payload for Claude code review decision prompt.
 *
 * Unlike {@link ClaudeDecisionInput}:
 * - No currentSpec/currentPlan (reviewing code, not documents)
 * - No previousDecisions (fresh context to avoid confirmation bias)
 * - Includes diff and changed_files instead
 */
export interface ClaudeCodeReviewInput {
  /** Current round number (1-based). */
  round: number;
  /** Codex findings enriched with issue IDs. */
  codexFindingsWithIds: Array<{
    issueId: string;
    finding: CodeFinding;
    isNew: boolean;
  }>;
  /** Ledger summary (status only, no decision reasons — fresh review). */
  ledgerSummary: string;
  /** Full git diff. */
  diff: string;
  /** Changed files with full content. */
  changed_files: ChangedFile[];
  /** Whether any findings are new. */
  hasNewFindings: boolean;
}

// === Review Snapshot Types ===

/**
 * Code review snapshot — frozen at start, all subsequent rounds read from snapshot.
 *
 * Solves:
 * 1. Staged mode: prevents reading unstaged changes via fs.readFile
 * 2. Resume mode: prevents reading user modifications after pause
 */
export interface ReviewSnapshot {
  /** Snapshot creation timestamp (ISO 8601). */
  created_at: string;
  /** Head commit SHA at snapshot time. */
  head_commit: string;
  /** Base ref used for diff (e.g. "HEAD", "main"). */
  base_ref: string;
  /** Review scope. */
  scope: ReviewScope;
  /** Frozen full git diff used for all rounds and resume. */
  diff: string;
  /** Snapshotted files with blob SHAs. */
  files: SnapshotFile[];
  /** Preloaded changed files derived from frozen blob SHAs and diff hunks. */
  changed_files: ChangedFile[];
  /** Files excluded from review (with reasons). */
  excluded_files: Array<{ path: string; reason: string }>;
}

/** A single file captured in the review snapshot. */
export interface SnapshotFile {
  /** File path (relative to repo root). */
  path: string;
  /** Old path (for rename/copy). */
  old_path?: string;
  /** Git blob SHA for content retrieval via `git show <blob_sha>`. */
  blob_sha: string;
  /** Base blob SHA (for deleted files, content from base). */
  base_blob_sha?: string;
  /** Change type. */
  change_type: ChangeType;
  /** File language (inferred from extension). */
  language: string;
}

// === Code Review Report Types ===

/** Code review final report. */
export interface CodeReviewReport {
  /** Workflow run_id. */
  run_id: string;
  /** Review scope. */
  scope: ReviewScope;
  /** Total rounds executed. */
  total_rounds: number;
  /** Statistics. */
  stats: {
    total_findings: number;
    accepted: number;
    rejected: number;
    deferred: number;
    by_severity: Record<Severity, number>;
    by_category: Partial<Record<CodeReviewCategory, number>>;
  };
  /** Per-file review results. */
  file_results: FileReviewResult[];
  /** Overall conclusion. */
  conclusion: 'clean' | 'needs_review' | 'minor_issues_only' | 'issues_found' | 'critical_issues';
  /** Report generation timestamp (ISO 8601). */
  generated_at: string;
  /** Files excluded from review. */
  excluded_files: Array<{ path: string; reason: string }>;
}

/** Single file review result in the report. */
export interface FileReviewResult {
  /** File path. */
  path: string;
  /** Issues found in this file (with decisions). */
  issues: Array<{
    id: string;
    severity: Severity;
    category: CodeReviewCategory;
    description: string;
    line_range?: { start: number; end: number };
    action: 'accept' | 'reject' | 'defer' | 'unreviewed';
    reason: string;
    fix_instruction?: string;
  }>;
}

// ═══════════════════════════════════════════════════════════════
// WorkflowProfile — Engine generalization for multiple workflow types
// ═══════════════════════════════════════════════════════════════

/**
 * Workflow profile — parameterized configuration for a workflow type.
 *
 * The engine uses the profile to drive its loop instead of hardcoding
 * step logic. Each workflow type (spec-review, code-review, dev) has
 * its own profile with distinct behavior flags.
 */
export interface WorkflowProfile {
  /** Workflow type identifier. */
  type: WorkflowType;

  /** Step sequence (engine executes in this order). */
  steps: WorkflowStep[];

  /** Config overrides (layered on top of DEFAULT_CONFIG). */
  configOverrides: Partial<WorkflowConfig>;

  /** Template name mapping. */
  templates: {
    /** Codex review prompt template filename. */
    review: string;
    /** Claude decision prompt template filename. */
    decision: string;
    /** Claude system role template filename. */
    decisionSystem: string;
  };

  /** Step behavior flags. */
  behavior: {
    /** Whether Claude receives previous_decisions (true=cumulative, false=fresh). */
    claudeIncludesPreviousDecisions: boolean;
    /** Whether to execute PatchApplier (spec-review needs it, code-review does not). */
    applyPatches: boolean;
    /** Whether to track resolves_issues (spec-review needs it, code-review does not). */
    trackResolvesIssues: boolean;
    /** Whether accept action requires fix_instruction field. */
    requireFixInstruction: boolean;
    /**
     * Whether 'accepted' status is a terminal state (does not block termination).
     *
     * - spec-review: false — accepted is intermediate, waiting for patch to resolve
     * - code-review: true  — accepted is terminal ("issue confirmed + fix suggested")
     *
     * Affects TerminationJudge: when true, 'accepted' is excluded from
     * "unresolved" calculation. LGTM terminates if no open/deferred remain.
     */
    acceptedIsTerminal: boolean;
  };
}

// === Predefined Profiles ===

/** Spec-Review profile — preserves all existing behavior. */
export const SPEC_REVIEW_PROFILE: WorkflowProfile = {
  type: 'spec-review',
  steps: ['codex_review', 'issue_matching', 'pre_termination', 'claude_decision', 'post_decision'],
  configOverrides: {},
  templates: {
    review: 'spec-review-pack.md',
    decision: 'claude-decision.md',
    decisionSystem: 'claude-decision-system.md',
  },
  behavior: {
    claudeIncludesPreviousDecisions: true,
    applyPatches: true,
    trackResolvesIssues: true,
    requireFixInstruction: false,
    acceptedIsTerminal: false,   // accepted = intermediate, waiting for resolve
  },
};

/** Code-Review profile — review-only MVP (P1b-CR-0). */
export const CODE_REVIEW_PROFILE: WorkflowProfile = {
  type: 'code-review',
  steps: ['codex_review', 'issue_matching', 'pre_termination', 'claude_decision', 'post_decision'],
  configOverrides: {
    max_rounds: 3,              // Code review typically converges in 2-3 rounds
  },
  templates: {
    review: 'code-review-pack.md',
    decision: 'code-review-decision.md',
    decisionSystem: 'code-review-decision-system.md',
  },
  behavior: {
    claudeIncludesPreviousDecisions: false,  // Fresh context — avoid confirmation bias
    applyPatches: false,                     // Review-only, no code modification
    trackResolvesIssues: false,              // No patches, no resolves_issues
    requireFixInstruction: true,             // accept requires fix suggestion
    acceptedIsTerminal: true,                // accepted = terminal (review conclusion)
  },
};

// ═══════════════════════════════════════════════════════════════
// P1b-CR-1: Review-and-Fix Types
// ═══════════════════════════════════════════════════════════════

/**
 * Result of the auto-fix process.
 *
 * Returned by {@link AutoFixer.applyFixes} after running Codex in an
 * isolated git worktree to apply fix_instructions from accepted issues.
 */
export interface FixResult {
  /** Whether all fixes were applied successfully. */
  success: boolean;
  /** Total number of accepted issues with fix_instructions. */
  totalCount: number;
  /** Number of successfully fixed issues. */
  fixedCount: number;
  /** Issue IDs that were successfully fixed. */
  fixedIssueIds: string[];
  /** Issue IDs that failed to fix. */
  failedIssueIds: string[];
  /** Error messages for failed fixes. */
  errors: string[];
  /** Path to the worktree where fixes were applied. */
  worktreePath: string;
  /** Branch name in the worktree. */
  worktreeBranch: string;
  /** Preview of the generated diff (first 5000 chars). */
  diffPreview: string;
}

/**
 * Options for the auto-fix process.
 */
export interface AutoFixOptions {
  /** Codex CLI backend name (default: 'codex'). */
  codexBackend?: string;
  /** Timeout for each Codex fix call in ms (default: 300_000 = 5 min). */
  codexTimeoutMs?: number;
  /** Maximum concurrent fix tasks (default: 1 — sequential for safety). */
  maxConcurrency?: number;
}
