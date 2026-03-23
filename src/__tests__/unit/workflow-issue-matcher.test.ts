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

import {
  IssueMatcher,
  extractIdentifiers,
  jaccardSimilarity,
} from '../../lib/workflow/issue-matcher.js';
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

  // ── Identifier overlap (fuzzy matching) ───────────────────

  describe('match() — identifier overlap (Strategy 3)', () => {
    // ── 12. Real-world ISS-001 vs ISS-007 case ──

    it('matches LLM re-phrased issue with overlapping code identifiers', () => {
      // ISS-001 from R1 (deferred)
      const existing = createIssue({
        id: 'ISS-001',
        description:
          '`resolves_issues` 只有 issue ID 列表，没有 issue 到具体 patch section 的结构化映射，但规范又要求在部分 patch 失败时只阻止"相关 issue"进入 `resolved`。',
        evidence: '§4.4 ClaudeDecisionOutput `resolves_issues?: string[]`; §6.10 Patch-Resolve Consistency Rule; §7.1 Step C3',
        severity: 'high',
        status: 'deferred',
      });

      // ISS-007 from R2 — same issue, different phrasing
      const finding = createFinding({
        issue:
          'resolves_issues 只有 issue ID 列表，但 C3 又要求在部分 patch 失败时只阻止"相关 issue"进入 resolved；按当前数据结构，执行层无法可靠判断某个 issue 依赖了哪些 spec/plan section',
        evidence: 'Spec §4.4 ClaudeDecisionOutput 中 resolves_issues?: string[]；§7.1 Step C3 要求"if related patch sections ALL succeeded"；§6.10 PatchApplier',
        severity: 'high',
      });

      const result = matcher.match(finding, [existing]);
      assert.notEqual(result, null, 'Should match via identifier overlap');
      assert.equal(result!.id, 'ISS-001');
    });

    // ── 13. Real-world ISS-004 vs ISS-008 case ──

    it('matches re-phrased config issue with overlapping identifiers', () => {
      // ISS-004 from R1
      const existing = createIssue({
        id: 'ISS-004',
        description:
          '`WorkflowConfig` 里声明了 `auto_terminate` 和 `human_review_on_deadlock` 两个行为开关，但终止判定和流程描述没有消费它们。',
        evidence: '§4.5 WorkflowConfig 定义 `auto_terminate`、`human_review_on_deadlock`; §5.5 Reason -> Action mapping 与 §7.2 Termination Priority',
        severity: 'medium',
        status: 'deferred',
      });

      // ISS-008 from R2 — same issue
      const finding = createFinding({
        issue:
          'WorkflowConfig 定义了 auto_terminate 和 human_review_on_deadlock 两个开关，但终止判定与主流程没有消费它们',
        evidence: 'Spec §4.5 WorkflowConfig 定义 auto_terminate、human_review_on_deadlock；§5.5 Reason->Action mapping 与 §7.1/§7.2',
        severity: 'medium',
      });

      const result = matcher.match(finding, [existing]);
      assert.notEqual(result, null, 'Should match via identifier overlap');
      assert.equal(result!.id, 'ISS-004');
    });

    // ── 14. Different issues should NOT match ──

    it('does not match genuinely different issues despite shared section refs', () => {
      const existing = createIssue({
        id: 'ISS-001',
        description: '`PatchApplier` fails on heading mismatch by appending to document end',
        evidence: '§6.10 PatchApplier algorithm step 4',
        severity: 'high',
      });

      // Different issue with different code identifiers, only §6.10 overlap
      const finding = createFinding({
        issue: '`TerminationJudge` does not handle the `only_style_issues` edge case correctly',
        evidence: '§6.5 TerminationJudge; §7.2 Termination Priority',
        severity: 'high',
      });

      const result = matcher.match(finding, [existing]);
      assert.equal(result, null, 'Should NOT match — different code identifiers');
    });

    // ── 15. Too few identifiers → skip fuzzy strategy ──

    it('does not match when identifier count is below threshold', () => {
      const existing = createIssue({
        id: 'ISS-001',
        description: 'The system has a potential race condition',
        evidence: 'Observed during testing',
        severity: 'high',
      });

      // Only 0 backtick/section/issue identifiers — should skip fuzzy
      const finding = createFinding({
        issue: 'A potential race condition exists in the system',
        evidence: 'Manual observation during testing',
        severity: 'high',
      });

      const result = matcher.match(finding, [existing]);
      assert.equal(result, null, 'Should NOT match — too few identifiers for fuzzy');
    });

    // ── 16. Severity too far apart → skip even with identifier overlap ──

    it('does not match when severity differs by more than 1 rank', () => {
      const existing = createIssue({
        id: 'ISS-001',
        description: '`resolves_issues` lacks structured mapping to `PatchApplier` sections',
        evidence: '§4.4 `ClaudeDecisionOutput`; §6.10 PatchApplier; §7.1 Step C3',
        severity: 'critical',
      });

      // Same identifiers but severity too far apart (critical vs low = 3 rank diff)
      const finding = createFinding({
        issue: '`resolves_issues` has no mapping to `PatchApplier` output sections',
        evidence: '§4.4 `ClaudeDecisionOutput`; §6.10 PatchApplier; §7.1',
        severity: 'low',
      });

      const result = matcher.match(finding, [existing]);
      assert.equal(result, null, 'Should NOT match — severity too far apart');
    });

    // ── 17. Reviewer false-positive case: same section refs, different problem ──

    it('does not match issues that share only section refs but different code identifiers', () => {
      // ISS-004: "config switches unused"
      const existing = createIssue({
        id: 'ISS-004',
        description:
          '`WorkflowConfig` 里声明了 `auto_terminate` 和 `human_review_on_deadlock` 两个行为开关，但终止判定和流程描述没有消费它们。',
        evidence: '§4.5 WorkflowConfig 定义 `auto_terminate`、`human_review_on_deadlock`; §5.5 Reason -> Action mapping 与 §7.2 Termination Priority',
        severity: 'medium',
        status: 'deferred',
      });

      // Different problem: "CLI docs don't list defaults" — shares §4.5/§5.5/§7.2 but
      // only one code identifier overlap (WorkflowConfig) — below MIN_CODE_ID_OVERLAP=2
      const finding = createFinding({
        issue:
          'CLI 文档没有为 WorkflowConfig 的各字段列出默认值，用户无法了解缺省行为',
        evidence: '§4.5 WorkflowConfig; §5.5 Configuration Defaults; §7.2 Termination Priority',
        severity: 'medium',
      });

      const result = matcher.match(finding, [existing]);
      assert.equal(result, null,
        'Should NOT match — only 1 code identifier overlap (WorkflowConfig), below threshold of 2');
    });

    // ── 18. Code identifiers via bare PascalCase/snake_case (no backticks) ──

    it('matches via bare PascalCase and snake_case identifiers (no backticks needed)', () => {
      const existing = createIssue({
        id: 'ISS-001',
        description:
          'DecisionValidator 的覆盖校验只要求覆盖 currentRoundFindings，允许 Claude 对遗留 issue 返回空 decisions',
        evidence: '§6.11 DecisionValidator; §6.2 ClaudeDecisionInput hasNewFindings=false',
        severity: 'high',
      });

      // Re-phrased without backticks — PascalCase should still extract
      const finding = createFinding({
        issue:
          'DecisionValidator coverage check only covers currentRoundFindings, ignores legacy issues when hasNewFindings is false',
        evidence: '§6.11 DecisionValidator check #3; §6.2 ClaudeDecisionInput',
        severity: 'high',
      });

      const result = matcher.match(finding, [existing]);
      assert.notEqual(result, null, 'Should match — bare PascalCase overlap: DecisionValidator, ClaudeDecisionInput');
      assert.equal(result!.id, 'ISS-001');
    });
  });
});

