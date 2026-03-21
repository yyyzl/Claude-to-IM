# Spec: Workflow Engine (Dual-Model Collaboration)

> Based on the final plan v2 (multi-robot-collaboration)
>
> Scope: P0 (protocol definition) + P1a (Spec-Review single workflow MVP)
>
> Future phases (P1b / P2 / P3) outlined at the end, not in current scope.

---

## 1. Background

### 1.1 Pain Points

The user collaborates with Claude + Codex daily. The core scenario is Spec/Plan review: Claude receives full assembled context each round (spec + plan + ledger + round history) for informed decisions, Codex uses fresh context for blind review, looping until convergence.

> **Context model clarification**: Both Claude and Codex calls are **stateless** (`Promise<string>`).
> "Claude keeps context" means the engine **assembles cumulative context into each Claude prompt**,
> not that Claude maintains a persistent session. This is the engine's responsibility, not the model's.

Currently this is fully manual:

1. Manually assembling cumulative prompts for Codex (most painful, 5-10 min/round)
2. Manually carrying Codex results to Claude
3. Manually tracking which issues were accepted/rejected
4. No persistence - history lost when context compresses

### 1.2 Goal

Build a Workflow Engine module that automates the full Spec/Plan review loop:

- Auto-build SpecReviewPack for each Codex round
- Auto-invoke Codex CLI for blind review
- Auto-feed results to Claude for decisions
- Auto-maintain Issue Ledger (decision log)
- Auto-evaluate termination conditions
- All artifacts persisted to disk, recoverable from breakpoints

### 1.3 Non-Goals (This Phase)

- Dev workflow (Manager-Worker) -- P1b
- Code review workflow (Adversarial Verification) -- P1b
- IM integration (/workflow command, Feishu cards) -- P2
- Session Orchestrator integration -- P3
- Parallel Codex instances -- P1b
- Publishable npm package (P1a is a repo-internal tool; `.claude-workflows/` templates/schemas are NOT included in `files` for npm publish)

---

## 2. User Stories

### 2.1 Core (P0 + P1a)

**US-1**: As a developer, I want to start a Spec/Plan review with one command. The system automatically loops between Claude and Codex until convergence. I only intervene at key decision points.

**US-2**: As a developer, I want every round's input, output, and decisions persisted to disk. Even if the process crashes, I can resume from the last checkpoint.

**US-3**: As a developer, I want the system to auto-terminate when appropriate (LGTM / no new issues / deadlock detected), not run a fixed N rounds.

### 2.2 Future (P1b / P2)

**US-4** (P1b): Use the same engine for dev workflow and code review workflow.

**US-5** (P2): Start review from Feishu with `/workflow spec-review`, see real-time progress, approve/reject via inline buttons.

---

## 3. Architecture

### 3.1 Module Location

```
src/lib/workflow/                    <-- Independent module, NOT inside bridge core
├── index.ts                         # Public exports + factory function
├── workflow-engine.ts               # Loop step-chain driver
├── pack-builder.ts                  # Assemble Pack from Artifact Store
├── prompt-assembler.ts              # Pack -> final prompt text
├── model-invoker.ts                 # Claude SDK / Codex CLI abstraction
├── termination-judge.ts             # Dynamic termination evaluation
├── context-compressor.ts            # Codex pack payload compression (large context)
├── workflow-store.ts                # Artifact Store read/write + event log
├── json-parser.ts                   # Best-effort JSON extraction from LLM output
├── issue-matcher.ts                 # Issue dedup / repeat detection
├── patch-applier.ts                 # Section-level spec/plan patch application
├── cli.ts                           # CLI entry point (US-1)
└── types.ts                         # Workflow type definitions
```

### 3.2 Architecture Boundaries

```
┌──────────────────────────────────────────────┐
│  Caller (Terminal CLI / future Bridge)       │
│  Only calls WorkflowEngine.start()/resume() │
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│  WorkflowEngine (orchestration layer)        │
│  ┌─────────────┐  ┌───────────────────┐      │
│  │ PackBuilder  │  │ PromptAssembler   │      │
│  └──────┬──────┘  └────────┬──────────┘      │
│  ┌──────▼──────────────────▼──────────┐      │
│  │ ModelInvoker (Claude / Codex CLI)  │      │
│  └────────────────────────────────────┘      │
│  ┌──────────────┐  ┌─────────────────┐       │
│  │ Termination  │  │ Context         │       │
│  │ Judge        │  │ Compressor      │       │
│  └──────────────┘  └─────────────────┘       │
│  ┌──────────────┐  ┌─────────────────┐       │
│  │ JsonParser   │  │ IssueMatcher    │       │
│  └──────────────┘  └─────────────────┘       │
│  ┌──────────────┐                            │
│  │ PatchApplier │                            │
│  └──────────────┘                            │
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│  WorkflowStore (persistence layer)           │
│  .claude-workflows/{run-id}/                 │
└───────────────────────────────────────────────┘
```

**Key constraints**:

- Workflow Engine does NOT depend on `src/lib/bridge/`
- Bridge does NOT depend on Workflow Engine (P2 bridges via DI or events)
- Workflow Engine calls LLM through `ModelInvoker` interface, never directly
- **ModelInvoker is an independent abstraction layer** — it does NOT reuse bridge's `LLMProvider` interface. Bridge's `LLMProvider.streamChat()` returns `ReadableStream<string>` (streaming SSE), while `ModelInvoker` returns `Promise<string>` (full completion). They are fundamentally different abstractions serving different use cases.

### 3.3 Relationship to Existing Code

| Module | Dependency | Notes |
|--------|-----------|-------|
| `bridge-manager.ts` | None | P2 adds `/workflow` command |
| `conversation-engine.ts` | None | ModelInvoker is independent stateless abstraction; does NOT reuse LLMProvider |
| `codex-passthrough.ts` | Reference only | Pack->Prompt similar to role wrapping |
| `host.ts` (BridgeStore) | None | WorkflowStore uses independent filesystem storage |

### 3.4 Prerequisites & Environment

**ModelInvoker dependencies** (must be available at runtime):

| Dependency | Purpose | Auth/Config |
|-----------|---------|-------------|
| `@anthropic-ai/sdk` | Claude API calls (stateless completions) | `ANTHROPIC_API_KEY` env var (or `CLAUDE_API_KEY`). NOT the same as `@anthropic-ai/claude-agent-sdk` used by the bridge — that SDK provides streaming SSE, while `@anthropic-ai/sdk` provides `Promise<string>` completions. |
| `codeagent-wrapper` | Codex CLI invocation | Must be on `$PATH`. Accepts `--backend codex` flag. No separate auth needed (uses its own config). |

> **Why not reuse existing bridge abstractions?**
>
> - Bridge's `LLMProvider.streamChat()` returns `ReadableStream<string>` (SSE streaming for real-time IM delivery)
> - Workflow's `ModelInvoker` returns `Promise<string>` (full completion for batch processing)
> - These are fundamentally different abstractions. Forcing one into the other would add complexity without benefit.
> - Bridge's `codex-passthrough.ts` wraps prompts for role-based dispatch; Workflow sends direct structured prompts to Codex CLI.

---

## 4. Data Structures

### 4.1 SpecReviewPack (Codex input per round)

```typescript
interface SpecReviewPack {
  spec: string;                    // Current spec full text
  plan: string;                    // Current plan full text
  unresolved_issues: Issue[];      // Only open/deferred items
  rejected_issues: RejectedIssueSummary[]; // Previously rejected (description only, no decision_reason)
  context_files: ContextFile[];    // Read-only reference files with content
  round_summary: string;           // e.g. "Round 1: +3 issues, 2 accepted, 1 rejected"
  round: number;
}

interface RejectedIssueSummary {
  id: string;                      // "ISS-001"
  description: string;             // Issue description (no decision_reason to avoid bias)
  round_rejected: number;          // Round in which it was rejected
}

interface ContextFile {
  path: string;                    // File path (for display)
  content: string;                 // File content (inlined into prompt)
}
```

