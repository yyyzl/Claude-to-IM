/**
 * Unit tests for workflow-command — `/workflow` 命令解析与子命令分发。
 *
 * 测试范围：
 * - parseWorkflowArgs(): 子命令解析（help/spec-review/code-review/status/resume/stop）
 * - _resolveSafePath(): 路径遍历防护
 * - Edge cases: 空输入、缺参、多余参数、--context 解析
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
  parseWorkflowArgs,
  _resolveSafePath,
  _renderCompletionMarkdown,
  type _WorkflowProgressState,
} from '../../lib/bridge/internal/workflow-command.js';

// ── Tests ────────────────────────────────────────────────────────

describe('parseWorkflowArgs', () => {

  // ================================================================
  // help
  // ================================================================

  describe('help', () => {
    it('returns help for empty input', () => {
      assert.deepStrictEqual(parseWorkflowArgs(''), { kind: 'help' });
    });

    it('returns help for whitespace-only input', () => {
      assert.deepStrictEqual(parseWorkflowArgs('   '), { kind: 'help' });
    });

    it('returns help for explicit "help"', () => {
      assert.deepStrictEqual(parseWorkflowArgs('help'), { kind: 'help' });
    });

    it('returns help for unknown subcommand', () => {
      assert.deepStrictEqual(parseWorkflowArgs('foobar'), { kind: 'help' });
    });
  });

  // ================================================================
  // spec-review / code-review
  // ================================================================

  describe('spec-review', () => {
    it('parses spec-review with spec and plan paths', () => {
      const result = parseWorkflowArgs('spec-review spec.md plan.md');
      assert.deepStrictEqual(result, {
        kind: 'spec-review',
        specPath: 'spec.md',
        planPath: 'plan.md',
        contextPaths: [],
        claudeModel: undefined,
        codexBackend: undefined,
      });
    });

    it('parses spec-review with --context files', () => {
      const result = parseWorkflowArgs('spec-review spec.md plan.md --context a.md,b.md');
      assert.deepStrictEqual(result, {
        kind: 'spec-review',
        specPath: 'spec.md',
        planPath: 'plan.md',
        contextPaths: ['a.md', 'b.md'],
        claudeModel: undefined,
        codexBackend: undefined,
      });
    });

    it('handles single context file', () => {
      const result = parseWorkflowArgs('spec-review spec.md plan.md --context readme.md');
      assert.deepStrictEqual(result, {
        kind: 'spec-review',
        specPath: 'spec.md',
        planPath: 'plan.md',
        contextPaths: ['readme.md'],
        claudeModel: undefined,
        codexBackend: undefined,
      });
    });

    it('returns help when spec is missing', () => {
      const result = parseWorkflowArgs('spec-review');
      assert.deepStrictEqual(result, { kind: 'help' });
    });

    it('returns help when plan is missing', () => {
      const result = parseWorkflowArgs('spec-review spec.md');
      assert.deepStrictEqual(result, { kind: 'help' });
    });

    it('handles paths with directories', () => {
      const result = parseWorkflowArgs('spec-review .claude/plan/spec.md .claude/plan/plan.md');
      assert.deepStrictEqual(result, {
        kind: 'spec-review',
        specPath: '.claude/plan/spec.md',
        planPath: '.claude/plan/plan.md',
        contextPaths: [],
        claudeModel: undefined,
        codexBackend: undefined,
      });
    });

    it('handles spec and plan in different subdirectories', () => {
      // /workflow spec-review docs/spec.md plans/plan.md  ✅ 可以不同子目录
      const result = parseWorkflowArgs('spec-review docs/spec.md plans/plan.md');
      assert.deepStrictEqual(result, {
        kind: 'spec-review',
        specPath: 'docs/spec.md',
        planPath: 'plans/plan.md',
        contextPaths: [],
        claudeModel: undefined,
        codexBackend: undefined,
      });
    });

    it('ignores --context without value', () => {
      const result = parseWorkflowArgs('spec-review spec.md plan.md --context');
      assert.deepStrictEqual(result, {
        kind: 'spec-review',
        specPath: 'spec.md',
        planPath: 'plan.md',
        contextPaths: [],
        claudeModel: undefined,
        codexBackend: undefined,
      });
    });

    it('parses --model flag', () => {
      const result = parseWorkflowArgs('spec-review spec.md plan.md --model claude-opus-4-20250514');
      assert.deepStrictEqual(result, {
        kind: 'spec-review',
        specPath: 'spec.md',
        planPath: 'plan.md',
        contextPaths: [],
        claudeModel: 'claude-opus-4-20250514',
        codexBackend: undefined,
      });
    });

    it('parses --codex-backend flag', () => {
      const result = parseWorkflowArgs('spec-review spec.md plan.md --codex-backend gemini');
      assert.deepStrictEqual(result, {
        kind: 'spec-review',
        specPath: 'spec.md',
        planPath: 'plan.md',
        contextPaths: [],
        claudeModel: undefined,
        codexBackend: 'gemini',
      });
    });

    it('parses all flags together', () => {
      const result = parseWorkflowArgs('spec-review spec.md plan.md --context a.md --model claude-opus-4-20250514 --codex-backend gemini');
      assert.deepStrictEqual(result, {
        kind: 'spec-review',
        specPath: 'spec.md',
        planPath: 'plan.md',
        contextPaths: ['a.md'],
        claudeModel: 'claude-opus-4-20250514',
        codexBackend: 'gemini',
      });
    });
  });

  describe('code-review', () => {
    it('parses code-review with default staged scope', () => {
      const result = parseWorkflowArgs('code-review');
      assert.deepStrictEqual(result, {
        kind: 'code-review',
        range: undefined,
        branchDiff: undefined,
        excludePatterns: undefined,
        contextPaths: [],
        claudeModel: undefined,
        codexBackend: undefined,
      });
    });

    it('parses code-review with --range', () => {
      const result = parseWorkflowArgs('code-review --range main..HEAD');
      assert.deepStrictEqual(result, {
        kind: 'code-review',
        range: 'main..HEAD',
        branchDiff: undefined,
        excludePatterns: undefined,
        contextPaths: [],
        claudeModel: undefined,
        codexBackend: undefined,
      });
    });

    it('parses code-review with branch diff, exclude, context and model flags', () => {
      const result = parseWorkflowArgs(
        'code-review --branch-diff main --exclude *.test.ts,*.md --context docs/review.md --model claude-opus-4-20250514 --codex-backend gemini',
      );
      assert.deepStrictEqual(result, {
        kind: 'code-review',
        range: undefined,
        branchDiff: 'main',
        excludePatterns: ['*.test.ts', '*.md'],
        contextPaths: ['docs/review.md'],
        claudeModel: 'claude-opus-4-20250514',
        codexBackend: 'gemini',
      });
    });
  });

  // ================================================================
  // status
  // ================================================================

  describe('status', () => {
    it('parses status without run-id', () => {
      const result = parseWorkflowArgs('status');
      assert.deepStrictEqual(result, { kind: 'status', runId: undefined });
    });

    it('parses status with run-id', () => {
      const result = parseWorkflowArgs('status 20260320-a3f1b2');
      assert.deepStrictEqual(result, { kind: 'status', runId: '20260320-a3f1b2' });
    });
  });

  // ================================================================
  // resume
  // ================================================================

  describe('resume', () => {
    it('parses resume with run-id', () => {
      const result = parseWorkflowArgs('resume 20260320-a3f1b2');
      assert.deepStrictEqual(result, { kind: 'resume', runId: '20260320-a3f1b2' });
    });

    it('returns help when run-id is missing', () => {
      const result = parseWorkflowArgs('resume');
      assert.deepStrictEqual(result, { kind: 'help' });
    });
  });

  // ================================================================
  // stop
  // ================================================================

  describe('stop', () => {
    it('parses stop without run-id', () => {
      const result = parseWorkflowArgs('stop');
      assert.deepStrictEqual(result, { kind: 'stop', runId: undefined });
    });

    it('parses stop with run-id', () => {
      const result = parseWorkflowArgs('stop 20260320-a3f1b2');
      assert.deepStrictEqual(result, { kind: 'stop', runId: '20260320-a3f1b2' });
    });
  });

  // ================================================================
  // Case insensitivity
  // ================================================================

  describe('case insensitivity', () => {
    it('handles uppercase SPEC-REVIEW', () => {
      const result = parseWorkflowArgs('SPEC-REVIEW spec.md plan.md');
      assert.deepStrictEqual(result, {
        kind: 'spec-review',
        specPath: 'spec.md',
        planPath: 'plan.md',
        contextPaths: [],
        claudeModel: undefined,
        codexBackend: undefined,
      });
    });

    it('handles uppercase CODE-REVIEW', () => {
      const result = parseWorkflowArgs('CODE-REVIEW --range HEAD~1..HEAD');
      assert.deepStrictEqual(result, {
        kind: 'code-review',
        range: 'HEAD~1..HEAD',
        branchDiff: undefined,
        excludePatterns: undefined,
        contextPaths: [],
        claudeModel: undefined,
        codexBackend: undefined,
      });
    });

    it('handles mixed case Status', () => {
      const result = parseWorkflowArgs('Status');
      assert.deepStrictEqual(result, { kind: 'status', runId: undefined });
    });

    it('handles RESUME with run-id', () => {
      const result = parseWorkflowArgs('RESUME abc123');
      assert.deepStrictEqual(result, { kind: 'resume', runId: 'abc123' });
    });
  });

  describe('compat removal', () => {
    it('returns help for legacy start syntax', () => {
      const result = parseWorkflowArgs('start spec.md plan.md');
      assert.deepStrictEqual(result, { kind: 'help' });
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// resolveSafePath (path traversal guard)
// ══════════════════════════════════════════════════════════════════

describe('resolveSafePath', () => {
  // Use a consistent cwd for tests (works on both Windows and POSIX)
  const cwd = path.resolve('/project/myapp');

  describe('allows paths within cwd', () => {
    it('allows a simple filename', () => {
      const result = _resolveSafePath(cwd, 'spec.md');
      assert.equal(result, path.join(cwd, 'spec.md'));
    });

    it('allows a nested relative path', () => {
      const result = _resolveSafePath(cwd, 'docs/spec.md');
      assert.equal(result, path.join(cwd, 'docs', 'spec.md'));
    });

    it('allows a deeply nested path', () => {
      const result = _resolveSafePath(cwd, 'a/b/c/d.md');
      assert.equal(result, path.join(cwd, 'a', 'b', 'c', 'd.md'));
    });

    it('normalizes redundant ./ prefix', () => {
      const result = _resolveSafePath(cwd, './spec.md');
      assert.equal(result, path.join(cwd, 'spec.md'));
    });
  });

  describe('rejects paths outside cwd', () => {
    it('rejects parent traversal (../)', () => {
      assert.equal(_resolveSafePath(cwd, '../secret.md'), null);
    });

    it('rejects deep parent traversal (../../)', () => {
      assert.equal(_resolveSafePath(cwd, '../../etc/passwd'), null);
    });

    it('rejects cross-repo traversal as spec path', () => {
      // /workflow spec-review ../../other-repo/spec.md plan.md  ❌ 被路径遍历保护拦住
      assert.equal(_resolveSafePath(cwd, '../../other-repo/spec.md'), null);
    });

    it('rejects traversal via subdirectory (sub/../../out)', () => {
      assert.equal(_resolveSafePath(cwd, 'sub/../../out.md'), null);
    });

    it('rejects absolute path outside cwd', () => {
      // Absolute path that doesn't start with cwd
      const outsidePath = path.resolve('/other/project/file.md');
      assert.equal(_resolveSafePath(cwd, outsidePath), null);
    });
  });
});

describe('renderCompletionMarkdown', () => {
  it('includes report artifact hints when provided', () => {
    const state: _WorkflowProgressState = {
      runId: 'run-123',
      currentRound: 2,
      rounds: new Map(),
      cardMode: false,
      cardCreated: false,
      startedAt: Date.now(),
      updateTimer: null,
    };

    const output = _renderCompletionMarkdown(state, {
      reason: 'lgtm',
      total_rounds: 2,
      total_issues: 3,
      report_markdown_path: '.claude-workflows/runs/run-123/code-review-report.md',
      report_json_path: '.claude-workflows/runs/run-123/code-review-report.json',
    } as {
      total_rounds?: number;
      total_issues?: number;
      reason?: string;
      severity?: { critical?: number; high?: number; medium?: number; low?: number };
      status?: { open?: number; accepted?: number; rejected?: number; deferred?: number; resolved?: number };
      report_markdown_path?: string;
      report_json_path?: string;
    });

    assert.ok(output.includes('code-review-report.md'));
    assert.ok(output.includes('code-review-report.json'));
    assert.ok(output.includes('报告'));
  });
});
