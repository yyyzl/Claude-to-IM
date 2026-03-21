Codex completed round {{round}} independent review. Decide on each finding:
accept (modify spec/plan), reject (explain why), defer, or accept_and_resolve (valid but no patch needed).

Each finding below has an assigned issue ID. Use these IDs in your decisions.

## Codex Findings (with assigned IDs)
{{codex_findings_with_ids}}

(If no findings above: Codex found no new issues. Please review and address the remaining
open/accepted issues in the ledger below. You may reject, defer, accept_and_resolve them,
or accept them with patches to resolve the underlying concerns.)

## Previous Rounds Decisions (for context continuity)
{{previous_decisions}}

## Current Issue Ledger
{{ledger_summary}}

## Current Spec (for reference when writing patches)
{{current_spec}}

## Current Plan (for reference when writing patches)
{{current_plan}}

## Output Format

Your response MUST have exactly TWO parts:

### Part 1: JSON Decision Block

A single JSON object with decisions only (NO patch content inside JSON):

```json
{
  "decisions": [
    { "issue_id": "ISS-001", "action": "accept|reject|defer|accept_and_resolve", "reason": "..." }
  ],
  "spec_updated": true,
  "plan_updated": false,
  "resolves_issues": ["ISS-001", "ISS-003"],
  "summary": "one-paragraph summary of this round's decisions"
}
```

### Part 2: Patch Content (only if spec_updated or plan_updated is true)

After the JSON block, write patches using markers:

--- SPEC PATCH ---
## 6.5 TerminationJudge
(full replacement content for this section)
--- END SPEC PATCH ---

--- PLAN PATCH ---
(full replacement content, if plan_updated)
--- END PLAN PATCH ---

## Rules

1. **Decision Budget**: Accept and patch at most 3 issues per round.
   Defer remaining valid issues to the next round. Quality over quantity.
2. When action="accept" AND you provide a patch, you MUST include "resolves_issues".
   If omitted, accepted issues will NOT be auto-resolved (safety measure).
3. Use "accept_and_resolve" for issues valid but needing no spec/plan change.
4. Patch sections must include their heading (matching original level exactly).
5. Each patch section should be MINIMAL — only the changed section, not entire chapters.
6. Keep patches under 200 lines total. If more needed, defer remaining issues.

## Fallback

If JSON output is not possible, wrap everything in markers:
--- DECISIONS ---
(your decisions in any format)
--- END DECISIONS ---
--- SPEC PATCH ---
(modified spec content)
--- END SPEC PATCH ---
