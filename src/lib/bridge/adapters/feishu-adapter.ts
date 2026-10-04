/**
 * Feishu (Lark) Adapter — implements BaseChannelAdapter for Feishu Bot API.
 *
 * Uses the official @larksuiteoapi/node-sdk WSClient for real-time event
 * subscription and REST Client for message sending / resource downloading.
 * Routes messages through an internal async queue (same pattern as Telegram).
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 * - Permission prompts → interactive card with action buttons
 *
 * card.action.trigger events are handled via EventDispatcher (Openclaw pattern):
 * button clicks are converted to synthetic text messages and routed through
 * the normal /perm command processing pipeline.
 */

import crypto from 'crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
  ChannelAddress,
  ModelSelectionResponse,
  ModelSelectionView,
} from '../types.js';
import type { GeneratedImage, UserInputRequest } from '../host.js';
import type { ImageUploadResult } from '../channel-adapter.js';
import { decodeGeneratedImage } from '../internal/generated-image.js';
import type { FileAttachment } from '../types.js';
import type { ToolCallInfo } from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';
import {
  htmlToFeishuMarkdown,
  preprocessFeishuMarkdown,
  hasComplexMarkdown,
  buildCardContent,
  buildPostContent,
  buildToolProgressMarkdown,
  buildFinalCardJson,
  buildPermissionButtonCard,
  buildUserInputCard,
  buildModelSelectionCard,
  MODEL_DEFAULT_EFFORT_OPTION,
  formatElapsed,
  splitFeishuMarkdown,
  feishuPayloadBytes,
} from '../markdown/feishu.js';

/** Max number of message_ids to keep for dedup. */
const DEDUP_MAX = 1000;

/** Max file download size (20 MB). */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Feishu emoji type for typing indicator (same as Openclaw). */
const TYPING_EMOJI = 'Typing';

/** State for an active CardKit v1 streaming card. */
interface FeishuCardState {
  cardId: string;
  messageId: string;
  sequence: number;
  startTime: number;
  toolCalls: ToolCallInfo[];
  thinking: boolean;
  pendingText: string | null;
  lastUpdateAt: number;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  nextFlushAt: number | null;
  inFlight: boolean;
  operation: Promise<void> | null;
  closing: boolean;
  progress: string;
  sentText: string;
  sentProgress: string;
  sentNotice: string;
  needsFlush: boolean;
  cooldownUntil: number;
  rateLimitBackoffMs: number;
  lastRateLimitLogAt: number;
  /** 追加消息提示，显示在流式卡片底部 */
  appendNotice: string | null;
}

/** Streaming card flush interval (ms). */
const DEFAULT_CARD_THROTTLE_MS = 2_000;
// 一轮最多两次写入，250ms 下限为收尾请求预留单卡 10 次/秒预算。
const MIN_CARD_THROTTLE_MS = 250;
const MAX_CARD_THROTTLE_MS = 30_000;

/** Feishu request trigger frequency limit (rate-limit). */
const FEISHU_TRIGGER_RATE_LIMIT_CODE = 99991400;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 60_000;
const RATE_LIMIT_LOG_THROTTLE_MS = 60_000;
const MAX_CARD_BYTES = 30_000;

function assertFeishuSuccess(response: { code?: number; msg?: string }): void {
  if (response.code !== undefined && response.code !== 0) {
    throw Object.assign(new Error(`FeishuError(${response.code}): ${response.msg ?? '请求失败'}`), response);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** SDK 的 Axios 错误含 multipart 正文，只提取数值状态，禁止转储对象或 message。 */
function safeFeishuFailureMetadata(values: unknown[]): { code?: number; status?: number } {
  const metadata: { code?: number; status?: number } = {};
  const inspect = (value: unknown, depth: number): void => {
    if (depth > 3) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 10)) inspect(item, depth + 1);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    if (typeof record.code === 'number' && Number.isSafeInteger(record.code)) metadata.code = record.code;
    if (typeof record.status === 'number' && Number.isSafeInteger(record.status) && record.status >= 100 && record.status <= 599) metadata.status = record.status;
    const response = asRecord(record.response);
    if (response) { inspect(response, depth + 1); inspect(response.data, depth + 1); }
  };
  for (const value of values) inspect(value, 0);
  return metadata;
}

export const feishuSdkLogger: lark.Logger = {
  error: (...values: unknown[]) => { console.error('[feishu-sdk] 请求失败', safeFeishuFailureMetadata(values)); },
  warn: (...values: unknown[]) => { console.warn('[feishu-sdk] 请求警告', safeFeishuFailureMetadata(values)); },
  // 低等级 SDK 消息可能携带请求数据，不输出原始诊断内容。
  info() {}, debug() {}, trace() {},
};

function imageFailure(operation: string, error: unknown): SendResult {
  const { code, status } = safeFeishuFailureMetadata([error]);
  const details = [code === undefined ? '' : `代码 ${code}`, status === undefined ? '' : `状态 ${status}`].filter(Boolean).join('，');
  return { ok: false, error: `${operation}失败${details ? `（${details}）` : ''}，可稍后补发`, httpStatus: status ?? 400 };
}

/** 这里只校验回调形状；目录、归属、revision 和期限由核心草稿统一校验。 */
function parseModelSelectionResponse(value: Record<string, unknown>, rawForm: unknown): ModelSelectionResponse | null {
  const requestId = pickString(value.model_selection_request_id);
  const revision = value.model_selection_revision;
  const action = value.model_selection_action;
  if (!requestId || requestId.length > 128 || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return null;
  if (action !== 'next' && action !== 'back' && action !== 'refresh' && action !== 'previous_page' && action !== 'next_page' && action !== 'apply' && action !== 'cancel') return null;
  const response: ModelSelectionResponse = { requestId, revision, action };
  const form = asRecord(rawForm);
  if (action === 'next') {
    const model = pickString(form?.model);
    if (!model || Buffer.byteLength(model, 'utf8') > MAX_CARD_BYTES) return null;
    response.model = model;
  } else if (action === 'apply') {
    const effort = pickString(form?.reasoning_effort);
    const speed = form?.speed;
    if (!effort || Buffer.byteLength(effort, 'utf8') > MAX_CARD_BYTES || (speed !== 'normal' && speed !== 'fast')) return null;
    response.reasoningEffort = effort === MODEL_DEFAULT_EFFORT_OPTION ? '' : effort;
    response.speed = speed;
  }
  return response;
}

function parsePositiveInt(raw: string | null): number | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (!t) return null;
  const n = parseInt(t, 10);
  if (!Number.isFinite(n)) return null;
  return n > 0 ? n : 0;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

type FeishuApiErrorPayload = {
  code: number;
  msg?: string;
  log_id?: string;
};

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function normalizeNumericCode(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^\d+$/.test(t)) return parseInt(t, 10);
  }
  return null;
}