> **Design note**: `issue_ledger` is intentionally excluded from SpecReviewPack.
> Codex performs "blind review" — exposing Claude's `decision_reason` would bias its judgment.
> `unresolved_issues` (open/deferred) are included for focus.
> `rejected_issues` (description only, **without** `decision_reason`) are included so Codex can
> avoid re-raising the same issues. If Codex does re-raise a rejected issue, IssueMatcher detects
> the repeat and increments `repeat_count` for deadlock detection.

### 4.2 Issue Ledger (Decision Log)

```typescript
interface IssueLedger {
  run_id: string;
  issues: Issue[];
}

interface Issue {
  id: string;                      // "ISS-001"
  round: number;                   // Round first raised
  raised_by: 'codex' | 'claude' | 'human';
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  evidence: string;                // e.g. "spec.md section 4.2"
  status: 'open' | 'accepted' | 'rejected' | 'deferred' | 'resolved';
  decided_by?: 'claude' | 'human';
  decision_reason?: string;
  resolved_in_round?: number;
  repeat_count: number;            // Times re-raised after rejection (deadlock detection)
  last_processed_round?: number;   // Last round in which this issue was created/updated by IssueMatcher (idempotency marker)
}
```

#### 4.2.1 Issue Lifecycle

```
                    ┌─────────────┐
  Codex raises  ──> │    open     │
                    └──────┬──────┘
                           │ Claude decides
              ┌────────────┼────────────┬────────────┐
              ▼            ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────────┐
        │ accepted │ │ rejected │ │ deferred │ │ accept_and_resolve │
        └────┬─────┘ └────┬─────┘ └──────────┘ └────────┬───────────┘
             │            │                              │ (immediate)
             │            │ Codex re-raises same issue   ▼
             │            └──> open (repeat_count++)  ┌──────────┐
             │                                        │ resolved │
             │ spec/plan patch applied & saved        └──────────┘
             ▼
        ┌──────────┐
        │ resolved │  (resolved_in_round = current round)
        └──────────┘
```

**Lifecycle rules**:

- `open -> accepted`: Claude agrees the issue is valid and will address it via spec/plan patch
- `open -> accept_and_resolve` (→ `resolved`): Claude agrees the issue is valid but it requires NO spec/plan change (e.g., already handled elsewhere, documentation-only, out-of-scope fix). The issue transitions directly to `resolved` in the same step, without requiring `spec_updated` or `plan_updated`.
- `accepted -> resolved`: The corresponding spec/plan update has been saved successfully in the same round. `resolved_in_round` is set to the current round number. **Resolution mapping**: `Decision.resolves_issues` explicitly lists which issue IDs are resolved by the current round's patches. Issues listed in `resolves_issues` whose status is `accepted` are transitioned to `resolved`. If `resolves_issues` is **absent**, the engine emits a `resolves_issues_missing` warning event and does **NOT** auto-resolve accepted issues. They remain `accepted` and will be re-evaluated next round. *(This prevents accidental resolution when Claude forgets to specify which issues are addressed by the patch.)*
- `open -> rejected`: Claude disagrees with rationale
- `rejected -> open`: Codex re-raises the same issue in a subsequent round. `repeat_count` increments. When `repeat_count >= 2`, triggers deadlock detection.
- `open -> deferred`: Claude defers to a later phase
- `deferred` issues remain in `unresolved_issues` and are re-sent to Codex each round (subject to `max_deferred_issues` limit; oldest deferred issues are dropped from Codex prompt when limit exceeded, but remain in ledger)
- `deferred` (re-raised by Codex): Stays `deferred`, does **NOT** increment `repeat_count`. Codex seeing a deferred issue is expected behavior, not a deadlock signal.

### 4.3 Codex Review Output

```typescript
interface CodexReviewOutput {
  findings: Finding[];
  overall_assessment: 'lgtm' | 'minor_issues' | 'major_issues';
  summary: string;
}

interface Finding {
  issue: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  evidence: string;
  suggestion: string;
}
```

### 4.4 Claude Decision Output

```typescript
interface ClaudeDecisionOutput {
  decisions: Decision[];
  spec_updated: boolean;
  plan_updated: boolean;
  spec_patch?: string;             // Modified spec sections (when spec_updated=true)
  plan_patch?: string;             // Modified plan sections (when plan_updated=true)
  resolves_issues?: string[];      // Issue IDs resolved by this round's patches (explicit mapping)
  summary: string;
}

interface Decision {
  issue_id: string;                // Must reference a known issue ID (assigned before Claude call)
  action: 'accept' | 'reject' | 'defer' | 'accept_and_resolve';
  reason: string;
}
// action semantics:
//   'accept'             — Issue is valid; spec/plan patch will address it (resolved via resolves_issues or patch)
//   'accept_and_resolve' — Issue is valid but requires NO spec/plan change (e.g., already handled,
//                          documentation-only, out-of-scope fix). Immediately transitions to 'resolved'.
//   'reject'             — Issue is invalid or not applicable
//   'defer'              — Valid but deferred to a later phase
```

> **Content delivery protocol**: When Claude accepts issues requiring spec/plan changes:
>
> 1. Set `spec_updated: true` and/or `plan_updated: true`
> 2. Include the full modified section(s) in `spec_patch` / `plan_patch`
> 3. **Must** set `resolves_issues: ["ISS-001", "ISS-003"]` to map patches to specific issues
> 4. The engine applies patches via `PatchApplier` (section-level replacement matched by heading)
>
> **Patch-Issue mapping**: Only issues listed in `resolves_issues` transition to `resolved`.
> If `resolves_issues` is **absent**, the engine emits `resolves_issues_missing` warning and
> accepted issues remain `accepted` (NOT auto-resolved). This is a safety measure.
>
> **No-patch resolution**: For issues that need no spec/plan change, use `action: 'accept_and_resolve'`
> instead of `action: 'accept'`. These issues transition directly to `resolved`.
>
> If JSON parsing fails to extract `spec_patch`/`plan_patch`, the engine falls back to
> scanning for `--- SPEC UPDATE ---` / `--- PLAN UPDATE ---` markers in the raw output.

### 4.5 Workflow Meta

```typescript
interface WorkflowMeta {
  run_id: string;
  workflow_type: 'spec-review' | 'dev' | 'code-review';
  status: 'running' | 'paused' | 'completed' | 'failed' | 'human_review';
  current_round: number;
  current_step: WorkflowStep;
  created_at: string;              // ISO 8601
  updated_at: string;
  config: WorkflowConfig;
  last_completed: {                // Checkpoint for resume
    round: number;
    step: WorkflowStep;
  } | null;
  termination_state: {             // Durable state for TerminationJudge (persisted across rounds/resumes)
    consecutive_no_new_high_rounds: number;  // Consecutive rounds with no new critical/high issues (reset on skip or new high)
    last_round_was_skipped: boolean;         // Whether last round was a timeout skip
  };
}

/**
 * Fine-grained step states for crash-safe resume.
 * Each step boundary is a safe checkpoint — the engine persists artifacts
 * BEFORE advancing current_step, so resume() can skip already-completed work.
 *
 * Step ordering per round: codex_review → issue_matching → pre_termination → claude_decision → post_decision
 */
type WorkflowStep =
  | 'codex_review'       // Step A: Codex blind review in progress
  | 'issue_matching'     // Step B1: IssueMatcher processing findings
  | 'pre_termination'    // Step B2: TerminationJudge pre-check
  | 'claude_decision'    // Step C: Claude decision in progress
  | 'post_decision';     // Step D: Post-decision termination check + round wrap-up

interface WorkflowConfig {
  max_rounds: number;              // Default 3, architecture-level changes: 5
  auto_terminate: boolean;         // Default true
  human_review_on_deadlock: boolean; // Default true, triggers when repeat_count >= 2
  codex_timeout_ms: number;        // Default 180000 (3 min; large specs may take 2-5 min)
  claude_timeout_ms: number;       // Default 120000
  codex_max_retries: number;       // Default 1 (retry once on timeout)
  claude_max_retries: number;      // Default 1
  codex_context_window_tokens: number; // Default 128000; used by ContextCompressor threshold
  max_deferred_issues: number;     // Default 10; max deferred issues sent to Codex (oldest dropped from prompt)
  context_files: ContextFile[];    // Global reference files (path + inlined content)
}
```

