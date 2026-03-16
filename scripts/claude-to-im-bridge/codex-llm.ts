import path from "node:path";

import type { InMemoryPermissionGateway } from "./permissions.ts";
import type { LLMProvider, StreamChatParams } from "./llm.ts";
import { JsonRpcAppServerClient, type JsonRpcMessage } from "./codex-jsonrpc.ts";
import { buildTurnSandboxPolicy, resolveCodexBinary, selectCodexModel } from "./codex-utils.ts";

function redactSensitive(text: string): string {
  let out = text;
  out = out.replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-***");
  out = out.replace(/\bBearer\s+\S+/gi, "Bearer ***");
  out = out.replace(
    /(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|token|secret)\s*[:=]\s*([^\s,;]+)/gi,
    "$1=***",
  );
  return out;
}

function safeStringify(obj: unknown): string {
  try {
    return redactSensitive(JSON.stringify(obj));
  } catch {
    return redactSensitive(String(obj));
  }
}

type ModelListResult = {
  data?: unknown[];
  [k: string]: unknown;
};

type ThreadStartResult = {
  thread?: { id?: string };
  [k: string]: unknown;
};

type TurnStartResult = {
  turn?: { id?: string };
  [k: string]: unknown;
};

function emit(controller: ReadableStreamDefaultController<string>, type: string, data: unknown): void {
  const payload = {
    type,
    data: typeof data === "string" ? data : JSON.stringify(data),
  };
  controller.enqueue(`data: ${JSON.stringify(payload)}\n`);
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function abortError(message = "Task stopped by user"): Error {
  const e = new Error(message);
  (e as any).name = "AbortError";
  return e;
}

function pickString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function parseCodexCliConfigOverrides(raw: string | undefined): string[] {
  const text = (raw || "").trim();
  if (!text) return [];

  const splitByNewline = text.includes("\n") || text.includes("\r");
  const parts = splitByNewline ? text.split(/\r?\n/) : text.split(";");

  const overrides = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !p.startsWith("#"));

  for (const item of overrides) {
    const eq = item.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        [
          "bridge_codex_cli_config 配置不合法：每一项必须是 key=value",
          `收到：${item}`,
          "",
          "示例：",
          "  bridge_codex_cli_config=model_provider=openai",
          "  bridge_codex_cli_config=\"model_provider=openai\\nfeatures.some_flag=true\"",
        ].join("\n"),
      );
    }
  }

  return overrides;
}

function extractHttpStatusFromTurnError(errObj: unknown): number | null {
  const e = errObj as any;
  const candidates = [
    e?.httpStatusCode,
    e?.status,
    e?.codexErrorInfo?.responseStreamDisconnected?.httpStatusCode,
    e?.codexErrorInfo?.responseStreamErrored?.httpStatusCode,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "string" && /^\d{3}$/.test(c)) return parseInt(c, 10);
  }
  return null;
}

function extractUrlFromTurnError(errObj: unknown): string | null {
  const e = errObj as any;
  const direct = pickString(e?.url);
  if (direct) return direct;

  const details = pickString(e?.additionalDetails);
  if (!details) return null;
  const m = details.match(/url:\s*(https?:\/\/\S+)/i);
  if (!m) return null;
  return m[1]?.replace(/[),.]+$/, "") || null;
}

function formatTurnErrorForHumans(errObj: unknown): string {
  const e = errObj as any;
  const message = pickString(e?.message);
  const additionalDetails = pickString(e?.additionalDetails);
  const httpStatus = extractHttpStatusFromTurnError(errObj);
  const url = extractUrlFromTurnError(errObj);

  const lines: string[] = ["turn 执行失败（Codex 后端报错）"];
  if (message) lines.push(`- message: ${message}`);
  if (httpStatus) lines.push(`- httpStatus: ${httpStatus}`);
  if (url) lines.push(`- url: ${url}`);
  if (additionalDetails && additionalDetails !== message) lines.push(`- details: ${redactSensitive(additionalDetails)}`);

  // 常见：自定义 base_url/代理网关 502
  if (httpStatus === 502 && url && !url.includes("api.openai.com")) {
    lines.push("");
    lines.push("排查建议：");
    lines.push("1) 你当前的 Codex CLI 很可能配置了自定义 model_provider/base_url（代理网关）");
    lines.push("2) 该网关返回 502（Bad Gateway），属于上游不可用/被拦截/不兼容 responses API");
    lines.push("3) 解决方式（二选一）：");
    lines.push("   - 修复/更换你的代理网关；或");
    lines.push("   - 在运行桥接的项目里加 .env.bridge.local，覆盖 Codex 配置，例如：");
    lines.push("       bridge_codex_cli_config=model_provider=openai");
    lines.push("");
    lines.push("提示：Codex 全局配置文件通常在 `~/.codex/config.toml`。");
  }

  lines.push("");
  lines.push(`原始错误（已脱敏）：${safeStringify(errObj)}`);
  return lines.join("\n");
}