function findFeishuApiErrorPayload(err: unknown, depth = 0): FeishuApiErrorPayload | null {
  if (err == null) return null;
  if (depth > 5) return null;

  if (Array.isArray(err)) {
    for (const item of err) {
      const found = findFeishuApiErrorPayload(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof err !== 'object') return null;
  const anyErr = err as any;

  const directCode = normalizeNumericCode(anyErr?.code);
  if (directCode != null) {
    const msg = pickString(anyErr?.msg) || undefined;
    const log_id = pickString(anyErr?.log_id) || undefined;
    return { code: directCode, ...(msg ? { msg } : {}), ...(log_id ? { log_id } : {}) };
  }

  const respData = anyErr?.response?.data;
  if (respData && typeof respData === 'object') {
    const code = normalizeNumericCode((respData as any)?.code);
    if (code != null) {
      const msg = pickString((respData as any)?.msg) || undefined;
      const log_id = pickString((respData as any)?.log_id) || undefined;
      return { code, ...(msg ? { msg } : {}), ...(log_id ? { log_id } : {}) };
    }
  }

  return null;
}

function toErrorMessage(err: unknown, depth = 0): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (depth > 3) return 'Unknown error';

  if (Array.isArray(err)) {
    for (const item of err) {
      const msg = toErrorMessage(item, depth + 1);
      if (msg) return msg;
    }
  }

  const payload = findFeishuApiErrorPayload(err);
  if (payload) {
    return payload.msg ? `FeishuError(${payload.code}): ${payload.msg}` : `FeishuError(${payload.code})`;
  }

  return 'Unknown error';
}

/** Shape of the SDK's im.message.receive_v1 event data. */
type FeishuMessageEventData = {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string; user_id?: string };
      name: string;
    }>;
  };
};