### 4.6 Workflow Event

```typescript
interface WorkflowEvent {
  timestamp: string;               // ISO 8601
  run_id: string;
  round: number;
  event_type: WorkflowEventType;
  data: Record<string, unknown>;
}

type WorkflowEventType =
  | 'workflow_started'    | 'round_started'
  | 'codex_review_started' | 'codex_review_completed'
  | 'codex_review_timeout' | 'codex_review_retried'
  | 'codex_parse_error'                                    // Codex output JSON parse failed
  | 'claude_decision_started' | 'claude_decision_completed'
  | 'claude_decision_timeout' | 'claude_decision_retried'
  | 'claude_parse_error'                                   // Claude output JSON parse failed
  | 'issue_created'       | 'issue_status_changed'
  | 'issue_matching_completed'                             // Step B1 finished (checkpoint marker)
  | 'claude_decisions_validated'                           // Step C2 finished (sub-checkpoint marker)
  | 'decision_validation_failed'                           // DecisionValidator found errors
  | 'spec_updated'        | 'plan_updated'
  | 'patch_apply_failed'                                   // PatchApplier heading match failed
  | 'resolves_issues_missing'                              // Claude omitted resolves_issues field
  | 'termination_triggered' | 'human_review_requested'
  | 'workflow_completed'  | 'workflow_failed' | 'workflow_resumed';
```

---

## 5. Artifact Store Directory

```
.claude-workflows/
├── templates/                     # P0 output: Prompt templates
│   ├── spec-review-pack.md
│   ├── claude-decision.md
│   └── round-summary.md
├── schemas/                       # P0 output: JSON Schemas
│   ├── issue-ledger.schema.json
│   ├── meta.schema.json
│   └── event.schema.json
└── runs/                          # Runtime output
    └── {run-id}/
        ├── meta.json
        ├── spec-v1.md / spec-v{N}.md
        ├── plan-v1.md / plan-v{N}.md
        ├── issue-ledger.json
        ├── events.ndjson
        └── rounds/
            ├── R1-pack.json
            ├── R1-codex-review.md
            ├── R1-claude-input.md
            ├── R1-claude-decision.md
            └── ...
```

---

## 6. Module Interfaces

### 6.1 WorkflowEngine

```typescript
class WorkflowEngine {
  private abortController: AbortController | null = null;

  constructor(
    store: WorkflowStore,
    packBuilder: PackBuilder,
    promptAssembler: PromptAssembler,
    modelInvoker: ModelInvoker,
    terminationJudge: TerminationJudge,
    contextCompressor: ContextCompressor,
    jsonParser: JsonParser,
    issueMatcher: IssueMatcher,
    patchApplier: PatchApplier,
    decisionValidator: DecisionValidator,
  );

  /** Start new Spec-Review workflow, returns run_id */
  async start(params: {
    spec: string; plan: string;
    config?: Partial<WorkflowConfig>;
    contextFiles?: ContextFile[];    // Pre-read files with inlined content (CLI reads files, engine receives content)
  }): Promise<string>;

  /** Resume from checkpoint */
  async resume(runId: string): Promise<void>;

  /**
   * Pause running workflow.
   * - Sets abortController.abort() to cancel in-flight ModelInvoker calls
   * - Waits for current step to reach a safe checkpoint
   * - Updates meta status to 'paused' with last_completed
   * - For Codex: kills child process via AbortSignal
   * - For Claude: cancels HTTP request via AbortSignal
   */
  async pause(runId: string): Promise<void>;

  /** Register event callback (for future IM push integration).
   *  NOTE: Must be called BEFORE start()/resume() to receive all events. */
  on(event: WorkflowEventType, cb: (e: WorkflowEvent) => void): void;
}
```

### 6.2 PackBuilder

```typescript
class PackBuilder {
  constructor(store: WorkflowStore, compressor: ContextCompressor);

  /**
   * Read from Artifact Store, assemble SpecReviewPack.
   * Internally calls ContextCompressor.compress() when payload exceeds threshold.
   * Includes rejected_issues (without decision_reason) and context_files (with inlined content).
   */
  async buildSpecReviewPack(runId: string, round: number, config: WorkflowConfig): Promise<SpecReviewPack>;

  /**
   * Assemble Claude decision input data (structured, NOT yet rendered into prompt text).
   * Returns a data object; PromptAssembler is responsible for rendering it into final prompt.
   *
   * @param matchedFindings - Findings WITH assigned issue IDs (output of IssueMatcher.processFindings).
   * @param previousDecisions - Summary of decisions from prior rounds (for context continuity).
   *
   * Division of responsibility:
   *   PackBuilder  → gathers & structures data (what goes into the prompt)
   *   PromptAssembler → renders data into final prompt text using templates (how it looks)
   */
  async buildClaudeDecisionInput(
    runId: string, round: number,
    matchedFindings: Array<{ issueId: string; finding: Finding; isNew: boolean }>,
  ): Promise<ClaudeDecisionInput>;

  /** Render IssueLedger as markdown table for Claude prompt */
  buildLedgerSummary(ledger: IssueLedger): string;

  /** Build a summary of previous rounds' decisions for Claude context continuity */
  buildPreviousDecisionsSummary(runId: string, upToRound: number): Promise<string>;
}

/** Structured input for Claude decision prompt (before template rendering) */
interface ClaudeDecisionInput {
  round: number;
  codexFindingsWithIds: Array<{ issueId: string; finding: Finding; isNew: boolean }>;
  ledgerSummary: string;          // Markdown table
  currentSpec: string;
  currentPlan: string;
  previousDecisions: string;      // Summary of prior rounds' decisions
  hasNewFindings: boolean;        // False when Codex said LGTM but open issues remain
}
```

### 6.3 PromptAssembler

```typescript
class PromptAssembler {
  constructor(store: WorkflowStore);  // For loading templates

  /** SpecReviewPack -> final Codex prompt text (simple string templates, no Handlebars) */
  async renderSpecReviewPrompt(pack: SpecReviewPack): Promise<string>;

  /**
   * ClaudeDecisionInput -> final Claude prompt text.
   * Handles two variants:
   * - Normal: findings present → standard decision prompt
   * - No findings: hasNewFindings=false → uses alternate prompt asking Claude to address open issues
   */
  async renderClaudeDecisionPrompt(input: ClaudeDecisionInput): Promise<string>;
}
```

### 6.4 ModelInvoker

```typescript
class ModelInvoker {
  /**
   * Invoke Codex CLI (codeagent-wrapper), inherently fresh context.
   * Timeout handling: retry up to config.codex_max_retries times.
   * If all retries exhausted, throw TimeoutError.
   * AbortSignal: if aborted, kill child process immediately and throw AbortError.
   */
  async invokeCodex(prompt: string, opts?: {
    timeoutMs: number;
    maxRetries?: number;
    model?: string;
    signal?: AbortSignal;          // For graceful pause support
  }): Promise<string>;

  /**
   * Invoke Claude for decision-making.
   * This is a **stateless** abstraction -- does NOT reuse bridge LLMProvider.
   * Each call is independent; context continuity is achieved by including
   * full assembled context (spec + plan + ledger + round history) in the prompt.
   * Implementation: direct @anthropic-ai/sdk call, returns full completion string.
   * Timeout handling: retry up to config.claude_max_retries times.
   * If all retries exhausted, throw TimeoutError.
   * AbortSignal: if aborted, cancel HTTP request and throw AbortError.
   */
  async invokeClaude(prompt: string, opts?: {
    timeoutMs: number;
    maxRetries?: number;
    model?: string;
    signal?: AbortSignal;          // For graceful pause support
  }): Promise<string>;
}
```

