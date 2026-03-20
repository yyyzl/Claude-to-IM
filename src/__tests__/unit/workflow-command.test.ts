/**
 * Unit tests for workflow-command — `/workflow` 命令解析与子命令分发。
 *
 * 测试范围：
 * - parseWorkflowArgs(): 子命令解析（help/start/status/resume/stop）
 * - _resolveSafePath(): 路径遍历防护
 * - Edge cases: 空输入、缺参、多余参数、--context 解析
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { parseWorkflowArgs, _resolveSafePath } from '../../lib/bridge/internal/workflow-command.js';

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
  // start
  // ================================================================

  describe('start', () => {
    it('parses start with spec and plan paths', () => {
      const result = parseWorkflowArgs('start spec.md plan.md');
      assert.deepStrictEqual(result, {
        kind: 'start',
        specPath: 'spec.md',
        planPath: 'plan.md',
        contextPaths: [],
      });
    });

    it('parses start with --context files', () => {
      const result = parseWorkflowArgs('start spec.md plan.md --context a.md,b.md');
      assert.deepStrictEqual(result, {
        kind: 'start',
        specPath: 'spec.md',
        planPath: 'plan.md',
        contextPaths: ['a.md', 'b.md'],
      });
    });

    it('handles single context file', () => {
      const result = parseWorkflowArgs('start spec.md plan.md --context readme.md');
      assert.deepStrictEqual(result, {
        kind: 'start',
        specPath: 'spec.md',
        planPath: 'plan.md',
        contextPaths: ['readme.md'],
      });
    });

    it('returns help when spec is missing', () => {
      const result = parseWorkflowArgs('start');
      assert.deepStrictEqual(result, { kind: 'help' });
    });

    it('returns help when plan is missing', () => {
      const result = parseWorkflowArgs('start spec.md');
      assert.deepStrictEqual(result, { kind: 'help' });
    });

    it('handles paths with directories', () => {
      const result = parseWorkflowArgs('start .claude/plan/spec.md .claude/plan/plan.md');
      assert.deepStrictEqual(result, {
        kind: 'start',
        specPath: '.claude/plan/spec.md',
        planPath: '.claude/plan/plan.md',
        contextPaths: [],
      });
    });

    it('ignores --context without value', () => {
      const result = parseWorkflowArgs('start spec.md plan.md --context');
      assert.deepStrictEqual(result, {
        kind: 'start',
        specPath: 'spec.md',
        planPath: 'plan.md',
        contextPaths: [],
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
    it('handles uppercase START', () => {
      const result = parseWorkflowArgs('START spec.md plan.md');
      assert.deepStrictEqual(result, {
        kind: 'start',
        specPath: 'spec.md',
        planPath: 'plan.md',
        contextPaths: [],
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
