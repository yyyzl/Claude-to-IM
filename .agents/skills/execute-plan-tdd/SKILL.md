---
name: execute-plan-tdd
description: "Execute the current task's plan.md slice by slice using strict red-green-refactor discipline. Reads the task PRD, technical design, and execution plan, reviews for gaps, and then implements only through failing tests first. Use after $write-task-plan and before finish-work."
---

# Execute Plan TDD

Execute the active task's `plan.md` using strict TDD.

## Goal

Turn the current task's:

- `prd.md`
- `info.md`
- `plan.md`

into working code by following the plan slice by slice without skipping red-green-refactor.

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Wrote implementation before writing the test? **Delete it. Start over with TDD.**

- Do not keep it as "reference"
- Do not "adapt" it while writing tests
- Do not look at it
- Delete means delete

Implement fresh from tests. No exceptions without user's explicit permission.

### Common Rationalizations (all wrong)

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Already manually tested" | Ad-hoc is not systematic. No record, can't re-run. |
| "Deleting X hours is wasteful" | Sunk cost fallacy. Unverified code is technical debt. |
| "Need to explore first" | Fine. Throw away exploration, start with TDD. |
| "TDD will slow me down" | TDD is faster than debugging. |
| "Test hard = skip test" | Hard to test = hard to use. Simplify the design. |

## Preconditions

Before execution starts, verify:

- there is an active task
- `.trellis/tasks/<task>/plan.md` exists
- the plan is stable enough to execute
- you are not about to implement directly on `main` / `master` unless the user explicitly approved that

If `plan.md` is missing or unclear, stop and recommend `$write-task-plan`.

## Core Rules

1. **Review before execution**
   Read the whole plan first. If the plan has blockers, contradictions, or missing paths, stop and ask or return to planning.

2. **TDD is mandatory**
   No production code before a failing test that fails for the expected reason.

3. **One slice at a time**
   Complete the current slice before moving to the next one.

4. **Do not silently expand scope**
   Follow the plan and the PRD. If you discover a necessary change outside scope, surface it explicitly.

5. **Use minimal implementation**
   Implement only enough code to pass the current failing test.

6. **Verification is part of execution**
   Do not mark a slice complete without running its focused and broader checks.

7. **No fake completion**
   If blocked, say blocked. Do not report progress as complete when red/green verification has not happened.

## Workflow

### 1. Load execution context

Read:

- `prd.md`
- `info.md` if present
- `plan.md`
- relevant spec files for the files you will touch

Summarize the slice order before changing code.

### 2. Critically review the plan

Before writing code, check:

- are file paths concrete?
- are the first slices implementable?
- do the steps reflect the PRD and design?
- are the verification commands clear?

If the answer is no, stop and recommend `$write-task-plan`.

### 3. Execute slice by slice

For each slice:

1. identify the exact behavior under test
2. write the failing test first
3. run the focused test and confirm the failure is correct
4. write the minimal implementation to pass
5. rerun focused tests until green
6. refactor only while keeping tests green
7. run broader verification for the slice
8. confirm the slice matches the plan and PRD

### 4. Red-Green-Refactor checklist

For each behavior:

- [ ] failing test written first
- [ ] failure observed for the expected reason
- [ ] minimal implementation added
- [ ] focused tests pass
- [ ] broader checks run
- [ ] no extra behavior added beyond the slice

### 5. Stop conditions

Stop and ask for help when:

- the plan is missing critical detail
- the failing test passes immediately
- the failure is caused by a typo or broken test rather than missing behavior
- a broader verification fails repeatedly
- a required dependency or environment assumption is missing
- the next slice requires changing the agreed architecture

### Checkpoint — Context Continuity

After completing each slice, **update `.fusion/` state** to persist progress:

```bash
python3 .trellis/scripts/fusion/checkpoint.py \
  --slice <completed-slice> \
  --status "<slice>.green complete" \
  --files "<files touched in this slice>" \
  --source "execute-plan-tdd" \
  --next "<next slice or action>"
```

This ensures progress survives session boundaries, compact, and platform switches.
Also run checkpoint proactively when context usage approaches ~60%.

### 6. Final wrap-up

After all slices are complete:

1. run the full test suite and read the complete output — do not claim "all pass" without fresh evidence
2. summarize what was implemented
3. list the tests and checks run
4. note any remaining risks
5. run a final `/fusion:checkpoint` to persist completion state
6. recommend `$harvest-learnings`
7. after that, recommend `$check`
8. after that, recommend `$finish-work`
9. after human testing and commit, recommend `$record-session`

### Red Flags — STOP and Start Over

- Code written before test
- Test written after implementation
- Test passes immediately (you are testing existing behavior, not new)
- Cannot explain why the test failed
- Tests added "later"
- Rationalizing "just this once"
- "Keep as reference" or "adapt existing code"

**All of these mean: delete code, start over with TDD.**

## Anti-Patterns

- reading only the first slice and not reviewing the full plan
- writing implementation before the failing test
- batching multiple slices before verification
- changing the plan ad hoc without telling the user
- skipping broader verification because focused tests passed
- treating "test added after implementation" as TDD
- claiming completion without running the full test suite

## Completion Message

Use a closing message shaped like this:

```text
Plan execution complete for <task-name>.

Completed slices:
- <slice 1>
- <slice 2>

Checks run:
- <focused tests>
- <broader checks>

Remaining risks:
- <none or short list>

Next steps:
1. Run $harvest-learnings
2. Run $check
3. Run $finish-work
4. After human testing and commit, run $record-session
```