### 6.5 TerminationJudge

```typescript
class TerminationJudge {
  /**
   * Returns termination result with action; null means continue.
   * Priority order: LGTM (no open) > Deadlock > No new high > Only low > Max rounds
   *
   * IMPORTANT: This method must be called AFTER IssueMatcher has processed
   * the current round's findings, so that `ledger` is up-to-date.
   * The engine handles the "LGTM with open issues" guard separately (see §7.1 Step B2).
   *
   * The judge computes high/critical new-issue counts directly from the ledger
   * (filtering by `round === currentRound` and `severity in ['critical','high']`),
   * rather than relying on a pre-computed number. This eliminates the ambiguity
   * between "total new issues" and "high/critical new issues".
   */
  judge(ctx: {
    round: number;
    config: WorkflowConfig;
    ledger: IssueLedger;
    latestOutput: CodexReviewOutput;
    terminationState: {             // Durable state from WorkflowMeta.termination_state (persisted across rounds/resumes)
      consecutive_no_new_high_rounds: number;
      last_round_was_skipped: boolean;
    };
    isSkippedRound?: boolean;       // True if this round was skipped (timeout). Skipped rounds reset
                                    // consecutive_no_new_high_rounds to 0.
  }): { result: TerminationResult | null; updatedState: typeof ctx.terminationState };
}

interface TerminationResult {
  reason: 'lgtm' | 'no_new_high_severity' | 'only_style_issues'
        | 'deadlock_detected' | 'max_rounds_reached';
  action: 'terminate' | 'pause_for_human';
  details: string;
}
```

> **Reason -> Action mapping**:
>
> | Reason | Action | How computed |
> |--------|--------|-------|
> | `lgtm` | `terminate` | `overall_assessment = 'lgtm'` AND no unresolved issues (open \| accepted \| deferred) in ledger |
> | `no_new_high_severity` | `terminate` | Judge scans ledger for issues with `round === currentRound` AND `severity in ['critical','high']`; if count = 0, increments `terminationState.consecutive_no_new_high_rounds`; if count > 0, resets to 0. When `consecutive_no_new_high_rounds >= 2` → terminate. Skipped rounds (`isSkippedRound`) reset to 0. State is persisted to `WorkflowMeta.termination_state`. |
> | `only_style_issues` | `terminate` | All **unresolved** issues (open \| accepted \| deferred) have `severity <= low` |
> | `deadlock_detected` | `pause_for_human` | Any rejected issue with `repeat_count >= 2` |
> | `max_rounds_reached` | `terminate` | `round >= config.max_rounds` |
>
> **LGTM with open issues**: When `overall_assessment = 'lgtm'` but ledger has unresolved issues (open/accepted/deferred),
> `judge()` returns `null` (continue). The engine proceeds to Claude to address remaining issues.

### 6.6 ContextCompressor

```typescript
class ContextCompressor {
  /**
   * Purpose: Compress the SpecReviewPack payload for Codex when it grows too large.
   * Called INTERNALLY by PackBuilder during buildSpecReviewPack(), NOT by WorkflowEngine directly.
   * PackBuilder passes `config.codex_context_window_tokens` to determine the threshold.
   *
   * Trigger: estimated tokens > 60% of `config.codex_context_window_tokens`
   *          OR round >= 4
   * Token estimation: chars / 4 (rough approximation).
   * Strategy: keep latest spec/plan + ledger summary (open+accepted only)
   *           + last round full content; drop middle rounds
   *
   * NOTE: Claude context is managed differently — the PromptAssembler always
   * includes full context in each Claude prompt (stateless calls).
   * If Claude prompt also grows too large, a separate compression strategy
   * should be added to PromptAssembler (future enhancement).
   *
   * Interface design: Input and output are both structured `SpecReviewPack` fields,
   * NOT raw text. This ensures compatibility with the Pack→Prompt pipeline.
   * PackBuilder constructs a draft SpecReviewPack, passes it through compress()
   * which returns a trimmed version of the same structure.
   */
  compress(ctx: {
    pack: SpecReviewPack;          // Draft pack assembled by PackBuilder (before compression)
    rounds: RoundData[];           // Historical round data for drop-middle-rounds strategy
    windowTokens: number;          // From config.codex_context_window_tokens
  }): {
    pack: SpecReviewPack;          // Compressed pack (same structure, truncated round_summary/issues)
    estimatedTokens: number;
    droppedRounds: number[];
  };
}
```

### 6.7 WorkflowStore

```typescript
class WorkflowStore {
  constructor(basePath?: string);   // default: .claude-workflows/

  // Run lifecycle
  async createRun(meta: WorkflowMeta): Promise<void>;
  async getMeta(runId: string): Promise<WorkflowMeta | null>;  // null if run not found
  async updateMeta(runId: string, updates: Partial<WorkflowMeta>): Promise<void>;

  // Spec / Plan (versioned, auto-incrementing)
  // Version management: store internally tracks latest version by scanning files.
  // Naming: spec-v1.md, spec-v2.md, spec-v3.md (consistent v-prefix for all versions)
  // saveSpec() without version auto-increments from latest.
  // loadSpec() without version returns the latest version.
  // loadSpec(version=1) returns spec-v1.md, loadSpec(version=2) returns spec-v2.md, etc.
  async saveSpec(runId: string, content: string, version?: number): Promise<number>; // returns assigned version
  async loadSpec(runId: string, version?: number): Promise<string | null>;  // null if not found
  async savePlan(runId: string, content: string, version?: number): Promise<number>;
  async loadPlan(runId: string, version?: number): Promise<string | null>;  // null if not found

  // Issue Ledger
  async saveLedger(runId: string, ledger: IssueLedger): Promise<void>;
  async loadLedger(runId: string): Promise<IssueLedger | null>;  // null if not found (first run)

  // Round artifacts
  async saveRoundArtifact(runId: string, round: number, name: string, content: string): Promise<void>;
  async loadRoundArtifact(runId: string, round: number, name: string): Promise<string | null>;  // null if not found (resume check)

  // Events (ndjson append)
  async appendEvent(event: WorkflowEvent): Promise<void>;
  async loadEvents(runId: string): Promise<WorkflowEvent[]>;  // empty array if no events file

  // Templates
  async loadTemplate(name: string): Promise<string>;  // throws if template not found (critical)
}

/**
 * Atomic Write Protocol (for crash-safe persistence):
 *
 * All critical file writes (meta.json, issue-ledger.json, spec-v{N}.md, plan-v{N}.md)
 * MUST use the following atomic write sequence:
 *   1. Write to a temporary file (e.g., `meta.json.tmp`) in the same directory
 *   2. Call fsync on the file descriptor to ensure data is flushed to disk
 *   3. Rename (atomic on POSIX) the temporary file to the target path
 *
 * This prevents truncated/corrupt files from partial writes on crash.
 * Events (ndjson append) are append-only and tolerate partial last lines —
 * on load, the reader MUST skip malformed trailing lines gracefully.
 *
 * Implementation: use a shared `atomicWriteFile(path, content)` helper
 * that encapsulates steps 1-3. WorkflowStore uses this for all critical writes.
 */
```

### 6.8 JsonParser

