/**
 * Unit tests for workflow card render functions.
 *
 * 测试范围：
 * - renderProgressMarkdown(): 进度状态 → Markdown 渲染
 * - renderCompletionMarkdown(): 完成摘要 → Markdown 渲染
 *
 * 这两个是纯函数（state → string），不需要 mock 任何外部依赖。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  _renderProgressMarkdown as renderProgressMarkdown,
  _renderCompletionMarkdown as renderCompletionMarkdown,
} from '../../lib/bridge/internal/workflow-command.js';
import type {
  _RoundProgress as RoundProgress,
  _WorkflowProgressState as WorkflowProgressState,
} from '../../lib/bridge/internal/workflow-command.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Create a minimal valid WorkflowProgressState for testing. */
function makeState(overrides: Partial<WorkflowProgressState> = {}): WorkflowProgressState {
  return {
    runId: 'test-run-001',
    currentRound: 1,
    rounds: new Map(),
    startedAt: Date.now(),
    workflowType: 'spec-review',
    cardMode: true,
    cardCreated: true,
    updateTimer: null,
    ...overrides,
  };
}

/** Create a minimal RoundProgress. */
function makeRound(overrides: Partial<RoundProgress> = {}): RoundProgress {
  return {
    codex: 'pending',
    claude: 'pending',
    warnings: [],
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════
// renderProgressMarkdown
// ══════════════════════════════════════════════════════════════════

describe('renderProgressMarkdown', () => {

  // ================================================================
  // Basic output structure
  // ================================================================

  describe('basic structure', () => {
    it('renders run ID header', () => {
      const state = makeState({ runId: 'abc-123' });
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('**Run:** `abc-123`'), 'should contain run ID');
    });

    it('renders empty state with only run ID', () => {
      const state = makeState();
      const md = renderProgressMarkdown(state);
      assert.ok(md.startsWith('**Run:**'), 'should start with run ID');
      // No round headers when rounds map is empty
      assert.ok(!md.includes('第'), 'should have no round sections');
    });
  });

  // ================================================================
  // Single round — Codex states
  // ================================================================

  describe('codex status rendering', () => {
    it('shows running indicator when codex is running', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({ codex: 'running' }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('🔍 Codex 审查中...'), 'should show running text');
    });

    it('shows findings count when codex is done', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({ codex: 'done', codexFindings: 5 }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('🔍 Codex: **5** 个问题'), 'should show findings count');
    });

    it('shows "?" when codex is done but findings is undefined', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({ codex: 'done' }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('Codex: **?** 个问题'), 'should show "?" for unknown count');
    });

    it('shows lgtm emoji for lgtm assessment', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({ codex: 'done', codexFindings: 0, codexAssessment: 'lgtm' }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('👍'), 'should show thumbs up for lgtm');
    });

    it('shows warning emoji for major_issues assessment', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({ codex: 'done', codexFindings: 8, codexAssessment: 'major_issues' }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('⚠️'), 'should show warning for major issues');
    });

    it('does not render codex line when still pending', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({ codex: 'pending' }));
      const md = renderProgressMarkdown(state);
      assert.ok(!md.includes('Codex'), 'should not mention Codex when pending');
    });
  });

  // ================================================================
  // Single round — Issue matching
  // ================================================================

  describe('issue matching rendering', () => {
    it('shows new issues count', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({ newIssues: 3 }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('📊 新增 **3** 个问题'), 'should show new issues');
    });

    it('shows critical/high count when present', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({ newIssues: 5, highCritical: 2 }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('Critical/High: **2**'), 'should show high/critical count');
    });

    it('does not show issue line when newIssues is 0', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({ newIssues: 0 }));
      const md = renderProgressMarkdown(state);
      assert.ok(!md.includes('📊'), 'should not show issue line for 0 new issues');
    });

    it('does not show issue line when newIssues is undefined', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound());
      const md = renderProgressMarkdown(state);
      assert.ok(!md.includes('📊'), 'should not show issue line when undefined');
    });
  });

  // ================================================================
  // Single round — Claude states
  // ================================================================

  describe('claude status rendering', () => {
    it('shows running indicator when claude is running', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({ claude: 'running' }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('🤔 Claude 决策中...'), 'should show running text');
    });

    it('shows decision counts when claude is done', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({
        claude: 'done',
        claudeDecision: { accepted: 3, rejected: 1, deferred: 2, resolved: 0 },
      }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('3✓'), 'should show accepted count');
      assert.ok(md.includes('1✗'), 'should show rejected count');
      assert.ok(md.includes('2⏳'), 'should show deferred count');
    });

    it('omits zero counts in decision', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({
        claude: 'done',
        claudeDecision: { accepted: 5, rejected: 0, deferred: 0, resolved: 0 },
      }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('5✓'), 'should show accepted');
      assert.ok(!md.includes('✗'), 'should omit rejected when 0');
      // Check the Claude decision line specifically (not the round icon ⏳)
      const claudeLine = md.split('\n').find(l => l.includes('🤔 Claude:'));
      assert.ok(claudeLine, 'should have Claude decision line');
      assert.ok(!claudeLine!.includes('⏳'), 'Claude line should omit deferred when 0');
    });

    it('shows resolved count with ↺ symbol', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({
        claude: 'done',
        claudeDecision: { accepted: 0, rejected: 0, deferred: 0, resolved: 4 },
      }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('4↺'), 'should show resolved count');
    });

    it('shows completion text when claude is done but all decision counts are 0', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({
        claude: 'done',
        claudeDecision: { accepted: 0, rejected: 0, deferred: 0, resolved: 0 },
      }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('🤔 Claude: 已完成'), 'should show completion text');
      assert.ok(!md.includes('🤔 Claude:\n'), 'should not render an empty Claude line');
    });

    it('does not render claude line when still pending', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({ claude: 'pending' }));
      const md = renderProgressMarkdown(state);
      assert.ok(!md.includes('Claude'), 'should not mention Claude when pending');
    });
  });

  // ================================================================
  // Spec/Plan updates
  // ================================================================

  describe('spec/plan update rendering', () => {
    it('shows spec updated', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({
        claude: 'done',
        claudeDecision: { accepted: 1, rejected: 0, deferred: 0, resolved: 0 },
        specUpdated: true,
      }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('📝 已更新: spec'), 'should show spec updated');
    });

    it('shows both spec and plan updated', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({
        claude: 'done',
        claudeDecision: { accepted: 1, rejected: 0, deferred: 0, resolved: 0 },
        specUpdated: true,
        planUpdated: true,
      }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('📝 已更新: spec, plan'), 'should show both updated');
    });

    it('does not show update line when neither updated', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({
        claude: 'done',
        claudeDecision: { accepted: 1, rejected: 0, deferred: 0, resolved: 0 },
      }));
      const md = renderProgressMarkdown(state);
      assert.ok(!md.includes('📝'), 'should not show update line');
    });
  });

  // ================================================================
  // Round icon (active vs completed)
  // ================================================================

  describe('round icon', () => {
    it('shows ⏳ for active round (current, no termination)', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound());
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('⏳ **第 1 轮**'), 'active round should use ⏳');
    });

    it('shows ✅ for completed round (not current)', () => {
      const state = makeState({ currentRound: 2 });
      state.rounds.set(1, makeRound({ codex: 'done', claude: 'done' }));
      state.rounds.set(2, makeRound());
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('✅ **第 1 轮**'), 'past round should use ✅');
      assert.ok(md.includes('⏳ **第 2 轮**'), 'current round should use ⏳');
    });

    it('shows ✅ for current round when terminated', () => {
      const state = makeState({
        currentRound: 1,
        termination: { reason: 'max_rounds' },
      });
      state.rounds.set(1, makeRound());
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('✅ **第 1 轮**'), 'terminated round should use ✅');
    });

    it('shows ✅ for current round when human review requested', () => {
      const state = makeState({
        currentRound: 1,
        humanReview: { reason: 'too many issues' },
      });
      state.rounds.set(1, makeRound());
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('✅ **第 1 轮**'), 'human review round should use ✅');
    });
  });

  // ================================================================
  // Multiple rounds — ordering
  // ================================================================

  describe('multi-round rendering', () => {
    it('renders rounds in ascending order', () => {
      const state = makeState({ currentRound: 3 });
      // Insert out of order
      state.rounds.set(3, makeRound());
      state.rounds.set(1, makeRound({ codex: 'done', codexFindings: 2 }));
      state.rounds.set(2, makeRound({ codex: 'done', codexFindings: 1 }));
      const md = renderProgressMarkdown(state);

      const idx1 = md.indexOf('第 1 轮');
      const idx2 = md.indexOf('第 2 轮');
      const idx3 = md.indexOf('第 3 轮');
      assert.ok(idx1 < idx2, 'round 1 should come before round 2');
      assert.ok(idx2 < idx3, 'round 2 should come before round 3');
    });
  });

  // ================================================================
  // Warnings
  // ================================================================

  describe('round warnings', () => {
    it('renders warnings with ⚠️ prefix', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({ warnings: ['Codex 审查超时，已跳过'] }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('⚠️ Codex 审查超时，已跳过'), 'should show warning');
    });

    it('renders multiple warnings', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({
        warnings: ['Warning 1', 'Warning 2'],
      }));
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('⚠️ Warning 1'), 'should show first warning');
      assert.ok(md.includes('⚠️ Warning 2'), 'should show second warning');
    });

    it('renders no warning lines when warnings array is empty', () => {
      const state = makeState({ currentRound: 1 });
      state.rounds.set(1, makeRound({ warnings: [] }));
      const md = renderProgressMarkdown(state);
      // Only the round header warning emoji should appear if at all;
      // there should be no standalone warning line
      const lines = md.split('\n').filter(l => l.trimStart().startsWith('⚠️'));
      assert.equal(lines.length, 0, 'should have no warning lines');
    });
  });

  // ================================================================
  // Termination
  // ================================================================

  describe('termination rendering', () => {
    it('renders termination reason', () => {
      const state = makeState({ termination: { reason: 'max_rounds' } });
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('⏹ **终止判定**: max_rounds'), 'should show termination');
    });

    it('renders termination details when present', () => {
      const state = makeState({
        termination: { reason: 'lgtm', details: '已连续 2 轮 LGTM' },
      });
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('已连续 2 轮 LGTM'), 'should show details');
    });

    it('omits details line when not present', () => {
      const state = makeState({ termination: { reason: 'max_rounds' } });
      const md = renderProgressMarkdown(state);
      const lines = md.split('\n');
      const termLine = lines.findIndex(l => l.includes('终止判定'));
      assert.ok(termLine >= 0, 'termination line should exist');
      assert.equal(lines[termLine + 1], undefined, 'should not render a details line');
    });
  });

  // ================================================================
  // Human review
  // ================================================================

  describe('human review rendering', () => {
    it('renders human review indicator', () => {
      const state = makeState({ humanReview: {} });
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('⚠️ **需要人工审查**'), 'should show human review');
    });

    it('renders human review reason when provided', () => {
      const state = makeState({ humanReview: { reason: 'too many critical issues' } });
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('原因: too many critical issues'), 'should show reason');
    });

    it('renders resume command with run ID', () => {
      const state = makeState({ runId: 'run-xyz', humanReview: {} });
      const md = renderProgressMarkdown(state);
      assert.ok(md.includes('`/workflow resume run-xyz`'), 'should show resume command');
    });
  });

  // ================================================================
  // Full scenario: a realistic multi-round workflow
  // ================================================================

  describe('full scenario', () => {
    it('renders a complete 2-round workflow progress', () => {
      const state = makeState({ runId: '20260323-a1b2c3', currentRound: 2 });

      // Round 1: completed
      state.rounds.set(1, makeRound({
        codex: 'done',
        codexFindings: 3,
        codexAssessment: 'major_issues',
        newIssues: 3,
        highCritical: 1,
        claude: 'done',
        claudeDecision: { accepted: 2, rejected: 0, deferred: 1, resolved: 0 },
        specUpdated: true,
        warnings: [],
      }));

      // Round 2: in progress (codex done, claude running)
      state.rounds.set(2, makeRound({
        codex: 'done',
        codexFindings: 1,
        codexAssessment: 'lgtm',
        newIssues: 1,
        claude: 'running',
        warnings: [],
      }));

      const md = renderProgressMarkdown(state);

      // Structural checks
      assert.ok(md.includes('`20260323-a1b2c3`'), 'run ID');
      assert.ok(md.includes('✅ **第 1 轮**'), 'round 1 completed');
      assert.ok(md.includes('⏳ **第 2 轮**'), 'round 2 active');

      // Round 1 details
      assert.ok(md.includes('**3** 个问题'), 'round 1 codex findings');
      assert.ok(md.includes('Critical/High: **1**'), 'round 1 high/critical');
      assert.ok(md.includes('2✓'), 'round 1 accepted');
      assert.ok(md.includes('1⏳'), 'round 1 deferred');
      assert.ok(md.includes('已更新: spec'), 'round 1 spec updated');

      // Round 2 details
      assert.ok(md.includes('👍'), 'round 2 lgtm');
      assert.ok(md.includes('Claude 决策中...'), 'round 2 claude running');
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// renderCompletionMarkdown
// ══════════════════════════════════════════════════════════════════

describe('renderCompletionMarkdown', () => {

  // ================================================================
  // Basic structure
  // ================================================================

  describe('basic structure', () => {
    it('includes progress section followed by separator and completion', () => {
      const state = makeState({ runId: 'completion-test' });
      const md = renderCompletionMarkdown(state, {});
      assert.ok(md.includes('**Run:** `completion-test`'), 'should include progress header');
      assert.ok(md.includes('---'), 'should include separator');
      assert.ok(md.includes('🎉 **工作流完成！**'), 'should include completion message');
    });

    it('completion section comes after progress section', () => {
      const state = makeState();
      state.rounds.set(1, makeRound({ codex: 'done', codexFindings: 2 }));
      const md = renderCompletionMarkdown(state, {});

      const progressIdx = md.indexOf('**Run:**');
      const separatorIdx = md.indexOf('---');
      const completionIdx = md.indexOf('🎉');
      assert.ok(progressIdx < separatorIdx, 'progress before separator');
      assert.ok(separatorIdx < completionIdx, 'separator before completion');
    });
  });

  // ================================================================
  // Completion data fields
  // ================================================================

  describe('completion data rendering', () => {
    it('renders termination reason', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, { reason: 'lgtm_streak' });
      assert.ok(md.includes('终止原因: lgtm_streak'), 'should show reason');
    });

    it('renders total rounds', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, { total_rounds: 3 });
      assert.ok(md.includes('轮次: 3'), 'should show total rounds');
    });

    it('renders total issues with bold', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, { total_issues: 12 });
      assert.ok(md.includes('Issue 总数: **12**'), 'should show total issues');
    });

    it('renders total_issues = 0', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, { total_issues: 0 });
      assert.ok(md.includes('Issue 总数: **0**'), 'should show 0 issues');
    });

    it('omits reason when not provided', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, {});
      assert.ok(!md.includes('终止原因'), 'should not show reason line');
    });

    it('omits total_rounds when not provided', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, {});
      assert.ok(!md.includes('轮次:'), 'should not show rounds line');
    });
  });

  // ================================================================
  // Severity breakdown
  // ================================================================

  describe('severity rendering', () => {
    it('renders all severity levels', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, {
        severity: { critical: 1, high: 2, medium: 5, low: 10 },
      });
      assert.ok(md.includes('🔴 Critical: 1'), 'critical');
      assert.ok(md.includes('🟠 High: 2'), 'high');
      assert.ok(md.includes('🟡 Medium: 5'), 'medium');
      assert.ok(md.includes('🟢 Low: 10'), 'low');
    });

    it('omits zero severity levels', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, {
        severity: { critical: 0, high: 3, medium: 0, low: 0 },
      });
      assert.ok(!md.includes('Critical'), 'should omit zero critical');
      assert.ok(md.includes('🟠 High: 3'), 'should show non-zero high');
      assert.ok(!md.includes('Medium'), 'should omit zero medium');
      assert.ok(!md.includes('Low'), 'should omit zero low');
    });

    it('omits severity line entirely when all zeros', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, {
        severity: { critical: 0, high: 0, medium: 0, low: 0 },
      });
      assert.ok(!md.includes('严重度:'), 'should not show severity line');
    });

    it('omits severity line when severity is not provided', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, {});
      assert.ok(!md.includes('严重度:'), 'should not show severity line');
    });

    it('handles partial severity (only some fields)', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, {
        severity: { high: 1 },
      });
      assert.ok(md.includes('🟠 High: 1'), 'should show partial severity');
      assert.ok(!md.includes('Critical'), 'should not show undefined fields');
    });
  });

  // ================================================================
  // Status breakdown
  // ================================================================

  describe('status rendering', () => {
    it('renders all status categories', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, {
        status: { open: 2, accepted: 5, rejected: 1, deferred: 3, resolved: 4 },
      });
      assert.ok(md.includes('open: 2'), 'open');
      assert.ok(md.includes('accepted: 5'), 'accepted');
      assert.ok(md.includes('rejected: 1'), 'rejected');
      assert.ok(md.includes('deferred: 3'), 'deferred');
      assert.ok(md.includes('resolved: 4'), 'resolved');
    });

    it('omits zero status categories', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, {
        status: { open: 0, accepted: 3, rejected: 0, deferred: 0, resolved: 2 },
      });
      assert.ok(!md.includes('open:'), 'should omit zero open');
      assert.ok(md.includes('accepted: 3'), 'should show non-zero accepted');
      assert.ok(md.includes('resolved: 2'), 'should show non-zero resolved');
    });

    it('omits status line when all zeros', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, {
        status: { open: 0, accepted: 0, rejected: 0, deferred: 0, resolved: 0 },
      });
      assert.ok(!md.includes('状态:'), 'should not show status line');
    });

    it('omits status line when not provided', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, {});
      assert.ok(!md.includes('状态:'), 'should not show status line');
    });
  });

  // ================================================================
  // Full scenario
  // ================================================================

  describe('full scenario', () => {
    it('renders a complete completion summary with all data', () => {
      // Completed workflow: termination is set, so all rounds show ✅
      const state = makeState({
        runId: '20260323-final',
        currentRound: 2,
        termination: { reason: 'lgtm_streak' },
      });
      state.rounds.set(1, makeRound({
        codex: 'done', codexFindings: 5, codexAssessment: 'major_issues',
        newIssues: 5, highCritical: 2,
        claude: 'done',
        claudeDecision: { accepted: 3, rejected: 1, deferred: 1, resolved: 0 },
        specUpdated: true,
        warnings: [],
      }));
      state.rounds.set(2, makeRound({
        codex: 'done', codexFindings: 1, codexAssessment: 'lgtm',
        claude: 'done',
        claudeDecision: { accepted: 1, rejected: 0, deferred: 0, resolved: 0 },
        warnings: [],
      }));

      const md = renderCompletionMarkdown(state, {
        total_rounds: 2,
        total_issues: 6,
        reason: 'lgtm_streak',
        severity: { critical: 1, high: 1, medium: 3, low: 1 },
        status: { open: 0, accepted: 4, rejected: 1, deferred: 1, resolved: 0 },
      });

      // Progress section
      assert.ok(md.includes('`20260323-final`'), 'run ID in progress');
      assert.ok(md.includes('✅ **第 1 轮**'), 'round 1 completed');
      assert.ok(md.includes('✅ **第 2 轮**'), 'round 2 completed (terminated)');

      // Separator
      assert.ok(md.includes('---'), 'separator');

      // Completion section
      assert.ok(md.includes('🎉 **工作流完成！**'), 'completion header');
      assert.ok(md.includes('终止原因: lgtm_streak'), 'reason');
      assert.ok(md.includes('轮次: 2'), 'total rounds');
      assert.ok(md.includes('Issue 总数: **6**'), 'total issues');
      assert.ok(md.includes('🔴 Critical: 1'), 'severity critical');
      assert.ok(md.includes('accepted: 4'), 'status accepted');
    });

    it('renders minimal completion (no optional fields)', () => {
      const state = makeState();
      const md = renderCompletionMarkdown(state, {});

      // Must have progress + separator + completion message
      assert.ok(md.includes('**Run:**'), 'has progress');
      assert.ok(md.includes('---'), 'has separator');
      assert.ok(md.includes('🎉 **工作流完成！**'), 'has completion');

      // Should NOT have optional fields
      assert.ok(!md.includes('终止原因'), 'no reason');
      assert.ok(!md.includes('轮次:'), 'no rounds');
      assert.ok(!md.includes('Issue 总数'), 'no issues');
      assert.ok(!md.includes('严重度:'), 'no severity');
      assert.ok(!md.includes('状态:'), 'no status');
    });
  });
});
