/**
 * Unit tests for IssueMatcher — finding deduplication and ledger integration.
 *
 * Covers:
 * - match(): exact description match, evidence-based match, no match, empty list
 * - processFindings(): new issues, rejected re-raise, deferred re-raise,
 *   open re-raise, newHighCriticalCount, idempotency, mixed scenario
 *
 * @module __tests__/unit/workflow-issue-matcher
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { IssueMatcher } from '../../lib/workflow/issue-matcher.js';
import type {
  Finding,
  Issue,
  IssueLedger,
} from '../../lib/workflow/types.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Build a Finding with sensible defaults. */
function createFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    issue: overrides.issue ?? 'Missing error handling',
    severity: overrides.severity ?? 'high',
    evidence: overrides.evidence ?? 'Line 42 in auth.ts has no try-catch',
    suggestion: overrides.suggestion ?? 'Wrap in try-catch block',
  };
}

/** Build an Issue with sensible defaults. */
function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? 'ISS-001',
    round: overrides.round ?? 1,
    raised_by: overrides.raised_by ?? 'codex',
    severity: overrides.severity ?? 'high',
    description: overrides.description ?? 'Missing error handling',
    evidence: overrides.evidence ?? 'Line 42 in auth.ts has no try-catch',
    status: overrides.status ?? 'open',
    repeat_count: overrides.repeat_count ?? 0,
    ...overrides,
  };
}