```typescript
class JsonParser {
  /**
   * Best-effort JSON extraction from LLM output.
   * Strategy (in order):
   * 1. Direct JSON.parse() on trimmed output
   * 2. Strip markdown code fences and retry
   * 3. Regex extraction of first { ... } or [ ... ] block
   * 4. Return null on failure (caller saves raw output + marks parse_error)
   */
  parse<T>(raw: string): T | null;

  /**
   * Extract spec/plan patches from Claude output.
   * Strategy (in order):
   * 1. Read spec_patch/plan_patch from parsed JSON
   * 2. Fallback: scan for --- SPEC UPDATE --- / --- PLAN UPDATE --- markers
   * 3. Return null if neither found
   */
  extractPatches(raw: string, parsed: ClaudeDecisionOutput | null): {
    specPatch: string | null;
    planPatch: string | null;
  };
}

/**
 * Claude Parse Failure Safety Protocol:
 *
 * When `jsonParser.parse()` returns null for Claude output (no valid JSON):
 *   1. Save raw output to R{N}-claude-raw.md (never lose data)
 *   2. Emit `claude_parse_error` event
 *   3. Attempt `extractPatches()` for marker-based fallback
 *   4. **CRITICAL**: If `decisions[]` cannot be extracted:
 *      - Do NOT apply any patches (even if marker-based patches exist)
 *      - Do NOT update IssueLedger status
 *      - Transition workflow to `status: 'human_review'` with reason 'claude_parse_failure'
 *      - Log: "Cannot safely apply patches without validated decisions"
 *   5. If `decisions[]` CAN be extracted (e.g., from partial JSON):
 *      - Validate via DecisionValidator before any side effects
 *      - Only then proceed with normal flow
 *
 * Rationale: Applying patches without knowing which issues they address
 * would corrupt the ledger ↔ document consistency. Better to pause for
 * human intervention than to silently corrupt state.
 */
```

### 6.9 IssueMatcher

```typescript
class IssueMatcher {
  /**
   * Match a single Codex Finding against existing Issues in the ledger.
   * Used for repeat_count increment and deadlock detection.
   *
   * Strategy (in order):
   * 1. Exact match: normalized description equality (lowercase, trim, collapse whitespace)
   * 2. Evidence match: same evidence reference + similar severity (within 1 level)
   * 3. No match: return null (caller creates new Issue)
   *
   * Returns matched Issue or null (new issue).
   */
  match(finding: Finding, existingIssues: Issue[]): Issue | null;

  /**
   * Batch process all Codex findings for a round.
   * For each finding: calls match(), then either creates a new Issue or updates the matched one.
   *
   * Dedup logic:
   * - matched + status=rejected: reopen (status→open), repeat_count++
   * - matched + status=deferred: keep deferred, do NOT increment repeat_count
   * - matched + status=open/accepted: skip (already tracked)
   * - no match: create new Issue (status=open, repeat_count=0)
   *
   * Idempotency mechanism:
   * - Each created/updated issue gets `last_processed_round = round`
   * - On re-run (crash resume), if an issue already has `last_processed_round === round`,
   *   skip the create/update entirely (prevents duplicate repeat_count++, duplicate reopen, etc.)
   * - This is more robust than just checking "if issue exists for this round",
   *   because it also guards reopen/repeat_count operations on matched issues.
   *
   * Returns structured result for engine consumption.
   */
  processFindings(findings: Finding[], ledger: IssueLedger, round: number): {
    newIssues: Issue[];            // Newly created issues
    matchedIssues: Array<{ issueId: string; finding: Finding; isNew: boolean }>;
                                   // All findings with assigned issue IDs (for Claude prompt)
    newHighCriticalCount: number;  // New issues with severity critical/high (for TerminationJudge)
    newTotalCount: number;         // Total new issues created
  };
}
```

### 6.10 PatchApplier

```typescript
class PatchApplier {
  /**
   * Apply spec/plan patch via section-level replacement.
   *
   * Algorithm:
   * 1. Parse both current document and patch into sections by ANY heading level (# through ####)
   * 2. For each section in patch, find matching heading in current document
   * 3. Replace the matched section's content (up to the NEXT heading of same or higher level)
   * 4. If no heading match found, append patch section at end + emit 'patch_apply_failed' event
   *
   * Multi-level heading support:
   * - Headings are matched at their exact level: `### Foo` only matches `### Foo`, not `## Foo`
   * - When replacing a section, content extends to the next heading of SAME or HIGHER level
   *   (e.g., replacing `### 4.2` replaces content up to the next `###`, `##`, or `#`)
   * - This allows Claude to patch a specific subsection without affecting siblings
   *
   * Matching rules:
   * - Exact heading match: same level + same text (case-sensitive, trimmed)
   * - Heading rename is NOT supported in P1a (YAGNI — Claude should use the existing heading text)
   *
   * Returns the merged document and a list of applied/failed sections.
   */
  apply(currentDoc: string, patch: string): {
    merged: string;
    appliedSections: string[];     // Headings successfully replaced
    failedSections: string[];      // Headings not found in current doc
  };
}
```

> **Patch-Resolve Consistency Rule**:
>
> When `PatchApplier.apply()` returns `failedSections.length > 0`:
> - Issues listed in `resolves_issues` that correspond to the failed patch sections
>   MUST NOT be transitioned to `resolved`. They remain `accepted`.
> - The engine emits a `patch_apply_failed` event for each failed section.
> - Only issues whose patches were **fully and successfully applied** may be resolved.
> - If ALL patch sections failed, the workflow transitions to `human_review`.

### 6.11 DecisionValidator

```typescript
class DecisionValidator {
  /**
   * Validate Claude's decision output before any side effects (ledger/patch/spec/plan).
   *
   * Checks:
   * 1. All `issue_id` values reference known issues in the ledger
   * 2. No duplicate `issue_id` in decisions array
   * 3. Every current-round finding has a corresponding decision (coverage check)
   * 4. `resolves_issues` entries (if present) only reference issues with action=accept
   *    (cannot resolve a rejected/deferred issue)
   * 5. `resolves_issues` entries reference existing, valid issue IDs
   *
   * On validation failure:
   * - Return detailed error list (which checks failed, with specifics)
   * - Engine MUST NOT apply any side effects
   * - Workflow transitions to `human_review` with validation error details
   *
   * On success: return validated decisions (same data, type-narrowed)
   */
  validate(
    decisions: Decision[],
    resolves_issues: string[] | undefined,
    ledger: IssueLedger,
    currentRoundFindings: Array<{ issueId: string; finding: Finding }>,
  ): { valid: true; decisions: Decision[] }
     | { valid: false; errors: string[] };
}
```

---

## 7. Spec-Review Flow (Detailed)

### 7.1 Full Loop

```
start(spec, plan, config)
  |-- store.createRun(meta)           // meta.current_step = 'codex_review'
  |-- store.saveSpec / savePlan       // spec-v1.md, plan-v1.md
  |-- store.saveLedger(empty)
  v
