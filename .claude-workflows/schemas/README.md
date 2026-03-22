# Workflow Schemas — Frozen (Documentation Only)

These JSON Schema files serve as **type documentation** for workflow artifacts.

They are **NOT** used for runtime validation — TypeScript type system provides compile-time safety.
See `workflow-engine-deep-audit.md` H-NEW-6 for the design rationale.

**Do not invest maintenance effort** in keeping these schemas in sync with code changes.
The source of truth is `src/lib/workflow/types.ts`.
