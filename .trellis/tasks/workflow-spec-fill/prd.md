# Fill Workflow Engine Coding Spec

## Goal

Analyze the `src/lib/workflow/` module and create a complete coding specification under `.trellis/spec/backend/`, covering its architecture, patterns, type system, and testing approach. The workflow engine is a dual-model (Codex + Claude) collaboration system that is architecturally distinct from the bridge system and currently has **zero** spec coverage.

## Context

### Project Overview

Claude-to-IM is a host-agnostic bridge connecting Claude Code SDK to IM platforms (Telegram, Discord, Feishu, QQ). It has two major subsystems:

1. **Bridge system** (`src/lib/bridge/`) — already has specs in `.trellis/spec/backend/`
2. **Workflow engine** (`src/lib/workflow/`) — **no specs yet, this is what you must create**

### Workflow Engine Architecture

The workflow engine implements a multi-round review loop:

```
Round N:
  codex_review → issue_matching → pre_termination → claude_decision → post_decision
```

Key architectural concepts:

- **WorkflowProfile (Strategy Pattern)**: Parameterizes behavior differences between workflow types (spec-review, code-review). See `SPEC_REVIEW_PROFILE` and `CODE_REVIEW_PROFILE` in `types.ts`
- **5-Step State Machine**: `WorkflowStep` type defines crash-safe resume states
- **Issue Ledger**: Append-only registry tracking all issues across rounds
- **Pack Builder**: Assembles context packs for the reviewing model
- **Context Compressor**: Manages token budget by summarizing old rounds
- **Termination Judge**: Decides when to stop (lgtm, max_rounds, deadlock, etc.)
- **Decision Validator**: Validates Claude's structured JSON output
- **Patch Applier**: Applies unified-diff patches to spec/plan documents
- **Model Invoker**: Abstracts Codex CLI and Claude API calls with timeout/retry

### Key Files

| File | Purpose |
|------|---------|
| `types.ts` | All type definitions (800+ lines), profiles, configs, custom errors |
| `index.ts` | Factory functions, engine creation, public API |
| `model-invoker.ts` | Codex CLI + Claude API abstraction |
| `pack-builder.ts` | Review pack assembly |
| `context-compressor.ts` | Token budget management |
| `issue-matcher.ts` | Finding → Issue ledger matching |
| `termination-judge.ts` | Termination condition checking |
| `decision-validator.ts` | JSON schema validation |
| `patch-applier.ts` | Unified diff application |
| `prompt-assembler.ts` | Template rendering |
| `report-generator.ts` | Final report generation |
| `diff-reader.ts` | Git diff parsing |
| `json-parser.ts` | Resilient JSON extraction |
| `cli.ts` | CLI entry point |

### Technology Stack

- TypeScript 5.x, `strict: true`, ES2022, ESM
- Node.js >= 20, `node:test` for testing
- `@anthropic-ai/sdk` for Claude API calls
- Codex CLI invoked via `child_process.execFile`
- File-based persistence (JSON files in `.claude-workflows/runs/`)

## Tools Available

You have a GitNexus MCP server for architecture-level code intelligence:

| Tool | Purpose | Example |
|------|---------|---------|
| `gitnexus_query` | Find execution flows by concept | `gitnexus_query({query: "workflow termination"})` |
| `gitnexus_context` | 360-degree symbol view | `gitnexus_context({name: "WorkflowEngine"})` |
| `gitnexus_impact` | Blast radius analysis | `gitnexus_impact({target: "IssueLedger", direction: "upstream"})` |
| `gitnexus_cypher` | Direct graph queries | `gitnexus_cypher({query: "MATCH (n:Class)-[:CALLS]->(m) WHERE n.file CONTAINS 'workflow' RETURN n.name, m.name LIMIT 30"})` |

### Recommended Workflow
1. Use `gitnexus_query` to find execution flows related to workflow concepts
2. Use `gitnexus_context` to understand key symbols' callers and callees
3. Read source files directly for full implementation details
4. Write specs with real code examples and file paths

## Files to Create

Create a new file `.trellis/spec/backend/workflow-engine.md` with these sections:

### 1. Module Overview
- Purpose and scope of the workflow engine
- Relationship to the bridge system (independent, shares nothing except host infra)
- The dual-model (Codex + Claude) collaboration model

### 2. Architecture
- 5-step state machine with crash-safe resume
- WorkflowProfile strategy pattern
- File-based persistence model
- Event log (append-only observability)

### 3. Key Patterns
- **Profile-driven behavior**: How `WorkflowProfile.behavior` flags eliminate conditionals
- **Factory functions**: `createSpecReviewEngine()`, `createCodeReviewEngine()`
- **Pack assembly**: How context is prepared for each round
- **Context compression**: Token budget management across rounds
- **Issue lifecycle**: `open → accepted → resolved` or `open → rejected → (re-raised?)`

### 4. Type System
- Union types for enums (Severity, IssueStatus, DecisionAction, etc.)
- Custom error classes (TimeoutError, AbortError, ModelInvocationError)
- Discriminated union for events (WorkflowEventType)
- Configuration layering (DEFAULT_CONFIG → profile overrides → per-run overrides)

### 5. Error Handling
- Model timeout → retry with configurable limits
- Parse failure → counter + eventual pause_for_human
- Abort → clean shutdown with partial result preservation
- Non-retryable client errors → immediate failure with ModelInvocationError

### 6. Testing Approach
- `workflow-*.test.ts` naming convention
- Mock model invoker for deterministic tests
- Test state machine transitions
- Test termination conditions

### 7. Anti-patterns
- Bypassing the Profile pattern with workflow-type conditionals
- Direct file I/O instead of going through WorkflowStore
- Modifying the issue ledger without going through IssueMatcher
- Ignoring the step checkpoint (breaking crash-safe resume)

Also update `.trellis/spec/backend/index.md` to add a link to the new workflow spec file.

## Important Rules

### Spec files are NOT fixed — adapt to reality
- If the template sections above don't fit what you find in the code, adapt them
- Create additional sections for patterns you discover
- Real code examples are mandatory — no placeholder text

### Parallel agents — stay in your lane
- ONLY modify files under `.trellis/spec/backend/`
- Specifically: create `workflow-engine.md` and update `index.md`
- DO NOT modify source code, other spec directories, or task files
- DO NOT run git commands
- You may read any file for analysis

## Acceptance Criteria

- [ ] `workflow-engine.md` has 150+ substantive lines
- [ ] All sections include real code examples with file paths
- [ ] Anti-patterns documented with explanations
- [ ] Profile pattern explained with both `SPEC_REVIEW_PROFILE` and `CODE_REVIEW_PROFILE`
- [ ] State machine and crash-safe resume clearly documented
- [ ] `index.md` updated with link to workflow spec
- [ ] No placeholder text remaining

## Technical Notes

- Package path: `src/lib/workflow/`
- Language: TypeScript (strict)
- Module system: ESM with `.js` import suffixes
- Build: `tsc -p tsconfig.build.json`
- Tests: `node --test --import tsx`
