/**
 * Unit tests for TerminationJudge — evaluates whether a workflow should
 * stop or continue based on review state.
 *
 * Covers all six priority-ordered termination conditions:
 * 1. LGTM with no open/accepted issues → terminate (lgtm)
 * 2. LGTM with open/accepted issues   → null (continue)
 * 3. Deadlock (rejected + repeat_count >= 2) → pause_for_human
 * 4. No new high/critical for 2 consecutive rounds → terminate
 * 5. Only low-severity issues remaining → terminate
 * 6. Max rounds reached → terminate
 *
 * Plus edge cases for skipped rounds, first-round behaviour, and
 * new high-severity issues preventing termination.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TerminationJudge } from '../../lib/workflow/termination-judge.js';
import type {
  WorkflowConfig,
  IssueLedger,
  Issue,
  CodexReviewOutput,
  TerminationResult,
} from '../../lib/workflow/types.js';
import { DEFAULT_CONFIG } from '../../lib/workflow/types.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Return a fresh copy of DEFAULT_CONFIG. */
function createDefaultConfig(): WorkflowConfig {
  return { ...DEFAULT_CONFIG };
}

/** Build an IssueLedger from a list of issues. */
function createLedger(issues: Issue[] = []): IssueLedger {
  return { run_id: 'test-run', issues };
}

/** Build an Issue with sensible defaults, overridable per field. */
function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? 'ISS-001',
    round: overrides.round ?? 1,
    raised_by: overrides.raised_by ?? 'codex',
    severity: overrides.severity ?? 'high',
    description: overrides.description ?? 'Test issue description',
    evidence: overrides.evidence ?? 'Test evidence',
    status: overrides.status ?? 'open',
    repeat_count: overrides.repeat_count ?? 0,
    ...overrides,
  };
}

