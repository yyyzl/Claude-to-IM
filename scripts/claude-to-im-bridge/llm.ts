/** Claude Agent SDK 适配层：只转换公开协议，平台交互由 bridge 负责。 */
import crypto from 'node:crypto';
import type { Options, PermissionMode, SDKMessage, SDKResultMessage, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';
import type { LLMProvider, StreamChatParams, UserInputRequest } from '../../src/lib/bridge/host.js';
import type { InMemoryPermissionGateway } from './permissions.js';

type SDKQuery = (args: Parameters<typeof query>[0]) => AsyncIterable<SDKMessage> & { close?: () => void };

function emit(controller: ReadableStreamDefaultController<string>, type: string, data: unknown): void {
  controller.enqueue(`data: ${JSON.stringify({ type, data: typeof data === 'string' ? data : JSON.stringify(data) })}\n`);
}

function normalizePermissionMode(mode?: string): PermissionMode {
  if (!mode || mode === 'default') return 'default';
  if (mode === 'plan' || mode === 'acceptEdits' || mode === 'dontAsk' || mode === 'auto') return mode;
  throw new Error(`不支持的 Claude 权限模式：${mode}`);
}

function normalizeEffort(value?: string): Options['effort'] {
  if (!value) return undefined;
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') return value;
  throw new Error(`Claude SDK 不支持思考强度 ${value}；请选择 low、medium、high、xhigh 或 max。`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractAssistantText(msg: SDKMessage): string | null {
  if (msg.type !== 'assistant' || msg.parent_tool_use_id) return null;
  const texts = msg.message.content.flatMap(block => block.type === 'text' ? [block.text] : []);
  return texts.length ? texts.join('') : null;
}

function extractPartialTextDelta(msg: SDKMessage): string | null {
  if (msg.type !== 'stream_event' || msg.parent_tool_use_id) return null;
  return msg.event.type === 'content_block_delta' && msg.event.delta.type === 'text_delta' ? msg.event.delta.text : null;
}

function buildPrompt(params: StreamChatParams): string | AsyncIterable<SDKUserMessage> {
  if (!params.files?.length) return params.prompt;
  const content: Exclude<SDKUserMessage['message']['content'], string> = [{ type: 'text', text: params.prompt }];
  for (const file of params.files) {
    const mime = file.type;
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/gif' && mime !== 'image/webp') {
      throw new Error(`Claude 桥接暂不支持附件 ${file.name}（${mime}），请发送 PNG、JPEG、GIF 或 WebP 图片。`);
    }
    if (!file.data) throw new Error(`图片附件 ${file.name} 缺少内容。`);
    content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: file.data } });
  }
  return (async function* () {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } satisfies SDKUserMessage;
  })();
}

function userInputRequest(requestId: string, input: Record<string, unknown>): UserInputRequest {
  if (!Array.isArray(input.questions) || !input.questions.length) throw new Error('AskUserQuestion 缺少问题');
  return {
    requestId,
    questions: input.questions.map((raw: unknown, index: number) => {
      if (!isRecord(raw) || typeof raw.question !== 'string') throw new Error('AskUserQuestion 问题格式无效');
      return {
        id: String(index), question: raw.question,
        header: typeof raw.header === 'string' ? raw.header : undefined,
        multiSelect: raw.multiSelect === true, allowOther: true,
        options: Array.isArray(raw.options) ? raw.options.flatMap((option: unknown) => {
          if (!isRecord(option) || typeof option.label !== 'string') return [];
          return [{ label: option.label, description: typeof option.description === 'string' ? option.description : undefined }];
        }) : undefined,
      };
    }),
  };
}

export class ClaudeCodeLLMProvider implements LLMProvider {
  private readonly query: SDKQuery;
  private readonly permissions: Pick<InMemoryPermissionGateway, 'waitFor'>;
  private readonly keepAliveMs: number;