// ── extractIdentifiers / jaccardSimilarity unit tests ────────

describe('extractIdentifiers()', () => {
  it('extracts backtick-quoted identifiers', () => {
    const ids = extractIdentifiers('The `resolves_issues` field in `ClaudeDecisionOutput` is incomplete');
    assert.ok(ids.has('resolves_issues'));
    assert.ok(ids.has('claudedecisionoutput'));
  });

  it('extracts section references (§X.Y)', () => {
    const ids = extractIdentifiers('See §4.4 and §6.10.1 for details');
    assert.ok(ids.has('§4.4'));
    assert.ok(ids.has('§6.10.1'));
  });

  it('extracts issue ID references', () => {
    const ids = extractIdentifiers('This duplicates ISS-001 and ISS-012');
    assert.ok(ids.has('ISS-001'));
    assert.ok(ids.has('ISS-012'));
  });

  it('returns empty set for plain text without identifiers', () => {
    const ids = extractIdentifiers('This is a plain text description with no special tokens.');
    assert.equal(ids.size, 0);
  });

  it('combines all types from mixed text', () => {
    const ids = extractIdentifiers('`PatchApplier` in §6.10 fails for ISS-003');
    assert.ok(ids.has('patchapplier'));
    assert.ok(ids.has('§6.10'));
    assert.ok(ids.has('ISS-003'));
  });

  it('extracts bare PascalCase identifiers (no backticks)', () => {
    const ids = extractIdentifiers('ClaudeDecisionOutput has issues, DecisionValidator fails');
    assert.ok(ids.has('claudedecisionoutput'));
    assert.ok(ids.has('decisionvalidator'));
  });

  it('extracts bare snake_case identifiers (no backticks)', () => {
    const ids = extractIdentifiers('resolves_issues and auto_terminate are not consumed');
    assert.ok(ids.has('resolves_issues'));
    assert.ok(ids.has('auto_terminate'));
  });

  it('does not extract single-segment words as snake_case', () => {
    const ids = extractIdentifiers('the issue is about configuration and testing');
    // None of these are multi-segment snake_case
    assert.ok(!ids.has('issue'));
    assert.ok(!ids.has('configuration'));
    assert.ok(!ids.has('testing'));
  });
});

describe('jaccardSimilarity()', () => {
  it('returns 1.0 for identical sets', () => {
    const a = new Set(['foo', 'bar']);
    assert.equal(jaccardSimilarity(a, a), 1.0);
  });

  it('returns 0 for disjoint sets', () => {
    const a = new Set(['foo']);
    const b = new Set(['bar']);
    assert.equal(jaccardSimilarity(a, b), 0);
  });

  it('returns correct value for partial overlap', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection = 2, union = 4
    assert.equal(jaccardSimilarity(a, b), 0.5);
  });

  it('returns 0 for two empty sets', () => {
    assert.equal(jaccardSimilarity(new Set(), new Set()), 0);
  });
});
