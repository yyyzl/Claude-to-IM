/**
 * Workflow Engine — Core Type Definitions
 *
 * All interfaces and types for the dual-model collaboration workflow engine.
 * Covers P0 protocol + P1a Spec-Review MVP.
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
  | 'claude_decision_timeout' | 'claude_decision_retried'
  | 'claude_parse_error'
  | 'issue_created' | 'issue_status_changed'
  | 'issue_matching_completed'
  | 'spec_updated' | 'plan_updated'
  | 'patch_apply_failed'
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