=== Round Loop =============================================
|                                                          |
|  Step A: Codex blind review                              |
|  |-- meta.current_step = 'codex_review'                  |
|  |-- packBuilder.buildSpecReviewPack(runId, round, config)|  <-- ContextCompressor called INSIDE PackBuilder
|  |-- promptAssembler.renderSpecReviewPrompt(pack)        |
|  |-- store.saveRoundArtifact(R{N}-pack.json)             |
|  |-- modelInvoker.invokeCodex(prompt, {signal})          |
|  |     |-- on timeout: retry once                        |
|  |     |-- on 2nd timeout: appendEvent(codex_timeout),   |
|  |     |   skip to TIMEOUT GUARD below                   |
|  |     |-- on abort (pause): save checkpoint, break      |
|  |-- jsonParser.parse -> CodexReviewOutput               |
|  |     |-- on parse failure: appendEvent(codex_parse_error), |
|  |     |   save raw output, use best-effort partial      |
|  |-- store.saveRoundArtifact(R{N}-codex-review.md)       |  <-- Persist raw output FIRST (crash-safe)
|  |-- appendEvent(codex_review_completed)                 |
|  |-- updateMeta(current_step='issue_matching')           |  <-- Checkpoint: Codex done
|                                                          |
|  Step B1: Issue matching                                 |
|  |-- meta.current_step = 'issue_matching'                |
|  |-- issueMatcher.processFindings(findings, ledger, round)|
|  |     |-- matched + status=rejected: reopen, repeat_count++ |
|  |     |-- matched + status=deferred: keep deferred, no increment |
|  |     |-- matched + status=open/accepted: skip          |
|  |     |-- no match: create new Issue (status=open)      |
|  |-- store.saveLedger(updated)                           |  <-- Persist ledger with new issues
|  |-- appendEvent(issue_matching_completed)               |
|  |-- updateMeta(current_step='pre_termination')          |  <-- Checkpoint: B1 done (prevents double-matching on resume)
|                                                          |
|  Step B2: Pre-termination check                          |
|  |  PURPOSE: Detect early termination BEFORE Claude call |
|  |  (saves a Claude API call when convergence reached)   |
|  |-- meta.current_step = 'pre_termination'               |
|  |-- terminationJudge.judge({...})                       |
|  |-- if LGTM AND ledger has no open/accepted -> terminate|
|  |-- if LGTM BUT open/accepted exist -> proceed to C    |
|  |-- if action='pause_for_human' -> pause, break         |
|  |-- if no_new_high for 2 consecutive -> terminate       |
|                                                          |
|  Step C: Claude decision (with sub-checkpoints for idempotent resume) |
|  |-- meta.current_step = 'claude_decision'               |
|  |                                                       |
|  |  Sub-step C1: Invoke Claude                           |
|  |-- packBuilder.buildClaudeDecisionInput(...)           |  <-- Includes issue IDs from B1 + previous_decisions
|  |-- promptAssembler.renderClaudeDecisionPrompt(input)   |  <-- Handles empty-findings variant
|  |-- modelInvoker.invokeClaude(prompt, {signal})         |
|  |     |-- on timeout: retry once                        |
|  |     |-- on 2nd timeout: appendEvent(claude_timeout),  |
|  |     |   skip to TIMEOUT GUARD below                   |
|  |     |-- on abort (pause): save checkpoint, break      |
|  |-- store.saveRoundArtifact(R{N}-claude-raw.md)         |  <-- Persist raw output FIRST (sub-checkpoint: raw_saved)
|  |                                                       |
|  |  Sub-step C2: Parse + Validate                        |
|  |-- jsonParser.parse -> ClaudeDecisionOutput            |
|  |     |-- on parse failure:                             |
|  |     |   appendEvent(claude_parse_error)               |
|  |     |   IF decisions[] unrecoverable:                 |
|  |     |     → prohibit all side effects                 |
|  |     |     → transition to human_review                |
|  |     |     → break (do NOT proceed to C3/C4)           |
|  |-- decisionValidator.validate(decisions, resolves_issues, ledger, findings) |
|  |     |-- on validation failure:                        |
|  |     |   → emit decision_validation_failed event       |
|  |     |   → transition to human_review with error details |
|  |     |   → break (do NOT proceed to C3/C4)             |
|  |-- appendEvent(claude_decisions_validated)             |  <-- Sub-checkpoint: decisions_validated
|  |                                                       |
|  |  Sub-step C3: Apply decisions + patches               |
|  |-- update IssueLedger from validated decisions:        |
|  |     |-- action=accept: status=accepted                |
|  |     |-- action=accept_and_resolve: status=resolved    |
|  |     |-- action=reject: status=rejected                |
|  |     |-- action=defer: status=deferred                 |
|  |-- jsonParser.extractPatches -> spec/plan patches      |
|  |-- if spec_updated:                                    |
|  |     |-- patchApplier.apply(currentSpec, specPatch)    |
|  |     |-- store.saveSpec(v{N+1})                        |
|  |-- if plan_updated:                                    |
|  |     |-- patchApplier.apply(currentPlan, planPatch)    |
|  |     |-- store.savePlan(v{N+1})                        |
|  |-- resolve issues (with patch-resolve consistency):    |
|  |     |-- collect failedSections from spec+plan patches |
|  |     |-- if resolves_issues present:                   |
|  |     |     → for each issue_id in resolves_issues:     |
|  |     |       if related patch sections ALL succeeded → mark resolved |
|  |     |       if related patch sections had failures → keep accepted, emit warning |
|  |     |-- if resolves_issues ABSENT → emit 'resolves_issues_missing' warning, |
|  |     |     accepted issues stay accepted (NOT auto-resolved) |
|  |-- store.saveLedger                                    |  <-- Sub-checkpoint: ledger_updated
|  |                                                       |
|  |  Sub-step C4: Commit                                  |
|  |-- store.saveRoundArtifact(R{N}-claude-decision.md)    |
|  |-- appendEvent(claude_decision_completed)              |
|  |-- updateMeta(current_step='post_decision')            |  <-- Checkpoint: Claude done
|                                                          |
|  Step D: Post-termination check                          |
|  |  PURPOSE: Detect termination AFTER Claude decisions   |
|  |  (catches deadlock from Claude rejections, max rounds)|
|  |-- meta.current_step = 'post_decision'                 |
|  |-- terminationJudge.judge({...})                       |
|  |-- if action='terminate' -> break                      |
|  |-- if action='pause_for_human' -> status=human_review  |
|  |                                                       |
|  round++                                                 |
|                                                          |
|  TIMEOUT GUARD (on skip-round):                          |
|  |-- round++                                             |
|  |-- if round > config.max_rounds -> terminate           |
|  |-- else continue to next round (isSkippedRound=true)   |
============================================================
  v
