Codex completed round {{round}} independent review. Decide on each finding:
accept (modify spec/plan), reject (explain why), defer, or accept_and_resolve (valid but no patch needed).

Each finding below has an assigned issue ID. Use these IDs in your decisions.

## Codex Findings (with assigned IDs)
{{codex_findings_with_ids}}

(If no findings above: Codex found no new issues. Please review and address the remaining
open/accepted issues in the ledger below. You may reject, defer, or accept_and_resolve them.)

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
