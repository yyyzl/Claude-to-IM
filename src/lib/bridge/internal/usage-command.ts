/**
 * /usage 命令：从本地按天汇总文件读取数据并输出。
 *
 * 目标：
 * - 支持中文自然语言：今天 / 昨天 / 最近N天（含中文数字）
 * - 默认输出：全局按天汇总 + Top N 项目（按 total tokens 排序）
 */

import type { UsageSummaryFile, DailyTokenUsage } from './usage-summary.js';
import { formatLocalDateKey, loadUsageSummaryFile } from './usage-summary.js';

export interface UsageQueryRange {
  /** 该查询的展示名称（例如 “今天”/“昨天”/“最近3天”） */
  label: string;
  /** 按顺序的日期 key（YYYY-MM-DD），用于按天输出 */
  dayKeys: string[];
}

export interface AggregatedUsage {
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd?: number;
}

export interface UsageReportOptions {
  topN?: number;
}

const DEFAULT_TOP_N = 5;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return (raw || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function parseChineseNumber(raw: string): number | null {
  const s = normalizeText(raw);
  if (!s) return null;

  // 1) Arabic digits
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  }

  // 2) Chinese numerals (supports 1-99-ish, enough for 1-31)
  const map: Record<string, number> = {
    '零': 0,
    '一': 1,
    '二': 2,
    '两': 2,
    '三': 3,
    '四': 4,
    '五': 5,
    '六': 6,
    '七': 7,
    '八': 8,
    '九': 9,
  };

  if (s === '十') return 10;

  const idx = s.indexOf('十');
  if (idx >= 0) {
    const left = s.slice(0, idx);
    const right = s.slice(idx + 1);
    const tens = left ? (map[left] ?? NaN) : 1;
    const ones = right ? (map[right] ?? NaN) : 0;
    const n = tens * 10 + ones;
    return Number.isFinite(n) ? n : null;
  }

  if (s.length === 1 && map[s] != null) return map[s];
  return null;
}

function buildRangeFromEnd(now: Date, days: number, endOffsetDays: number, label: string): UsageQueryRange {
  const end = new Date(now);
  end.setDate(end.getDate() - endOffsetDays);

  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    dayKeys.push(formatLocalDateKey(d));
  }
  return { label, dayKeys };
}

export function parseUsageQueryRange(argsRaw: string, now: Date = new Date()): UsageQueryRange {
  const text = normalizeText(argsRaw);
  if (!text) return buildRangeFromEnd(now, 1, 0, '今天');

  if (text.includes('今天')) return buildRangeFromEnd(now, 1, 0, '今天');
  if (text.includes('昨天') || text.includes('昨日')) return buildRangeFromEnd(now, 1, 1, '昨天');

  // 最近N天 / 近N天
  const recent = text.match(/(?:最近|近)\s*([0-9一二三四五六七八九十两]+)\s*天/);
  if (recent) {
    const n = parseChineseNumber(recent[1] || '');
    const days = Math.max(1, Math.min(365, n || 0));
    return buildRangeFromEnd(now, days, 0, `最近${days}天`);
  }

  // 兜底：N天（用户常用 “3天”）
  const bare = text.match(/([0-9一二三四五六七八九十两]+)\s*天/);
  if (bare) {
    const n = parseChineseNumber(bare[1] || '');
    const days = Math.max(1, Math.min(365, n || 0));
    return buildRangeFromEnd(now, days, 0, `最近${days}天`);
  }

  // 无法解析 → 默认今天
  return buildRangeFromEnd(now, 1, 0, '今天');
}