/** Build an empty IssueLedger. */
function createLedger(issues: Issue[] = []): IssueLedger {
  return {
    run_id: 'run-test-001',
    issues: [...issues],
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('IssueMatcher', () => {
  let matcher: IssueMatcher;

  beforeEach(() => {
    matcher = new IssueMatcher();
  });

  // ── match() ──────────────────────────────────────────────────

  describe('match()', () => {
    // ── 1. Exact description match (case/whitespace insensitive) ──

    it('returns matched issue on exact description match (case/whitespace insensitive)', () => {
      const existing = createIssue({
        description: 'Missing error handling',
      });

      // Finding with different casing and extra whitespace
      const finding = createFinding({
        issue: '  MISSING   Error  Handling  ',
      });

      const result = matcher.match(finding, [existing]);
      assert.notEqual(result, null);
      assert.equal(result!.id, existing.id);
    });

    // ── 2. Evidence-based match (same evidence + similar severity) ──

    it('returns matched issue on evidence match with similar severity', () => {
      const existing = createIssue({
        description: 'Old description that differs',
        severity: 'critical',
        evidence: 'Line 42 in auth.ts has no try-catch',
      });

      // Different description, same evidence, severity within 1 rank step
      const finding = createFinding({
        issue: 'Completely different issue text',
        severity: 'high', // |critical(0) - high(1)| = 1 => similar
        evidence: 'Line 42 in auth.ts has no try-catch',
      });

      const result = matcher.match(finding, [existing]);
      assert.notEqual(result, null);
      assert.equal(result!.id, existing.id);
    });

    // ── 3. No match (brand new issue) ──

    it('returns null when no existing issue matches', () => {
      const existing = createIssue({
        description: 'Missing error handling',
        evidence: 'Line 42 in auth.ts has no try-catch',
        severity: 'high',
      });

      const finding = createFinding({
        issue: 'SQL injection vulnerability',
        evidence: 'User input passed directly to query builder',
        severity: 'critical',
      });

      const result = matcher.match(finding, [existing]);
      assert.equal(result, null);
    });

    // ── 4. Empty existingIssues list ──

    it('returns null when existingIssues is empty', () => {
      const finding = createFinding({
        issue: 'Some new issue',
      });

      const result = matcher.match(finding, []);
      assert.equal(result, null);
    });
  });

  // ── processFindings() ────────────────────────────────────────

  describe('processFindings()', () => {
    // ── 5. All new findings (no history) ──

    it('creates new issues starting from ISS-001 when ledger is empty', () => {
      const ledger = createLedger();
      const findings: Finding[] = [
        createFinding({ issue: 'Issue A', severity: 'critical', evidence: 'Evidence for A' }),
        createFinding({ issue: 'Issue B', severity: 'medium', evidence: 'Evidence for B' }),
        createFinding({ issue: 'Issue C', severity: 'low', evidence: 'Evidence for C' }),
      ];

      const result = matcher.processFindings(findings, ledger, 1);

      // All should be new
      assert.equal(result.newTotalCount, 3);
      assert.equal(result.newIssues.length, 3);

      // IDs should be sequential starting from ISS-001
      assert.equal(result.newIssues[0].id, 'ISS-001');
      assert.equal(result.newIssues[1].id, 'ISS-002');
      assert.equal(result.newIssues[2].id, 'ISS-003');

      // All should be open with repeat_count = 0
      for (const issue of result.newIssues) {
        assert.equal(issue.status, 'open');
        assert.equal(issue.repeat_count, 0);
        assert.equal(issue.raised_by, 'codex');
        assert.equal(issue.round, 1);
      }

      // matchedIssues should mark all as new
      assert.equal(result.matchedIssues.length, 3);
      for (const mi of result.matchedIssues) {
        assert.equal(mi.isNew, true);
      }

      // Ledger should be mutated in-place
      assert.equal(ledger.issues.length, 3);
    });

    // ── 6. Rejected issue re-raised ──

    it('reopens rejected issue and increments repeat_count', () => {
      const rejectedIssue = createIssue({
        id: 'ISS-001',
        description: 'Missing error handling',
        status: 'rejected',
        repeat_count: 1,
        decided_by: 'claude',
        decision_reason: 'Not applicable',
      });
      const ledger = createLedger([rejectedIssue]);

      const finding = createFinding({
        issue: 'Missing error handling',
      });

      const result = matcher.processFindings([finding], ledger, 2);

      // Should not create new issues
      assert.equal(result.newTotalCount, 0);
      assert.equal(result.newIssues.length, 0);

      // Should match and reopen the rejected issue
      assert.equal(result.matchedIssues.length, 1);
      assert.equal(result.matchedIssues[0].issueId, 'ISS-001');
      assert.equal(result.matchedIssues[0].isNew, false);

      // The issue in the ledger should be reopened
      const issue = ledger.issues[0];
      assert.equal(issue.status, 'open');
      assert.equal(issue.repeat_count, 2);
      // Decision metadata should be cleared
      assert.equal(issue.decided_by, undefined);
      assert.equal(issue.decision_reason, undefined);
    });

    // ── 7. Deferred issue re-raised ──

    it('keeps deferred issue as-is without incrementing repeat_count', () => {
      const deferredIssue = createIssue({
        id: 'ISS-001',
        description: 'Low priority refactoring',
        status: 'deferred',
        repeat_count: 0,
        decided_by: 'claude',
        decision_reason: 'Deferred to next sprint',
      });
      const ledger = createLedger([deferredIssue]);

      const finding = createFinding({
        issue: 'Low priority refactoring',
      });

      const result = matcher.processFindings([finding], ledger, 2);

      assert.equal(result.newTotalCount, 0);
      assert.equal(result.matchedIssues.length, 1);
      assert.equal(result.matchedIssues[0].isNew, false);

      // Status and repeat_count should remain unchanged
      const issue = ledger.issues[0];
      assert.equal(issue.status, 'deferred');
      assert.equal(issue.repeat_count, 0);
      // Decision metadata should remain intact
      assert.equal(issue.decided_by, 'claude');
      assert.equal(issue.decision_reason, 'Deferred to next sprint');
    });

    // ── 8. Open issue re-raised ──

    it('skips already-open issue (no changes)', () => {
      const openIssue = createIssue({
        id: 'ISS-001',
        description: 'Existing open issue',
        status: 'open',
        repeat_count: 0,
      });
      const ledger = createLedger([openIssue]);

      const finding = createFinding({
        issue: 'Existing open issue',
      });

      const result = matcher.processFindings([finding], ledger, 2);

      assert.equal(result.newTotalCount, 0);
      assert.equal(result.matchedIssues.length, 1);
      assert.equal(result.matchedIssues[0].isNew, false);

      // No mutation
      const issue = ledger.issues[0];
      assert.equal(issue.status, 'open');
      assert.equal(issue.repeat_count, 0);
    });

    // ── 9. newHighCriticalCount ──

    it('correctly counts only critical and high severity new issues', () => {
      const ledger = createLedger();
      const findings: Finding[] = [
        createFinding({ issue: 'Critical bug', severity: 'critical', evidence: 'Critical evidence' }),
        createFinding({ issue: 'High severity bug', severity: 'high', evidence: 'High evidence' }),
        createFinding({ issue: 'Medium issue', severity: 'medium', evidence: 'Medium evidence' }),
        createFinding({ issue: 'Low issue', severity: 'low', evidence: 'Low evidence' }),
      ];

      const result = matcher.processFindings(findings, ledger, 1);

      assert.equal(result.newTotalCount, 4);
      assert.equal(result.newHighCriticalCount, 2); // only critical + high
    });

    // ── 10. Idempotency ──

    it('does not create duplicates when processFindings is called twice for the same round', () => {
      const ledger = createLedger();
      const findings: Finding[] = [
        createFinding({ issue: 'Issue Alpha', severity: 'high', evidence: 'Alpha evidence' }),
        createFinding({ issue: 'Issue Beta', severity: 'medium', evidence: 'Beta evidence' }),
      ];

      // First call — creates new issues
      const result1 = matcher.processFindings(findings, ledger, 1);
      assert.equal(result1.newTotalCount, 2);
      assert.equal(ledger.issues.length, 2);

      // Second call — same findings, same round
      const result2 = matcher.processFindings(findings, ledger, 1);

      // Should NOT create new issues (idempotent)
      assert.equal(result2.newTotalCount, 0);
      assert.equal(result2.newIssues.length, 0);

      // Ledger should still have exactly 2 issues
      assert.equal(ledger.issues.length, 2);

      // All matchedIssues should point to existing issues
      for (const mi of result2.matchedIssues) {
        assert.equal(mi.isNew, false);
      }
    });

    // ── 11. Mixed scenario ──

    it('handles mix of new, matched-rejected, matched-deferred, and matched-open', () => {
      const rejectedIssue = createIssue({
        id: 'ISS-001',
        description: 'Rejected issue to reopen',
        evidence: 'Rejected evidence',
        status: 'rejected',
        repeat_count: 0,
        decided_by: 'claude',
        decision_reason: 'Was rejected',
      });
      const deferredIssue = createIssue({
        id: 'ISS-002',
        description: 'Deferred issue stays deferred',
        evidence: 'Deferred evidence',
        status: 'deferred',
        repeat_count: 0,
      });
      const openIssue = createIssue({
        id: 'ISS-003',
        description: 'Already tracked open issue',
        evidence: 'Open evidence',
        status: 'open',
        repeat_count: 0,
      });

      const ledger = createLedger([rejectedIssue, deferredIssue, openIssue]);

      const findings: Finding[] = [
        // Matches rejected issue
        createFinding({ issue: 'Rejected issue to reopen', severity: 'high', evidence: 'Rejected evidence' }),
        // Matches deferred issue
        createFinding({ issue: 'Deferred issue stays deferred', severity: 'medium', evidence: 'Deferred evidence' }),
        // Matches open issue
        createFinding({ issue: 'Already tracked open issue', severity: 'low', evidence: 'Open evidence' }),
        // Brand new issues
        createFinding({ issue: 'Brand new critical issue', severity: 'critical', evidence: 'New critical evidence' }),
        createFinding({ issue: 'Brand new low issue', severity: 'low', evidence: 'New low evidence' }),
      ];

      const result = matcher.processFindings(findings, ledger, 2);

      // 2 new issues created
      assert.equal(result.newTotalCount, 2);
      assert.equal(result.newIssues.length, 2);
      assert.equal(result.newIssues[0].id, 'ISS-004'); // nextSeq = 3 existing + 1
      assert.equal(result.newIssues[1].id, 'ISS-005');

      // newHighCriticalCount: only the critical one is new high/critical
      assert.equal(result.newHighCriticalCount, 1);

      // Total matched entries: 5 (3 existing + 2 new)
      assert.equal(result.matchedIssues.length, 5);

      // Verify rejected issue was reopened
      const reopened = ledger.issues.find((i) => i.id === 'ISS-001')!;
      assert.equal(reopened.status, 'open');
      assert.equal(reopened.repeat_count, 1);
      assert.equal(reopened.decided_by, undefined);
      assert.equal(reopened.decision_reason, undefined);

      // Verify deferred issue remains unchanged
      const deferred = ledger.issues.find((i) => i.id === 'ISS-002')!;
      assert.equal(deferred.status, 'deferred');
      assert.equal(deferred.repeat_count, 0);

      // Verify open issue remains unchanged
      const open = ledger.issues.find((i) => i.id === 'ISS-003')!;
      assert.equal(open.status, 'open');
      assert.equal(open.repeat_count, 0);

      // Ledger should now have 5 issues total (3 existing + 2 new)
      assert.equal(ledger.issues.length, 5);
    });
  });
});
