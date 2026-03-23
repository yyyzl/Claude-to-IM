/**
 * Decision Validator -- validates Claude's decisions against the current ledger state.
 *
 * Performs structural and referential integrity checks on decisions before
 * they are applied to the issue ledger, catching invalid references, duplicates,
 * and unknown actions early.
 *
 * Supports both spec-review and code-review workflows via optional WorkflowProfile:
 * - spec-review: validates resolves_issues, allows accept_and_resolve
 * - code-review: validates fix_instruction on accept, skips resolves_issues (§8.1)
 *
 * @module workflow/decision-validator
 */

import type { Decision, IssueLedger, DecisionAction, WorkflowProfile } from './types.js';

/** All valid actions for spec-review (default). */
const SPEC_REVIEW_ACTIONS: DecisionAction[] = ['accept', 'reject', 'defer', 'accept_and_resolve'];

/** Valid actions for code-review (no accept_and_resolve — review-only, no auto-fix). */
const CODE_REVIEW_ACTIONS: DecisionAction[] = ['accept', 'reject', 'defer'];

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class DecisionValidator {
  /**
   * Validate Claude's decisions against the current ledger state.
   *
   * Checks (all workflows):
   * 1. All issue_ids reference known issues in the ledger
   * 2. No duplicate issue_ids in the decisions array
   * 3. All actions are valid DecisionAction values
   *
   * Conditional checks:
   * 4. resolves_issues entries reference issues with accept decisions (spec-review only)
   * 5. resolves_issues entries reference existing issue IDs (spec-review only)
   * 6. accept action requires fix_instruction (code-review only, §8.1)
   *
   * @param decisions - Claude's per-issue decisions.
   * @param resolvesIssues - Issue IDs resolved by patches (spec-review provides this).
   * @param ledger - The current issue ledger.
   * @param profile - Optional workflow profile for condition-based validation.
   *                  When omitted, defaults to spec-review behavior (backward-compatible).
   */
  validate(
    decisions: Decision[],
    resolvesIssues: string[] | undefined,
    ledger: IssueLedger,
    profile?: WorkflowProfile,
  ): ValidationResult {
    const errors: string[] = [];
    const issueIds = new Set(ledger.issues.map((i) => i.id));
    const seenDecisionIds = new Set<string>();
    const acceptedIds = new Set<string>();

    // Determine valid actions based on profile
    const validActions = profile?.behavior.requireFixInstruction
      ? CODE_REVIEW_ACTIONS
      : SPEC_REVIEW_ACTIONS;

    for (const decision of decisions) {
      // Check 1: issue_id exists in ledger
      if (!issueIds.has(decision.issue_id)) {
        errors.push(`Decision references unknown issue_id '${decision.issue_id}'`);
      }

      // Check 2: no duplicate issue_ids
      if (seenDecisionIds.has(decision.issue_id)) {
        errors.push(`Duplicate decision for issue_id '${decision.issue_id}'`);
      }
      seenDecisionIds.add(decision.issue_id);

      // Check 3: valid action
      if (!validActions.includes(decision.action)) {
        errors.push(
          `Invalid action '${decision.action}' for issue_id '${decision.issue_id}'. ` +
          `Must be one of: ${validActions.join(', ')}`,
        );
      }

      // Track accepted ids for check 4
      if (decision.action === 'accept' || decision.action === 'accept_and_resolve') {
        acceptedIds.add(decision.issue_id);
      }

      // Check 6 (code-review §8.1): accept requires fix_instruction
      if (
        profile?.behavior.requireFixInstruction &&
        decision.action === 'accept'
      ) {
        const fixInstruction = (decision as Decision & { fix_instruction?: string })
          .fix_instruction;
        if (!fixInstruction || fixInstruction.trim() === '') {
          errors.push(
            `Decision for '${decision.issue_id}' has action 'accept' but missing fix_instruction`,
          );
        }
      }
    }

    // Check 4 & 5: resolves_issues validation (spec-review only)
    // When trackResolvesIssues is false (code-review), skip entirely.
    const trackResolves = profile ? profile.behavior.trackResolvesIssues : true;
    if (trackResolves && resolvesIssues) {
      for (const id of resolvesIssues) {
        // Check 5: resolves_issues references existing issue
        if (!issueIds.has(id)) {
          errors.push(`resolves_issues references unknown issue_id '${id}'`);
        }
        // Check 4: resolves_issues only references accepted issues
        if (!acceptedIds.has(id)) {
          errors.push(
            `resolves_issues references '${id}' but it was not accepted in this round's decisions`,
          );
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
