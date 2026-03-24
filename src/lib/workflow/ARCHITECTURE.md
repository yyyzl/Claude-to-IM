# Workflow Engine Architecture

## Module Dependency Graph

```
index.ts (public API + factory functions)
├── workflow-engine.ts (5-step state machine orchestrator)
│   ├── pack-builder.ts (review pack assembly)
│   │   └── context-compressor.ts (CJK-aware token budget)
│   ├── prompt-assembler.ts (template rendering)
│   ├── model-invoker.ts (Agent SDK + Codex CLI abstraction)
│   ├── termination-judge.ts (5-condition priority termination)
│   ├── json-parser.ts (4-strategy resilient JSON extraction)
│   ├── issue-matcher.ts (finding → ledger dedup/matching)
│   ├── patch-applier.ts (heading-based document patching)
│   ├── decision-validator.ts (5-item semantic validation)
│   └── report-generator.ts (final Markdown/JSON report)
├── diff-reader.ts (git diff parsing)
├── auto-fixer.ts (review-and-fix post-processor)
├── workflow-store.ts (file system persistence + atomic writes)
├── cli.ts (CLI entry: spec-review / code-review / review-fix)
└── types.ts (all types, profiles, configs, custom errors)
```

## Architecture Overview

The Workflow Engine is **independent from the Bridge system**. Bridge handles IM message routing; Workflow handles dual-model (Claude + Codex) orchestration. They share nothing except host infrastructure.

```
┌─────────────────────────────┐      ┌──────────────────────────┐
│ Bridge (交互层)              │      │ CLI (cli.ts)             │
│ internal/workflow-command.ts │      │ npm run workflow:*       │
└──────────┬──────────────────┘      └──────────┬───────────────┘
           │ engine.start() / pause()            │
           ▼                                     ▼
┌────────────────────────────────────────────────────────────┐
│                Workflow Engine (编排层)                      │
│  WorkflowEngine (5-step state machine)                     │
│  ├── PackBuilder ← ContextCompressor                       │
│  ├── PromptAssembler (template rendering)                  │
│  ├── ModelInvoker (Agent SDK + Codex CLI)                  │
│  ├── TerminationJudge (dynamic termination)                │
│  ├── IssueMatcher + DecisionValidator                      │
│  ├── PatchApplier (document patching)                      │
│  └── ReportGenerator (final reports)                       │
└────────────────────┬───────────────────────────────────────┘
                     │ read/write
                     ▼
┌────────────────────────────────────────────────────────────┐
│              Artifact Store (持久层)                        │
│  WorkflowStore → .claude-workflows/runs/{run-id}/          │
│  ├── meta.json (checkpoint + crash-safe resume)            │
│  ├── issue-ledger.json (single source of truth)            │
│  ├── events.ndjson (append-only audit log)                 │
│  ├── spec-v{N}.md / plan-v{N}.md (versioned documents)    │
│  └── rounds/ (raw I/O per round)                           │
└────────────────────────────────────────────────────────────┘
```

## Profile-Driven Strategy

Workflow types are **not** distinguished by conditionals. Instead, `WorkflowProfile` parameterizes all behavioral differences:

```
WorkflowProfile
├── name: 'spec-review' | 'code-review'
├── pack:
│   ├── templateId (which prompt template to use)
│   ├── includeSpec / includePlan / includeDiff
│   └── includeChangedFiles
└── behavior:
    ├── applyPatches (spec-review: true, code-review: false)
    ├── generateReport (code-review: true)
    └── allowAutoFix (review-fix: true)
```

Adding a new workflow type = creating a new profile constant + prompt templates. **No engine code changes needed.**

## 5-Step State Machine (Per Round)