/** Build a CodexReviewOutput with sensible defaults, overridable. */
function createCodexOutput(overrides: Partial<CodexReviewOutput> = {}): CodexReviewOutput {
  return {
    findings: overrides.findings ?? [],
    overall_assessment: overrides.overall_assessment ?? 'minor_issues',
    summary: overrides.summary ?? 'Test summary',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('TerminationJudge', () => {
  const judge = new TerminationJudge();

  // ── 1. LGTM + no open/accepted issues → terminate (lgtm) ─────

  describe('Check 1: LGTM assessment', () => {
    it('terminates with reason "lgtm" when LGTM and no open/accepted issues', () => {
      const result = judge.judge({
        round: 2,
        config: createDefaultConfig(),
        ledger: createLedger([
          createIssue({ id: 'ISS-001', status: 'resolved' }),
          createIssue({ id: 'ISS-002', status: 'deferred' }),
        ]),
        latestOutput: createCodexOutput({ overall_assessment: 'lgtm' }),
        previousRoundHadNewHighCritical: false,
      });

      assert.ok(result, 'Expected a TerminationResult, got null');
      assert.equal(result.reason, 'lgtm');
      assert.equal(result.action, 'terminate');
      assert.ok(result.details.includes('LGTM'));
      assert.ok(result.details.includes('2 round(s)'));
    });

    // ── 2. LGTM with open issues → null (continue to Claude) ───

    it('returns null when LGTM but open issues remain', () => {
      const result = judge.judge({
        round: 2,
        config: createDefaultConfig(),
        ledger: createLedger([
          createIssue({ id: 'ISS-001', status: 'open', severity: 'high' }),
        ]),
        latestOutput: createCodexOutput({ overall_assessment: 'lgtm' }),
        previousRoundHadNewHighCritical: false,
      });

      assert.equal(result, null);
    });

    // ── 3. LGTM with accepted (unresolved) issues → null ────────

    it('returns null when LGTM but accepted issues remain', () => {
      const result = judge.judge({
        round: 2,
        config: createDefaultConfig(),
        ledger: createLedger([
          createIssue({ id: 'ISS-001', status: 'accepted', severity: 'medium' }),
        ]),
        latestOutput: createCodexOutput({ overall_assessment: 'lgtm' }),
        previousRoundHadNewHighCritical: false,
      });

      assert.equal(result, null);
    });
  });

  // ── 4. Deadlock detected → pause_for_human ────────────────────

  describe('Check 2: Deadlock detection', () => {
    it('pauses for human when rejected issue has repeat_count >= 2', () => {
      const result = judge.judge({
        round: 3,
        config: createDefaultConfig(),
        ledger: createLedger([
          createIssue({
            id: 'ISS-001',
            status: 'rejected',
            repeat_count: 2,
            severity: 'high',
          }),
        ]),
        latestOutput: createCodexOutput({ overall_assessment: 'major_issues' }),
        previousRoundHadNewHighCritical: true,
      });

      assert.ok(result, 'Expected a TerminationResult, got null');
      assert.equal(result.reason, 'deadlock_detected');
      assert.equal(result.action, 'pause_for_human');
      assert.ok(result.details.includes('ISS-001'));
      assert.ok(result.details.includes('Deadlock'));
    });
  });

  // ── 5–7. No new high/critical for 2 consecutive rounds ───────

  describe('Check 3: No new high/critical for 2 consecutive rounds', () => {
    it('terminates when no new high/critical in 2 consecutive rounds', () => {
      // Round 3: no new high/critical issues in round 3,
      // previousRoundHadNewHighCritical = false (round 2 also had none).
      const result = judge.judge({
        round: 3,
        config: createDefaultConfig(),
        ledger: createLedger([
          // Issues exist but were raised in earlier rounds and are low severity
          createIssue({ id: 'ISS-001', round: 1, severity: 'low', status: 'open' }),
        ]),
        latestOutput: createCodexOutput({ overall_assessment: 'minor_issues' }),
        previousRoundHadNewHighCritical: false,
      });

      assert.ok(result, 'Expected a TerminationResult, got null');
      assert.equal(result.reason, 'no_new_high_severity');
      assert.equal(result.action, 'terminate');
      assert.ok(result.details.includes('2 consecutive'));
    });

    // ── 6. Only 1 round with no new high/critical → null ────────

    it('returns null when only current round has no new high/critical (previous did)', () => {
      const config = createDefaultConfig();
      config.max_rounds = 5;

      const result = judge.judge({
        round: 2,
        config,
        ledger: createLedger([
          // Medium severity — prevents Check 4 (only_style_issues) from firing
          createIssue({ id: 'ISS-001', round: 2, severity: 'medium', status: 'open' }),
        ]),
        latestOutput: createCodexOutput({ overall_assessment: 'minor_issues' }),
        previousRoundHadNewHighCritical: true,
      });

      // Only 1 round clean — need 2 consecutive → continue
      assert.equal(result, null);
    });

    // ── 7. Skipped round resets consecutive counter → null ───────

    it('returns null when round is skipped (resets consecutive counter)', () => {
      const config = createDefaultConfig();
      config.max_rounds = 5;

      const result = judge.judge({
        round: 3,
        config,
        ledger: createLedger([
          // Medium severity open issue prevents "only low severity" termination
          createIssue({ id: 'ISS-001', round: 1, severity: 'medium', status: 'open' }),
        ]),
        latestOutput: createCodexOutput({ overall_assessment: 'minor_issues' }),
        previousRoundHadNewHighCritical: false,
        isSkippedRound: true,
      });

      // Skipped round bypasses Check 3 (consecutive no-high).
      // Check 4 doesn't trigger (medium issue exists).
      // Check 5 doesn't trigger (round 3 < 5).
      // → should return null.
      assert.equal(result, null);
    });
  });

  // ── 8. Only low severity issues remain → terminate ────────────

  describe('Check 4: Only low-severity issues remaining', () => {
    it('terminates when all remaining open issues are low severity', () => {
      const config = createDefaultConfig();
      config.max_rounds = 5;

      const result = judge.judge({
        round: 2,
        config,
        ledger: createLedger([
          createIssue({ id: 'ISS-001', round: 1, severity: 'low', status: 'open' }),
          createIssue({ id: 'ISS-002', round: 2, severity: 'low', status: 'open' }),
          // Resolved issues should not count
          createIssue({ id: 'ISS-003', round: 1, severity: 'high', status: 'resolved' }),
        ]),
        latestOutput: createCodexOutput({ overall_assessment: 'minor_issues' }),
        // Need to ensure Check 3 doesn't fire first.
        // Round 2 has no high/critical issues (only low).
        // previousRoundHadNewHighCritical = true means Check 3 won't fire.
        previousRoundHadNewHighCritical: true,
      });

      assert.ok(result, 'Expected a TerminationResult, got null');
      assert.equal(result.reason, 'only_style_issues');
      assert.equal(result.action, 'terminate');
      assert.ok(result.details.includes('2 remaining open issue(s)'));
      assert.ok(result.details.includes('low severity'));
    });
  });

  // ── 9. Max rounds reached → terminate ─────────────────────────

  describe('Check 5: Max rounds reached', () => {
    it('terminates when current round equals max_rounds', () => {
      const config = createDefaultConfig();
      // max_rounds defaults to 3
      assert.equal(config.max_rounds, 3);

      const result = judge.judge({
        round: 3,
        config,
        ledger: createLedger([
          // Medium severity open issue to prevent "only low severity" termination
          createIssue({ id: 'ISS-001', round: 3, severity: 'medium', status: 'open' }),
        ]),
        latestOutput: createCodexOutput({ overall_assessment: 'minor_issues' }),
        // A new high/critical issue exists in round 3 to prevent Check 3
        previousRoundHadNewHighCritical: true,
      });

      assert.ok(result, 'Expected a TerminationResult, got null');
      assert.equal(result.reason, 'max_rounds_reached');
      assert.equal(result.action, 'terminate');
      assert.ok(result.details.includes('Maximum'));
      assert.ok(result.details.includes('3'));
    });
  });

  // ── 10. Continue when new high-severity issue exists ──────────

  describe('Continue conditions', () => {
    it('returns null when ledger has new high-severity issue in current round', () => {
      const config = createDefaultConfig();
      config.max_rounds = 5;

      const result = judge.judge({
        round: 2,
        config,
        ledger: createLedger([
          // New high-severity issue in current round prevents Check 3
          createIssue({ id: 'ISS-001', round: 2, severity: 'high', status: 'open' }),
        ]),
        latestOutput: createCodexOutput({ overall_assessment: 'minor_issues' }),
        previousRoundHadNewHighCritical: false,
      });

      // Check 3: current round HAS new high/critical → doesn't terminate
      // Check 4: open issues include high severity → doesn't terminate
      // Check 5: round 2 < 5 → doesn't terminate
      // → null
      assert.equal(result, null);
    });

    // ── 11. Edge case: first round with previousRoundHadNewHighCritical=true

    it('returns null on first round when previousRoundHadNewHighCritical is true', () => {
      const config = createDefaultConfig();
      config.max_rounds = 5;

      const result = judge.judge({
        round: 1,
        config,
        ledger: createLedger([
          createIssue({ id: 'ISS-001', round: 1, severity: 'medium', status: 'open' }),
        ]),
        latestOutput: createCodexOutput({ overall_assessment: 'minor_issues' }),
        // First round: typically the orchestrator seeds this as true
        // to prevent premature termination.
        previousRoundHadNewHighCritical: true,
      });

      // Check 3: previousRoundHadNewHighCritical = true → won't terminate
      // Check 4: medium issue exists → won't terminate
      // Check 5: round 1 < 5 → won't terminate
      // → null
      assert.equal(result, null);
    });
  });

  // ── Priority ordering: earlier checks take precedence ─────────

  describe('Priority ordering', () => {
    it('LGTM check fires before deadlock check', () => {
      // Scenario: LGTM + no open/accepted + deadlocked issue.
      // Check 1 (LGTM) should win because it's evaluated first.
      // However, the deadlocked issue is 'rejected', not 'open' or 'accepted',
      // so LGTM will still terminate.
      const result = judge.judge({
        round: 3,
        config: createDefaultConfig(),
        ledger: createLedger([
          createIssue({
            id: 'ISS-001',
            status: 'rejected',
            repeat_count: 3,
            severity: 'high',
          }),
        ]),
        latestOutput: createCodexOutput({ overall_assessment: 'lgtm' }),
        previousRoundHadNewHighCritical: false,
      });

      assert.ok(result, 'Expected a TerminationResult, got null');
      assert.equal(result.reason, 'lgtm');
      assert.equal(result.action, 'terminate');
    });

    it('deadlock check fires before no-new-high-severity check', () => {
      // Scenario: not LGTM, deadlocked issue, and 2 consecutive rounds
      // with no new high/critical. Deadlock should take priority.
      const config = createDefaultConfig();
      config.max_rounds = 10;

      const result = judge.judge({
        round: 5,
        config,
        ledger: createLedger([
          createIssue({
            id: 'ISS-001',
            status: 'rejected',
            repeat_count: 2,
            severity: 'medium',
            round: 1,
          }),
        ]),
        latestOutput: createCodexOutput({ overall_assessment: 'minor_issues' }),
        previousRoundHadNewHighCritical: false,
      });

      assert.ok(result, 'Expected a TerminationResult, got null');
      assert.equal(result.reason, 'deadlock_detected');
      assert.equal(result.action, 'pause_for_human');
    });
  });

  // ── Edge: empty ledger ────────────────────────────────────────

  describe('Edge cases', () => {
    it('terminates with no_new_high_severity on empty ledger and 2 clean rounds', () => {
      const config = createDefaultConfig();
      config.max_rounds = 5;

      const result = judge.judge({
        round: 2,
        config,
        ledger: createLedger([]),
        latestOutput: createCodexOutput({ overall_assessment: 'minor_issues' }),
        previousRoundHadNewHighCritical: false,
      });

      // Empty ledger → no high/critical in current round, previous was clean too.
      // Check 3 fires → terminate.
      assert.ok(result, 'Expected a TerminationResult, got null');
      assert.equal(result.reason, 'no_new_high_severity');
      assert.equal(result.action, 'terminate');
    });

    it('LGTM with completely empty ledger terminates immediately', () => {
      const result = judge.judge({
        round: 1,
        config: createDefaultConfig(),
        ledger: createLedger([]),
        latestOutput: createCodexOutput({ overall_assessment: 'lgtm' }),
        previousRoundHadNewHighCritical: true,
      });

      assert.ok(result, 'Expected a TerminationResult, got null');
      assert.equal(result.reason, 'lgtm');
      assert.equal(result.action, 'terminate');
      assert.ok(result.details.includes('1 round(s)'));
    });
  });
});