function getNotifThreadId(msg: JsonRpcMessage): string | null {
  const params = (msg.params || {}) as Record<string, unknown>;
  return pickString(params.threadId);
}

function getNotifTurnId(msg: JsonRpcMessage): string | null {
  const params = (msg.params || {}) as Record<string, unknown>;
  const direct = pickString(params.turnId);
  if (direct) return direct;
  const turn = params.turn as Record<string, unknown> | undefined;
  return turn ? pickString(turn.id) : null;
}

export type CodexAppServerLLMProviderOptions = {
  projectRoot: string;
  permissions: InMemoryPermissionGateway;
  codexBin?: string;
  /**
   * 传给 `codex app-server -c key=value` 的配置覆盖项。
   *
   * 格式：每行一条（或用 ; 分隔），例如：
   * - model_provider=openai
   * - model_providers.openai.base_url="https://api.openai.com/v1"
   */
  cliConfig?: string;
  modelId?: string;
  modelHint?: string;
  sandboxMode?: string; // danger-full-access | workspace-write | read-only
  approvalPolicy?: string; // 暂按 app-server 约定透传（默认 never）
  /**
   * turn 等待超时（毫秒）。
   *
   * - 默认 30 分钟（适配长时间工具执行/构建）
   * - 设为 0 或负数：不做超时（不推荐，除非你明确需要）
   */
  turnTimeoutMs?: number;
  debug?: boolean;
};

/**
 * 使用 Codex CLI 的 app-server 作为后端的 LLMProvider。
 *
 * 说明：
 * - 目前先打通“飞书→Codex→文本回复”最小闭环；
 * - tool/approval 事件映射留作下一步（需要 experimentalRawEvents + 事件对齐）。
 */
export class CodexAppServerLLMProvider implements LLMProvider {
  private projectRoot: string;
  private permissions: InMemoryPermissionGateway;
  private client: JsonRpcAppServerClient;

  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private selectedModelId: string | null = null;
  private selectedModelLabel: string | null = null;

  private modelId?: string;
  private modelHint?: string;
  private sandboxMode: string;
  private approvalPolicy: string;
  private turnTimeoutMs: number;

  constructor(opts: CodexAppServerLLMProviderOptions) {
    this.projectRoot = opts.projectRoot;
    this.permissions = opts.permissions;
    this.modelId = opts.modelId;
    this.modelHint = opts.modelHint;
    this.sandboxMode = opts.sandboxMode || "danger-full-access";
    this.approvalPolicy = opts.approvalPolicy || "never";
    this.turnTimeoutMs = Number.isFinite(opts.turnTimeoutMs as number) ? (opts.turnTimeoutMs as number) : 30 * 60_000;

    const codexBin = resolveCodexBinary(opts.codexBin);
    const cmd = [codexBin, "app-server"];

    const overrides = parseCodexCliConfigOverrides(opts.cliConfig);
    for (const item of overrides) cmd.push("-c", item);

    cmd.push("--listen", "stdio://");
    this.client = new JsonRpcAppServerClient({
      command: cmd,
      cwd: this.projectRoot,
      debug: Boolean(opts.debug),
    });
  }