```
┌──────────────────┐
│  codex_review    │  Codex blind-reviews with fresh context (Pack)
└────────┬─────────┘
         ▼
┌──────────────────┐
│  issue_matching  │  IssueMatcher deduplicates findings against ledger
└────────┬─────────┘
         ▼
┌──────────────────┐
│  pre_termination │  TerminationJudge pre-checks (LGTM? max rounds?)
└────────┬─────────┘
         ▼
┌──────────────────┐
│  claude_decision │  Claude arbitrates: accept/reject/defer each issue
│  ├── C1: raw     │  (4 sub-checkpoints for crash-safe resume)
│  ├── C2: validate│
│  ├── C3: ledger  │
│  └── C4: commit  │
└────────┬─────────┘
         ▼
┌──────────────────┐
│  post_decision   │  Final termination check + round cleanup
└──────────────────┘
```

Each step persists output **before** advancing. The `meta.json` checkpoint is written **last**, so a crash replays at most one step.

**Write ordering guarantee**: raw output → ledger → spec/plan → checkpoint event → meta.

## Crash-Safe Resume

On `engine.resume(runId)`:
1. Load `meta.json` to find `last_completed` step
2. Skip already-completed steps in the current round
3. Re-execute from the next step with full context restored
4. Sub-checkpoints (C1-C4) within `claude_decision` enable fine-grained recovery

## Termination Conditions (Priority Order)

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | Codex LGTM + no unresolved issues | Terminate |
| 2 | Same issue rejected then re-raised 2+ rounds | Pause → human review |
| 3 | No new high/critical for 2 consecutive rounds | Terminate |
| 4 | All unresolved issues are low severity | Terminate |
| 5 | Max rounds reached (default: 3) | Terminate |

## Model Invocation

`ModelInvoker` abstracts two backends:

- **Claude**: Via `@anthropic-ai/claude-agent-sdk` (local, no API key). `tools: []`, `maxTurns: 1`, `persistSession: false`.
- **Codex**: Via `codeagent-wrapper` child process. 32KB chunked stdin with backpressure. 90-minute default timeout.

Both support:
- Configurable retry with `isNonRetryableError()` heuristic (auth/ENOENT/permission → immediate fail)
- AbortController propagation for graceful pause
- Detailed diagnostic logging (spawn/timeout/exit/retry/abort)

## Event System

All transitions emit typed `WorkflowEvent`s, persisted to `events.ndjson`:

- `workflow_started`, `workflow_completed`, `workflow_failed`, `workflow_resumed`
- `round_started`, `codex_review_started/completed/timeout`
- `claude_decision_started/completed`, `issue_matching_completed`
- `termination_triggered`, `human_review_requested`

Bridge's `bindProgressEvents()` subscribes to these for IM card/text updates.

## Key Design Decisions

### Hand-Wired Composition Root
Factory functions (`createSpecReviewEngine()`) manually wire all 9 dependencies. No DI framework — explicit, debuggable, zero magic.

### Issue Ledger as Single Source of Truth
All issue state lives in `issue-ledger.json`. The ledger is the only place to look for issue status — not Claude's output, not event logs.

### Pack-Based Context Transfer
Models never share chat history. Each invocation receives a structured Pack (SpecReviewPack or CodeReviewPack) built from the ledger + latest documents.

### CJK-Aware Token Estimation
`ContextCompressor` estimates tokens at 0.67 per CJK character vs 0.25 per ASCII character. Compression triggers at 60% of context window capacity.

### Atomic File Writes
`WorkflowStore` uses write-tmp → fsync → rename pattern for all critical files, preventing truncated JSON on crash.

## Relationship to Bridge

| Aspect | Bridge | Workflow |
|--------|--------|----------|
| **Purpose** | IM message routing | Dual-model orchestration |
| **DI** | `BridgeContext` (globalThis) | Hand-wired factory functions |
| **State** | In-memory + DB (via host) | File system (.claude-workflows/) |
| **Integration** | `workflow-command.ts` starts/stops engines | Emits events consumed by bridge |
| **Independence** | Can run without workflow | Can run without bridge (CLI mode) |