/** MIME type guesses by message_type. */
const MIME_BY_TYPE: Record<string, string> = {
  image: 'image/png',
  file: 'application/octet-stream',
  audio: 'audio/ogg',
  video: 'video/mp4',
  media: 'application/octet-stream',
};

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'feishu';

  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private incomingInFlight = new Set<string>();
  private cardGenerations = new Map<string, object>();
  private reactionMessages = new Map<string, string>();
  private seenMessageIds = new Map<string, boolean>();
  private botOpenId: string | null = null;
  /** All known bot IDs (open_id, user_id, union_id) for mention matching. */
  private botIds = new Set<string>();
  /** Track last incoming message ID per chat for typing indicator. */
  private lastIncomingMessageId = new Map<string, string>();
  /** Track active typing reaction IDs per chat for cleanup. */
  private typingReactions = new Map<string, string>();
  /** 兜底定时器：若无法展示打字/卡片指示，则回一条“正在处理”的短提示。 */
  private processingNoticeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Active streaming card state per chatId. */
  private activeCards = new Map<string, FeishuCardState>();
  /** In-flight card creation promises per chatId — prevents duplicate creation. */
  private cardCreatePromises = new Map<string, Promise<boolean>>();

  /** Active workflow progress card state per chatId (independent of streaming cards). */
  private workflowCards = new Map<string, { cardId: string; sequence: number; operation: Promise<unknown>; closing: boolean }>();

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[feishu-adapter] Cannot start:', configError);
      return;
    }

    const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id') || '';
    const appSecret = getBridgeContext().store.getSetting('bridge_feishu_app_secret') || '';
    const domainSetting = getBridgeContext().store.getSetting('bridge_feishu_domain') || 'feishu';
    const domain = domainSetting === 'lark'
      ? lark.Domain.Lark
      : lark.Domain.Feishu;

    // Create REST client
    this.restClient = new lark.Client({
      appId,
      appSecret,
      domain,
      logger: feishuSdkLogger,
      // 保留 SDK 的响应解包和 User-Agent，给本客户端的请求设有界超时。
      // SDK 的默认实例拦截器返回 resp.data；Axios 原始声明未反映该解包。
      httpInstance: new Proxy(lark.defaultHttpInstance as unknown as lark.Client['httpInstance'], {
        get(target, property, receiver) {
          if (property === 'request') {
            return (options: Parameters<typeof target.request>[0]) => target.request({ ...options, timeout: 15_000 });
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });

    // Resolve bot identity for @mention detection
    await this.resolveBotIdentity(appId, appSecret, domain);

    this.running = true;

    // Create EventDispatcher and register event handlers.
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        await this.handleIncomingEvent(data as FeishuMessageEventData);
      },
      'card.action.trigger': (async (data: unknown) => {
        return await this.handleCardAction(data);
      }) as any,
    });

    // Create and start WSClient
    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain,
    });

    // Monkey-patch WSClient.handleEventData to support card action events (type: "card").
    // The SDK's WSClient only processes type="event" messages. Card action callbacks
    // arrive as type="card" and would be silently dropped without this patch.
    const wsClientAny = this.wsClient as any;
    if (typeof wsClientAny.handleEventData === 'function') {
      const origHandleEventData = wsClientAny.handleEventData.bind(wsClientAny);
      wsClientAny.handleEventData = (data: any) => {
        const msgType = data.headers?.find?.((h: any) => h.key === 'type')?.value;
        if (msgType === 'card') {
          console.log('[feishu-adapter] handleEventData type: card (patched → event)');
          const patchedData = {
            ...data,
            headers: data.headers.map((h: any) =>
              h.key === 'type' ? { ...h, value: 'event' } : h,
            ),
          };
          return origHandleEventData(patchedData);
        }
        return origHandleEventData(data);
      };
    }

    this.wsClient.start({ eventDispatcher: dispatcher });

    console.log('[feishu-adapter] Started (botOpenId:', this.botOpenId || 'unknown', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Close WebSocket connection (SDK exposes close())
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch (err) {
        console.warn('[feishu-adapter] WSClient close error:', err instanceof Error ? err.message : err);
      }
      this.wsClient = null;
    }
    this.restClient = null;

    // Reject all waiting consumers
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    // Clean up active cards
    for (const [, state] of this.activeCards) {
      state.closing = true;
      if (state.throttleTimer) clearTimeout(state.throttleTimer);
    }
    this.activeCards.clear();
    this.cardCreatePromises.clear();
    this.cardGenerations.clear();
    this.workflowCards.clear();

    // Clear state
    this.seenMessageIds.clear();
    this.incomingInFlight.clear();
    this.lastIncomingMessageId.clear();
    this.typingReactions.clear();
    this.reactionMessages.clear();
    for (const [, t] of this.processingNoticeTimers) {
      clearTimeout(t);
    }
    this.processingNoticeTimers.clear();

    console.log('[feishu-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this.running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  // ── Typing indicator (Openclaw-style reaction) ─────────────

  /**
   * Add a "Typing" emoji reaction to the user's message and create streaming card.
   * Called by bridge-manager via onMessageStart().
   */
  onMessageStart(chatId: string): void {
    this.cleanupCard(chatId);
    const generation = {};
    this.cardGenerations.set(chatId, generation);
    const messageId = this.lastIncomingMessageId.get(chatId);

    // Clear previous fallback timer (if any)
    const existingTimer = this.processingNoticeTimers.get(chatId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.processingNoticeTimers.delete(chatId);
    }

    const cancelProcessingNotice = () => {
      const t = this.processingNoticeTimers.get(chatId);
      if (t) {
        clearTimeout(t);
        this.processingNoticeTimers.delete(chatId);
      }
    };

    // 兜底：如果没能展示任何“正在处理”的可见指示（无 reaction、无流式卡片），
    // 就回一条短提示，避免长时间无反馈导致用户不确定是否还在跑。
    if (messageId && this.restClient) {
      const timer = setTimeout(() => {
        if (this.cardGenerations.get(chatId) !== generation) return;
        this.processingNoticeTimers.delete(chatId);
        if (this.activeCards.has(chatId) || this.typingReactions.has(chatId)) return;

        const text = '已开始处理（可能需要较长时间）。可用 /status 查看，/stop 中断。';
        this.restClient!.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        }).catch(() => { /* best effort */ });
      }, 2500);
      this.processingNoticeTimers.set(chatId, timer);
    }

    // 创建流式卡片（非关键路径）。若成功，取消兜底提示。
    if (messageId) {
      this.createStreamingCard(chatId, messageId)
        .then((ok) => { if (ok && this.cardGenerations.get(chatId) === generation) cancelProcessingNotice(); })
        .catch(() => {});
    }

    // Typing indicator (same as before)
    if (!messageId || !this.restClient) return;
    this.restClient.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: TYPING_EMOJI } },
    }).then((res) => {
      const reactionId = (res as any)?.data?.reaction_id;
      if (reactionId) {
        if (this.cardGenerations.get(chatId) !== generation) {
          void this.restClient?.im.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } }).catch(() => {});
          return;
        }
        this.reactionMessages.set(chatId, messageId);
        this.typingReactions.set(chatId, reactionId);
        cancelProcessingNotice();
      }
    }).catch((err) => {
      const code = (err as { code?: number })?.code;
      if (code !== 99991400 && code !== 99991403) {
        console.warn('[feishu-adapter] Typing indicator failed:', err instanceof Error ? err.message : err);
      }
    });
  }

  /**
   * Remove the "Typing" emoji reaction and clean up card state.
   * Called by bridge-manager via onMessageEnd().
   */
  onMessageEnd(chatId: string): void {
    const timer = this.processingNoticeTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this.processingNoticeTimers.delete(chatId);
    }

    // Clean up any orphaned card state (normally cleaned by finalizeCard)
    this.cleanupCard(chatId);

    // Remove typing reaction (same as before)
    const reactionId = this.typingReactions.get(chatId);
    const messageId = this.reactionMessages.get(chatId);
    this.reactionMessages.delete(chatId);
    if (!reactionId || !messageId || !this.restClient) return;
    this.typingReactions.delete(chatId);
    this.restClient.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    }).catch(() => { /* ignore */ });
  }

  // ── Card Action Handler ─────────────────────────────────────

  /**
   * 飞书要求快速响应；这里只解析并入队，目录刷新和持久化由核心处理。
   */
  private async handleCardAction(data: unknown): Promise<unknown> {
    const event = asRecord(data);
    const action = asRecord(event?.action);
    const value = asRecord(action?.value);
    const context = asRecord(event?.context);
    const operator = asRecord(event?.operator);
    // 来源只能取飞书回调上下文，不能信任按钮 value 中的 chatId。
    const chatId = pickString(context?.open_chat_id);
    const messageId = pickString(context?.open_message_id);
    const userId = pickString(operator?.open_id);
    if (!chatId || !messageId || !userId || !this.isAuthorized(userId, chatId)) {
      return { toast: { type: 'error', content: '无权操作此卡片，或消息来源无效。' } };
    }
    const callbackMsg: InboundMessage = {
      messageId: `card_action_${crypto.randomUUID()}`,
      address: { channelType: 'feishu', chatId, userId },
      text: '', timestamp: Date.now(), callbackMessageId: messageId,
    };
    const requestId = pickString(value?.user_input_request_id);
    if (value && 'model_selection_request_id' in value) {
      const response = parseModelSelectionResponse(value, action?.form_value);
      if (!response) return { toast: { type: 'error', content: '模型设置表单无效，请重新打开 /model。' } };
      callbackMsg.modelSelectionResponse = response;
    } else if (requestId) {
      const fields = asRecord(value?.fields);
      const form = asRecord(action?.form_value);
      if (!fields || !form || Object.keys(fields).length === 0 || Object.keys(fields).length > 50) {
        return { toast: { type: 'error', content: '问答表单无效，请重新提交。' } };
      }
      const answers: Record<string, string[]> = Object.create(null);
      for (const [name, rawId] of Object.entries(fields)) {
        const id = pickString(rawId);
        if (!id || !/^q\d+$/.test(name)) return { toast: { type: 'error', content: '问答字段无效。' } };
        const raw = form[name];
        const other = form[`${name}_other`];
        if (raw !== undefined && typeof raw !== 'string' && !(Array.isArray(raw) && raw.every(item => typeof item === 'string'))) {
          return { toast: { type: 'error', content: '答案格式无效。' } };
        }
        if (other !== undefined && typeof other !== 'string') return { toast: { type: 'error', content: '补充答案格式无效。' } };
        const selected = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter(item => item.trim());
        // 自由文本用于替代单选，或补充多选；核心 broker 继续校验问题和可选值。
        const multiSelect = Array.isArray(value?.multi_select_fields) && value.multi_select_fields.includes(name);
        answers[id] = typeof other === 'string' && other.trim()
          ? multiSelect ? [...selected, other.trim()] : [other.trim()]
          : selected;
      }
      callbackMsg.userInputResponse = { requestId, answers };
    } else {
      const callbackData = pickString(value?.callback_data);
      if (!callbackData || !/^(perm|workflow):/.test(callbackData)) return { toast: { type: 'error', content: '不支持的卡片操作。' } };
      callbackMsg.callbackData = callbackData;
    }
    this.enqueue(callbackMsg);
    return { toast: { type: 'info', content: '已提交，正在校验请求状态。' } };
  }

  // ── Streaming Card (CardKit v1) ────────────────────────────────

  /**
   * Create a new streaming card and send it as a message.
   * Returns true if card was created successfully.
   */
  private createStreamingCard(chatId: string, replyToMessageId?: string): Promise<boolean> {
    if (!this.restClient || this.activeCards.has(chatId)) return Promise.resolve(false);

    // In-flight guard: if creation is already in progress, return the existing promise
    const existing = this.cardCreatePromises.get(chatId);
    if (existing) return existing;

    const generation = this.cardGenerations.get(chatId) ?? {};
    this.cardGenerations.set(chatId, generation);
    const promise = this._doCreateStreamingCard(chatId, replyToMessageId, generation);
    this.cardCreatePromises.set(chatId, promise);
    void promise.finally(() => { if (this.cardCreatePromises.get(chatId) === promise) this.cardCreatePromises.delete(chatId); });
    return promise;
  }

  private async _doCreateStreamingCard(chatId: string, replyToMessageId: string | undefined, generation: object): Promise<boolean> {
    if (!this.restClient) return false;

    try {
      // Step 1: Create card via CardKit v1
      const cardBody = {
        schema: '2.0',
        config: {
          streaming_mode: true,
          wide_screen_mode: true,
          summary: { content: '思考中...' },
          streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: 'fast' },
        },
        body: {
          elements: [{
            tag: 'markdown',
            content: ' ',
            text_align: 'left',
            text_size: 'normal',
            element_id: 'streaming_content',
          }, { tag: 'markdown', content: '💭 思考中…', element_id: 'tool_progress', text_size: 'notation' },
          { tag: 'markdown', content: ' ', element_id: 'append_notice', text_size: 'notation' }],
        },
      };

      const createResp = await this.restClient.cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(cardBody) },
      });
      assertFeishuSuccess(createResp);
      if (this.cardGenerations.get(chatId) !== generation) return false;
      const cardId = createResp?.data?.card_id;
      if (!cardId) {
        console.warn('[feishu-adapter] Card create returned no card_id');
        return false;
      }

      // Step 2: Send card as IM message
      const cardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      let msgResp;
      if (replyToMessageId) {
        msgResp = await this.restClient.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardContent, msg_type: 'interactive' },
        });
      } else {
        msgResp = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardContent,
          },
        });
      }

      assertFeishuSuccess(msgResp);
      if (this.cardGenerations.get(chatId) !== generation) return false;
      const messageId = msgResp?.data?.message_id;
      if (!messageId) {
        console.warn('[feishu-adapter] Card message send returned no message_id');
        return false;
      }

      // Store card state
      this.activeCards.set(chatId, {
        cardId,
        messageId,
        sequence: 0,
        startTime: Date.now(),
        toolCalls: [],
        thinking: true,
        pendingText: null,
        lastUpdateAt: 0,
        throttleTimer: null,
        nextFlushAt: null,
        inFlight: false,
        operation: null,
        closing: false,
        progress: '',
        sentText: '',
        sentProgress: '💭 思考中…',
        sentNotice: '',
        needsFlush: false,
        cooldownUntil: 0,
        rateLimitBackoffMs: DEFAULT_RATE_LIMIT_BACKOFF_MS,
        lastRateLimitLogAt: 0,
        appendNotice: null,
      });

      console.log(`[feishu-adapter] Streaming card created: cardId=${cardId}, msgId=${messageId}`);
      return true;
    } catch (err) {
      console.warn('[feishu-adapter] Failed to create streaming card:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  /**
   * Update streaming card content with throttling.
   */
  private getCardThrottleMs(): number {
    const { store } = getBridgeContext();
    const raw = store.getSetting('bridge_feishu_stream_card_throttle_ms');
    const n = parsePositiveInt(raw);
    if (n == null) return DEFAULT_CARD_THROTTLE_MS;
    return clamp(n, MIN_CARD_THROTTLE_MS, MAX_CARD_THROTTLE_MS);
  }

  private scheduleCardUpdate(chatId: string): void {
    const state = this.activeCards.get(chatId);
    if (!state || state.closing) return;

    if (state.inFlight) {
      state.needsFlush = true;
      return;
    }

    const throttleMs = this.getCardThrottleMs();
    const now = Date.now();
    const earliestByThrottle = (state.lastUpdateAt > 0) ? (state.lastUpdateAt + throttleMs) : now;
    const earliest = Math.max(earliestByThrottle, state.cooldownUntil);

    if (earliest <= now) {
      if (state.throttleTimer) {
        clearTimeout(state.throttleTimer);
        state.throttleTimer = null;
      }
      state.nextFlushAt = null;
      this.flushCardUpdate(chatId);
      return;
    }

    if (state.throttleTimer) {
      if (state.nextFlushAt === earliest) return;
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }

    state.nextFlushAt = earliest;
    state.throttleTimer = setTimeout(() => {
      const current = this.activeCards.get(chatId);
      if (current !== state || state.closing) return;
      current.throttleTimer = null;
      current.nextFlushAt = null;
      this.flushCardUpdate(chatId);
    }, Math.max(0, earliest - now));
    state.throttleTimer.unref();
  }

  private updateCardContent(chatId: string, text: string): void {
    const state = this.activeCards.get(chatId);
    if (!state || state.closing || !this.restClient) return;

    // Clear thinking state once text arrives
    if (state.thinking && text.trim()) {
      state.thinking = false;
    }
    const parts = splitFeishuMarkdown(text, 20_000);
    state.pendingText = parts[0] ?? '';
    if (parts.length > 1) state.appendNotice = '正文较长，完整回答将在结束后分段发送。';
    this.scheduleCardUpdate(chatId);
  }

  /**
   * Flush pending card update to Feishu API.
   */
  private flushCardUpdate(chatId: string): void {
    const state = this.activeCards.get(chatId);
    const client = this.restClient;
    if (!state || !client || state.closing) return;
    if (state.inFlight) { state.needsFlush = true; return; }
    if (state.cooldownUntil > Date.now()) { this.scheduleCardUpdate(chatId); return; }

    const text = state.pendingText || '';
    const progress = [state.progress, buildToolProgressMarkdown(state.toolCalls)].filter(Boolean).join('\n');
    const notice = state.appendNotice || '';
    if (text === state.sentText && progress === state.sentProgress && notice === state.sentNotice) return;
    // 超长正文留给最终分块投递，不截断或谎报已完成。
    if (Buffer.byteLength(JSON.stringify({ text, progress, notice }), 'utf8') > MAX_CARD_BYTES - 2_000) return;

    state.inFlight = true;
    state.needsFlush = false;
    state.operation = (async () => {
      try {
        if (text !== state.sentText && text) {
          assertFeishuSuccess(await client.cardkit.v1.cardElement.content({
            path: { card_id: state.cardId, element_id: 'streaming_content' },
            data: { content: text, sequence: ++state.sequence },
          }));
          state.sentText = text;
        }
        // 收尾已开始时无需再写进度，最终卡会替换所有元素。
        if (state.closing) return;
        const actions: Array<Record<string, unknown>> = [];
        if (progress !== state.sentProgress) actions.push({ action: 'partial_update_element', params: { element_id: 'tool_progress', partial_element: { content: progress || ' ' } } });
        if (notice !== state.sentNotice) actions.push({ action: 'partial_update_element', params: { element_id: 'append_notice', partial_element: { content: notice || ' ' } } });
        if (actions.length) {
          assertFeishuSuccess(await client.cardkit.v1.card.batchUpdate({
            path: { card_id: state.cardId },
            data: { actions: JSON.stringify(actions), sequence: ++state.sequence },
          }));
          state.sentProgress = progress;
          state.sentNotice = notice;
        }
        state.cooldownUntil = 0;
        state.rateLimitBackoffMs = DEFAULT_RATE_LIMIT_BACKOFF_MS;
      } catch (err) {
        const payload = findFeishuApiErrorPayload(err);
        if (payload?.code === FEISHU_TRIGGER_RATE_LIMIT_CODE) {
          const backoff = state.rateLimitBackoffMs;
          state.cooldownUntil = Date.now() + backoff;
          state.rateLimitBackoffMs = Math.min(backoff * 2, MAX_RATE_LIMIT_BACKOFF_MS);
          state.needsFlush = true;
          if (Date.now() - state.lastRateLimitLogAt >= RATE_LIMIT_LOG_THROTTLE_MS) {
            state.lastRateLimitLogAt = Date.now();
            console.warn(`[feishu-adapter] 卡片更新频控，退避 ${backoff}ms`);
          }
        } else {
          console.warn(`[feishu-adapter] 卡片更新失败：${toErrorMessage(err)}`);
        }
      } finally {
        state.lastUpdateAt = Date.now();
        state.inFlight = false;
        state.operation = null;
        // 旧卡片的异步回调不得调度同一聊天后续新卡。
        if (!state.closing && this.activeCards.get(chatId) === state && state.needsFlush) {
          state.needsFlush = false;
          this.scheduleCardUpdate(chatId);
        }
      }
    })();
  }

  /**
   * Update tool progress in the streaming card.
   */
  private updateToolProgress(chatId: string, tools: ToolCallInfo[]): void {
    const state = this.activeCards.get(chatId);
    if (!state || state.closing) return;
    state.toolCalls = tools;
    this.scheduleCardUpdate(chatId);
  }

  /** 先禁止新更新，再等待已发请求，最后提交完成卡。 */
  private async finalizeCard(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    extras?: { ctx?: string },
  ): Promise<boolean> {
    const generation = this.cardGenerations.get(chatId);
    let state = this.activeCards.get(chatId);
    const pending = this.cardCreatePromises.get(chatId);
    if (pending) { try { await pending; } catch { /* 创建失败交回普通投递 */ } }
    if (this.cardGenerations.get(chatId) !== generation) return false;
    state ??= this.activeCards.get(chatId);
    const client = this.restClient;
    if (!state || !client || state.closing) return false;
    state.closing = true;
    state.needsFlush = false;
    if (state.throttleTimer) clearTimeout(state.throttleTimer);
    state.throttleTimer = null;
    state.nextFlushAt = null;
    if (state.operation) await state.operation;
    if (this.cardGenerations.get(chatId) !== generation || this.activeCards.get(chatId) !== state) return false;

    const labels = { completed: '✅ 已完成', interrupted: '⚠️ 已中断', error: '❌ 出错' };
    const elapsed = formatElapsed(Date.now() - state.startTime);
    const finalCardJson = buildFinalCardJson(responseText, [], { status: labels[status], elapsed, ...extras });
    const summary = `${labels[status]} ${responseText.replace(/\s+/g, ' ').trim()}`.slice(0, 120);
    let updated = false;
    try {
      if (Buffer.byteLength(JSON.stringify({ card: { type: 'card_json', data: finalCardJson }, sequence: state.sequence + 1 }), 'utf8') > MAX_CARD_BYTES) throw new Error('最终卡片超过 30KB，转交完整回答投递');
      assertFeishuSuccess(await client.cardkit.v1.card.update({
        path: { card_id: state.cardId },
        data: { card: { type: 'card_json', data: finalCardJson }, sequence: ++state.sequence },
      }));
      updated = true;
    } catch (err) {
      console.warn(`[feishu-adapter] 完成卡更新失败：${toErrorMessage(err)}`);
      // 即使最终正文投递失败也结束流式状态；返回 false 让核心发送完整回答。
      try {
        if (this.cardGenerations.get(chatId) !== generation) return false;
        assertFeishuSuccess(await client.cardkit.v1.card.settings({
          path: { card_id: state.cardId },
          data: { settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: summary } } }), sequence: ++state.sequence },
        }));
      } catch (closeError) {
        console.warn(`[feishu-adapter] 关闭流式卡失败：${toErrorMessage(closeError)}`);
      }
    } finally {
      if (this.activeCards.get(chatId) === state) this.activeCards.delete(chatId);
    }
    const notifyEnabled = getBridgeContext().store.getSetting('bridge_feishu_stream_card_notify_on_complete') !== 'false';
    if (this.cardGenerations.get(chatId) === generation && updated && notifyEnabled && (status === 'completed' || (status === 'error' && responseText.trim()))) {
      try {
        const notice = status === 'completed' ? '任务已完成' : '任务执行出错';
        assertFeishuSuccess(await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: `${notice}（耗时 ${elapsed}）` }) },
        }));
      } catch (err) { console.warn(`[feishu-adapter] 完成通知失败：${toErrorMessage(err)}`); }
    }
    return updated;
  }

  /**
   * Clean up card state without finalizing (e.g. on unexpected errors).
   */
  private cleanupCard(chatId: string): void {
    this.cardGenerations.delete(chatId);
    this.cardCreatePromises.delete(chatId);
    const state = this.activeCards.get(chatId);
    if (!state) return;
    state.closing = true;
    state.needsFlush = false;
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
    }
    this.activeCards.delete(chatId);
  }

  /**
   * Check if there is an active streaming card for a given chat.
   */
  hasActiveCard(chatId: string): boolean {
    return this.activeCards.has(chatId);
  }

  // ── Streaming adapter interface ────────────────────────────────

  /**
   * 在活跃的流式卡片上显示追加消息提示。
   * 如果有活跃卡片，设置 appendNotice 并触发刷新，返回 true。
   * 如果没有活跃卡片，返回 false（调用方应 fallback 为文本消息）。
   */
  notifyAppend(chatId: string, count: number, previewText: string): boolean {
    const state = this.activeCards.get(chatId);
    if (!state || state.closing) return false;
    const preview = previewText.length > 60
      ? previewText.slice(0, 57) + '...'
      : previewText;
    state.appendNotice = count === 1
      ? `📎 **+1 追加** ${preview}`
      : `📎 **+${count} 追加**`;
    // 触发一次卡片刷新以显示提示
    this.scheduleCardUpdate(chatId);
    return true;
  }

  /**
   * Called by bridge-manager on each text SSE event.
   * Creates streaming card on first call, then updates content.
   */
  onStreamText(chatId: string, fullText: string): void {
    if (!this.activeCards.has(chatId)) {
      // Card should have been created by onMessageStart, but create lazily if not
      const messageId = this.lastIncomingMessageId.get(chatId);
      const creating = this.createStreamingCard(chatId, messageId);
      const generation = this.cardGenerations.get(chatId);
      creating.then((ok) => {
        if (ok && this.cardGenerations.get(chatId) === generation) this.updateCardContent(chatId, fullText);
      }).catch(() => {});
      return;
    }
    this.updateCardContent(chatId, fullText);
  }

  onToolEvent(chatId: string, tools: ToolCallInfo[]): void {
    this.updateToolProgress(chatId, tools);
  }

  onProgress(chatId: string, text: string): void {
    const state = this.activeCards.get(chatId);
    if (!state) {
      const creating = this.createStreamingCard(chatId, this.lastIncomingMessageId.get(chatId));
      const generation = this.cardGenerations.get(chatId);
      void creating.then(ok => {
        if (ok && this.cardGenerations.get(chatId) === generation) this.onProgress(chatId, text);
      });
      return;
    }
    if (state.closing) return;
    state.progress = text;
    this.scheduleCardUpdate(chatId);
  }

  async sendUserInputRequest(address: ChannelAddress, request: UserInputRequest, replyToMessageId?: string): Promise<SendResult> {
    if (request.questions.some(question => question.isSecret)) {
      return { ok: false, error: '此聊天不支持安全输入，请在本地完成。' };
    }
    if (!this.restClient) return { ok: false, error: 'Feishu client not initialized' };
    try {
      const content = buildUserInputCard(request);
      if (Buffer.byteLength(content, 'utf8') > MAX_CARD_BYTES) return { ok: false, error: '问答卡片超过大小限制，请在本地完成。' };
      const response = replyToMessageId
        ? await this.restClient.im.message.reply({ path: { message_id: replyToMessageId }, data: { msg_type: 'interactive', content } })
        : await this.restClient.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: address.chatId, msg_type: 'interactive', content } });
      assertFeishuSuccess(response);
      return response.data?.message_id ? { ok: true, messageId: response.data.message_id } : { ok: false, error: '问答卡片发送后缺少消息 ID' };
    } catch (err) {
      return { ok: false, error: toErrorMessage(err) };
    }
  }

  async sendModelSelection(address: ChannelAddress, view: ModelSelectionView, replyToMessageId?: string): Promise<SendResult> {
    if (!this.restClient) return { ok: false, error: 'Feishu client not initialized' };
    try {
      const content = buildModelSelectionCard(view);
      const data = { msg_type: 'interactive', content, ...(!replyToMessageId ? { receive_id: address.chatId } : {}) };
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_CARD_BYTES) return { ok: false, httpStatus: 413, error: '模型目录内容过长，暂时无法显示卡片；可用 /model <目录 ID> 选择。' };
      const response = replyToMessageId
        ? await this.restClient.im.message.reply({ path: { message_id: replyToMessageId }, data })
        : await this.restClient.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { ...data, receive_id: address.chatId } });
      assertFeishuSuccess(response);
      const messageId = pickString(response.data?.message_id);
      return messageId ? { ok: true, messageId } : { ok: false, error: '模型卡片发送后缺少消息 ID' };
    } catch (err) {
      return { ok: false, error: toErrorMessage(err) };
    }
  }

  async updateModelSelection(_address: ChannelAddress, messageId: string, view: ModelSelectionView): Promise<SendResult> {
    if (!this.restClient) return { ok: false, error: 'Feishu client not initialized' };
    if (!pickString(messageId)) return { ok: false, error: '模型卡片更新缺少消息 ID' };
    try {
      const data = { content: buildModelSelectionCard(view) };
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_CARD_BYTES) return { ok: false, httpStatus: 413, error: '模型目录内容过长，暂时无法显示卡片；可用 /model <目录 ID> 选择。' };
      assertFeishuSuccess(await this.restClient.im.message.patch({ path: { message_id: messageId }, data }));
      return { ok: true, messageId };
    } catch (err) {
      return { ok: false, error: toErrorMessage(err) };
    }
  }

  async updateInteractionMessage(address: ChannelAddress, messageId: string, status: 'allowed' | 'denied' | 'expired' | 'failed' | 'answered'): Promise<void> {
    if (!this.restClient) throw new Error('Feishu client not initialized');
    const labels = { allowed: '✅ 已允许', denied: '⛔ 已拒绝或取消', expired: '⌛ 请求已过期', failed: '❌ 请求投递失败，已拒绝', answered: '✅ 答案已提交' };
    assertFeishuSuccess(await this.restClient.im.message.patch({ path: { message_id: messageId }, data: { content: buildCardContent(labels[status]) } }));
  }

  async onStreamEnd(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    extras?: { ctx?: string },
  ): Promise<boolean> {
    return this.finalizeCard(chatId, status, responseText, extras);
  }

  // ── Workflow progress card ────────────────────────────────────

  /**
   * Create a workflow progress card and send it as a message.
   * Uses CardKit v1 (non-streaming) — the full card JSON is replaced on each update.
   *
   * @returns cardId on success, null on failure.
   */
  async createWorkflowCard(chatId: string, cardJson: string, replyToMessageId?: string): Promise<string | null> {
    if (!this.restClient) return null;
    if (this.workflowCards.has(chatId)) {
      console.warn('[feishu-adapter] Workflow card already exists for chat, skipping creation');
      return null;
    }

    try {
      // Step 1: Create card via CardKit v1
      const createResp = await this.restClient.cardkit.v1.card.create({
        data: { type: 'card_json', data: cardJson },
      });
      assertFeishuSuccess(createResp);
      const cardId = createResp?.data?.card_id;
      if (!cardId) {
        console.warn('[feishu-adapter] Workflow card create returned no card_id');
        return null;
      }

      // Step 2: Send card as IM message
      const cardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      let msgResp;
      if (replyToMessageId) {
        msgResp = await this.restClient.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardContent, msg_type: 'interactive' },
        });
      } else {
        msgResp = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content: cardContent },
        });
      }

      assertFeishuSuccess(msgResp);
      if (!msgResp?.data?.message_id) {
        console.warn('[feishu-adapter] Workflow card message send returned no message_id');
        return null;
      }

      this.workflowCards.set(chatId, { cardId, sequence: 0, operation: Promise.resolve(), closing: false });
      console.log(`[feishu-adapter] Workflow card created: cardId=${cardId}`);
      return cardId;
    } catch (err) {
      console.warn('[feishu-adapter] Failed to create workflow card:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Update workflow progress card with new card JSON.
   */
  async updateWorkflowCard(chatId: string, cardJson: string): Promise<boolean> {
    const state = this.workflowCards.get(chatId);
    const client = this.restClient;
    if (!state || !client || state.closing) return false;
    const operation = state.operation.then(async () => {
      if (state.closing) return false;
      assertFeishuSuccess(await client.cardkit.v1.card.update({
        path: { card_id: state.cardId },
        data: { card: { type: 'card_json', data: cardJson }, sequence: ++state.sequence },
      }));
      return true;
    }).catch((err: unknown) => {
      console.warn(`[feishu-adapter] 工作流卡更新失败：${toErrorMessage(err)}`);
      return false;
    });
    state.operation = operation;
    return operation;
  }

  /**
   * Finalize workflow progress card and clean up state.
   */
  async finalizeWorkflowCard(chatId: string, cardJson: string): Promise<boolean> {
    const state = this.workflowCards.get(chatId);
    const client = this.restClient;
    if (!state || !client || state.closing) return false;
    state.closing = true;
    await state.operation;
    try {
      assertFeishuSuccess(await client.cardkit.v1.card.update({
        path: { card_id: state.cardId },
        data: { card: { type: 'card_json', data: cardJson }, sequence: ++state.sequence },
      }));
      console.log(`[feishu-adapter] Workflow card finalized: cardId=${state.cardId}`);
      return true;
    } catch (err) {
      console.warn('[feishu-adapter] Workflow card finalize failed:', err instanceof Error ? err.message : err);
      return false;
    } finally {
      if (this.workflowCards.get(chatId) === state) this.workflowCards.delete(chatId);
    }
  }

  // ── Send ────────────────────────────────────────────────────

  async uploadImage(image: GeneratedImage): Promise<ImageUploadResult> {
    if (!this.restClient) return { ok: false, error: '飞书客户端尚未初始化' };
    let bytes: Buffer;
    try { bytes = decodeGeneratedImage(image); }
    catch { return { ok: false, error: '生成图片内容无效，无法上传' }; }
    try {
      const response = await this.restClient.im.image.create({ data: { image_type: 'message', image: bytes } });
      if (typeof response?.image_key !== 'string' || !response.image_key.trim()) {
        return { ok: false, error: '飞书图片上传未返回有效标识，尚未发送图片消息' };
      }
      return { ok: true, imageKey: response.image_key };
    } catch (error) { return imageFailure('飞书图片上传', error); }
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    if (message.image) {
      if (!message.image.imageKey.trim() || !message.image.sendUuid.trim()) return { ok: false, httpStatus: 400, error: '图片发送标识无效' };
      try {
        const response = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: message.address.chatId, msg_type: 'image',
            content: JSON.stringify({ image_key: message.image.imageKey }), uuid: message.image.sendUuid },
        });
        if (response?.code !== 0 || !response.data?.message_id?.trim()) return imageFailure('飞书图片发送', response);
        return { ok: true, messageId: response.data.message_id };
      } catch (error) { return imageFailure('飞书图片发送', error); }
    }

    let text = message.text;

    // Convert HTML to markdown for Feishu rendering (e.g. command responses)
    if (message.parseMode === 'HTML') {
      text = htmlToFeishuMarkdown(text);
    }

    // Preprocess markdown for Claude responses
    if (message.parseMode === 'Markdown') {
      text = preprocessFeishuMarkdown(text);
    }

    // If there are inline buttons (permission prompts), send card with action buttons
    if (message.inlineButtons && message.inlineButtons.length > 0) {
      return this.sendPermissionCard(message.address.chatId, text, message.inlineButtons);
    }

    if (feishuPayloadBytes(text) > MAX_CARD_BYTES) return { ok: false, httpStatus: 413, error: '飞书消息超过字节预算，请通过分块投递发送' };

    // Rendering strategy (aligned with Openclaw):
    // - Code blocks / tables → interactive card (schema 2.0 markdown)
    // - Other text → post (md tag)
    if (hasComplexMarkdown(text)) {
      return this.sendAsCard(message.address.chatId, text);
    }
    return this.sendAsPost(message.address.chatId, text);
  }

  /**
   * Send text as an interactive card (schema 2.0 markdown).
   * Used for code blocks and tables — card renders them properly.
   */
  private async sendAsCard(chatId: string, text: string): Promise<SendResult> {
    const cardContent = buildCardContent(text);

    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardContent,
        },
      });

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Card send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Card send error, falling back to post:', err instanceof Error ? err.message : err);
    }

    // Fallback to post
    return this.sendAsPost(chatId, text);
  }

  /**
   * Send text as a post message (msg_type: 'post') with md tag.
   * Used for simple text — renders bold, italic, inline code, links.
   */
  private async sendAsPost(chatId: string, text: string): Promise<SendResult> {
    const postContent = buildPostContent(text);

    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: postContent,
        },
      });

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Post send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Post send error, falling back to text:', err instanceof Error ? err.message : err);
    }

    // Final fallback: plain text
    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Permission card (with real action buttons) ─────────────

  /**
   * Send a permission card with real Feishu card action buttons.
   * Button clicks trigger card.action.trigger events handled by handleCardAction().
   * Falls back to text-based /perm commands if button card fails.
   */
  private async sendPermissionCard(
    chatId: string,
    text: string,
    inlineButtons: import('../types.js').InlineButton[][],
  ): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    const mdText = htmlToFeishuMarkdown(text);
    const firstButton = inlineButtons.flat()[0];
    const permissionId = firstButton?.callbackData.startsWith('perm:')
      ? firstButton.callbackData.split(':').slice(2).join(':') : '';
    if (permissionId) {
      try {
        const response = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content: buildPermissionButtonCard(mdText, permissionId, chatId) },
        });
        assertFeishuSuccess(response);
        if (response.data?.message_id) return { ok: true, messageId: response.data.message_id };
      } catch (err) {
        console.warn(`[feishu-adapter] 审批卡发送失败，改用文本命令：${toErrorMessage(err)}`);
      }
    }
    // 卡片能力不可用时直接发送等价命令，避免重复尝试同一类卡片。
    const commands = inlineButtons.flat().map(button => {
      const [prefix, action, ...id] = button.callbackData.split(':');
      return prefix === 'perm' ? `${button.text}：/perm ${action} ${id.join(':')}` : button.text;
    });
    try {
      const response = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: [mdText, '', ...commands].join('\n') }) },
      });
      assertFeishuSuccess(response);
      return response.data?.message_id
        ? { ok: true, messageId: response.data.message_id }
        : { ok: false, error: '审批消息发送后缺少消息 ID' };
    } catch (err) {
      return { ok: false, error: toErrorMessage(err) };
    }
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const enabled = getBridgeContext().store.getSetting('bridge_feishu_enabled');
    if (enabled !== 'true') return 'bridge_feishu_enabled is not true';

    const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id');
    if (!appId) return 'bridge_feishu_app_id not configured';

    const appSecret = getBridgeContext().store.getSetting('bridge_feishu_app_secret');
    if (!appSecret) return 'bridge_feishu_app_secret not configured';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('bridge_feishu_allowed_users') || '';
    if (!allowedUsers) {
      // No restriction configured — allow all
      return true;
    }

    const allowed = allowedUsers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowed.length === 0) return true;

    return allowed.includes(userId) || allowed.includes(chatId);
  }

  // ── Incoming event handler ──────────────────────────────────

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    const id = data.message.message_id;
    if (this.seenMessageIds.has(id) || this.incomingInFlight.has(id)) return;
    this.incomingInFlight.add(id);
    try {
      await this.processIncomingEvent(data);
      this.addToDedup(id);
    } catch (err) {
      console.error(
        '[feishu-adapter] Unhandled error in event handler:',
        err instanceof Error ? err.stack || err.message : err,
      );
    } finally { this.incomingInFlight.delete(id); }
  }

  private async processIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    const msg = data.message;
    const sender = data.sender;

    // [P1] Filter out bot messages to prevent self-triggering loops
    if (sender.sender_type === 'bot') return;

    // Dedup by message_id
    if (this.seenMessageIds.has(msg.message_id)) return;

    const chatId = msg.chat_id;
    // [P2] Complete sender ID fallback chain: open_id > user_id > union_id
    const userId = sender.sender_id?.open_id
      || sender.sender_id?.user_id
      || sender.sender_id?.union_id
      || '';
    const isGroup = msg.chat_type === 'group';

    // Authorization check
    if (!this.isAuthorized(userId, chatId)) {
      console.warn('[feishu-adapter] Unauthorized message from userId:', userId, 'chatId:', chatId);
      return;
    }

    // Group chat policy
    if (isGroup) {
      const policy = getBridgeContext().store.getSetting('bridge_feishu_group_policy') || 'open';

      if (policy === 'disabled') {
        console.log('[feishu-adapter] Group message ignored (policy=disabled), chatId:', chatId);
        return;
      }

      if (policy === 'allowlist') {
        const allowedGroups = (getBridgeContext().store.getSetting('bridge_feishu_group_allow_from') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!allowedGroups.includes(chatId)) {
          console.log('[feishu-adapter] Group message ignored (not in allowlist), chatId:', chatId);
          return;
        }
      }

      // Require @mention check
      const requireMention = getBridgeContext().store.getSetting('bridge_feishu_require_mention') !== 'false';
      if (requireMention && !this.isBotMentioned(msg.mentions)) {
        console.log('[feishu-adapter] Group message ignored (bot not @mentioned), chatId:', chatId, 'msgId:', msg.message_id);
        try {
          getBridgeContext().store.insertAuditLog({
            channelType: 'feishu',
            chatId,
            direction: 'inbound',
            messageId: msg.message_id,
            summary: '[FILTERED] Group message dropped: bot not @mentioned (require_mention=true)',
          });
        } catch { /* best effort */ }
        return;
      }
    }

    // Track last message ID per chat for typing indicator
    this.lastIncomingMessageId.set(chatId, msg.message_id);

    // Extract content based on message type
    const messageType = msg.message_type;
    let text = '';
    const attachments: FileAttachment[] = [];

    if (messageType === 'text') {
      text = this.parseTextContent(msg.content);
    } else if (['image', 'post'].includes(messageType)) {
      const parsed = messageType === 'post' ? this.parsePostContent(msg.content) : { extractedText: '', imageKeys: [this.extractFileKey(msg.content)].filter((key): key is string => Boolean(key)) };
      text = parsed.extractedText;
      const failed: number[] = [];
      for (const [index, key] of parsed.imageKeys.entries()) {
        const attachment = await this.downloadResource(msg.message_id, key, 'image');
        if (attachment && /^image\/(png|jpeg|gif|webp)$/.test(attachment.type)) attachments.push(attachment);
        else failed.push(index + 1);
      }
      if (!parsed.imageKeys.length && messageType === 'image') failed.push(1);
      if (failed.length) {
        const warning = `图片 ${failed.join('、')} 未能读取（下载失败或格式不支持）。${attachments.length ? '仅使用已成功读取的图片继续处理。' : '本条未交给模型，请重新发送 PNG/JPEG/GIF/WebP 图片。'}`;
        const notice = await this.send({ address: { channelType: 'feishu', chatId, userId }, text: warning, parseMode: 'plain' });
        if (!notice.ok) throw new Error(notice.error || '附件失败提示发送失败');
        if (!attachments.length) return;
        text += `\n[附件接收提示] ${warning}`;
      }
    } else {
      const notice = await this.send({ address: { channelType: 'feishu', chatId, userId }, text: `暂不支持读取 ${messageType} 类型附件，请发送文本或 PNG/JPEG/GIF/WebP 图片。`, parseMode: 'plain' });
      if (!notice.ok) throw new Error(notice.error || '附件类型提示发送失败');
      return;
    }

    // Strip @mention markers from text
    text = this.stripMentionMarkers(text);

    if (!text.trim() && attachments.length === 0) return;

    const timestamp = parseInt(msg.create_time, 10) || Date.now();
    const address = {
      channelType: 'feishu' as const,
      chatId,
      userId,
    };

    // [P1] Check for /perm text command (permission approval fallback)
    const trimmedText = text.trim();
    if (trimmedText.startsWith('/perm ')) {
      const permParts = trimmedText.split(/\s+/);
      // /perm <action> <permId>
      if (permParts.length >= 3) {
        const action = permParts[1]; // allow / allow_session / deny
        const permId = permParts.slice(2).join(' ');
        const callbackData = `perm:${action}:${permId}`;

        const inbound: InboundMessage = {
          messageId: msg.message_id,
          address,
          text: trimmedText,
          timestamp,
          callbackData,
        };
        this.enqueue(inbound);
        return;
      }
    }

    const inbound: InboundMessage = {
      messageId: msg.message_id,
      address,
      text: text.trim(),
      timestamp,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    // Audit log
    try {
      const summary = attachments.length > 0
        ? `[${attachments.length} attachment(s)] ${text.slice(0, 150)}`
        : text.slice(0, 200);
      getBridgeContext().store.insertAuditLog({
        channelType: 'feishu',
        chatId,
        direction: 'inbound',
        messageId: msg.message_id,
        summary,
      });
    } catch { /* best effort */ }

    this.enqueue(inbound);
  }

  // ── Content parsing ─────────────────────────────────────────

  private parseTextContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return parsed.text || '';
    } catch {
      return content;
    }
  }

  /**
   * Extract file key from message content JSON.
   * Handles multiple key names: image_key, file_key, imageKey, fileKey.
   */
  private extractFileKey(content: string): string | null {
    try {
      const parsed = JSON.parse(content);
      return parsed.image_key || parsed.file_key || parsed.imageKey || parsed.fileKey || null;
    } catch {
      return null;
    }
  }

  /**
   * Parse rich text (post) content.
   * Extracts plain text from text elements and image keys from img elements.
   */
  private parsePostContent(content: string): { extractedText: string; imageKeys: string[] } {
    const imageKeys: string[] = [];
    const textParts: string[] = [];

    try {
      const parsed = JSON.parse(content);
      // Post content structure: { title, content: [[{tag, text/image_key}]] }
      const title = parsed.title;
      if (title) textParts.push(title);

      const paragraphs = parsed.content;
      if (Array.isArray(paragraphs)) {
        for (const paragraph of paragraphs) {
          if (!Array.isArray(paragraph)) continue;
          for (const element of paragraph) {
            if (element.tag === 'text' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'a' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'at' && element.user_id) {
              // Mention in post — handled by isBotMentioned for group policy
            } else if (element.tag === 'img') {
              const key = element.image_key || element.file_key || element.imageKey;
              if (key) imageKeys.push(key);
            }
          }
          textParts.push('\n');
        }
      }
    } catch {
      // Failed to parse post content
    }

    return { extractedText: textParts.join('').trim(), imageKeys };
  }

  // ── Bot identity ────────────────────────────────────────────

  /**
   * Resolve bot identity via the Feishu REST API /bot/v3/info/.
   * Collects all available bot IDs for comprehensive mention matching.
   */
  private async resolveBotIdentity(
    appId: string,
    appSecret: string,
    domain: lark.Domain,
  ): Promise<void> {
    try {
      const baseUrl = domain === lark.Domain.Lark
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn';

      const tokenRes = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokenData: any = await tokenRes.json();
      if (!tokenData.tenant_access_token) {
        console.warn('[feishu-adapter] Failed to get tenant access token');
        return;
      }

      const botRes = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const botData: any = await botRes.json();
      if (botData?.bot?.open_id) {
        this.botOpenId = botData.bot.open_id;
        this.botIds.add(botData.bot.open_id);
      }
      // Also record app_id-based IDs if available
      if (botData?.bot?.bot_id) {
        this.botIds.add(botData.bot.bot_id);
      }
      if (!this.botOpenId) {
        console.warn('[feishu-adapter] Could not resolve bot open_id');
      }
    } catch (err) {
      console.warn(
        '[feishu-adapter] Failed to resolve bot identity:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── @Mention detection ──────────────────────────────────────

  /**
   * [P2] Check if bot is mentioned — matches against open_id, user_id, union_id.
   */
  private isBotMentioned(
    mentions?: FeishuMessageEventData['message']['mentions'],
  ): boolean {
    if (!mentions || this.botIds.size === 0) return false;
    return mentions.some((m) => {
      const ids = [m.id.open_id, m.id.user_id, m.id.union_id].filter(Boolean) as string[];
      return ids.some((id) => this.botIds.has(id));
    });
  }

  private stripMentionMarkers(text: string): string {
    // Feishu uses @_user_N placeholders for mentions
    return text.replace(/@_user_\d+/g, '').trim();
  }

  // ── Resource download ───────────────────────────────────────

  /**
   * Download a message resource (image/file/audio/video) via SDK.
   * Returns null on failure (caller decides fallback behavior).
   */
  private async downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: string,
  ): Promise<FileAttachment | null> {
    if (!this.restClient) return null;

    try {
      console.log(`[feishu-adapter] Downloading resource: type=${resourceType}, key=${fileKey}, msgId=${messageId}`);

      const res = await this.restClient.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: resourceType === 'image' ? 'image' : 'file',
        },
      });

      if (!res) {
        console.warn('[feishu-adapter] messageResource.get returned null/undefined');
        return null;
      }

      // SDK returns { writeFile, getReadableStream, headers }
      // Try stream approach first, fall back to writeFile + read if stream fails
      let buffer: Buffer;

      try {
        const readable = res.getReadableStream();
        const chunks: Buffer[] = [];
        let totalSize = 0;

        for await (const chunk of readable) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalSize += buf.length;
          if (totalSize > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
          chunks.push(buf);
        }
        buffer = Buffer.concat(chunks);
      } catch (streamErr) {
        // Stream approach failed — fall back to writeFile + read
        console.warn('[feishu-adapter] Stream read failed, falling back to writeFile:', streamErr instanceof Error ? streamErr.message : streamErr);

        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const tmpPath = path.join(os.tmpdir(), `feishu-dl-${crypto.randomUUID()}`);
        try {
          await res.writeFile(tmpPath);
          buffer = fs.readFileSync(tmpPath);
          if (buffer.length > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
        } finally {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
        }
      }

      if (!buffer || buffer.length === 0) {
        console.warn('[feishu-adapter] Downloaded resource is empty, key:', fileKey);
        return null;
      }

      const base64 = buffer.toString('base64');
      const id = crypto.randomUUID();
      const mimeType = MIME_BY_TYPE[resourceType] || 'application/octet-stream';
      const ext = resourceType === 'image' ? 'png'
        : resourceType === 'audio' ? 'ogg'
        : resourceType === 'video' ? 'mp4'
        : 'bin';

      console.log(`[feishu-adapter] Resource downloaded: ${buffer.length} bytes, key=${fileKey}`);

      return {
        id,
        name: `${fileKey}.${ext}`,
        type: mimeType,
        size: buffer.length,
        data: base64,
      };
    } catch (err) {
      console.error(
        `[feishu-adapter] Resource download failed (type=${resourceType}, key=${fileKey}):`,
        err instanceof Error ? err.stack || err.message : err,
      );
      return null;
    }
  }

  // ── Utilities ───────────────────────────────────────────────

  private addToDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);

    // LRU eviction: remove oldest entries when exceeding limit
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const excess = this.seenMessageIds.size - DEDUP_MAX;
      let removed = 0;
      for (const key of this.seenMessageIds.keys()) {
        if (removed >= excess) break;
        this.seenMessageIds.delete(key);
        removed++;
      }
    }
  }
}

// Self-register so bridge-manager can create FeishuAdapter via the registry.
registerAdapterFactory('feishu', () => new FeishuAdapter());