  stop(): void {
    this.client.stop();
    this.initialized = false;
    this.initPromise = null;
    this.selectedModelId = null;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const abortController = params.abortController ?? new AbortController();
    const signal = abortController.signal;

    return new ReadableStream<string>({
      start: async (controller) => {
        try {
          await this.ensureInitialized();

          const resumedThreadId = params.sdkSessionId && params.sdkSessionId.trim()
            ? params.sdkSessionId.trim()
            : null;

          const threadId = resumedThreadId || await this.startThread({
            systemPrompt: params.systemPrompt,
            cwd: params.workingDirectory,
          });

          emit(controller, "status", {
            session_id: threadId,
            model: this.selectedModelLabel || this.selectedModelId || "",
          });

          const prompt = this.buildTurnPrompt(params.prompt, params.workingDirectory);

          const turnId = await this.startTurn({
            threadId,
            prompt,
            cwd: params.workingDirectory,
          });

          const text = await this.collectTurnText({
            threadId,
            turnId,
            onDelta: (delta) => emit(controller, "text", delta),
            signal,
          });

          // 某些情况下 delta 可能为空，completed 才有整段文本
          if (text) {
            // 已通过 delta 发过的情况下，text 可能等于已发送内容；这里不再重复发送
          }

          emit(controller, "result", { usage: null, is_error: false, session_id: threadId });
        } catch (err) {
          const isAbort = err instanceof Error && err.name === "AbortError";
          const msg = isAbort ? "Task stopped by user" : toErrorMessage(err);
          emit(controller, "error", msg);
          emit(controller, "result", { usage: null, is_error: true, session_id: null });
        } finally {
          controller.close();
        }
      },
      cancel: () => {
        abortController.abort();
      },
    });
  }