function emptyAgg(): AggregatedUsage {
  return {
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function addDaily(into: AggregatedUsage, day: DailyTokenUsage | undefined): void {
  if (!day) return;
  into.turns += day.turns || 0;
  into.input_tokens += day.input_tokens || 0;
  into.output_tokens += day.output_tokens || 0;
  into.cache_read_input_tokens += day.cache_read_input_tokens || 0;
  into.cache_creation_input_tokens += day.cache_creation_input_tokens || 0;
  if (day.cost_usd != null) {
    into.cost_usd = (into.cost_usd ?? 0) + day.cost_usd;
  }
}

function totalTokens(agg: AggregatedUsage): number {
  // cache_* 是 input 的拆分字段，不额外加到 total
  return (agg.input_tokens || 0) + (agg.output_tokens || 0);
}

function formatTokensLine(fmt: Intl.NumberFormat, agg: AggregatedUsage): string {
  const input = fmt.format(Math.round(agg.input_tokens || 0));
  const output = fmt.format(Math.round(agg.output_tokens || 0));
  const total = fmt.format(Math.round(totalTokens(agg)));
  return `输入 ${input} / 输出 ${output} / 合计 ${total}`;
}

function formatCacheHint(fmt: Intl.NumberFormat, agg: AggregatedUsage): string {
  const read = fmt.format(Math.round(agg.cache_read_input_tokens || 0));
  const create = fmt.format(Math.round(agg.cache_creation_input_tokens || 0));
  return `缓存读 ${read} / 缓存写 ${create}`;
}

export async function renderUsageReportHtml(opts: {
  filePath: string;
  range: UsageQueryRange;
  options?: UsageReportOptions;
  now?: Date;
}): Promise<string> {
  const topN = opts.options?.topN ?? DEFAULT_TOP_N;
  const summary: UsageSummaryFile = await loadUsageSummaryFile(opts.filePath);

  const fmt = new Intl.NumberFormat('en-US');

  // 1) Global daily totals
  const globalByDay: Record<string, AggregatedUsage> = {};
  for (const dayKey of opts.range.dayKeys) {
    globalByDay[dayKey] = emptyAgg();
  }

  // 2) Project totals within range
  const projectTotals: Array<{ projectKey: string; label: string; agg: AggregatedUsage }> = [];

  for (const [projectKey, project] of Object.entries(summary.projects || {})) {
    const agg = emptyAgg();
    for (const dayKey of opts.range.dayKeys) {
      const day = project.days?.[dayKey];
      addDaily(agg, day);
      addDaily(globalByDay[dayKey], day);
    }
    if (agg.turns > 0) {
      projectTotals.push({
        projectKey,
        label: project.label || projectKey,
        agg,
      });
    }
  }

  const globalTotal = emptyAgg();
  for (const dayKey of opts.range.dayKeys) {
    addDaily(globalTotal, globalByDay[dayKey]);
  }

  // No data
  if (globalTotal.turns === 0) {
    return [
      '<b>Token 用量</b>',
      '',
      `范围：<code>${escapeHtml(opts.range.label)}</code>（无数据）`,
      '',
      '暂无统计数据：当前还没有记录到任何带 usage 的对话结果。',
      '提示：只有当上游 LLM 返回 result.usage 时，桥接才会写入本地统计。',
    ].join('\n');
  }

  // 3) Top projects
  projectTotals.sort((a, b) => totalTokens(b.agg) - totalTokens(a.agg));
  const top = projectTotals.slice(0, Math.max(0, topN));

  const lines: string[] = [];
  lines.push('<b>Token 用量</b>');
  lines.push('');
  const firstDay = opts.range.dayKeys[0];
  const lastDay = opts.range.dayKeys[opts.range.dayKeys.length - 1];
  const daySpanLabel = opts.range.dayKeys.length === 1
    ? `<code>${escapeHtml(firstDay)}</code>（${escapeHtml(opts.range.label)}）`
    : `<code>${escapeHtml(firstDay)} ~ ${escapeHtml(lastDay)}</code>（${escapeHtml(opts.range.label)}）`;
  lines.push(`范围：${daySpanLabel}`);
  lines.push('');

  lines.push('<b>按天汇总（全局）</b>');
  for (const dayKey of opts.range.dayKeys) {
    const agg = globalByDay[dayKey];
    const core = formatTokensLine(fmt, agg);
    const cache = formatCacheHint(fmt, agg);
    lines.push(`${escapeHtml(dayKey)}：${core}（${cache}）`);
  }

  lines.push('');
  lines.push('<b>合计（全局）</b>');
  lines.push(`${formatTokensLine(fmt, globalTotal)}（${formatCacheHint(fmt, globalTotal)}）`);
  if (globalTotal.cost_usd != null) {
    lines.push(`cost_usd ${globalTotal.cost_usd.toFixed(6)}`);
  }

  if (top.length > 0) {
    lines.push('');
    lines.push(`<b>Top ${top.length} 项目</b>`);
    for (let i = 0; i < top.length; i++) {
      const item = top[i];
      const label = escapeHtml(item.label);
      const core = formatTokensLine(fmt, item.agg);
      const cache = formatCacheHint(fmt, item.agg);
      lines.push(`${i + 1}. ${label}：${core}（${cache}）`);
    }
  }

  return lines.join('\n');
}
