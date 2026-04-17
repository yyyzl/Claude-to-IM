/**
 * 模型上下文窗口注册表 + Context Usage footer 构造器。
 *
 * 职责边界：
 * - 只封装"根据模型名推算 context window 大小"与"把 TokenUsage 渲染成 footer 字符串"两件事
 * - 不做 I/O、不读设置、不依赖具体 adapter
 * - 对未知模型返回 null，调用方决定是否回退到 {@link DEFAULT_CONTEXT_WINDOW}
 *
 * 语义说明：
 * - Anthropic `TokenUsage.input_tokens` 指"未命中缓存的新 input"，不含 cache_read / cache_creation
 * - 当前 turn 的上下文窗口占用（也是衡量"离满还有多远"的口径）= input + cache_creation + cache_read
 * - 因此 {@link totalInputTokens} 做三项相加
 *
 * 用户可见格式（PRD 锁定）：
 *   ctx 42% (420k/1M)
 */

import type { TokenUsage } from '../host.js';

/**
 * Context window 兜底值 = 1,000,000 (1M)。
 *
 * 取 1M 的理由：本桥接主力模型为 Claude Sonnet 4.5，在启用
 * `anthropic-beta: context-1m-2025-08-07` 后窗口即为 1M；为了让 ctx footer
 * 在主力场景下准确，全表统一使用 1M。
 *
 * 已知代价：Opus / Haiku 等没有 1M beta 的模型也会按 1M 分母计算，
 * 占比数字会偏小（但不会出现 `>100%` 的错误数字）。将来按需要可以细分。
 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * Prefix 匹配表。
 * 按 prefix 匹配以容忍 date suffix（如 `claude-sonnet-4-5-20250929`）。
 * 插入顺序 = 匹配优先级：**长前缀在前**，避免被短前缀抢先命中。
 *
 * 窗口取值：当前全表统一 1M（见 DEFAULT_CONTEXT_WINDOW 的 JSDoc 说明）。
 * 若未来需要按模型细分，只需替换对应行数值，无需改动 {@link resolveContextWindow}。
 */
const PREFIX_WINDOW_TABLE: ReadonlyArray<readonly [string, number]> = [
  // Claude 4.x 家族（Sonnet 4.5 / 4 开启 beta 后为真正 1M；Opus/Haiku 实际 200k，暂统一按 1M 分母计算）
  ['claude-opus-4', 1_000_000],
  ['claude-sonnet-4', 1_000_000],
  ['claude-haiku-4', 1_000_000],
  // Claude 3.7 / 3.5 家族（实际 200k，暂统一按 1M）
  ['claude-3-7-sonnet', 1_000_000],
  ['claude-3-5-sonnet', 1_000_000],
  ['claude-3-5-haiku', 1_000_000],
  // Claude 3 家族（实际 200k，暂统一按 1M）
  ['claude-3-opus', 1_000_000],
  ['claude-3-sonnet', 1_000_000],
  ['claude-3-haiku', 1_000_000],
];

/**
 * 解析指定模型的 context window 大小。
 *
 * @param model 模型 id（`ChannelBinding.model` 或 `BridgeSession.model`）
 * @returns 命中返回窗口值；未命中 / 非法输入返回 null
 */
export function resolveContextWindow(model: string | null | undefined): number | null {
  if (!model || typeof model !== 'string') return null;
  const lowered = model.toLowerCase();
  for (const [prefix, window] of PREFIX_WINDOW_TABLE) {
    if (lowered.startsWith(prefix)) return window;
  }
  return null;
}

/**
 * 把 `TokenUsage` 还原为"本 turn 完整 input 规模"。
 * 公式：input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *
 * 任一字段非数字 / 负数 / NaN 都视为 0，保证不抛。
 */
export function totalInputTokens(usage: TokenUsage | null | undefined): number {
  if (!usage) return 0;
  return safeNum(usage.input_tokens)
    + safeNum(usage.cache_creation_input_tokens)
    + safeNum(usage.cache_read_input_tokens);
}

/**
 * 把 token 数缩写成短形式：
 * - `< 1000` → 原数（取整）
 * - `>= 1000` → 除以 1000，保留 1 位小数；整数去掉 `.0`
 *
 * 例：`6708 → "6.7k"`，`200000 → "200k"`，`999 → "999"`。
 */
export function formatTokenShort(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return `${Math.round(n)}`;
  const k = n / 1000;
  const rounded = Math.round(k * 10) / 10;
  if (rounded % 1 === 0) return `${rounded.toFixed(0)}k`;
  return `${rounded.toFixed(1)}k`;
}

/**
 * 构造一条 ctx footer 字符串，形如 `ctx 42% (84k/200k)`。
 *
 * 规则：
 * - `usage` 为空 / 未提供时返回 null（调用方不渲染该 footer）
 * - `window` 非正数 / NaN 时返回 null
 * - 总 input 为 0（例如某些错误路径）时返回 null，避免显示 `ctx 0% (0/200k)` 噪声
 * - 百分比四舍五入取整，并硬上限 999% 防止极端数据把行撑爆
 */
export function formatCtxFooter(
  usage: TokenUsage | null | undefined,
  window: number,
): string | null {
  if (!Number.isFinite(window) || window <= 0) return null;
  const input = totalInputTokens(usage);
  if (input <= 0) return null;
  const pctRaw = (input / window) * 100;
  const pct = Math.min(999, Math.max(0, Math.round(pctRaw)));
  return `ctx ${pct}% (${formatTokenShort(input)}/${formatTokenShort(window)})`;
}

function safeNum(v: number | null | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return v;
}