  private buildTurnPrompt(userText: string, workingDirectory?: string): string {
    const cwd = workingDirectory && workingDirectory.trim() ? workingDirectory.trim() : "";
    if (!cwd) return userText;

    // 提醒 Codex 当前工作目录，尽量减少“相对路径漂移”
    const normalized = cwd.replace(/\//g, path.sep);
    return `当前工作目录：${normalized}\n\n用户消息：\n${userText}`;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return await this.initPromise;

    this.initPromise = (async () => {
      // 1) initialize
      await this.client.request(
        "initialize",
        {
          clientInfo: {
            name: "claude-to-im-bridge-codex-runner",
            title: "Claude-to-IM Codex Runner",
            version: "1.0.0",
          },
          capabilities: null,
        },
        30_000,
      );

      // 2) model/list
      const modelsRaw = await this.client.request(
        "model/list",
        { limit: 200, includeHidden: true },
        30_000,
      );

      const models = (modelsRaw as ModelListResult | undefined)?.data;
      const list = Array.isArray(models) ? models : [];
      if (list.length === 0) {
        const tail = this.client.getRecentLogs?.(30) || "";
        throw new Error(
          [
            "Codex model/list 返回为空，无法选择模型。",
            "",
            "常见原因：",
            "1) 本机尚未登录 Codex：请在运行桥接的机器上执行 `codex login`",
            "2) 未设置 OPENAI_API_KEY（可写入 .env.bridge.local）",
            "3) 当前账号/网络环境下无可用模型权限或被代理拦截",
            "",
            this.modelHint ? `当前 modelHint: ${this.modelHint}` : "",
            tail ? `最近 codex 输出（已脱敏）：\n${tail}` : "",
          ].filter(Boolean).join("\n"),
        );
      }
      const selected = selectCodexModel(list as any, { explicitId: this.modelId, hint: this.modelHint });
      const id = pickString(selected?.id);
      if (!id) {
        const tail = this.client.getRecentLogs?.(30) || "";
        throw new Error(
          [
            "Codex model/list 返回了模型，但未能解析到可用的 model id。",
            "",
            this.modelHint ? `当前 modelHint: ${this.modelHint}` : "",
            tail ? `最近 codex 输出（已脱敏）：\n${tail}` : "",
          ].filter(Boolean).join("\n"),
        );
      }

      this.selectedModelId = id;
      this.selectedModelLabel = pickString(selected?.displayName) || pickString(selected?.model) || id;
      this.initialized = true;
    })();

    try {
      await this.initPromise;
    } finally {
      // allow retry after failure
      if (!this.initialized) this.initPromise = null;
    }
  }

  private async startThread(opts: { systemPrompt?: string; cwd?: string }): Promise<string> {
    const system = opts.systemPrompt && opts.systemPrompt.trim() ? opts.systemPrompt.trim() : "";

    const payload: Record<string, unknown> = {
      model: this.selectedModelId,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandboxMode,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    };

    const cwd = (opts.cwd || "").trim();
    if (cwd) {
      // 让 Codex app-server 在该 thread 下以指定 cwd 运行（用于 /cwd 或默认工作目录）
      payload.cwd = cwd;
    }

    if (system) {
      payload.baseInstructions = system;
    }

    const res = await this.client.request("thread/start", payload, 30_000);
    const threadId = pickString((res as ThreadStartResult | undefined)?.thread?.id) || pickString((res as any)?.id);
    if (!threadId) throw new Error("thread/start 未返回 thread.id");
    return threadId;
  }

  private async startTurn(opts: { threadId: string; prompt: string; cwd?: string }): Promise<string> {
    const turnPayload: Record<string, unknown> = {
      threadId: opts.threadId,
      approvalPolicy: this.approvalPolicy,
      sandboxPolicy: buildTurnSandboxPolicy(this.sandboxMode),
      input: [
        {
          type: "text",
          text: opts.prompt,
          text_elements: [],
        },
      ],
    };

    const cwd = (opts.cwd || "").trim();
    if (cwd) {
      // 允许每个 turn 指定 cwd，确保后续工具/命令在正确目录执行
      turnPayload.cwd = cwd;
    }

    const res = await this.client.request("turn/start", turnPayload, 30_000);
    const turnId = pickString((res as TurnStartResult | undefined)?.turn?.id) || pickString((res as any)?.id);
    if (!turnId) throw new Error("turn/start 未返回 turn.id");
    return turnId;
  }

  private async collectTurnText(opts: {
    threadId: string;
    turnId: string;
    onDelta: (delta: string) => void;
    signal: AbortSignal;
  }): Promise<string> {
    const timeoutMs = this.turnTimeoutMs;
    const deadlineMs = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
    let merged = "";
    let itemCompletedText: string | null = null;
    let turnCompleted = false;

    const handle = (msg: JsonRpcMessage): void => {
      const msgThreadId = getNotifThreadId(msg);
      const msgTurnId = getNotifTurnId(msg);
      if (msgThreadId !== opts.threadId || msgTurnId !== opts.turnId) return;

      const method = msg.method || "";
      const params = (msg.params || {}) as Record<string, unknown>;

      if (method === "item/agentMessage/delta") {
        const delta = String(params.delta ?? "");
        if (delta) {
          merged += delta;
          opts.onDelta(delta);
        }
        return;
      }

      if (method === "item/completed") {
        const item = (params.item || {}) as Record<string, unknown>;
        if (String(item.type || "") === "agentMessage") {
          const txt = pickString(item.text);
          if (txt) itemCompletedText = txt;
        }
        return;
      }

      if (method === "error") {
        const errObj = params.error;
        throw new Error(formatTurnErrorForHumans(errObj));
      }

      if (method === "turn/completed") {
        turnCompleted = true;
      }
    };

    // 先消费 backlog，避免“通知早于 turn/start 返回”导致丢失
    let lastError: unknown = null;
    for (const msg of this.client.drainBacklog((m) =>
      getNotifThreadId(m) === opts.threadId && getNotifTurnId(m) === opts.turnId
    )) {
      try {
        handle(msg);
      } catch (e) {
        lastError = e;
      }
    }

    const off = this.client.onNotification((m) => {
      try {
        // 复用同一个 handle，但把异常捕获出来供外层 await 检查
        handle(m);
      } catch (e) {
        lastError = e;
      }
    });

    try {
      while (true) {
        if (opts.signal.aborted) throw abortError();
        if (lastError) throw lastError;

        if (turnCompleted) {
          if (itemCompletedText && !merged) {
            merged = itemCompletedText;
            opts.onDelta(itemCompletedText);
          }
          return merged.trim();
        }

        if (Date.now() > deadlineMs) {
          const mins = timeoutMs > 0 ? Math.ceil(timeoutMs / 60_000) : 0;
          const hint = timeoutMs > 0 ? `（超过 ${mins} 分钟，可通过 bridge_codex_turn_timeout_ms 调整）` : "";
          throw new Error(`等待 turn 输出超时${hint}: ${opts.turnId}`);
        }

        // 让出事件循环，等待更多 notification
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      off();
    }
  }
}
