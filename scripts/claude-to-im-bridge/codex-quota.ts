/** 校验 Codex 账号额度协议，只向桥接核心提供公开额度字段。 */
import type { AccountQuota, AccountQuotaBucket, AccountQuotaWindow } from '../../src/lib/bridge/host.js';

function invalidQuota(): never {
  throw new Error('Codex 额度响应格式无效，请稍后重试。');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidQuota();
  return value as Record<string, unknown>;
}

function nullableLabel(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return invalidQuota();
  return value.trim() || null;
}

function parseWindow(value: unknown): AccountQuotaWindow | null {
  if (value == null) return null;
  const raw = object(value);
  if (typeof raw.usedPercent !== 'number' || !Number.isSafeInteger(raw.usedPercent) || raw.usedPercent < 0) return invalidQuota();
  const duration = raw.windowDurationMins;
  if (duration != null && (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration <= 0)) return invalidQuota();
  const resetsAt = raw.resetsAt;
  if (resetsAt != null && (typeof resetsAt !== 'number' || !Number.isSafeInteger(resetsAt) || resetsAt < 0 || !Number.isFinite(new Date(resetsAt * 1000).getTime()))) return invalidQuota();
  return { usedPercent: raw.usedPercent, windowDurationMins: typeof duration === 'number' ? duration : null, resetsAt: typeof resetsAt === 'number' ? resetsAt : null };
}

function parseBucket(value: unknown, fallbackId?: string): AccountQuotaBucket {
  const raw = object(value);
  return {
    limitId: nullableLabel(raw.limitId) ?? fallbackId ?? null,
    limitName: nullableLabel(raw.limitName),
    primary: parseWindow(raw.primary),
    secondary: parseWindow(raw.secondary),
  };
}

/** 0.160.0 的单/多额度桶。只投影显示字段，绝不传播原始响应。 */
export function parseCodexAccountQuota(value: unknown, queriedAt = Date.now()): AccountQuota {
  const raw = object(value);
  // 正式 schema 要求提供单桶；多桶有效时仅采用多桶，避免重复镜像。
  object(raw.rateLimits);
  const byId = raw.rateLimitsByLimitId == null ? null : object(raw.rateLimitsByLimitId);
  const entries = byId ? Object.entries(byId) : [];
  const buckets = entries.length
    ? entries.map(([id, bucket]) => parseBucket(bucket, id))
    : [parseBucket(raw.rateLimits)];
  return { queriedAt, buckets };
}
