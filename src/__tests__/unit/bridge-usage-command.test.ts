/**
 * Unit tests for /usage local summary + command rendering.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  parseUsageQueryRange,
  renderUsageReportHtml,
} from '../../lib/bridge/internal/usage-command';
import {
  recordTokenUsageToDailySummary,
  resolveProjectInfoFromWorkingDirectory,
} from '../../lib/bridge/internal/usage-summary';

describe('/usage query parsing', () => {
  it('defaults to today when args empty', () => {
    const now = new Date(2026, 2, 18, 12, 0, 0);
    const range = parseUsageQueryRange('', now);
    assert.equal(range.label, '今天');
    assert.deepStrictEqual(range.dayKeys, ['2026-03-18']);
  });

  it('parses 昨天', () => {
    const now = new Date(2026, 2, 18, 12, 0, 0);
    const range = parseUsageQueryRange('昨天', now);
    assert.equal(range.label, '昨天');
    assert.deepStrictEqual(range.dayKeys, ['2026-03-17']);
  });

  it('parses 最近3天 and chinese numerals', () => {
    const now = new Date(2026, 2, 18, 12, 0, 0);
    const r1 = parseUsageQueryRange('最近3天', now);
    assert.equal(r1.label, '最近3天');
    assert.deepStrictEqual(r1.dayKeys, ['2026-03-16', '2026-03-17', '2026-03-18']);

    const r2 = parseUsageQueryRange('我想看看最近五天的', now);
    assert.equal(r2.label, '最近5天');
    assert.equal(r2.dayKeys.length, 5);
    assert.equal(r2.dayKeys[0], '2026-03-14');
    assert.equal(r2.dayKeys[4], '2026-03-18');
  });
});

describe('project key resolution', () => {
  it('uses git repo root when .git exists', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-to-im-project-'));
    const repoRoot = path.join(tmpDir, 'repo');
    const subDir = path.join(repoRoot, 'sub');
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
    await fs.mkdir(subDir, { recursive: true });

    const info = resolveProjectInfoFromWorkingDirectory(subDir);
    const expectedKey = path.resolve(repoRoot).replaceAll('\\', '/');
    assert.equal(info.projectKey, expectedKey);
    assert.equal(info.projectLabel, 'repo');
  });
});

describe('/usage render from daily summary', () => {
  it('renders no-data message when summary missing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-to-im-usage-'));
    const filePath = path.join(tmpDir, 'usage-summary.json');
    const range = parseUsageQueryRange('', new Date(2026, 2, 18, 12, 0, 0));
    const html = await renderUsageReportHtml({ filePath, range });
    assert.match(html, /暂无统计数据/);
  });

  it('records usage and renders global + top projects', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-to-im-usage-'));
    const filePath = path.join(tmpDir, 'usage-summary.json');
    const now = new Date(2026, 2, 18, 12, 0, 0);

    // project A: 2 turns
    await recordTokenUsageToDailySummary({
      filePath,
      project: { projectKey: 'A', projectLabel: 'Repo-A' },
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 },
      now,
      retentionDays: 365,
    });
    await recordTokenUsageToDailySummary({
      filePath,
      project: { projectKey: 'A', projectLabel: 'Repo-A' },
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 },
      now,
      retentionDays: 365,
    });

    // project B: bigger
    await recordTokenUsageToDailySummary({
      filePath,
      project: { projectKey: 'B', projectLabel: 'Repo-B' },
      usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
      now,
      retentionDays: 365,
    });

    const range = parseUsageQueryRange('今天', now);
    const html = await renderUsageReportHtml({ filePath, range, options: { topN: 5 } });

    // Global totals: A(20/10) + B(100/1) = in 120 / out 11 / total 131
    assert.match(html, /2026-03-18：输入 120 \/ 输出 11 \/ 合计 131/);
    // Cache totals: A(14/4) + B(50/0) = 64/4
    assert.match(html, /缓存读 64 \/ 缓存写 4/);

    // Top projects should list Repo-B first
    const repoBIdx = html.indexOf('1. Repo-B');
    const repoAIdx = html.indexOf('2. Repo-A');
    assert.ok(repoBIdx >= 0 && repoAIdx >= 0 && repoBIdx < repoAIdx);
  });
});
