const MINUTES = 60_000;

// 与 conversation-engine 的默认值保持一致：未配置 turn 超时时，默认 90 分钟。
export const DEFAULT_CODEX_TURN_TIMEOUT_MS = 90 * MINUTES;
export const DEFAULT_SESSION_QUEUE_TIMEOUT_MS = 5 * MINUTES;
export const DEFAULT_SESSION_QUEUE_TIMEOUT_EXTRA_MS = 10 * MINUTES;

/**
 * 计算 session 排队超时（毫秒）。
 *
 * 规则：
 * 1) 用户显式配置 bridge_session_queue_timeout_ms（包括 0 关闭）→ 直接使用；
 * 2) 否则使用 turn 超时的生效值 + 10 分钟（turn 超时未配置时，按默认 90 分钟算）；
 * 3) 若 turn 超时关闭（=0）→ 回退到 5 分钟（历史默认）。
 */
export function computeSessionQueueTimeoutMs(
  queueTimeoutSettingMs: number | null,
  turnTimeoutSettingMs: number | null,
): number {
  if (queueTimeoutSettingMs != null) return queueTimeoutSettingMs;
  const effectiveTurnTimeoutMs = (turnTimeoutSettingMs != null) ? turnTimeoutSettingMs : DEFAULT_CODEX_TURN_TIMEOUT_MS;
  if (effectiveTurnTimeoutMs > 0) {
    return effectiveTurnTimeoutMs + DEFAULT_SESSION_QUEUE_TIMEOUT_EXTRA_MS;
  }
  return DEFAULT_SESSION_QUEUE_TIMEOUT_MS;
}
