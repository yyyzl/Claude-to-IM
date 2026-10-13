import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAccountQuotaHtml } from '../../lib/bridge/internal/quota-command.js';
import { buildBridgeCommandHelp } from '../../lib/bridge/internal/bridge-help.js';
import type { AccountQuota } from '../../lib/bridge/host.js';

const queriedAt = Date.parse('2026-10-13T00:00:00Z');
const window = (usedPercent: number, windowDurationMins: number | null, resetsAt: number | null = queriedAt / 1000 + 3600) => ({ usedPercent, windowDurationMins, resetsAt });
function quota(primary: AccountQuota['buckets'][number]['primary'], secondary: AccountQuota['buckets'][number]['secondary'] = null): AccountQuota {
  return { queriedAt, buckets: [{ limitId: 'codex', limitName: '<额度 & "名称">', primary, secondary }] };
}

test('按实际周期命名，展示账号共享范围、北京时间及查询时间，并转义标签', () => {
  const text = renderAccountQuotaHtml(quota(window(25, 10080), window(60, 300)));
  assert.match(text, /周额度.*已用 25%.*剩余 75%/);
  assert.match(text, /5 小时额度.*已用 60%.*剩余 40%/);
  assert.match(text, /2026-10-13 09:00:00/);
  assert.match(text, /查询时间.*2026-10-13 08:00:00/);
  assert.match(text, /北京时间/);
  assert.match(text, /登录账号/);
  assert.match(text, /其它项目和客户端共享/);
  assert.match(text, /&lt;额度 &amp; "名称"&gt;/);
  assert.doesNotMatch(text, /<额度/);
});

for (const [used, left] of [[0, 100], [100, 0], [115, 0]]) {
  test(`已用 ${used}% 正确计算剩余 ${left}%`, () => {
    assert.match(renderAccountQuotaHtml(quota(window(used, 300))), new RegExp(`已用 ${used}%.*剩余 ${left}%`));
  });
}

test('其它与未知周期、缺失时间和到期不能伪装恢复或无限额度', () => {
  const text = renderAccountQuotaHtml(quota(window(40, 90, null), window(55, null, queriedAt / 1000 - 1)));
  assert.match(text, /90 分钟额度/);
  assert.match(text, /次窗口（周期未知）/);
  assert.match(text, /重置时间：未提供/);
  assert.match(text, /时间已到.*不代表额度已恢复/);
  const empty = renderAccountQuotaHtml(quota(null));
  assert.match(empty, /未提供.*窗口/);
  assert.doesNotMatch(empty, /剩余 100%|无限/);
  assert.match(renderAccountQuotaHtml({ queriedAt, buckets: [] }), /未提供.*额度/);
});

test('帮助包含额度查询，保留本地 Token 的 usage 入口', () => {
  assert.match(buildBridgeCommandHelp(), /\/quota/);
  assert.match(buildBridgeCommandHelp(), /\/usage \[今天\|昨天\|最近N天\]/);
});
