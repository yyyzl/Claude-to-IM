import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  [k: string]: unknown;
};

const MAX_RECENT_LOG_LINES = 200;
const MAX_RECENT_LOG_LINE_LEN = 800;
export type AppServerProcessFactory = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

type PendingRequest = {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export function redactSensitive(text: string): string {
  let out = text;

  // Common OpenAI-style keys
  out = out.replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-***");

  // Bearer tokens
  out = out.replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer ***");

  // Generic key/value secrets in logs
  out = out.replace(
    /(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|token|secret)["']?\s*[:=]\s*["']?[^\s,;"'}]+/gi,
    "$1=***",
  );

  if (out.length > MAX_RECENT_LOG_LINE_LEN) {
    out = out.slice(0, MAX_RECENT_LOG_LINE_LEN) + "…";
  }
  return out;
}

function safeJsonParse(line: string): JsonRpcMessage | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as JsonRpcMessage;
  } catch {
    return null;
  }
}

function extractLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buffer;
  while (true) {
    const idx = rest.indexOf("\n");
    if (idx < 0) break;
    const line = rest.slice(0, idx).replace(/\r$/, "");
    rest = rest.slice(idx + 1);
    lines.push(line);
  }
  return { lines, rest };
}

export class JsonRpcAppServerClient {
  private command: string[];
  private cwd?: string;
  private debug: boolean;
  private spawnProcess: AppServerProcessFactory;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private emitter = new EventEmitter();
  private backlog: JsonRpcMessage[] = [];

  private stdoutBuffer = "";
  private stderrBuffer = "";
  private recentLogs: string[] = [];

  constructor(opts: { command: string[]; cwd?: string; debug?: boolean; spawnProcess?: AppServerProcessFactory }) {
    this.command = opts.command;
    this.cwd = opts.cwd;
    this.debug = Boolean(opts.debug);
    this.spawnProcess = opts.spawnProcess ?? ((command, args, options) => {
      if (process.env.NODE_TEST_CONTEXT) throw new Error('测试禁止启动真实 Codex 进程，请注入内存 transport/process factory');
      return spawn(command, args, options);
    });
    this.emitter.setMaxListeners(50);
  }

  isRunning(): boolean {
    return Boolean(this.proc && this.proc.exitCode === null && !this.proc.killed);
  }

  getRecentLogs(maxLines = 30): string {
    const n = Math.max(1, Math.min(MAX_RECENT_LOG_LINES, Math.floor(maxLines)));
    return this.recentLogs.slice(-n).join("\n");
  }

