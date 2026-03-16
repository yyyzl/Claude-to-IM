export type PermissionBehavior = "allow" | "deny";

export interface PermissionResolution {
  behavior: PermissionBehavior;
  message?: string;
  updatedPermissions?: unknown[];
}

type Pending = {
  promise: Promise<PermissionResolution>;
  resolve: (resolution: PermissionResolution) => void;
  createdAt: number;
};

export class InMemoryPermissionGateway {
  private pending = new Map<string, Pending>();
  /** 权限请求自动超时（毫秒）。<=0 表示不超时。默认 10 分钟。 */
  private permissionTimeoutMs: number;

  constructor(opts?: { permissionTimeoutMs?: number }) {
    const raw = opts?.permissionTimeoutMs;
    this.permissionTimeoutMs = typeof raw === "number" && Number.isFinite(raw) ? raw : 10 * 60_000;
  }

  waitFor(permissionRequestId: string, signal?: AbortSignal): Promise<PermissionResolution> {
    const existing = this.pending.get(permissionRequestId);
    if (existing) return existing.promise;

    let resolver: ((resolution: PermissionResolution) => void) | null = null;
    const promise = new Promise<PermissionResolution>((resolve) => {
      resolver = resolve;
    });

    const pending: Pending = {
      promise,
      resolve: (resolution) => {
        this.pending.delete(permissionRequestId);
        resolver?.(resolution);
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
            message: `Permission timed out after ${Math.ceil(this.permissionTimeoutMs / 60_000)} minutes (auto-denied)`,
          });
        }
      }, this.permissionTimeoutMs);
      // 如果提前被 resolve（用户点了按钮），清除 timer
      promise.then(() => clearTimeout(timer));
    }

    if (signal) {
      if (signal.aborted) {
        pending.resolve({ behavior: "deny", message: "aborted" });
        return promise;
      }
      signal.addEventListener(
        "abort",
        () => {
          if (this.pending.has(permissionRequestId)) {
            pending.resolve({ behavior: "deny", message: "aborted" });
          }
        },
        { once: true },
      );
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
