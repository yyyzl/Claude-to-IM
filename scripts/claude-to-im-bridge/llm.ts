import crypto from "node:crypto";

import type { InMemoryPermissionGateway } from "./permissions.ts";

export interface StreamChatParams {
  prompt: string;
  sessionId: string;
  sdkSessionId?: string;
  model?: string;
  systemPrompt?: string;
  workingDirectory?: string;
  abortController?: AbortController;
  permissionMode?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  files?: unknown[];
  onRuntimeStatusChange?: (status: string) => void;
}

export interface LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string>;
}

type SDKQuery = (args: { prompt: string; options: Record<string, unknown> }) => AsyncGenerator<any, void> & {
  close?: () => void;
};

function emit(controller: ReadableStreamDefaultController<string>, type: string, data: unknown): void {
  const payload = {
    type,
    data: typeof data === "string" ? data : JSON.stringify(data),
  };
  controller.enqueue(`data: ${JSON.stringify(payload)}\n`);
}

function normalizePermissionMode(mode?: string): string {
  if (!mode) return "default";
  if (mode === "plan" || mode === "default" || mode === "acceptEdits" || mode === "dontAsk") return mode;
  return "default";
}

export class ClaudeCodeLLMProvider implements LLMProvider {
  private query: SDKQuery;
  private permissions: InMemoryPermissionGateway;
  private keepAliveMs: number;

  constructor(opts: { query: SDKQuery; permissions: InMemoryPermissionGateway; keepAliveMs?: number }) {
    this.query = opts.query;
    this.permissions = opts.permissions;
    const ka = Number.isFinite(opts.keepAliveMs as number) ? (opts.keepAliveMs as number) : 15_000;
    this.keepAliveMs = ka > 0 ? ka : 0;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const abortController = params.abortController ?? new AbortController();
    const signal = abortController.signal;
    const permissionMode = normalizePermissionMode(params.permissionMode);
    const resume = params.sdkSessionId && params.sdkSessionId.trim() ? params.sdkSessionId.trim() : undefined;

    return new ReadableStream<string>({
      start: async (controller) => {
        let keepAliveTimer: NodeJS.Timeout | null = null;
        let resultMsg: any = null;
        let capturedSdkSessionId: string | null = null;

        // Clean up env vars that interfere with SDK child process:
        // CLAUDECODE: prevents "nested session" detection when bridge runs inside Claude Code
        const cleanEnv = { ...process.env };
        delete cleanEnv.CLAUDECODE;

        // Debug: log SDK call parameters
        console.log("[claude-sdk] query params:", JSON.stringify({
          cwd: params.workingDirectory,
          model: params.model,
          resume,
          permissionMode,
          hasSystemPrompt: !!params.systemPrompt,
          hasCanUseTool: true,
          hasEnv: true,
          CLAUDE_CODE_GIT_BASH_PATH: cleanEnv.CLAUDE_CODE_GIT_BASH_PATH || "(未设置)",
        }));

        const q = this.query({
          prompt: params.prompt,
          options: {
            env: cleanEnv,
            cwd: params.workingDirectory,
            model: params.model,
            resume,
            settingSources: ['user', 'project', 'local'],
            systemPrompt: params.systemPrompt,
            abortController,
            permissionMode,
            stderr: (data: string) => {
              // Surface SDK child process stderr to terminal for debugging
              const trimmed = data.trim();
              if (trimmed) console.error(`[claude-sdk-stderr] ${trimmed}`);
            },
            canUseTool: async (
              toolName: string,
              input: Record<string, unknown>,
              options: { signal: AbortSignal; suggestions?: unknown[]; toolUseID?: string },
            ) => {
              const permissionRequestId = options.toolUseID || crypto.randomUUID();

              emit(controller, "permission_request", {
                permissionRequestId,
                toolName,
                toolInput: input,
                suggestions: options.suggestions || [],
              });

              const resolution = await this.permissions.waitFor(permissionRequestId, options.signal);
              if (resolution.behavior === "allow") {
                return {
                  behavior: "allow",
                  ...(resolution.updatedPermissions ? { updatedPermissions: resolution.updatedPermissions as any } : {}),
                  ...(options.toolUseID ? { toolUseID: options.toolUseID } : {}),
                };
              }
              return {
                behavior: "deny",
                message: resolution.message || "Denied via IM bridge",
                ...(options.toolUseID ? { toolUseID: options.toolUseID } : {}),
              };
            },
          },
        });

        try {
          if (this.keepAliveMs > 0) {
            // 避免部分 SSE/反代链路因“长时间无输出”触发 idle timeout。
            keepAliveTimer = setInterval(() => {
              if (signal.aborted) return;
              try { emit(controller, "keep_alive", ""); } catch { /* ignore */ }
            }, this.keepAliveMs);
          }

          for await (const msg of q) {
            if (msg?.session_id && !capturedSdkSessionId) {
              capturedSdkSessionId = msg.session_id;
              emit(controller, "status", { session_id: msg.session_id });
            }

            // ── Forward tool events for /status live context display ──
            // Pattern 1: SDK yields assistant messages containing tool_use content blocks
            if (msg?.type === "assistant" && Array.isArray(msg?.message?.content)) {
              for (const block of msg.message.content) {
                if (block?.type === "tool_use" && block.name) {
                  emit(controller, "tool_use", {
                    id: block.id || `tool-${Date.now()}`,
                    name: block.name,
                    input: block.input || {},
                  });
                }
              }
            }
            // Pattern 2: SDK yields direct tool_use / tool_result events
            if (msg?.type === "tool_use" && msg?.name) {
              emit(controller, "tool_use", {
                id: msg.id || `tool-${Date.now()}`,
                name: msg.name,
                input: msg.input || {},
              });
            }
            if (msg?.type === "tool_result") {
              emit(controller, "tool_result", {
                tool_use_id: msg.tool_use_id || msg.id || "",
                content: typeof msg.content === "string" ? msg.content : "",
                is_error: msg.is_error || false,
              });
            }

            if (msg?.type === "result") {
              resultMsg = msg;
              // 不 break：SDK 可能在 result 后还有 prompt_suggestion 等
            }
          }

          if (resultMsg?.session_id) capturedSdkSessionId = resultMsg.session_id;

          if (resultMsg?.type === "result") {
            if (resultMsg.subtype === "success") {
              emit(controller, "text", resultMsg.result || "");
              emit(controller, "result", {
                usage: resultMsg.usage || null,
                is_error: false,
                session_id: capturedSdkSessionId,
              });
            } else {
              const errText = Array.isArray(resultMsg.errors) && resultMsg.errors.length > 0
                ? resultMsg.errors.join("\n")
                : "Unknown error";
              emit(controller, "error", errText);
              emit(controller, "result", {
                usage: resultMsg.usage || null,
                is_error: true,
                session_id: capturedSdkSessionId,
              });
            }
          } else {
            emit(controller, "error", "Session ended without result message");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emit(controller, "error", msg);
          emit(controller, "result", { usage: null, is_error: true, session_id: capturedSdkSessionId });
        } finally {
          if (keepAliveTimer) clearInterval(keepAliveTimer);
          try { (q as any).close?.(); } catch { /* ignore */ }
          controller.close();
        }
      },
      cancel: () => {
        abortController.abort();
      },
    });
  }
}
