export class SessionQueueTimeoutError extends Error {
  timeoutMs: number;

  constructor(sessionId: string, timeoutMs: number) {
    super(`Session ${sessionId} is busy, queue timeout`);
    this.name = 'SessionQueueTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 对同一 session 的任务做串行化执行（同一 session 串行，不同 session 并行）。
 *
 * 注意：queueTimeoutMs 只统计“排队等待锁”的时间，不包含 fn 的执行时间。
 * - 超时前仍未轮到本任务执行：reject SessionQueueTimeoutError，并跳过 fn。
 * - 一旦开始执行 fn：不再触发队列超时。
 */
export function processWithSessionLock(
  locks: Map<string, Promise<void>>,
  sessionId: string,
  fn: () => Promise<void>,
  queueTimeoutMs: number,
): Promise<void> {
  const prev = locks.get(sessionId) || Promise.resolve();

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const current = prev.catch(() => {}).then(async () => {
    // 已从队列出队：后续不再受“排队超时”影响
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (cancelled) return;
    await fn();
  });

  // 队列锁链必须吞掉错误，避免阻断后续任务
  const lockPromise = current.then(() => {}, () => {});
  locks.set(sessionId, lockPromise);

  // 仅当本任务仍是队列尾部时才清理，避免误删后续任务的锁
  lockPromise.finally(() => {
    if (locks.get(sessionId) === lockPromise) {
      locks.delete(sessionId);
    }
  }).catch(() => {});

  if (queueTimeoutMs <= 0) return current;

  return new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      cancelled = true;
      timer = null;
      reject(new SessionQueueTimeoutError(sessionId, queueTimeoutMs));
    }, queueTimeoutMs);

    current.then(resolve, reject);
  });
}

