# Enhance Guides with Design Patterns

## Goal

Enhance the `.trellis/spec/guides/` directory by creating a new **Design Patterns Guide** that documents the architectural patterns used across both the bridge and workflow subsystems. The existing guides cover cross-layer thinking and code reuse but lack a systematic catalog of the project's design patterns.

## Context

### Current Guides

The guides directory has two well-written files:
- `cross-layer-thinking-guide.md` — boundary-aware design thinking
- `code-reuse-thinking-guide.md` — DRY principles and search-first workflow

These are excellent for *process* guidance but don't document the *structural patterns* that the codebase is built on.

### Design Patterns Found in the Codebase

Through analysis of the source code, these patterns are systematically used:

1. **Dependency Injection Container** (`context.ts`)
   - `initBridgeContext()` / `getBridgeContext()` via `globalThis`
   - All bridge modules access host services through context, never directly

2. **Abstract Factory + Registry** (`channel-adapter.ts`)
   - `BaseChannelAdapter` abstract class + `registerAdapterFactory()` + `createAdapter()`
   - Self-registration via side-effect imports in `adapters/index.ts`

3. **Strategy Pattern via Profiles** (`workflow/types.ts`)
   - `WorkflowProfile` parameterizes workflow behavior
   - `SPEC_REVIEW_PROFILE` vs `CODE_REVIEW_PROFILE` — no conditionals, pure data

4. **HMR-Safe Singleton** (`bridge-manager.ts`)
   - Uses `globalThis[GLOBAL_KEY]` to survive Next.js hot module replacement
   - Pattern: `const GLOBAL_KEY = '__bridge_manager__'`

5. **Producer-Consumer Queue** (adapters)
   - Adapters use async queue: `consumeOne()` blocks, `enqueue()` wakes
   - bridge-manager runs consume loop per adapter

6. **Layered Error Classification** (`delivery-layer.ts`)
   - `classifyError()` → `ErrorCategory` → `shouldRetry()` decision tree
   - Separates error classification from retry policy

7. **Sliding Window Rate Limiter** (`security/rate-limiter.ts`)
   - `ChatRateLimiter.acquire()` with per-chat buckets
   - Periodic cleanup to prevent memory leaks

8. **Best-Effort Side Effects** (throughout)
   - Non-critical operations wrapped in `try { ... } catch { /* best effort */ }`
   - Audit logging, dedup cleanup, outbound refs

9. **Crash-Safe State Machine** (`workflow/types.ts`)
   - 5-step state machine with checkpoints
   - `last_completed` field enables resume from any step

### Technology Stack
- TypeScript 5.x, `strict: true`, ES2022, ESM
- Node.js >= 20
- No frameworks (pure Node.js library)

## Tools Available

You have a GitNexus MCP server for architecture-level code intelligence:

| Tool | Purpose | Example |
|------|---------|---------|
| `gitnexus_query` | Find execution flows by concept | `gitnexus_query({query: "dependency injection context"})` |
| `gitnexus_context` | 360-degree symbol view | `gitnexus_context({name: "BaseChannelAdapter"})` |
| `gitnexus_impact` | Blast radius analysis | `gitnexus_impact({target: "getBridgeContext", direction: "upstream"})` |
| `gitnexus_cypher` | Direct graph queries | `gitnexus_cypher({query: "MATCH (n:Class) RETURN n.name, n.file LIMIT 30"})` |

### Recommended Workflow
1. Use GitNexus to trace each pattern's usage across the codebase
2. Read source files directly for implementation details
3. Write the guide with real code examples and file paths
4. Cross-reference with existing guides to avoid duplication

## Files to Create/Modify

### Create: `design-patterns-guide.md`

Structure each pattern with:

```markdown
## Pattern Name

**What**: One-sentence description
**Where**: File paths where this pattern is implemented
**Why**: What problem it solves in this project

### Implementation

Real code example from the codebase.

### When to Use

Concrete scenarios in this project.

### Anti-patterns

What NOT to do (with explanations specific to this project).
```

### Modify: `index.md`

Add the new design patterns guide to the reading order table and trigger conditions:

- Add row to the guide table
- Add trigger condition: "When you need to understand or extend an architectural pattern"

## Important Rules

### Spec files are NOT fixed — adapt to reality
- If you discover patterns not listed in the Context section, add them
- Group related patterns if it improves readability
- Focus on patterns that a new contributor NEEDS to understand

### Parallel agents — stay in your lane
- ONLY create/modify files under `.trellis/spec/guides/`
- Specifically: create `design-patterns-guide.md` and update `index.md`
- DO NOT modify backend specs, source code, or task files
- DO NOT run git commands
- You may read any file for analysis

## Acceptance Criteria

- [ ] `design-patterns-guide.md` has 150+ substantive lines
- [ ] At least 7 patterns documented with real code examples
- [ ] Each pattern has: What, Where, Why, Implementation, When to Use, Anti-patterns
- [ ] File paths reference actual source files
- [ ] `index.md` updated with link and trigger conditions
- [ ] No overlap with content in `cross-layer-thinking-guide.md` or `code-reuse-thinking-guide.md`
- [ ] No placeholder text remaining

## Technical Notes

- Key files for pattern analysis:
  - `src/lib/bridge/context.ts` — DI Container
  - `src/lib/bridge/channel-adapter.ts` — Abstract Factory + Registry
  - `src/lib/bridge/bridge-manager.ts` — Singleton, orchestration
  - `src/lib/bridge/delivery-layer.ts` — Error classification, retry
  - `src/lib/bridge/security/rate-limiter.ts` — Rate limiter pattern
  - `src/lib/workflow/types.ts` — Profile pattern, state machine
  - `src/lib/workflow/index.ts` — Factory functions
