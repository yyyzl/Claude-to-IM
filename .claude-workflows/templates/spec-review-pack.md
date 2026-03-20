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
