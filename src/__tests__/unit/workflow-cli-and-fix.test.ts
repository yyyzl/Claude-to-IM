/**
 * Unit tests for:
 * - CLI argument parsing (cli.ts subcommands)
 * - AutoFixer types and structure
 * - workflow-command review-fix parsing
 * - buildWorkflowCardJson interactive buttons
 *
 * @module __tests__/unit/workflow-cli-and-fix
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── CLI parseArgs is not exported, so we test via workflow-command parsing ──

import {
  parseWorkflowArgs,
} from '../../lib/bridge/internal/workflow-command.js';

import {
  buildWorkflowCardJson,
} from '../../lib/bridge/markdown/feishu.js';

import type {
  FixResult,
  AutoFixOptions,
} from '../../lib/workflow/types.js';

// ── Tests ────────────────────────────────────────────────────────

describe('workflow-command review-fix parsing', () => {

  it('parses bare review-fix (staged by default)', () => {
    const result = parseWorkflowArgs('review-fix');
    assert.equal(result.kind, 'review-fix');
    if (result.kind === 'review-fix') {
      assert.equal(result.range, undefined);
      assert.equal(result.branchDiff, undefined);
      assert.deepStrictEqual(result.contextPaths, []);
    }
  });

  it('parses review-fix with --range', () => {
    const result = parseWorkflowArgs('review-fix --range HEAD~3..HEAD');
    assert.equal(result.kind, 'review-fix');
    if (result.kind === 'review-fix') {
      assert.equal(result.range, 'HEAD~3..HEAD');
    }
  });

  it('parses review-fix with --branch-diff', () => {
    const result = parseWorkflowArgs('review-fix --branch-diff main');
    assert.equal(result.kind, 'review-fix');
    if (result.kind === 'review-fix') {
      assert.equal(result.branchDiff, 'main');
    }
  });

  it('parses review-fix with --exclude', () => {
    const result = parseWorkflowArgs('review-fix --exclude *.test.ts,*.md');
    assert.equal(result.kind, 'review-fix');
    if (result.kind === 'review-fix') {
      assert.deepStrictEqual(result.excludePatterns, ['*.test.ts', '*.md']);
    }
  });

  it('parses review-fix with --context', () => {
    const result = parseWorkflowArgs('review-fix --context tsconfig.json,package.json');
    assert.equal(result.kind, 'review-fix');
    if (result.kind === 'review-fix') {
      assert.deepStrictEqual(result.contextPaths, ['tsconfig.json', 'package.json']);
    }
  });

  it('parses review-fix with --model and --codex-backend', () => {
    const result = parseWorkflowArgs('review-fix --model claude-opus --codex-backend gemini');
    assert.equal(result.kind, 'review-fix');
    if (result.kind === 'review-fix') {
      assert.equal(result.claudeModel, 'claude-opus');
      assert.equal(result.codexBackend, 'gemini');
    }
  });

  it('parses review-fix with all options combined', () => {
    const result = parseWorkflowArgs(
      'review-fix --branch-diff main --exclude *.test.ts --context tsconfig.json --model claude-opus',
    );
    assert.equal(result.kind, 'review-fix');
    if (result.kind === 'review-fix') {
      assert.equal(result.branchDiff, 'main');
      assert.deepStrictEqual(result.excludePatterns, ['*.test.ts']);
      assert.deepStrictEqual(result.contextPaths, ['tsconfig.json']);
      assert.equal(result.claudeModel, 'claude-opus');
    }
  });
});

describe('FixResult type structure', () => {
  it('FixResult has all required fields', () => {
    const result: FixResult = {
      success: true,
      totalCount: 5,
      fixedCount: 3,
      fixedIssueIds: ['ISS-001', 'ISS-002', 'ISS-003'],
      failedIssueIds: ['ISS-004', 'ISS-005'],
      errors: ['Failed to fix file.ts'],
      worktreePath: '/tmp/auto-fix',
      worktreeBranch: 'auto-fix/20260324-abc123',
      diffPreview: '--- a/file.ts\n+++ b/file.ts\n-old\n+new',
    };

    assert.equal(result.success, true);
    assert.equal(result.totalCount, 5);
    assert.equal(result.fixedCount, 3);
    assert.equal(result.fixedIssueIds.length, 3);
    assert.equal(result.failedIssueIds.length, 2);
    assert.equal(result.errors.length, 1);
  });

  it('AutoFixOptions has all optional fields', () => {
    const opts: AutoFixOptions = {};
    assert.equal(opts.codexBackend, undefined);
    assert.equal(opts.codexTimeoutMs, undefined);
    assert.equal(opts.maxConcurrency, undefined);

    const optsWithValues: AutoFixOptions = {
      codexBackend: 'codex',
      codexTimeoutMs: 300_000,
      maxConcurrency: 2,
    };
    assert.equal(optsWithValues.codexBackend, 'codex');
    assert.equal(optsWithValues.codexTimeoutMs, 300_000);
  });
});

describe('buildWorkflowCardJson with interactive buttons', () => {

  it('renders card without buttons when runId is not provided', () => {
    const json = buildWorkflowCardJson('**Progress**');
    const card = JSON.parse(json);
    assert.equal(card.schema, '2.0');
    assert.equal(card.body.elements.length, 1);
    assert.equal(card.body.elements[0].tag, 'markdown');
  });

  it('renders card with stop button when running', () => {
    const json = buildWorkflowCardJson('Round 1...', {
      runId: 'test-run-123',
      isRunning: true,
    });
    const card = JSON.parse(json);

    // Find column_set element (buttons container)
    const columnSet = card.body.elements.find(
      (e: Record<string, unknown>) => e.tag === 'column_set',
    );
    assert.ok(columnSet, 'Should have column_set for buttons');

    const columns = columnSet.columns as Array<Record<string, unknown>>;
    assert.ok(columns.length > 0, 'Should have at least one button column');

    // Find stop button
    const stopColumn = columns.find((col: any) =>
      col.elements?.[0]?.value?.callback_data === 'workflow:stop:test-run-123',
    );
    assert.ok(stopColumn, 'Should have stop button');
  });

  it('renders card with resume + report buttons when completed', () => {
    const json = buildWorkflowCardJson('Done!', {
      runId: 'test-run-456',
      isRunning: false,
      hasReport: true,
    });
    const card = JSON.parse(json);

    const columnSet = card.body.elements.find(
      (e: Record<string, unknown>) => e.tag === 'column_set',
    );
    assert.ok(columnSet, 'Should have column_set for buttons');

    const columns = columnSet.columns as Array<Record<string, unknown>>;

    // Find report button
    const reportBtn = columns.find((col: any) =>
      col.elements?.[0]?.value?.callback_data === 'workflow:report:test-run-456',
    );
    assert.ok(reportBtn, 'Should have report button');

    // Find resume button
    const resumeBtn = columns.find((col: any) =>
      col.elements?.[0]?.value?.callback_data === 'workflow:resume:test-run-456',
    );
    assert.ok(resumeBtn, 'Should have resume button');
  });

  it('renders card with footer when provided', () => {
    const json = buildWorkflowCardJson('Content', {
      footer: { status: '🔄 运行中', elapsed: '2m 30s' },
    });
    const card = JSON.parse(json);

    // Find notation element (footer)
    const notation = card.body.elements.find(
      (e: Record<string, unknown>) => e.text_size === 'notation',
    );
    assert.ok(notation, 'Should have notation footer');
    assert.ok((notation.content as string).includes('2m 30s'));
  });

  it('renders card with custom header title', () => {
    const json = buildWorkflowCardJson('Content', {
      headerTitle: '🔍 Code-Review 工作流',
      headerTemplate: 'green',
    });
    const card = JSON.parse(json);
    assert.equal(card.header.title.content, '🔍 Code-Review 工作流');
    assert.equal(card.header.template, 'green');
  });

  it('handles empty content gracefully', () => {
    const json = buildWorkflowCardJson('');
    const card = JSON.parse(json);
    // Empty content should not generate a markdown element
    assert.equal(card.body.elements.length, 0);
  });
});

describe('CLI subcommand compatibility (via parseWorkflowArgs)', () => {

  it('code-review still works as before', () => {
    const result = parseWorkflowArgs('code-review --range HEAD~1..HEAD');
    assert.equal(result.kind, 'code-review');
    if (result.kind === 'code-review') {
      assert.equal(result.range, 'HEAD~1..HEAD');
    }
  });

  it('spec-review still works as before', () => {
    const result = parseWorkflowArgs('spec-review spec.md plan.md');
    assert.equal(result.kind, 'spec-review');
    if (result.kind === 'spec-review') {
      assert.equal(result.specPath, 'spec.md');
      assert.equal(result.planPath, 'plan.md');
    }
  });

  it('status still works as before', () => {
    const result = parseWorkflowArgs('status my-run-id');
    assert.equal(result.kind, 'status');
    if (result.kind === 'status') {
      assert.equal(result.runId, 'my-run-id');
    }
  });

  it('resume still works as before', () => {
    const result = parseWorkflowArgs('resume my-run-id');
    assert.equal(result.kind, 'resume');
    if (result.kind === 'resume') {
      assert.equal(result.runId, 'my-run-id');
    }
  });

  it('stop still works as before', () => {
    const result = parseWorkflowArgs('stop my-run-id');
    assert.equal(result.kind, 'stop');
    if (result.kind === 'stop') {
      assert.equal(result.runId, 'my-run-id');
    }
  });

  it('help still works as before', () => {
    assert.deepStrictEqual(parseWorkflowArgs(''), { kind: 'help' });
    assert.deepStrictEqual(parseWorkflowArgs('help'), { kind: 'help' });
  });
});
