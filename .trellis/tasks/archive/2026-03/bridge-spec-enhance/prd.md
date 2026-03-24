# Enhance Bridge Backend Spec with Coding Standards

## Goal

Enhance the existing `.trellis/spec/backend/` files by incorporating detailed, project-specific coding standards extracted from `docs/coding-standards.md`. The current specs cover architecture and boundaries well, but lack **concrete coding rules** — naming conventions, import ordering, error handling patterns, async programming patterns, and security practices.

## Context

### Current State

The backend spec already has 7 well-written files:
- `index.md` — overview and reading order
- `directory-structure.md` — where files go
- `module-boundaries.md` — who does what
- `type-safety.md` — type system rules
- `integration-guidelines.md` — scripts layer rules
- `testing-guidelines.md` — test approach
- `quality-guidelines.md` — general quality rules

These focus on **architectural boundaries** but miss **day-to-day coding rules**. A developer reading them knows *where* code should go but not *how* to write it.

### What's Missing

The following topics from `docs/coding-standards.md` need to be integrated:

1. **Naming conventions** — file naming (kebab-case), identifier naming (PascalCase classes, camelCase functions, UPPER_SNAKE_CASE constants, no I-prefix on interfaces, union types instead of enums)
2. **Import rules** — `.js` suffix required, import ordering (node → third-party → internal), `import type` for type-only imports, no default exports
3. **Error handling patterns** — custom Error classes with `.name`, best-effort catches, error classification + retry, exponential backoff with jitter
4. **Async patterns** — async/await preferred, AbortController/Signal for cancellation, producer-consumer queues, timer `.unref()` management
5. **Security practices** — input validation (validators.ts), rate limiting, authorization checks
6. **Numeric literals** — underscore separators for readability (60_000 not 60000)
7. **Comment style** — file-level JSDoc, section separators (`// ── Section ──────`), public API JSDoc, bilingual comments policy

### Project Stack
- TypeScript 5.x, `strict: true`, ES2022, ESM (`"type": "module"`)
- Node.js >= 20
- `node:test` + `node:assert/strict`
- Dependencies: `@anthropic-ai/claude-agent-sdk`, `discord.js`, `markdown-it`, `ws`

## Tools Available

You have a GitNexus MCP server for architecture-level code intelligence:

| Tool | Purpose | Example |
|------|---------|---------|
| `gitnexus_query` | Find execution flows by concept | `gitnexus_query({query: "error handling retry"})` |
| `gitnexus_context` | 360-degree symbol view | `gitnexus_context({name: "ChatRateLimiter"})` |
| `gitnexus_impact` | Blast radius analysis | `gitnexus_impact({target: "deliver", direction: "upstream"})` |
| `gitnexus_cypher` | Direct graph queries | `gitnexus_cypher({query: "MATCH (n) WHERE n.name CONTAINS 'Error' RETURN n.name, n.file LIMIT 20"})` |

### Recommended Workflow
1. Read `docs/coding-standards.md` for the complete coding standards reference
2. Read each existing spec file to understand what's already documented
3. Use GitNexus to find real code examples for each pattern
4. Enhance specs by adding concrete coding rules with real examples

## Files to Modify

### `quality-guidelines.md` — Primary target for coding standards

Add these new sections (or expand existing ones):

- **Naming Conventions**: file naming, identifier naming, special conventions (unused params `_prefix`, boolean `is/has` prefix, event callbacks `on` prefix)
- **Import Rules**: ESM `.js` suffix, ordering, `import type`, no default exports
- **Comment & Documentation Style**: file-level JSDoc template, section separators format, bilingual policy
- **Numeric Literals**: underscore separators

### `type-safety.md` — Add concrete typing rules

Add:
- Union types vs interfaces decision tree
- Forbidden patterns: `any` in public API, non-null assertions without reason, `as` assertions
- `import type` usage examples
- Optional parameter placement rules

### `testing-guidelines.md` — Add mock factory pattern

Add:
- Mock factory function pattern with code example from `bridge-delivery-layer.test.ts`
- `beforeEach` context initialization pattern
- Observable fields pattern for assertions

### `module-boundaries.md` — Add adapter registration pattern

Add:
- Self-registration pattern (registerAdapterFactory + side-effect import)
- Steps for adding a new adapter (with concrete file paths)

## Important Rules

### Enhance, don't replace
- Keep ALL existing content — only ADD new sections or expand existing ones
- New sections should follow the existing document style: heading → explanation → recommended patterns → anti-patterns → real examples
- Reference real file paths and real code from the codebase

### Parallel agents — stay in your lane
- ONLY modify files under `.trellis/spec/backend/`
- DO NOT create new spec files (that's handled by the workflow-spec-fill task)
- DO NOT modify source code, guides, or task files
- DO NOT run git commands
- You may read any file for analysis

## Acceptance Criteria

- [ ] `quality-guidelines.md` has naming conventions section with examples
- [ ] `quality-guidelines.md` has import rules section with ordering example
- [ ] `quality-guidelines.md` has comment/documentation style section
- [ ] `type-safety.md` has union-vs-interface decision tree
- [ ] `type-safety.md` has forbidden patterns list with explanations
- [ ] `testing-guidelines.md` has mock factory pattern with real code example
- [ ] `module-boundaries.md` has adapter registration pattern
- [ ] All new sections use real code examples from the actual codebase
- [ ] No placeholder text remaining
- [ ] Existing content preserved intact

## Technical Notes

- Primary reference: `docs/coding-standards.md` (comprehensive standards document)
- Key source files for examples: `delivery-layer.ts`, `channel-adapter.ts`, `types.ts`, `security/validators.ts`, `security/rate-limiter.ts`
- Key test file for mock patterns: `src/__tests__/unit/bridge-delivery-layer.test.ts`