  constructor(opts: { query: SDKQuery; permissions: Pick<InMemoryPermissionGateway, 'waitFor'>; keepAliveMs?: number }) {
    this.query = opts.query;
    this.permissions = opts.permissions;
    const ka = opts.keepAliveMs ?? 15_000;
    this.keepAliveMs = Number.isFinite(ka) && ka > 0 ? ka : 0;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const abortController = params.abortController ?? new AbortController();
    let closed = false;
    let q: ReturnType<SDKQuery> | undefined;
    return new ReadableStream<string>({
      start: async controller => {
        const send = (type: string, data: unknown) => { if (!closed) emit(controller, type, data); };
        let timer: NodeJS.Timeout | undefined;
        let result: SDKResultMessage | undefined;
        let sessionId: string | undefined;
        let streamedText = '';
        let assistantText = '';
        let lastUsage: unknown = null;
        let lastModel: string | undefined;
        try {
          const cleanEnv = { ...process.env };
          delete cleanEnv.CLAUDECODE;
          const options: Options = {
            env: cleanEnv, cwd: params.workingDirectory, model: params.model,
            effort: normalizeEffort(params.reasoningEffort),
            resume: params.sdkSessionId?.trim() || undefined,
            settingSources: ['user', 'project', 'local'], includePartialMessages: true,
            systemPrompt: params.systemPrompt, abortController,
            permissionMode: normalizePermissionMode(params.permissionMode),
            canUseTool: async (toolName, input, toolOptions) => {
              const id = toolOptions.toolUseID || crypto.randomUUID();
              const question = toolName === 'AskUserQuestion' ? userInputRequest(id, input) : undefined;
              // 先登记等待，再展示卡片，避免快速回调早于 waiter 的竞态。
              const pending = this.permissions.waitFor(id, toolOptions.signal);
              params.onRuntimeStatusChange?.('waiting_permission');
              send(question ? 'user_input_request' : 'permission_request', question ?? {
                permissionRequestId: id, toolName, toolInput: input, suggestions: toolOptions.suggestions ?? [],
              });
              const resolution = await pending;
              params.onRuntimeStatusChange?.('running');
              if (resolution.behavior === 'deny') return { behavior: 'deny', message: resolution.message || '用户已拒绝', toolUseID: id };
              if (question) {
                const rawAnswers = resolution.updatedInput?.answers;
                if (!isRecord(rawAnswers)) return { behavior: 'deny', message: '未收到问题答案', toolUseID: id };
                const answers: Record<string, string> = {};
                for (const item of question.questions) {
                  const answer = rawAnswers[item.id];
                  if (!Array.isArray(answer) || !answer.length || answer.some(value => typeof value !== 'string')) {
                    return { behavior: 'deny', message: '问题答案不完整', toolUseID: id };
                  }
                  answers[item.question] = answer.join(', ');
                }
                return { behavior: 'allow', updatedInput: { ...input, answers }, toolUseID: id };
              }
              return {
                behavior: 'allow', updatedInput: input, toolUseID: id,
                // “本会话允许”不能把 SDK 建议写入用户或项目的持久设置。
                ...(resolution.scope === 'session' ? {
                  updatedPermissions: toolOptions.suggestions?.map(suggestion => ({ ...suggestion, destination: 'session' as const })),
                } : {}),
              };
            },
          };
          q = this.query({ prompt: buildPrompt(params), options });
          if (this.keepAliveMs > 0) timer = setInterval(() => send('keep_alive', ''), this.keepAliveMs);
          for await (const msg of q) {
            if (abortController.signal.aborted) break;
            if ('session_id' in msg && msg.session_id && !sessionId) {
              sessionId = msg.session_id;
              send('status', { session_id: sessionId });
            }
            const delta = extractPartialTextDelta(msg);
            if (delta) { streamedText += delta; send('text', delta); }
            const text = extractAssistantText(msg);
            if (text) assistantText = text;
            if (msg.type === 'assistant') {
              if (!msg.parent_tool_use_id) { lastUsage = msg.message.usage; lastModel = msg.message.model; }
              for (const block of msg.message.content) {
                if (block.type === 'tool_use') send('tool_use', { id: block.id, name: block.name, input: block.input });
              }
            }
            if (msg.type === 'user' && Array.isArray(msg.message.content)) {
              for (const block of msg.message.content) {
                if (block.type !== 'tool_result') continue;
                const content = typeof block.content === 'string' ? block.content : (block.content ?? []).flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
                send('tool_result', { tool_use_id: block.tool_use_id, content, is_error: block.is_error ?? false });
              }
            }
            if (msg.type === 'system') {
              if (msg.subtype === 'task_progress') send('progress', msg.summary || msg.description);
              if (msg.subtype === 'task_started' && !msg.ambient && !msg.skip_transcript) send('progress', msg.description);
              if (msg.subtype === 'task_notification' && !msg.ambient && !msg.skip_transcript) send('progress', msg.summary);
            }
            if (msg.type === 'tool_progress') send('progress', `${msg.tool_name} · ${Math.round(msg.elapsed_time_seconds)} 秒`);
            if (msg.type === 'result') result = msg;
          }
          if (!result) throw new Error(abortController.signal.aborted ? '会话已中断' : 'Session ended without result message');
          const failed = result.is_error || result.subtype !== 'success';
          if (failed) send('error', result.subtype === 'success' ? result.result : result.errors.join('\n'));
          else if (result.subtype === 'success') {
            const finalText = assistantText || result.result;
            if (!streamedText) send('text', finalText);
            else if (finalText.startsWith(streamedText)) { const rest = finalText.slice(streamedText.length); if (rest) send('text', rest); }
          }
          const usage = result.usage ? { ...result.usage } : null;
          const modelUsages = result.modelUsage ?? {};
          const contextWindow = (lastModel ? modelUsages[lastModel]?.contextWindow : undefined)
            ?? (Object.keys(modelUsages).length === 1 ? Object.values(modelUsages)[0]?.contextWindow : undefined);
          send('result', {
            usage, last_usage: lastUsage, context_window: contextWindow,
            // SDK 总成本在 resume 时是会话累计，独立传递，避免当成单轮费用重复计费。
            total_cost_usd: result.total_cost_usd,
            is_error: failed, session_id: result.session_id || sessionId,
          });
        } catch (err) {
          send('error', err instanceof Error ? err.message : String(err));
          send('result', { usage: null, last_usage: lastUsage, is_error: true, session_id: sessionId });
        } finally {
          if (timer) clearInterval(timer);
          try { q?.close?.(); } catch { /* 已结束的 SDK 会话无需再次关闭。 */ }
          if (!closed) { closed = true; controller.close(); }
        }
      },
      cancel: () => { closed = true; abortController.abort(); q?.close?.(); },
    });
  }
}