workflow_completed / workflow_failed
```

### 7.2 Termination Priority

| Priority | Condition | Action | Checked in | Notes |
|----------|-----------|--------|------------|-------|
| 1 | Codex `overall_assessment = 'lgtm'` AND no unresolved issues (open/accepted/deferred) in ledger | `terminate`, skip Claude | B2 | |
| 2 | Codex `overall_assessment = 'lgtm'` BUT unresolved issues (open \| accepted \| deferred) exist | Continue to Claude (do NOT skip) | B2 | `judge()` returns null |
| 3 | Any issue with `repeat_count >= 2` and `status = rejected` | `pause_for_human` (deadlock) | B2, D | |
| 4 | No new high/critical issues for 2 consecutive rounds (judge computes from ledger, not a pre-computed count) | `terminate` | B2, D | Skipped rounds (`isSkippedRound`) reset the consecutive counter |
| 5 | All unresolved issues (open \| accepted \| deferred) have `severity <= low` | `terminate` | B2, D | |
| 6 | `round >= config.max_rounds` | `terminate` (force) | B2, D, TIMEOUT GUARD | |

> **B2 vs D division of responsibility**:
> - **B2** (pre-Claude): Primarily catches LGTM convergence and no-new-high to skip the Claude call.
>   Also catches deadlock and max_rounds early.
> - **D** (post-Claude): Catches conditions that emerge from Claude's decisions — e.g., Claude rejects
>   an issue, making it eligible for deadlock detection in future rounds. Also serves as the final
>   max_rounds gate after Claude processing.
>
> **Skip-round termination**: When a round is skipped due to timeout, the TIMEOUT GUARD
> checks `round > config.max_rounds` directly, bypassing TerminationJudge. This prevents
> infinite skip loops when Codex/Claude are persistently unreachable. Skipped rounds are passed
> to the next judge() call as `isSkippedRound=true`, resetting the "2 consecutive" counter.

### 7.3 Checkpoint Resume

When `status = paused/failed/human_review`, calling `resume(runId)`:

1. Read `meta.json` for `current_step` and `last_completed` checkpoint
2. Determine resume point from `current_step`:
   - `codex_review`: Codex call may or may not have completed. Check if `R{N}-codex-review.md` exists:
     - If exists → reuse saved output, skip to `issue_matching`
     - If not → re-invoke Codex
   - `issue_matching`: Codex output exists but IssueMatcher may not have finished. Check if `issue_matching_completed` event exists in events.ndjson:
     - If exists → ledger is up-to-date, skip to `pre_termination`
     - If not → re-run IssueMatcher (idempotent: processFindings re-derives from raw findings + current ledger)
   - `pre_termination`: B1 done, skip to B2 check
   - `claude_decision`: Resume uses sub-checkpoint events to determine precise re-entry:
     - Check if `R{N}-claude-raw.md` exists:
       - If not → re-invoke Claude (sub-step C1)
     - Check if `claude_decisions_validated` event exists for this round:
       - If not → reuse raw output, re-parse and re-validate (sub-step C2; idempotent)
     - Check if ledger has been updated for this round (via `last_processed_round` on decisions):
       - If not → reuse validated decisions, apply to ledger + patches (sub-step C3)
     - If all above exist → skip to C4 (commit)
   - `post_decision`: Claude done, skip to D check
3. Reload `issue-ledger.json` and latest spec/plan version

> **Idempotency guarantee for IssueMatcher**:
> `processFindings()` must be **idempotent** — re-running it with the same raw findings and current
> ledger state must produce the same result. This is achieved by checking if an issue already exists
> in the ledger for the current round before creating/updating it. If `issue_matching_completed`
> event is missing but ledger has been partially updated, re-running processFindings will detect
> existing issues and skip them.

> **Write ordering for crash safety**:
> Within each step, persist artifacts in this order to minimize inconsistency on crash:
> 1. Save raw LLM output (round artifact) — always first, never lose data
> 2. Update issue-ledger.json
> 3. Save spec/plan new version (if updated)
> 4. Append checkpoint event (e.g., `issue_matching_completed`, `claude_decisions_validated`)
> 5. Update meta.json (`current_step`) — always last, serves as commit marker
>
> **Atomic write protocol**: All critical writes (meta.json, issue-ledger.json, spec/plan versions)
> use the atomic write helper: write-tmp → fsync → rename. See §6.7 for details.
> Events (ndjson) are append-only; malformed trailing lines are skipped on load.

---

## 8. Prompt Templates

### 8.1 Codex Blind Review (spec-review-pack.md)

Template placeholders: `{{spec}}`, `{{plan}}`, `{{unresolved_issues}}`, `{{rejected_issues}}`, `{{round_summary}}`, `{{round}}`, `{{context_files}}`

```
You are an independent technical reviewer. Review the following Spec and Plan rigorously.

Your responsibilities:
- Find logic gaps, missing edge cases, inconsistencies
- Assess technical feasibility
- Check spec-plan consistency
- Focus on unresolved issues; do NOT re-raise issues listed in "Previously Rejected"
  unless you have strong new evidence

Output format (strict JSON):
{ "findings": [{ "issue": "description", "severity": "critical|high|medium|low",
                  "evidence": "section reference", "suggestion": "proposed fix" }],
  "overall_assessment": "lgtm|minor_issues|major_issues",
  "summary": "one-paragraph summary" }

IMPORTANT: severity must be one of: critical, high, medium, low (exactly these values).

## Current Spec
{{spec}}

## Current Plan
{{plan}}

## Unresolved Issues (focus here)
{{unresolved_issues}}

## Previously Rejected (do not re-raise without new evidence)
{{rejected_issues}}

## Previous Rounds Summary
{{round_summary}}

## Current Round
{{round}}

## Reference Files
{{context_files}}
```

### 8.2 Claude Decision (claude-decision.md)

Template placeholders: `{{round}}`, `{{codex_findings_with_ids}}`, `{{ledger_summary}}`, `{{current_spec}}`, `{{current_plan}}`, `{{previous_decisions}}`

> **Note**: `{{codex_findings_with_ids}}` includes issue IDs assigned by IssueMatcher in Step B1.
> Claude uses these IDs in its `decisions` array. `{{ledger_summary}}` is generated by
> PackBuilder from the current IssueLedger (format: table of issue ID, description, status, severity).
> `{{previous_decisions}}` is a summary of prior rounds' Claude decisions, generated by
> PackBuilder.buildPreviousDecisionsSummary() for context continuity.

```
Codex completed round {{round}} independent review. Decide on each finding:
accept (modify spec/plan), reject (explain why), defer, or accept_and_resolve (valid but no patch needed).

Each finding below has an assigned issue ID. Use these IDs in your decisions.

## Codex Findings (with assigned IDs)
{{codex_findings_with_ids}}

(If no findings above: Codex found no new issues. Please review and address the remaining
unresolved issues (open/accepted/deferred) in the ledger below. You may accept (with spec/plan
patches and resolves_issues), reject, defer, or accept_and_resolve them.)

## Previous Rounds Decisions (for context continuity)
{{previous_decisions}}

## Current Issue Ledger
{{ledger_summary}}

## Current Spec (for reference when writing patches)
{{current_spec}}

## Current Plan (for reference when writing patches)
{{current_plan}}

Output format (strict JSON):
{ "decisions": [{ "issue_id": "ISS-001", "action": "accept|reject|defer|accept_and_resolve", "reason": "..." }],
  "spec_updated": true/false, "plan_updated": true/false,
  "spec_patch": "...(full modified section with heading, only if spec_updated)...",
  "plan_patch": "...(full modified section with heading, only if plan_updated)...",
  "resolves_issues": ["ISS-001", "ISS-003"],
  "summary": "..." }

IMPORTANT:
- When action="accept" AND you provide a patch, you MUST include "resolves_issues" listing the issue IDs
  your patch addresses. If omitted, accepted issues will NOT be auto-resolved (safety measure).
- Use "accept_and_resolve" for issues that are valid but require no spec/plan change.
- Patch sections must include their heading (e.g., "## 4.2 Issue Lifecycle" or "### 6.5 TerminationJudge").
  The heading level must match the original document exactly.

If JSON output is not possible, wrap modified sections in markers:
--- SPEC UPDATE ---
(modified spec content)
--- END SPEC UPDATE ---
--- PLAN UPDATE ---
(modified plan content)
--- END PLAN UPDATE ---
```

---

## 9. Configuration Defaults

```typescript
const DEFAULT_CONFIG: WorkflowConfig = {
  max_rounds: 3,
  auto_terminate: true,             // When true, workflow auto-terminates on convergence conditions
  human_review_on_deadlock: true,   // When true, deadlock (repeat_count >= 2) transitions to human_review instead of terminate
  codex_timeout_ms: 180_000,             // 3 min (large specs may take 2-5 min)
  claude_timeout_ms: 120_000,
  codex_max_retries: 1,
  claude_max_retries: 1,
  codex_context_window_tokens: 128_000,  // Codex model context window (for compression threshold)
  max_deferred_issues: 10,               // Max deferred issues sent to Codex prompt (oldest dropped; all remain in ledger)
  context_files: [],
};