  start(): void {
    if (this.isRunning()) return;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.backlog = [];

    const rawBin = this.command[0];
    const rawArgs = this.command.slice(1);

    // Windows 下无法直接 spawn .cmd/.bat（会抛 EINVAL），需要通过 cmd.exe /c 包一层。
    // 这也是飞书侧看到 "Error: spawn EINVAL" 的常见根因。
    const ext = path.extname(rawBin || "").toLowerCase();
    const isWindows = process.platform === "win32";
    const needsCmdWrapper = isWindows && ext !== ".exe" && ext !== ".com";

    const spawnBin = needsCmdWrapper ? (process.env.ComSpec || "cmd.exe") : rawBin;
    const spawnArgs = needsCmdWrapper
      ? ["/d", "/s", "/c", rawBin, ...rawArgs]
      : rawArgs;

    this.proc = this.spawnProcess(spawnBin, spawnArgs, {
      cwd: this.cwd,
      stdio: "pipe",
      windowsHide: true,
    });
    const currentProcess = this.proc;

    this.proc.stdin.setDefaultEncoding("utf8");
    this.proc.stdin.on("error", (error) => {
      if (this.proc !== currentProcess) return;
      const safeError = new Error(redactSensitive(error.message));
      this.rejectAllPending(safeError);
      this.emitter.emit("disconnect", safeError);
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stdout.on("data", (chunk: string) => {
      if (this.proc !== currentProcess) return;
      this.stdoutBuffer += chunk;
      const { lines, rest } = extractLines(this.stdoutBuffer);
      this.stdoutBuffer = rest;
      for (const line of lines) this.handleLine(line, "STDOUT");
    });

    this.proc.stderr.on("data", (chunk: string) => {
      if (this.proc !== currentProcess) return;
      this.stderrBuffer += chunk;
      const { lines, rest } = extractLines(this.stderrBuffer);
      this.stderrBuffer = rest;
      for (const line of lines) {
        const trimmed = (line || "").trim();
        if (!trimmed) continue;
        const safe = redactSensitive(trimmed);
        this.pushRecentLog(`STDERR ${safe}`);
        // 仅 debug 时输出，避免飞书侧噪声/泄漏风险
        if (this.debug) console.warn("[codex-app-server:stderr]", safe);
      }
    });

    this.proc.on("error", (err) => {
      if (this.proc !== currentProcess) return;
      const safeError = new Error(redactSensitive(`codex app-server 启动失败: ${err instanceof Error ? err.message : String(err)}`));
      this.rejectAllPending(safeError);
      this.emitter.emit("disconnect", safeError);
    });

    this.proc.on("exit", (code, signal) => {
      if (this.proc !== currentProcess) return;
      const msg = `[codex-app-server] exited: code=${code ?? "null"} signal=${signal ?? "null"}`;
      this.rejectAllPending(new Error(msg));
      this.emitter.emit("disconnect", new Error(msg));
      this.proc = null;
    });
  }

  stop(): void {
    if (!this.proc) return;
    this.rejectAllPending(new Error("codex app-server 已停止"));
    try {
      if (this.proc.exitCode === null && !this.proc.killed) {
        this.proc.kill();
      }
    } catch {
      // ignore
    } finally {
      this.proc = null;
    }
  }

  onNotification(listener: (msg: JsonRpcMessage) => void): () => void {
    this.emitter.on("notification", listener);
    return () => this.emitter.off("notification", listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.emitter.on("disconnect", listener);
    return () => this.emitter.off("disconnect", listener);
  }

  onServerRequest(listener: (msg: JsonRpcMessage & { id: number | string }) => void): () => void {
    this.emitter.on("serverRequest", listener);
    return () => this.emitter.off("serverRequest", listener);
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ method, ...(params ? { params } : {}) });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private write(payload: JsonRpcMessage): void {
    if (!this.proc || !this.isRunning()) throw new Error("app-server 尚未启动");
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  drainBacklog(predicate: (msg: JsonRpcMessage) => boolean): JsonRpcMessage[] {
    const matched: JsonRpcMessage[] = [];
    const remaining: JsonRpcMessage[] = [];
    for (const msg of this.backlog) {
      if (predicate(msg)) matched.push(msg);
      else remaining.push(msg);
    }
    this.backlog = remaining;
    return matched;
  }

  async request(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
    this.start();
    if (!this.proc || !this.proc.stdin) throw new Error("app-server 尚未启动");

    const id = this.nextRequestId();
    const payload = {
      id,
      method,
      params,
    };

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时: ${method}`));
      }, Math.max(1000, timeoutMs));

      this.pending.set(id, { method, resolve, reject, timer });

      try {
        this.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`发送请求失败: ${method}: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  private nextRequestId(): number {
    this.requestId += 1;
    return this.requestId;
  }

  private handleLine(line: string, _source: "STDOUT" | "STDERR"): void {
    const trimmed = (line || "").trim();
    if (!trimmed) return;

    const msg = safeJsonParse(trimmed);
    if (!msg) {
      const safe = redactSensitive(trimmed);
      this.pushRecentLog(`RAW ${safe}`);
      if (this.debug) console.warn("[codex-app-server:raw]", safe);
      return;
    }
    this.handleMessage(msg);
  }

  private handleMessage(msg: JsonRpcMessage): void {
    const id = msg.id;
    // 双向 RPC 的两个 ID 空间互相独立，必须先区分 method。
    if (typeof msg.method === "string" && (typeof id === "number" || typeof id === "string")) {
      if (this.emitter.listenerCount("serverRequest") === 0) {
        this.respondError(id, -32601, `不支持的服务端请求: ${msg.method}`);
      } else {
        this.emitter.emit("serverRequest", msg);
      }
      return;
    }
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (msg.error) {
        pending.reject(new Error(`请求失败: ${pending.method}: ${redactSensitive(JSON.stringify(msg.error))}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.method === "string") {
      this.backlog.push(msg);
      if (this.backlog.length > 2000) this.backlog.splice(0, this.backlog.length - 2000);
      this.emitter.emit("notification", msg);
    }
  }

  private rejectAllPending(err: Error): void {
    const tail = this.getRecentLogs(30);
    const merged = tail
      ? new Error([err.message, "", "[codex recent logs]", tail].join("\n"))
      : err;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(merged);
      this.pending.delete(id);
    }
  }

  private pushRecentLog(line: string): void {
    this.recentLogs.push(line);
    if (this.recentLogs.length > MAX_RECENT_LOG_LINES) {
      this.recentLogs.splice(0, this.recentLogs.length - MAX_RECENT_LOG_LINES);
    }
  }
}
