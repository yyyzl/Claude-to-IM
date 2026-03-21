/**
 * Termination Judge — evaluates whether a workflow should stop or continue.
 *
 * Checks a prioritised list of termination conditions against the current
 * workflow state (round number, issue ledger, Codex assessment) and returns
 * a {@link TerminationResult} when any condition is met, or `null` to
 * signal that the workflow should proceed to the next Claude decision step.
 *
 * Priority order (first match wins):
 * 1. LGTM with no open/accepted issues → terminate
 * 2. LGTM with open/accepted issues   → continue (null)
 * 3. Deadlock (rejected issues with repeat_count >= 2) → pause_for_human
 * 4. No new high/critical for 2 consecutive rounds → terminate
 * 5. Only low-severity issues remaining → terminate
 * 6. Max rounds reached → terminate
 *
 * @module workflow/termination-judge
 */

import type {
  WorkflowConfig,
  IssueLedger,
  CodexReviewOutput,
  TerminationResult,
  Issue,
} from './types.js';

// ── TerminationJudge ────────────────────────────────────────────

export class TerminationJudge {
  /**
   * Evaluate termination conditions against the current workflow state.
   *
   * Returns a {@link TerminationResult} if any termination condition is met,
   * or `null` to indicate the workflow should continue to the Claude decision step.
   *
   * @param ctx.round - Current round number (1-based).
   * @param ctx.config - Workflow configuration (provides max_rounds).
   * @param ctx.ledger - The issue ledger containing all tracked issues.
   * @param ctx.latestOutput - Codex review output for the current round.
   * @param ctx.previousRoundHadNewHighCritical - Whether the previous round
   *   introduced new high/critical issues (used for consecutive-round detection).
   * @param ctx.isSkippedRound - If true, this round was skipped (e.g. Codex
   *   returned no findings). Resets the consecutive no-new-high counter.
   * @returns A termination result, or `null` to continue.
   */
  judge(ctx: {
    round: number;
    config: WorkflowConfig;
    ledger: IssueLedger;
    latestOutput: CodexReviewOutput;
    previousRoundHadNewHighCritical: boolean;
    isSkippedRound?: boolean;
    isPreTermination?: boolean;
  }): TerminationResult | null {
    const { round, config, ledger, latestOutput, previousRoundHadNewHighCritical, isSkippedRound } = ctx;

    // ── Check 1: LGTM assessment ──────────────────────────────
    // If Codex says "lgtm", check whether there are still unresolved issues.
    if (latestOutput.overall_assessment === 'lgtm') {
      const hasOpenOrAccepted = ledger.issues.some(
        (issue) => issue.status === 'open' || issue.status === 'accepted',
      );

      if (!hasOpenOrAccepted) {
        return {
          reason: 'lgtm',
          action: 'terminate',
          details:
            `Codex assessed LGTM with no open or accepted issues remaining. ` +
            `Workflow completed successfully after ${round} round(s).`,
        };
      }

      // Open/accepted issues exist — continue so Claude can address them.
      return null;
    }

    // ── Check 2: Deadlock detection ───────────────────────────
    // If any rejected issue has been re-raised 2+ times, we have a deadlock.
    const deadlockedIssues = ledger.issues.filter(
      (issue) => issue.status === 'rejected' && issue.repeat_count >= 2,
    );

    if (deadlockedIssues.length > 0) {
      const ids = deadlockedIssues.map((issue) => issue.id).join(', ');
      const action = config.human_review_on_deadlock ? 'pause_for_human' : 'terminate';
      return {
        reason: 'deadlock_detected',
        action,
        details:
          `Deadlock detected: ${deadlockedIssues.length} issue(s) have been rejected ` +
          `and re-raised 2+ times (${ids}). ` +
          (action === 'pause_for_human'
            ? 'Human review required to break the cycle.'
            : 'Terminating workflow (human_review_on_deadlock is disabled).'),
      };
    }

    // ── Check 3: No new high/critical for 2 consecutive rounds ─
    // A "skipped" round resets the consecutive counter and does NOT
    // count toward the 2-round window.
    if (isSkippedRound !== true) {
      const currentRoundHasNewHighCritical = hasNewHighCriticalInRound(ledger, round);

      if (!currentRoundHasNewHighCritical && !previousRoundHadNewHighCritical) {
        return {
          reason: 'no_new_high_severity',
          action: 'terminate',
          details:
            `No new critical or high severity issues found in the last 2 consecutive ` +
            `rounds (rounds ${round - 1} and ${round}). Remaining issues are lower priority.`,
        };
      }
    }

    // ── Check 4: Only low-severity issues remaining ───────────
    // Consider ALL unresolved statuses (open + accepted + deferred) to avoid
    // prematurely terminating when high/critical issues have been acknowledged
    // but not yet resolved (ISS-003).
    const unresolvedIssues = ledger.issues.filter(
      (issue) =>
        issue.status === 'open' ||
        issue.status === 'accepted' ||
        issue.status === 'deferred',
    );

    // Guard: never terminate if there are unresolved high/critical issues
    const unresolvedHighCritical = unresolvedIssues.filter(
      (issue) => issue.severity === 'critical' || issue.severity === 'high',
    );

    if (unresolvedHighCritical.length > 0) {
      // High/critical issues still unresolved — do NOT terminate early
      // Fall through to max_rounds check
    } else if (
      unresolvedIssues.length > 0 &&
      unresolvedIssues.every((issue) => issue.severity === 'low')
    ) {
      return {
        reason: 'only_style_issues',
        action: 'terminate',
        details:
          `All ${unresolvedIssues.length} remaining unresolved issue(s) are low severity (style/cosmetic). ` +
          `Terminating — these can be addressed separately.`,
      };
    }

    // ── Check 5: Max rounds reached ──────────────────────────
    // Only check max_rounds in post_decision (D), not pre_termination (B2).
    // This ensures the last round's Claude decision gets a chance to execute.
    if (!ctx.isPreTermination && round >= config.max_rounds) {
      return {
        reason: 'max_rounds_reached',
        action: 'terminate',
        details:
          `Maximum number of rounds (${config.max_rounds}) reached. ` +
          `Terminating with ${unresolvedIssues.length} unresolved issue(s) remaining` +
          (unresolvedHighCritical.length > 0
            ? ` (including ${unresolvedHighCritical.length} high/critical)`
            : '') +
          `.`,
      };
    }

    // ── No termination condition met — continue ───────────────
    return null;
  }
}

// ── Private helpers ──────────────────────────────────────────────

/**
 * Check whether the given round introduced any new issues with
 * critical or high severity.
 *
 * An issue is considered "new in this round" if its `round` field
 * matches the given round number.
 */
function hasNewHighCriticalInRound(ledger: IssueLedger, round: number): boolean {
  return ledger.issues.some(
    (issue: Issue) =>
      issue.round === round &&
      (issue.severity === 'critical' || issue.severity === 'high'),
  );
}