/** Extended overrides for architecture-level reviews (user applies manually) */
const SPEC_REVIEW_OVERRIDES = {
  max_rounds_extended: 5,          // Override max_rounds for architecture-level changes
  context_compress_threshold: 0.6, // Codex window percentage (used by ContextCompressor)
  context_compress_round: 4,       // Trigger round for compression
};
```

---

## 10. Error Handling

| Scenario | Handling | Event Type |
|----------|---------|------------|
| Codex CLI timeout | Retry once -> still timeout: log event, skip round via TIMEOUT GUARD (`isSkippedRound=true`) | `codex_review_timeout` |
| Claude timeout | Retry once -> still timeout: log event, skip round via TIMEOUT GUARD (`isSkippedRound=true`) | `claude_decision_timeout` |
| Codex invalid JSON output | `JsonParser.parse()` best-effort; fallback: save raw + log event | `codex_parse_error` |
| Claude invalid JSON output | `JsonParser.parse()` returns null → save raw + log event. **If `decisions[]` unrecoverable: prohibit patch/ledger changes, transition to `human_review`**. If `decisions[]` partially recovered: validate via `DecisionValidator` then proceed. | `claude_parse_error` |
| Patch apply heading mismatch | `PatchApplier` appends unmatched section, logs failed headings | `patch_apply_failed` |
| Claude omits `resolves_issues` | Emit warning, accepted issues stay accepted (NOT auto-resolved) | `resolves_issues_missing` |
| Filesystem write failure | Throw, `status=failed`, resumable | `workflow_failed` |
| Missing files on resume | Check `current_step` + partially-saved artifacts, reuse if valid; else restart from current step | `workflow_resumed` |
| Crash between B1 and B2 | Resume detects `current_step='issue_matching'`, checks `issue_matching_completed` event; re-runs processFindings (idempotent) if needed | `workflow_resumed` |
| SIGINT / pause during LLM call | AbortController.abort() -> ModelInvoker throws AbortError -> engine saves checkpoint | (no event; meta updated) |
| Skip-round exceeds max_rounds | TIMEOUT GUARD checks `round > max_rounds`, terminates directly | `termination_triggered` |

---

## 11. Future Phases

### P1b: Dev + Code Review Workflows

**Dev (Manager-Worker)**:

- New `TaskPack` / `DeliveryPack` types
- `workspace_strategy` isolation (branch / worktree / file ownership)
- `PackBuilder.buildTaskPack()` / `buildDeliveryInput()`
- `workflow_type: 'dev'`

**Code Review (Adversarial)**:

- 5-step loop: Codex review -> Claude decide -> Codex fix -> Codex re-review -> terminate
- All steps `fresh_with_pack` (including Claude)
- New `ReviewPack` with `code_snapshot` / `diff`
- `workflow_type: 'code-review'`

### P2: IM Integration

- `/workflow` command in `bridge-manager.ts` switch statement
- `WorkflowEngine.on()` events drive IM message push
- Feishu cards + inline buttons (reuse existing card action mechanism)
- Push only key milestones, aggregate intelligently

### P3: Session Orchestrator Integration

- Pack JSON -> SO `RunPack` `observation_pack` extension
- Issue Ledger -> SO `work_items` structured upgrade
- `events.ndjson` directly compatible
- `meta.json` -> SO `snapshot.json` superset

---

## 12. Acceptance Criteria

### P0

- [ ] Templates exist: `spec-review-pack.md`, `claude-decision.md` in `.claude-workflows/templates/`
- [ ] Schemas exist: `issue-ledger.schema.json`, `meta.schema.json`, `event.schema.json` in `.claude-workflows/schemas/`
- [ ] Template placeholders cover all SpecReviewPack fields (`spec`, `plan`, `unresolved_issues`, `rejected_issues`, `round_summary`, `round`, `context_files`)
- [ ] Claude decision template includes `{{previous_decisions}}` placeholder and empty-findings guidance
- [ ] Event schema includes `codex_parse_error`, `claude_parse_error`, `patch_apply_failed`, `resolves_issues_missing`, `issue_matching_completed`, `claude_decisions_validated`, `decision_validation_failed` event types
- [ ] Meta schema includes all 5 `WorkflowStep` values for `current_step`
- [ ] Meta schema includes `termination_state` object with `consecutive_no_new_high_rounds` and `last_round_was_skipped`
- [ ] `.gitignore` updated: `.claude-workflows/runs/` ignored, `templates/` and `schemas/` tracked

### P1a

- [ ] CLI entry point accepts spec+plan paths (via npm script or bin)
- [ ] `WorkflowEngine.start()` accepts spec+plan + `ContextFile[]`, runs full loop
- [ ] Each round auto-invokes Codex CLI, parses structured output via `JsonParser`
- [ ] Each round auto-invokes Claude, parses decision output including `spec_patch`/`plan_patch`
- [ ] `IssueMatcher.processFindings()` runs BEFORE TerminationJudge (Step B1 before B2)
- [ ] Claude receives findings with assigned issue IDs (from IssueMatcher)
- [ ] Claude receives `previous_decisions` for context continuity across rounds
- [ ] Claude receives alternate prompt when no new findings but open issues exist
- [ ] Issue Ledger correctly maintained (create, status change, repeat_count increment via `IssueMatcher`)
- [ ] Issue lifecycle: `accepted` -> `resolved` transition works with explicit `resolves_issues` mapping
- [ ] Issue lifecycle: `accept_and_resolve` -> `resolved` works (no patch required)
- [ ] Missing `resolves_issues` emits warning, does NOT auto-resolve accepted issues
- [ ] Deferred issues re-raised by Codex stay deferred (no repeat_count increment)
- [ ] Deferred issues subject to `max_deferred_issues` limit in Codex prompt
- [ ] All termination conditions work (LGTM with unresolved-issue guard / no new high/critical / deadlock / only-low / max rounds)
- [ ] TerminationJudge computes high/critical count from ledger (not from pre-computed number)
- [ ] TerminationJudge uses durable `termination_state` from WorkflowMeta (not transient params)
- [ ] `only_style_issues` checks ALL unresolved issues (open | accepted | deferred), not just open
- [ ] Skipped rounds reset `consecutive_no_new_high_rounds` to 0 via `isSkippedRound` flag
- [ ] `TerminationResult.action` correctly maps to terminate vs pause_for_human
- [ ] TIMEOUT GUARD: skip-round checks max_rounds directly (no infinite skip loop)
- [ ] Timeout handling: retry once -> skip round (both Codex and Claude)
- [ ] Graceful pause: `pause()` cancels in-flight LLM calls via AbortSignal
- [ ] `PatchApplier` correctly applies section-level replacements by ANY heading level (# through ####)
- [ ] `PatchApplier` replaces content up to next heading of same or higher level
- [ ] All artifacts persisted (meta / spec / plan / ledger / rounds / events)
- [ ] `current_step` updated at each step boundary (5 states: codex_review → issue_matching → pre_termination → claude_decision → post_decision)
- [ ] Checkpoint resume: uses `current_step` + artifact checks for precise re-entry
- [ ] `IssueMatcher.processFindings()` is idempotent on re-run (via `last_processed_round` guard)
- [ ] `DecisionValidator` validates all decisions before any side effects
- [ ] `DecisionValidator` rejects unknown/duplicate issue_ids, missing coverage, invalid resolves_issues targets
- [ ] Claude parse failure with unrecoverable `decisions[]` → `human_review`, no side effects
- [ ] Patch-resolve consistency: `failedSections` prevents affected issues from being resolved
- [ ] Step C sub-checkpoints enable precise resume at C1/C2/C3/C4 boundaries
- [ ] Write ordering for crash safety: raw output → ledger → spec/plan → checkpoint event → meta (last)
- [ ] Critical files use atomic write protocol (write-tmp → fsync → rename)
- [ ] Events ndjson reader skips malformed trailing lines gracefully
- [ ] File versioning uses consistent naming: spec-v1.md, spec-v2.md, spec-v3.md
- [ ] WorkflowStore returns `null` for missing files (not throw)
- [ ] Unit tests cover all `TerminationJudge` branches (including high/critical filtering from ledger, isSkippedRound)
- [ ] Unit tests cover `IssueMatcher` exact/evidence/no-match/deferred-re-raise/idempotency paths
- [ ] Unit tests cover `JsonParser` all 4 strategies + `extractPatches`
- [ ] Unit tests cover `PatchApplier` multi-level heading matching + heading mismatch + patch-resolve consistency
- [ ] Unit tests cover `DecisionValidator` all 5 validation checks + error cases
- [ ] Integration test: full 2-3 round spec-review loop (mock ModelInvoker OK)
- [ ] `package.json`: `@anthropic-ai/sdk` added as dependency
- [ ] `package.json`: test script pattern includes `workflow-*.test.ts`
- [ ] `package.json`: exports use correct format: `"./workflow/*"` (not `"./src/lib/workflow/*"`)
