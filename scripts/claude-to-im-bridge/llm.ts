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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractAssistantText(msg: unknown): string | null {
  if (!isRecord(msg) || msg.type !== "assistant") return null;
  const message = isRecord(msg.message) ? msg.message : null;
  const content = Array.isArray(message?.content) ? message.content : null;
  if (!content) return null;

  const textParts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string" || !block.text) continue;
    textParts.push(block.text);
  }

  return textParts.length > 0 ? textParts.join("") : null;
}

function extractPartialTextDelta(msg: unknown): string | null {
  if (!isRecord(msg) || msg.type !== "stream_event" || !isRecord(msg.event)) return null;
  const event = msg.event;
  if (event.type !== "content_block_delta" || !isRecord(event.delta)) return null;
  const delta = event.delta;
  if (delta.type !== "text_delta" || typeof delta.text !== "string" || !delta.text) return null;
  return delta.text;
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
        let streamedText = "";
        let assistantTextSnapshot = "";
        // 最近一次 assistant message 的 usage = "当前 turn 最后一次 API 调用的 prompt size"。
        // 与 SDK ResultMessage.usage（整个 turn N 次 API 调用的累计和）区分开来，
        // 下游 ctx footer 需要的是前者（"离满还有多远"的真实度量）。
        let lastAssistantUsage: any = null;

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
            includePartialMessages: true,
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

            const partialText = extractPartialTextDelta(msg);
            if (partialText) {
              streamedText += partialText;
              emit(controller, "text", partialText);
            }

            const assistantText = extractAssistantText(msg);
            if (assistantText) {
              assistantTextSnapshot = assistantText;
            }

            // Capture the usage of the most recent assistant message.
            // SDK emits one assistant message per API call; within a single turn the SDK
            // may make multiple API calls (tool-use round-trips). We keep overwriting so
            // the last value wins — that is the "current context window footprint".
            if (msg?.type === "assistant" && msg?.message?.usage) {
              lastAssistantUsage = msg.message.usage;
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
              const finalText = assistantTextSnapshot || resultMsg.result || "";
              if (finalText) {
                if (!streamedText) {
                  streamedText = finalText;
                  emit(controller, "text", finalText);
                } else if (finalText.startsWith(streamedText)) {
                  const trailingText = finalText.slice(streamedText.length);
                  if (trailingText) {
                    streamedText += trailingText;
                    emit(controller, "text", trailingText);
                  }
                } else if (finalText !== streamedText) {
                  console.warn(
                    "[claude-sdk] Streamed text differs from final assistant text; keeping streamed text to avoid duplication",
                  );
                }
              }
              emit(controller, "result", {
                usage: resultMsg.usage || null,
                last_usage: lastAssistantUsage || null,
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
                last_usage: lastAssistantUsage || null,
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
          emit(controller, "result", { usage: null, last_usage: null, is_error: true, session_id: capturedSdkSessionId });
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
