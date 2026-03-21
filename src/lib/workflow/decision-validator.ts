/**
 * Decision Validator -- validates Claude's decisions against the current ledger state.
 *
 * Performs structural and referential integrity checks on decisions before
 * they are applied to the issue ledger, catching invalid references, duplicates,
 * and unknown actions early.
 *
 * @module workflow/decision-validator
 */

import type { Decision, IssueLedger, DecisionAction } from './types.js';

const VALID_ACTIONS: DecisionAction[] = ['accept', 'reject', 'defer', 'accept_and_resolve'];

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class DecisionValidator {
  /**
   * Validate Claude's decisions against the current ledger state.
   *
   * Checks:
   * 1. All issue_ids reference known issues in the ledger
   * 2. No duplicate issue_ids in the decisions array
   * 3. All actions are valid DecisionAction values
   * 4. resolves_issues entries reference issues with accept decisions
   * 5. resolves_issues entries reference existing issue IDs
   */
  validate(
    decisions: Decision[],
    resolvesIssues: string[] | undefined,
    ledger: IssueLedger,
  ): ValidationResult {
    const errors: string[] = [];
    const issueIds = new Set(ledger.issues.map((i) => i.id));
    const seenDecisionIds = new Set<string>();
    const acceptedIds = new Set<string>();

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
      if (!VALID_ACTIONS.includes(decision.action)) {
        errors.push(
          `Invalid action '${decision.action}' for issue_id '${decision.issue_id}'. ` +
          `Must be one of: ${VALID_ACTIONS.join(', ')}`,
        );
      }

      // Track accepted ids for check 4
      if (decision.action === 'accept' || decision.action === 'accept_and_resolve') {
        acceptedIds.add(decision.issue_id);
      }
    }

    // Check 4 & 5: resolves_issues validation
    if (resolvesIssues) {
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
