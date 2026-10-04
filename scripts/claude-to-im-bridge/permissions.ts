import type { PermissionResolution } from '../../src/lib/bridge/host.js';
export type { PermissionResolution } from '../../src/lib/bridge/host.js';

type Pending = {
  promise: Promise<PermissionResolution>;
  resolve: (resolution: PermissionResolution) => void;
  createdAt: number;
};

export class InMemoryPermissionGateway {
  private pending = new Map<string, Pending>();
  private listeners = new Map<string, Set<(resolution: PermissionResolution) => void>>();
  /** 只保留终态元数据，覆盖事件在消费前已过期的竞态，不保留答案正文。 */
  private completed = new Map<string, PermissionResolution>();

  onResolution(requestId: string, listener: (resolution: PermissionResolution) => void): () => void {
    const completed = this.completed.get(requestId);
    if (completed) { listener(completed); return () => {}; }
    const listeners = this.listeners.get(requestId) ?? new Set();
    listeners.add(listener); this.listeners.set(requestId, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(requestId); };
  }
  /** 权限请求自动超时（毫秒）。<=0 表示不超时。默认 10 分钟。 */
  private permissionTimeoutMs: number;

  constructor(opts?: { permissionTimeoutMs?: number }) {
    const raw = opts?.permissionTimeoutMs;
    this.permissionTimeoutMs = typeof raw === "number" && Number.isFinite(raw) ? raw : 10 * 60_000;
  }

  waitFor(permissionRequestId: string, signal?: AbortSignal): Promise<PermissionResolution> {
    const existing = this.pending.get(permissionRequestId);
    if (existing) return existing.promise;
    this.completed.delete(permissionRequestId);

    let resolver: ((resolution: PermissionResolution) => void) | null = null;
    const promise = new Promise<PermissionResolution>((resolve) => {
      resolver = resolve;
    });

    const pending: Pending = {
      promise,
      resolve: (resolution) => {
        this.pending.delete(permissionRequestId);
        resolver?.(resolution);
        this.completed.set(permissionRequestId, { behavior: resolution.behavior, reason: resolution.reason });
        if (this.completed.size > 100) this.completed.delete(this.completed.keys().next().value!);
        const listeners = this.listeners.get(permissionRequestId);
        this.listeners.delete(permissionRequestId);
        for (const listener of listeners ?? []) { try { listener(resolution); } catch { /* 观察者不改变授权终态。 */ } }
      },
      createdAt: Date.now(),
    };
    this.pending.set(permissionRequestId, pending);

    // 自动超时：超过 permissionTimeoutMs 未回复则自动 deny
    if (this.permissionTimeoutMs > 0) {
      const timer = setTimeout(() => {
        if (this.pending.has(permissionRequestId)) {
          console.warn(
            `[permissions] Permission ${permissionRequestId} timed out after ${Math.ceil(this.permissionTimeoutMs / 60_000)} min, auto-denied`,
          );
          pending.resolve({
            behavior: "deny",
            reason: 'expired',
            message: `Permission timed out after ${Math.ceil(this.permissionTimeoutMs / 60_000)} minutes (auto-denied)`,
          });
        }
      }, this.permissionTimeoutMs);
      // 如果提前被 resolve（用户点了按钮），清除 timer
      promise.then(() => clearTimeout(timer));
    }

    if (signal) {
      if (signal.aborted) {
        pending.resolve({ behavior: "deny", message: "aborted", reason: 'cancelled' });
        return promise;
      }
      const onAbort = () => {
          if (this.pending.has(permissionRequestId)) {
            pending.resolve({ behavior: "deny", message: "aborted", reason: 'cancelled' });
          }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void promise.then(() => signal.removeEventListener("abort", onAbort));
    }

    return promise;
  }

  resolvePendingPermission(permissionRequestId: string, resolution: PermissionResolution): boolean {
    const pending = this.pending.get(permissionRequestId);
    if (!pending) return false;
    pending.resolve(resolution);
    return true;
  }
}
