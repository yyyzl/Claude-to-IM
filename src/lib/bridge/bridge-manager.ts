/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type {
  BridgeStatus,
  ChannelBinding,
  ChannelAddress,
  InboundMessage,
  OutboundMessage,
  StreamingPreviewState,
  ToolCallInfo,
} from './types.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { clearUserInputRequests, forwardUserInputRequest, handleUserInputResponse, handleUserInputText } from './user-input-broker.js';
import { deliver, deliverSingle } from './delivery-layer.js';
import { deliverResponse, retryResponseDelivery, getResponseDeliveryStatus } from './response-delivery.js';
import { abortable, settleWithin } from './internal/abort.js';
import { getBridgeContext } from './context.js';
import { ChatAdmissionGate, ModelSelectionCoordinator, describeModelPreferences } from './internal/model-selection.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import {
  processWithSessionLock as processWithSessionLockInternal,
  SessionQueueTimeoutError,
  SessionQueueCancelledError,
} from './internal/session-lock.js';
import { computeSessionQueueTimeoutMs, DEFAULT_CODEX_TURN_TIMEOUT_MS } from './internal/timeouts.js';
import {
  getGitCommitMessageExamples,
  generateAutoConventionalCommitMessage,
  parseGitSlashCommandArgs,
  validateAndNormalizeConventionalCommitMessage,
} from './internal/git-command.js';
import { generateGitCommitMessageWithLLM } from './internal/git-llm.js';
import {
  getUsageRetentionDays,
  recordTokenUsageToDailySummary,
  resolveProjectInfoFromWorkingDirectory,
  resolveUsageSummaryPath,
} from './internal/usage-summary.js';
import { parseUsageQueryRange, renderUsageReportHtml } from './internal/usage-command.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  formatCtxFooter,
  resolveContextWindow,
} from './internal/model-context-window.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';
import { buildBridgeCommandHelp } from './internal/bridge-help.js';
import { buildClaudePassthroughHelp, buildCodexPassthroughHelp } from './internal/passthrough-help.js';
import { buildCodexPassthroughPrompt } from './internal/codex-passthrough.js';
import { handleWorkflowCommand } from './internal/workflow-command.js';

const GLOBAL_KEY = '__bridge_manager__';
const execFileAsync = promisify(execFile);

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * feishu/qq channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface InputDebounceBuffer {
  /** 该 buffer 所属的最后一个 userId（用于避免群聊里把不同人的消息合并） */
  userId: string | undefined;
  messages: InboundMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  context: TurnContext;
}

interface TurnContext {
  turnId: string;
  binding: ChannelBinding;
  chatKey: string;
  generation: number;
  runEpoch: number;
  abort: AbortController;
}

interface QueuedTurn {
  context: TurnContext;
  ack: () => void;
  messageCount: number;
  started: boolean;
}

interface GitDraftRecord {
  createdAt: number;
  cwd: string;
  stagedFiles: string[];
  diffStatText: string;
  commitMessage: string;
  summaryLines: string[];
}

interface ActiveChatTask {
  abort: AbortController;
  sessionId: string;
  startedAt: number;
}

/** Timestamped tool call entry for /status live context display. */
interface RecentToolCallEntry {
  name: string;
  status: 'running' | 'complete' | 'error';
  timestamp: number; // Date.now()
}

/** Max tool call entries kept per session. */
const MAX_RECENT_TOOL_CALLS = 10;

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  activeTasksByChat: Map<string, ActiveChatTask>;
  uiOwners: Map<string, AbortController>;
  activeTaskStartedAt: Map<string, number>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  /** 普通消息的输入合并（debounce）缓冲：key = `${channelType}:${chatId}` */
  inputDebounceBuffers: Map<string, InputDebounceBuffer>;
  /** /git draft 缓存：key = codepilotSessionId */
  gitDrafts: Map<string, GitDraftRecord>;
  autoStartChecked: boolean;
  /** Recent tool calls per session for /status live context: key = codepilotSessionId */
  recentToolCalls: Map<string, RecentToolCallEntry[]>;
  /** 追加消息缓冲：当 LLM 正忙时，新消息暂存于此，任务完成后自动作为后续轮次处理。key = `${channelType}:${chatId}` */
  pendingAppends: Map<string, InboundMessage[]>;
  chatGenerations: Map<string, number>;
  queuedTurns: Set<QueuedTurn>;
  taskPromises: Set<Promise<void>>;
  /** 补发独立于模型/UI 任务，取消与停机仍使用同一代际和排空机制。 */
  retryTasks: Set<TurnContext>;
  runEpoch: number;
  stopping: Promise<void> | null;
  admissionGate: ChatAdmissionGate;
  modelSelection?: ModelSelectionCoordinator;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      activeTasksByChat: new Map(),
      uiOwners: new Map(),
      activeTaskStartedAt: new Map(),
      sessionLocks: new Map(),
      inputDebounceBuffers: new Map(),
      gitDrafts: new Map(),
      autoStartChecked: false,
      recentToolCalls: new Map(),
      pendingAppends: new Map(),
      chatGenerations: new Map(),
      queuedTurns: new Set(),
      taskPromises: new Set(),
      retryTasks: new Set(),
      runEpoch: 0,
      stopping: null,
      admissionGate: new ChatAdmissionGate(),
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  // Backfill activeTaskStartedAt for states created before this field existed
  if (!g[GLOBAL_KEY].activeTaskStartedAt) {
    g[GLOBAL_KEY].activeTaskStartedAt = new Map();
  }
  if (!g[GLOBAL_KEY].activeTasksByChat) {
    g[GLOBAL_KEY].activeTasksByChat = new Map();
  }
  // Backfill debounce buffers for states created before this field existed
  if (!g[GLOBAL_KEY].inputDebounceBuffers) {
    g[GLOBAL_KEY].inputDebounceBuffers = new Map();
  }
  // Backfill gitDrafts for states created before this field existed
  if (!g[GLOBAL_KEY].gitDrafts) {
    g[GLOBAL_KEY].gitDrafts = new Map();
  }
  // Backfill recentToolCalls for states created before this field existed
  if (!g[GLOBAL_KEY].recentToolCalls) {
    g[GLOBAL_KEY].recentToolCalls = new Map();
  }
  // Backfill pendingAppends for states created before this field existed
  if (!g[GLOBAL_KEY].pendingAppends) {
    g[GLOBAL_KEY].pendingAppends = new Map();
  }
  g[GLOBAL_KEY].chatGenerations ??= new Map();
  g[GLOBAL_KEY].uiOwners ??= new Map();
  g[GLOBAL_KEY].queuedTurns ??= new Set();
  g[GLOBAL_KEY].taskPromises ??= new Set();
  g[GLOBAL_KEY].retryTasks ??= new Set();
  g[GLOBAL_KEY].runEpoch ??= 0;
  g[GLOBAL_KEY].stopping ??= null;
  g[GLOBAL_KEY].admissionGate ??= new ChatAdmissionGate();
  return g[GLOBAL_KEY];
}

function getModelSelection(): ModelSelectionCoordinator {
  const state = getState();
  const { store, llm } = getBridgeContext();
  state.modelSelection ??= new ModelSelectionCoordinator({
    store, llm, gate: state.admissionGate,
    capture: address => {
      const binding = router.resolve(address);
      return { bindingId: binding.id, sessionId: binding.codepilotSessionId,
        generation: state.chatGenerations.get(getChatTaskKey(address)) ?? 0, epoch: state.runEpoch };
    },
    isCurrent: (address, owner) => {
      const binding = store.getChannelBinding(address.channelType, address.chatId);
      return binding?.id === owner.bindingId && binding.codepilotSessionId === owner.sessionId
        && owner.epoch === state.runEpoch && owner.generation === (state.chatGenerations.get(getChatTaskKey(address)) ?? 0);
    },
    isBusy: address => {
      const binding = store.getChannelBinding(address.channelType, address.chatId);
      return Boolean(getActiveTaskForChat(address) || countWaitingMessages(address)
        || (binding && (state.activeTasks.has(binding.codepilotSessionId) || state.sessionLocks.has(binding.codepilotSessionId))));
    },
  });
  return state.modelSelection;
}

/**
 * Record a tool call into the per-session recent history.
 * Only records when status is 'running' (start of a new tool call).
 */
function recordRecentToolCall(sessionId: string, name: string, status: 'running' | 'complete' | 'error'): void {
  if (status !== 'running') return; // only record new tool starts
  const st = getState();
  let list = st.recentToolCalls.get(sessionId);
  if (!list) {
    list = [];
    st.recentToolCalls.set(sessionId, list);
  }
  list.push({ name, status, timestamp: Date.now() });
  // Keep only the latest N entries
  if (list.length > MAX_RECENT_TOOL_CALLS) {
    st.recentToolCalls.set(sessionId, list.slice(-MAX_RECENT_TOOL_CALLS));
  }
}

function getChatTaskKey(address: ChannelAddress): string {
  return `${address.channelType}:${address.chatId}`;
}

function registerActiveTask(address: ChannelAddress, sessionId: string, abort: AbortController): void {
  const state = getState();
  const startedAt = Date.now();
  state.activeTasks.set(sessionId, abort);
  state.activeTaskStartedAt.set(sessionId, startedAt);
  state.activeTasksByChat.set(getChatTaskKey(address), {
    abort,
    sessionId,
    startedAt,
  });
  state.uiOwners.set(getChatTaskKey(address), abort);
}

function clearActiveTask(address: ChannelAddress, sessionId: string, abort: AbortController): void {
  const state = getState();
  if (state.activeTasks.get(sessionId) === abort) {
    state.activeTasks.delete(sessionId);
    state.activeTaskStartedAt.delete(sessionId);
  }

  const chatKey = getChatTaskKey(address);
  const activeChatTask = state.activeTasksByChat.get(chatKey);
  if (activeChatTask?.abort === abort) {
    state.activeTasksByChat.delete(chatKey);
  }
}

function getActiveTaskForChat(address: ChannelAddress): ActiveChatTask | null {
  return getState().activeTasksByChat.get(getChatTaskKey(address)) ?? null;
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 * If queueing takes too long, rejects with SessionQueueTimeoutError.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  const state = getState();
  const { store } = getBridgeContext();
  const queueTimeoutMs = computeSessionQueueTimeoutMs(
    parsePositiveInt(store.getSetting('bridge_session_queue_timeout_ms')),
    parsePositiveInt(store.getSetting('bridge_codex_turn_timeout_ms')),
  );
  return processWithSessionLockInternal(state.sessionLocks, sessionId, fn, queueTimeoutMs, signal);
}

function captureTurn(address: ChannelAddress): TurnContext {
  const state = getState();
  const chatKey = getChatTaskKey(address);
  return {
    turnId: randomUUID(), binding: { ...router.resolve(address) }, chatKey,
    generation: state.chatGenerations.get(chatKey) ?? 0,
    runEpoch: state.runEpoch, abort: new AbortController(),
  };
}

function countWaitingMessages(address: ChannelAddress): number {
  const state = getState();
  const key = getChatTaskKey(address);
  return (state.inputDebounceBuffers.get(key)?.messages.length ?? 0)
    + (state.pendingAppends.get(key)?.length ?? 0)
    + [...state.queuedTurns].filter(turn => !turn.started && turn.context.chatKey === key)
      .reduce((sum, turn) => sum + turn.messageCount, 0);
}

function ownsTurn(context: TurnContext): boolean {
  const state = getState();
  const binding = getBridgeContext().store.getChannelBinding(context.binding.channelType, context.binding.chatId);
  return !context.abort.signal.aborted && context.runEpoch === state.runEpoch
    && context.generation === (state.chatGenerations.get(context.chatKey) ?? 0)
    && binding?.id === context.binding.id
    && binding.codepilotSessionId === context.binding.codepilotSessionId;
}

/** 一次取消覆盖 collecting、append、queued、running；旧代际不再操作新 UI。 */
function cancelChat(adapter: BaseChannelAdapter, address: ChannelAddress): { running: boolean; dropped: number } {
  const state = getState();
  state.modelSelection?.invalidate(address);
  const key = getChatTaskKey(address);
  state.chatGenerations.set(key, (state.chatGenerations.get(key) ?? 0) + 1);
  let retrying = false;
  for (const retry of state.retryTasks) {
    if (retry.chatKey !== key) continue;
    retrying = true;
    retry.abort.abort();
  }
  let dropped = clearPendingAppends(adapter, key);
  const collecting = state.inputDebounceBuffers.get(key);
  if (collecting) {
    if (collecting.timer) clearTimeout(collecting.timer);
    state.inputDebounceBuffers.delete(key);
    collecting.context.abort.abort();
    dropped += collecting.messages.length;
    createAckForMergedMessages(adapter, collecting.messages)();
  }
  for (const queued of state.queuedTurns) {
    if (queued.context.chatKey !== key || queued.started) continue;
    dropped += queued.messageCount;
    queued.context.abort.abort();
    queued.ack();
    state.queuedTurns.delete(queued);
  }
  const active = getActiveTaskForChat(address);
  if (active && !active.abort.signal.aborted) {
    active.abort.abort();
    clearUserInputRequests(active.sessionId);
    // 先提交旧卡终态，完成后仅清理仍归属于旧回合的 UI。
    const ending = adapter.onStreamEnd?.(address.chatId, 'interrupted', '');
    const endUi = () => {
      if (state.uiOwners.get(key) !== active.abort) return;
      state.uiOwners.delete(key);
      adapter.onMessageEnd?.(address.chatId);
    };
    if (ending) {
      const cleanup = ending.then(endUi, endUi).finally(() => state.taskPromises.delete(cleanup));
      state.taskPromises.add(cleanup);
    } else {
      endUi();
    }
  }
  return { running: Boolean(active) || retrying, dropped };
}

/** 消费循环只登记补发；网络和持久化等待纳入独立、可取消的后台任务。 */
function startResponseRetry(adapter: BaseChannelAdapter, msg: InboundMessage, id?: string): void {
  const state = getState();
  const context = captureTurn(msg.address);
  state.retryTasks.add(context);
  const task = Promise.resolve().then(async () => {
    let feedback: string;
    try {
      const result = await retryResponseDelivery(adapter, msg.address, id, { isCurrent: () => ownsTurn(context) });
      feedback = result.ok ? '回答已送达。' : `回答重投失败：${result.error || '未知错误'}。`;
    } catch (error) {
      // attempt 会返回投递/flush 错误；列表读取等意外异常也必须给当前聊天反馈。
      feedback = `回答重投失败：${error instanceof Error ? error.message : '未知错误'}。`;
    }
    if (!ownsTurn(context)) return;
    await deliverSingle(adapter, {
      address: msg.address,
      text: feedback,
      parseMode: 'plain', replyToMessageId: msg.messageId,
    }, undefined, () => ownsTurn(context));
  }).catch(error => {
    console.error('[bridge-manager] 回答补发结果通知失败:', error);
  }).finally(() => {
    state.retryTasks.delete(context);
    state.taskPromises.delete(task);
  });
  state.taskPromises.add(task);
}

function scheduleMessages(adapter: BaseChannelAdapter, messages: InboundMessage[], context = captureTurn(messages[0].address)): void {
  const state = getState();
  const ack = createAckForMergedMessages(adapter, messages);
  if (!state.running || !adapter.isRunning() || !ownsTurn(context)) { ack(); return; }
  const queued: QueuedTurn = { context, ack, messageCount: messages.length, started: false };
  state.queuedTurns.add(queued);
  const message = mergeInboundMessages(messages);
  const promise = processWithSessionLock(context.binding.codepilotSessionId, async () => {
    queued.started = true;
    if (!state.running || !ownsTurn(context)) { ack(); return; }
    await handleMessage(adapter, message, { ack, context });
  }, context.abort.signal).catch(async err => {
    ack();
    if (err instanceof SessionQueueCancelledError || context.abort.signal.aborted) return;
    if (err instanceof SessionQueueTimeoutError) {
      if (ownsTurn(context)) await deliver(adapter, {
        address: message.address, text: '消息排队超时，已自动取消。', parseMode: 'plain', replyToMessageId: message.messageId,
      });
      return;
    }
    console.error('[bridge-manager] 会话任务失败:', err);
  }).finally(() => {
    state.queuedTurns.delete(queued);
    state.taskPromises.delete(promise);
  });
  state.taskPromises.add(promise);
}

function parsePositiveInt(raw: string | null): number | null {
  if (raw == null) return null;
  const n = parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return null;
  return n > 0 ? n : 0;
}

function parseBooleanSetting(raw: string | null, defaultValue: boolean): boolean {
  if (raw == null) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (!v) return defaultValue;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return defaultValue;
}

/**
 * 构建变更摘要 HTML 块（diffStat 优先，文件列表兜底）。
 */
function buildChangeSummaryBlock(stagedFiles: string[], diffStatText: string): string | null {
  const stat = (diffStatText || '').trim();
  if (stat) {
    const allLines = stat.split('\n').map(l => l.trimEnd()).filter(Boolean);
    const maxLines = 12;
    let shownLines = allLines;
    if (allLines.length > maxLines) {
      const headCount = Math.max(1, maxLines - 2);
      const omitted = allLines.length - headCount - 1;
      const tail = allLines[allLines.length - 1];
      shownLines = [
        ...allLines.slice(0, headCount),
        `...（已省略 ${omitted} 行）`,
        tail,
      ];
    }
    const raw = shownLines.join('\n');
    const clipped = raw.length > 1800 ? raw.slice(0, 1800) + '…' : raw;
    return [
      `<b>变更摘要</b>`,
      `Files: <code>${stagedFiles.length}</code>`,
      `<code>${escapeHtml(clipped)}</code>`,
    ].join('\n');
  }

  if (stagedFiles.length === 0) return null;

  const maxFiles = 20;
  const shown = stagedFiles.slice(0, maxFiles);
  const omitted = stagedFiles.length - shown.length;
  const raw = shown.join('\n') + (omitted > 0 ? `\n...（已省略 ${omitted} 个文件）` : '');
  const clipped = raw.length > 1800 ? raw.slice(0, 1800) + '…' : raw;
  return [
    `<b>变更摘要</b>`,
    `Files: <code>${stagedFiles.length}</code>`,
    `<code>${escapeHtml(clipped)}</code>`,
  ].join('\n');
}

/**
 * 构建语义摘要 HTML 块（LLM 生成的要点列表）。
 */
function buildSemanticSummaryBlock(summaryLines: string[]): string | null {
  const lines = (summaryLines || [])
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((l) => `- ${escapeHtml(l).slice(0, 200)}`);
  if (lines.length === 0) return null;
  return ['<b>语义摘要</b>', ...lines].join('\n');
}

function formatTimeoutMs(ms: number): string {
  if (ms <= 0) return 'disabled';
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  if (mins >= 120) return `${Math.ceil(mins / 60)}h`;
  return `${mins}min`;
}

// ── Append (追加) helpers ──────────────────────────────────────
//
// 当 LLM 正在处理一条消息时，用户又发了新消息。新消息暂存到 pendingAppends，
// 等当前任务完成后 merge 为一条、作为单个后续轮次处理——一张卡片。
// Claude 能从上一轮的完整问答上下文中理解这些追加内容。
//
// 配置：
// - 全局：bridge_append_enabled    (默认 true)
// - 按渠道：bridge_${channelType}_append_enabled
//
// 与 debounce 的关系：
// - debounce 处理"LLM 还没开始处理"时的连发合并
// - append  处理"LLM 正在忙"时的消息缓冲（完成后合并处理）

function isAppendEnabled(channelType: string): boolean {
  const { store } = getBridgeContext();
  const scoped = store.getSetting(`bridge_${channelType}_append_enabled`);
  if (scoped != null) return parseBooleanSetting(scoped, true);
  return parseBooleanSetting(store.getSetting('bridge_append_enabled'), true);
}

function appendMessageToChat(chatKey: string, msg: InboundMessage): void {
  const state = getState();
  const list = state.pendingAppends.get(chatKey) || [];
  list.push(msg);
  state.pendingAppends.set(chatKey, list);
}

/** 原子取出并清除指定 chatKey 的所有追加消息。 */
function drainPendingAppends(chatKey: string): InboundMessage[] {
  const state = getState();
  const list = state.pendingAppends.get(chatKey);
  if (!list || list.length === 0) return [];
  state.pendingAppends.delete(chatKey);
  return list;
}

/**
 * 清除指定 chatKey 的追加消息（用于 /stop、/new、/bind 等场景）。
 * 必须传入 adapter 以 ack 被丢弃的消息，否则未提交的 offset 会导致
 * 适配器重放（尤其是 Telegram long-polling）。
 */
function clearPendingAppends(adapter: BaseChannelAdapter, chatKey: string): number {
  const state = getState();
  const list = state.pendingAppends.get(chatKey);
  if (!list || list.length === 0) return 0;
  const count = list.length;
  state.pendingAppends.delete(chatKey);
  // Ack 被丢弃的消息，推进 offset
  for (const msg of list) {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      try { adapter.acknowledgeUpdate(msg.updateId); } catch { /* best effort */ }
    }
  }
  return count;
}

/**
 * 排出并调度指定 chatKey 的追加消息。
 * drain → merge → processWithSessionLock → handleMessage。
 * 同时用于：finally 排出、群聊 userId 切换时提前 flush。
 */
function flushPendingAppends(adapter: BaseChannelAdapter, chatKey: string): void {
  const messages = drainPendingAppends(chatKey);
  if (messages.length === 0) return;
  scheduleMessages(adapter, messages);
}

/**
 * 输入合并窗口（毫秒）。
 *
 * 典型诉求：用户在 IM 里连续发两条短消息（补充说明），希望合并成一次 LLM 请求，
 * 而不是第一条跑完再跑第二条。
 *
 * 配置：
 * - 全局：bridge_input_debounce_ms
 * - 按渠道：bridge_${channelType}_input_debounce_ms
 *
 * 约定：<=0 视为关闭（不合并）。
 */
function getInputDebounceMs(channelType: string): number {
  const { store } = getBridgeContext();
  const scoped = parsePositiveInt(store.getSetting(`bridge_${channelType}_input_debounce_ms`));
  if (scoped != null) return scoped;
  const global = parsePositiveInt(store.getSetting('bridge_input_debounce_ms'));
  if (global != null) return global;
  return 0;
}

function getDebounceKey(msg: InboundMessage): string {
  return `${msg.address.channelType}:${msg.address.chatId}`;
}

function mergeInboundMessages(messages: InboundMessage[]): InboundMessage {
  if (messages.length === 1) return messages[0];
  const last = messages[messages.length - 1];

  const textParts: string[] = [];
  const attachments: NonNullable<InboundMessage['attachments']> = [];

  for (const m of messages) {
    const t = m.text?.trim();
    if (t) textParts.push(t);
    if (m.attachments && m.attachments.length > 0) {
      attachments.push(...m.attachments);
    }
  }

  return {
    ...last,
    text: textParts.join('\n'),
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

function createAckForMergedMessages(adapter: BaseChannelAdapter, messages: InboundMessage[]): () => void {
  const updateIds = messages
    .map(m => m.updateId)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  if (updateIds.length === 0 || !adapter.acknowledgeUpdate) return () => {};

  // 去重 + 升序，避免某些 adapter 的 watermark 推进依赖顺序/重复
  const uniqueSorted = Array.from(new Set(updateIds)).sort((a, b) => a - b);
  return () => {
    for (const id of uniqueSorted) {
      try { adapter.acknowledgeUpdate!(id); } catch { /* best effort */ }
    }
  };
}

function flushDebouncedMessages(
  adapter: BaseChannelAdapter,
  key: string,
): void {
  const state = getState();
  const entry = state.inputDebounceBuffers.get(key);
  if (!entry || entry.messages.length === 0) return;

  state.inputDebounceBuffers.delete(key);
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  if (!state.running || !adapter.isRunning()) {
    // Bridge/adapter 已停止：丢弃（此时即使不 debounce 也很可能丢）。
    return;
  }

  scheduleMessages(adapter, entry.messages, entry.context);
}

function enqueueRegularMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): void {
  // ── Append 检测 ──
  // 如果当前 chat 已有活跃任务（LLM 正在处理），将新消息暂存到 pendingAppends，
  // 等当前任务完成后合并为一条后续轮次处理。
  // 注意：不提前 ack，保留 updateId 在 buffer 中，follow-up 处理完再统一 ack，
  // 保证"处理完成后再提交 offset"的可靠性约束。
  if (isAppendEnabled(adapter.channelType)) {
    const activeTask = getActiveTaskForChat(msg.address);
    if (activeTask && !activeTask.abort.signal.aborted) {
      const chatKey = getChatTaskKey(msg.address);
      // 群聊保护：不同 userId 的消息不混合（与 debounce 路径保持一致）。
      // 遇到不同用户时先 flush 旧 buffer，再开新 buffer。
      const existing = getState().pendingAppends.get(chatKey);
      if (existing && existing.length > 0) {
        const prevUserId = existing[0].address.userId || '';
        const nextUserId = msg.address.userId || '';
        if (prevUserId && nextUserId && prevUserId !== nextUserId) {
          flushPendingAppends(adapter, chatKey);
        }
      }
      appendMessageToChat(chatKey, msg);
      const appendList = getState().pendingAppends.get(chatKey);
      const appendCount = appendList ? appendList.length : 1;
      // 优先在流式卡片上显示追加提示（飞书），fallback 为独立文本消息
      const notifiedOnCard = adapter.notifyAppend?.(
        msg.address.chatId, appendCount, msg.text?.trim() || '',
      ) ?? false;
      if (!notifiedOnCard) {
        deliver(adapter, {
          address: msg.address,
          text: '✓ 已收到，当前任务完成后将依次处理',
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        }).catch(() => {});
      }
      // 不 ack — updateId 保留在 msg 中，由 follow-up handleMessage 处理完后统一 ack
      return;
    }
  }

  const debounceMs = getInputDebounceMs(adapter.channelType);
  if (debounceMs <= 0) {
    scheduleMessages(adapter, [msg]);
    return;
  }

  const state = getState();
  const key = getDebounceKey(msg);
  const existing = state.inputDebounceBuffers.get(key);

  // 群聊里避免合并不同 user 的消息：遇到不同 userId 时先 flush 旧 buffer，再开新 buffer。
  if (existing && existing.messages.length > 0) {
    const prevUserId = existing.userId || '';
    const nextUserId = msg.address.userId || '';
    if (prevUserId && nextUserId && prevUserId !== nextUserId) {
      flushDebouncedMessages(adapter, key);
    }
  }

  const entry = state.inputDebounceBuffers.get(key)
    || { userId: msg.address.userId, messages: [], timer: null, context: captureTurn(msg.address) };

  if (!state.inputDebounceBuffers.has(key)) {
    state.inputDebounceBuffers.set(key, entry);
  }

  entry.userId = msg.address.userId || entry.userId;
  entry.messages.push(msg);

  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  entry.timer = setTimeout(() => {
    flushDebouncedMessages(adapter, key);
  }, debounceMs);
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.stopping) await state.stopping;
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (store.getSetting(settingKey) !== 'true') continue;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    state.uiOwners.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.runEpoch++;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (state.stopping) return state.stopping;
  if (!state.running) return;
  const { lifecycle } = getBridgeContext();
  state.running = false;
  state.runEpoch++;
  state.modelSelection?.invalidate();
  const stopping = (async () => {
    for (const abort of state.loopAborts.values()) abort.abort();
    state.loopAborts.clear();
    const chats = new Map<string, ChannelAddress>();
    for (const entry of state.inputDebounceBuffers.values()) {
      if (entry.messages[0]) chats.set(getChatTaskKey(entry.messages[0].address), entry.messages[0].address);
    }
    for (const messages of state.pendingAppends.values()) {
      if (messages[0]) chats.set(getChatTaskKey(messages[0].address), messages[0].address);
    }
    for (const queued of state.queuedTurns) chats.set(queued.context.chatKey, queued.context.binding);
    for (const binding of getBridgeContext().store.listChannelBindings()) {
      if (state.activeTasksByChat.has(getChatTaskKey(binding))) chats.set(getChatTaskKey(binding), binding);
    }
    for (const address of chats.values()) {
      const adapter = state.adapters.get(address.channelType);
      if (adapter) cancelChat(adapter, address);
    }
    for (const abort of state.activeTasks.values()) abort.abort();
    for (const retry of state.retryTasks) retry.abort.abort();
    const drained = await settleWithin(Promise.allSettled([...state.taskPromises]), 5000);
    if (!drained) console.warn('[bridge-manager] 本地停止等待超时，仍有任务清理未完成；旧回调已隔离。');
    await Promise.all([...state.adapters.entries()].map(async ([type, adapter]) => {
      const settled = await settleWithin(adapter.stop().catch(err => {
        console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
      }), 5000);
      if (!settled) console.warn(`[bridge-manager] Adapter ${type} 停止超时`);
    }));
    state.adapters.clear();
    state.adapterMeta.clear();
    state.uiOwners.clear();
    state.startedAt = null;
    lifecycle.onBridgeStop?.();
    console.log('[bridge-manager] Bridge stopped');
  })();
  state.stopping = stopping;
  try { await stopping; } finally { state.stopping = null; }
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);
  const runEpoch = state.runEpoch;

  (async () => {
    while (state.running && adapter.isRunning() && !abort.signal.aborted && state.runEpoch === runEpoch) {
      try {
        const msg = await adapter.consumeOne();
        if (abort.signal.aborted || state.runEpoch !== runEpoch || !state.running) break;
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for feishu/qq MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.userInputResponse ||
          msg.modelSelectionResponse ||
          isControlCommand(msg.text.trim()) ||
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId)
        ) {
          if (msg.modelSelectionResponse || /^\/model(?:@\S+)?(?:\s|$)/i.test(msg.text.trim())) {
            // 目录网络请求不阻塞后续 stop/new；归属由协调器在 await 后复验。
            const task = handleMessage(adapter, msg).catch(err => console.error('[bridge-manager] 模型选择失败:', err))
              .finally(() => state.taskPromises.delete(task));
            state.taskPromises.add(task);
          } else await handleMessage(adapter, msg);
        } else {
          // 普通消息：可选 debounce 合并（避免”连发两句”触发两次完整请求）
          await state.admissionGate.run(msg.address, () => {
            if (!abort.signal.aborted && state.runEpoch === runEpoch && state.running) enqueueRegularMessage(adapter, msg);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

/** 模型透传和普通文本走同一调度入口；真正的控制命令绕过模型锁。 */
function isControlCommand(text: string): boolean {
  if (text.startsWith('//')) return ['', 'help'].includes(text.slice(2).trim().toLowerCase());
  if (text.toLowerCase().startsWith('/codex:')) {
    const [command, ...args] = text.split(/\s+/);
    return buildCodexPassthroughPrompt(command.split('@')[0].toLowerCase(), args.join(' ')) === null;
  }
  return text.startsWith('/');
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  opts?: { ack?: () => void; context?: TurnContext },
): Promise<void> {
  const { store } = getBridgeContext();

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const defaultAck = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };
  const ack = opts?.ack || defaultAck;

  if (msg.modelSelectionResponse) {
    try {
      if ((store.getSetting('bridge_llm_backend') || '').toLowerCase() !== 'codex') throw new Error('当前桥接不是 Codex，模型卡已失效。');
      const feedback = await getModelSelection().respond(adapter, msg);
      if (feedback) await deliver(adapter, { address: msg.address, text: feedback, parseMode: 'plain' });
    } catch (error) {
      await deliver(adapter, { address: msg.address, text: error instanceof Error ? error.message : '模型卡操作失败。', parseMode: 'plain' });
    } finally { ack(); }
    return;
  }

  if (msg.userInputResponse || /^\/answer(?:\s|$)/.test(msg.text.trim())) {
    const handled = msg.userInputResponse
      ? handleUserInputResponse(msg.address, msg.userInputResponse, msg.callbackMessageId)
      : handleUserInputText(msg.address, msg.text.trim());
    await deliver(adapter, { address: msg.address, text: handled ? '回答已提交。' : '回答无效或请求已过期，请检查问题与选项。', parseMode: 'plain' });
    ack();
    return;
  }

  // Handle callback queries (permission buttons, workflow action buttons)
  if (msg.callbackData) {
    // ── Workflow card action buttons (workflow:stop/resume/report) ──
    if (msg.callbackData.startsWith('workflow:')) {
      const parts = msg.callbackData.split(':');
      const action = parts[1]; // stop, resume, report
      const runId = parts.slice(2).join(':');
      // Convert to synthetic /workflow command and re-process
      // P0-4: Route 'report' action to /workflow report (not /workflow status).
      const syntheticText = `/workflow ${action} ${runId}`;
      const syntheticMsg: InboundMessage = { ...msg, text: syntheticText, callbackData: undefined };
      // Acknowledge the button press immediately
      ack();
      // Re-dispatch as a normal text command
      await handleMessage(adapter, syntheticMsg, { ack: () => {} });
      return;
    }

    // ── Permission buttons (perm:action:id) ──
    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      // Send confirmation
      const confirmMsg: OutboundMessage = {
        address: msg.address,
        text: 'Permission response recorded.',
        parseMode: 'plain',
      };
      await deliver(adapter, confirmMsg);
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // Handle image-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    const rawData = msg.raw as { imageDownloadFailed?: boolean; failedCount?: number } | undefined;
    if (rawData?.imageDownloadFailed) {
      await deliver(adapter, {
        address: msg.address,
        text: `Failed to download ${rawData.failedCount ?? 1} image(s). Please try sending again.`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (feishu/qq only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (adapter.channelType === 'feishu' || adapter.channelType === 'qq') {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[123]$/.test(normalized)) {
      const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId);
      if (pendingLinks.length === 1) {
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
        const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
        if (handled) {
          await deliver(adapter, {
            address: msg.address,
            text: `${label}: recorded.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: `Permission not found or already resolved.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliver(adapter, {
          address: msg.address,
          text: `Multiple pending permissions (${pendingLinks.length}). Please use the full command:\n/perm allow|allow_session|deny <id>`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // ── Passthrough detection ─────────────────────────────────────
  // // double-slash   → forward to Claude session as plain message
  // /codex:xxx       → wrap with Codex role prompt, then forward
  // /xxx (single)    → bridge command (handled by handleCommand)

  let effectiveText = rawText; // may be rewritten by passthrough logic

  if (rawText.startsWith('//')) {
    const passthroughBody = rawText.slice(2).trim(); // strip leading //
    const passthroughLower = passthroughBody.toLowerCase();

    // //help → return help text directly (not forwarded to LLM)
    if (passthroughLower === 'help' || passthroughLower === '') {
      await deliver(adapter, {
        address: msg.address,
        text: buildClaudePassthroughHelp(),
        parseMode: 'HTML',
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }

    // Rewrite: strip one leading / so it becomes a regular message
    // e.g. "//review src/" → "/review src/" (sent as-is to Claude)
    // e.g. "//trellis:start" → "/trellis:start" (透传给 Claude，由 skill 处理)
    effectiveText = rawText.slice(1);
    // Fall through to normal message processing below
  } else if (rawText.toLowerCase().startsWith('/codex:')) {
    const spaceIdx = rawText.search(/\s/);
    const cmdPart = spaceIdx === -1 ? rawText : rawText.slice(0, spaceIdx);
    const codexCmd = cmdPart.split('@')[0].toLowerCase(); // /codex:review@bot → /codex:review
    const codexArgs = spaceIdx === -1 ? '' : rawText.slice(spaceIdx).trim();

    // /codex:help → return help text directly
    if (codexCmd === '/codex:help') {
      await deliver(adapter, {
        address: msg.address,
        text: buildCodexPassthroughHelp(),
        parseMode: 'HTML',
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }

    const prompt = buildCodexPassthroughPrompt(codexCmd, codexArgs);
    if (prompt) {
      effectiveText = prompt; // Replace with role-annotated prompt
      // Fall through to normal message processing below
    } else {
      await deliver(adapter, {
        address: msg.address,
        text: 'Unknown codex command. Type <code>/codex:help</code> for available commands.',
        parseMode: 'HTML',
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }
  } else if (rawText.startsWith('/')) {
    // Single slash → bridge command
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(effectiveText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${effectiveText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${effectiveText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  const admitted = await getState().admissionGate.run(msg.address, () => {
    const context = opts?.context ?? captureTurn(msg.address);
    if (!ownsTurn(context)) return null;
    const binding = {
      ...context.binding,
      codexModelPreferences: context.binding.codexModelPreferences ? { ...context.binding.codexModelPreferences } : undefined,
      sdkSessionId: store.getChannelBinding(context.binding.channelType, context.binding.chatId)?.sdkSessionId ?? '',
    };
    registerActiveTask(msg.address, binding.codepilotSessionId, context.abort);
    return { context, binding };
  });
  if (!admitted) { ack(); return; }
  const { context, binding } = admitted;
  const isCurrent = () => ownsTurn(context) && getState().uiOwners.get(context.chatKey) === context.abort;

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = context.abort;

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  // Build the preview onPartialText callback (or undefined if preview not supported)
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    if (!isCurrent()) return;
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (isCurrent() && !ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (isCurrent() && !ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  // ── Streaming card setup (Feishu CardKit) ──────────────────
  // If the adapter supports streaming cards (e.g. Feishu), wire up
  // onStreamText, onToolEvent, and onStreamEnd callbacks.
  // These run in parallel with the existing preview system — Feishu
  // uses cards instead of message edit for streaming.
  const hasStreamingCards = typeof adapter.onStreamText === 'function';
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onStreamCardText = hasStreamingCards ? (fullText: string) => {
    if (!isCurrent()) return;
    try { adapter.onStreamText!(msg.address.chatId, fullText); } catch { /* non-critical */ }
  } : undefined;

  const onToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (!isCurrent()) return;
    // Always record to global state for /status live context
    if (toolName) {
      recordRecentToolCall(binding.codepilotSessionId, toolName, status);
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      // tool_result doesn't carry name — update existing entry's status
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    // Update streaming card if adapter supports it
    if (hasStreamingCards) {
      try {
        adapter.onToolEvent!(msg.address.chatId, Array.from(toolCallTracker.values()));
      } catch { /* non-critical */ }
    }
  };

  // Combined partial text callback: streaming preview + streaming cards
  const onPartialText = (previewOnPartialText || onStreamCardText) ? (fullText: string) => {
    if (previewOnPartialText) previewOnPartialText(fullText);
    if (onStreamCardText) onStreamCardText(fullText);
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');

    const result = await engine.processMessage(binding, promptText, async (perm) => {
      if (!isCurrent()) {
        getBridgeContext().permissions.resolvePendingPermission(perm.permissionRequestId, { behavior: 'deny', message: '任务已取消' });
        return;
      }
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, onToolEvent, {
      isCurrent,
      onUserInputRequest: async request => {
        if (!isCurrent()) {
          getBridgeContext().permissions.resolvePendingPermission(request.requestId, { behavior: 'deny', message: '任务已取消' });
          return;
        }
        await forwardUserInputRequest(adapter, msg.address, request, binding.codepilotSessionId, msg.messageId);
      },
      onProgress: text => { if (isCurrent()) adapter.onProgress?.(msg.address.chatId, text); },
    });
    clearUserInputRequests(binding.codepilotSessionId);
    if (!isCurrent()) return;

    // Best-effort: record token usage into local daily summary.
    // 写入失败不得影响主流程（IM 响应/流式体验）。
    if (result.tokenUsage) {
      try {
        const filePath = resolveUsageSummaryPath(store);
        const retentionDays = getUsageRetentionDays(store);
        const workDir = binding.workingDirectory
          || store.getSession(binding.codepilotSessionId)?.working_directory
          || '';
        const project = resolveProjectInfoFromWorkingDirectory(workDir);
        recordTokenUsageToDailySummary({
          filePath,
          project,
          usage: result.tokenUsage,
          retentionDays,
        }).catch((err) => {
          console.warn(
            '[bridge-manager] Failed to record token usage summary:',
            err instanceof Error ? err.message : err,
          );
        });
      } catch (err) {
        console.warn(
          '[bridge-manager] Failed to schedule token usage summary write:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Best-effort: compute ctx footer (context window usage indicator).
    // 任何失败都退化为 undefined — 绝不影响卡片渲染主流程。
    //
    // 口径选择 (分子): **优先** result.lastTurnUsage（本 turn 最后一次 API 调用的 prompt size），
    // 而不是 result.tokenUsage（整个 turn N 次 API 调用的累计）。
    // 原因: 一个 turn 内 SDK 可能做多轮 tool-use round-trip，累计 input_tokens 会远超
    // 真实窗口（实测 1.2M+），导致 footer 显示 `ctx 600%` 这种荒谬数字。
    //
    // 窗口 (分母): **优先** result.contextWindow（后端自报的 model_context_window，
    // 目前仅 Codex backend 提供），兜底到 resolveContextWindow(model) 的静态注册表，
    // 最终兜底 DEFAULT_CONTEXT_WINDOW。
    //
    // 模型名: `binding.model` 在进入 turn 时常为 hint/alias（例如 'default' / 'sonnet'）。
    // conversation-engine 收到 SDK statusData.model 后会把真实模型同步写回 store
    // （见 updateSessionModel + updateChannelBinding 调用）。
    // 因此必须从 store 重新读取最新 session，才能拿到真实模型并据此解析 window。
    let ctxFooter: string | undefined;
    // 注意：绝不回退到 turn 累计 usage。
    // `tokenUsage` 是整个 turn 的累计量，在 tool-use / 多轮 round-trip 下会显著大于
    // 当前 prompt footprint，直接拿来算会出现 `ctx 256%` 这类明显错误的数字。
    // 拿不到 `lastTurnUsage` 时宁可不显示 ctx，也不显示错值。
    const usageForCtx = result.contextTokens != null
      ? { input_tokens: result.contextTokens, output_tokens: 0 }
      : result.lastTurnUsage ?? null;
    if (usageForCtx) {
      try {
        const freshSession = store.getSession(binding.codepilotSessionId);
        const effectiveModel = freshSession?.model || binding.model;
        const window = result.contextWindow
          ?? resolveContextWindow(effectiveModel)
          ?? DEFAULT_CONTEXT_WINDOW;
        ctxFooter = formatCtxFooter(usageForCtx, window) ?? undefined;
      } catch (err) {
        console.warn(
          '[bridge-manager] Failed to compute ctx footer:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Finalize streaming card if adapter supports it.
    // onStreamEnd awaits any in-flight card creation and returns true if a card
    // was actually finalized (meaning content is already visible to the user).
    const finalize = async () => {
      if (!isCurrent()) return false;
      if (hasStreamingCards && adapter.onStreamEnd) {
        const status = result.errorCode === 'abort' ? 'interrupted' : result.hasError ? 'error' : 'completed';
        return adapter.onStreamEnd(
          msg.address.chatId,
          status,
          result.responseText,
          ctxFooter ? { ctx: ctxFooter } : undefined,
        );
      }
      return false;
    };

    // 空回答没有待发记录，也必须限制卡片收尾等待，避免占住会话队列。
    if (!result.responseText) {
      const deadline = parsePositiveInt(store.getSetting('bridge_delivery_timeout_ms')) || 15_000;
      const settled = await abortable(settleWithin(finalize(), deadline), taskAbort.signal);
      if (!settled) console.warn('[bridge-manager] 空回答卡片收尾超时，平台更新结果未知。');
      if (!isCurrent()) return;
    }

    // Send response text — render via channel-appropriate format.
    // Skip if streaming card was finalized (content already in card).
    if (result.responseText) {
      const sent = await abortable(deliverResponse(adapter, msg.address, result.responseText, binding.codepilotSessionId, msg.messageId, {
        turnId: context.turnId, isCurrent, finalize,
      }), taskAbort.signal);
      if (!sent.ok && isCurrent()) {
        console.warn('[bridge-manager] 回答未送达，可通过 /retry 重投已有回答。');
      }
    } else if (result.hasError) {
      if (result.errorCode === 'timeout') {
        const timeoutMs = parsePositiveInt(store.getSetting('bridge_codex_turn_timeout_ms')) ?? 90 * 60_000;
        const mins = timeoutMs > 0 ? Math.max(1, Math.ceil(timeoutMs / 60_000)) : 0;
        const hint = timeoutMs > 0 ? `（超过 ${mins} 分钟，可通过 bridge_codex_turn_timeout_ms 调整）` : '';
        await deliver(adapter, {
          address: msg.address,
          text: `任务执行超时${hint}，已自动取消。`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
      } else {
        const errorResponse: OutboundMessage = {
          address: msg.address,
          text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
          parseMode: 'HTML',
          replyToMessageId: msg.messageId,
        };
        await deliver(adapter, errorResponse);
      }
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    if (binding.id && isCurrent()) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
        if (update !== null) {
          store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } catch (error) {
    if (!taskAbort.signal.aborted) throw error;
  } finally {
    // Clean up preview state
    clearUserInputRequests(binding.codepilotSessionId);
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      if (isCurrent()) adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    // If task was aborted and streaming card is still active, finalize as interrupted
    const ownedUi = isCurrent();
    clearActiveTask(msg.address, binding.codepilotSessionId, taskAbort);
    // Notify adapter that message processing ended
    if (ownedUi) {
      getState().uiOwners.delete(context.chatKey);
      adapter.onMessageEnd?.(msg.address.chatId);
    }
    // Commit the offset only after full processing (success or failure)
    ack();

    // ── 排出追加消息 ──
    // 当前任务已完成，activeTask 已清除。缓冲中的追加消息合并为一条后续轮次。
    if (ownedUi) flushPendingAppends(adapter, getChatTaskKey(msg.address));
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store, llm } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
      response = buildBridgeCommandHelp();
      break;

    case '/new': {
      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }

      // If there is a running task for this chat, stop it before switching sessions.
      const { stopped, binding } = await getState().admissionGate.run(msg.address, () => {
        const { running } = cancelChat(adapter, msg.address);
        return { stopped: running, binding: router.startNewSession(msg.address, workDir ? { workingDirectory: workDir } : {}) };
      });

      const session = store.getSession(binding.codepilotSessionId);
      const effectiveModel = (session?.model || binding.model || 'default').trim() || 'default';
      const backend = (store.getSetting('bridge_llm_backend') || '').trim().toLowerCase();

      const st = getState();
      const activeChatTask = getActiveTaskForChat(msg.address);
      const isRunningTask = Boolean(activeChatTask);
      const startedAtMs = activeChatTask?.startedAt ?? null;
      const runningForMs = (isRunningTask && startedAtMs) ? (Date.now() - startedAtMs) : null;
      const activeTaskSessionId = activeChatTask?.sessionId ?? binding.codepilotSessionId;
      const hasSessionLock = st.sessionLocks.has(activeTaskSessionId);

      const turnTimeoutSetting = parsePositiveInt(store.getSetting('bridge_codex_turn_timeout_ms'));
      const idleTimeoutSetting = parsePositiveInt(store.getSetting('bridge_codex_turn_idle_timeout_ms'));
      const queueTimeoutSetting = parsePositiveInt(store.getSetting('bridge_session_queue_timeout_ms'));
      const effectiveTurnTimeoutMs = (turnTimeoutSetting != null) ? turnTimeoutSetting : DEFAULT_CODEX_TURN_TIMEOUT_MS;
      const effectiveIdleTimeoutMs = (idleTimeoutSetting != null) ? idleTimeoutSetting : 0;
      const effectiveQueueTimeoutMs = computeSessionQueueTimeoutMs(queueTimeoutSetting, turnTimeoutSetting);

      response = [
        '<b>New session created.</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        ...(backend !== 'codex' ? [`Model: <code>${escapeHtml(effectiveModel)}</code>`] : []),
        ...(backend === 'codex' ? [escapeHtml(describeModelPreferences(binding))] : []),
        `Backend: <code>${escapeHtml(backend || 'default')}</code>`,
        `Task: ${activeChatTask?.abort.signal.aborted ? '<b>cancelling</b>' : isRunningTask ? '<b>running</b>' : '<b>idle</b>'}${runningForMs != null ? ` (<code>${formatTimeoutMs(runningForMs)}</code>)` : ''}`,
        `Session lock: ${hasSessionLock ? '<b>busy</b>' : '<b>free</b>'}`,
        `Turn timeout: <code>${formatTimeoutMs(effectiveTurnTimeoutMs)}</code>`,
        `Turn idle timeout: <code>${formatTimeoutMs(effectiveIdleTimeoutMs)}</code>`,
        `Queue timeout: <code>${formatTimeoutMs(effectiveQueueTimeoutMs)}</code>`,
        stopped ? '<i>已请求中断旧任务，并隔离其后续回调。</i>' : '',
      ].filter(Boolean).join('\n');
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      if (!store.getSession(args)) { response = 'Session not found.'; break; }
      const { stopped, binding } = await getState().admissionGate.run(msg.address, () => {
        const { running } = cancelChat(adapter, msg.address);
        return { stopped: running, binding: router.bindToSession(msg.address, args) };
      });
      if (binding) {
        response = [
          `Bound to session <code>${args.slice(0, 8)}...</code>`,
          ...((store.getSetting('bridge_llm_backend') || '').toLowerCase() === 'codex' ? [escapeHtml(describeModelPreferences(binding))] : []),
          stopped ? '<i>已请求中断旧任务，并隔离其后续回调。</i>' : '',
        ].filter(Boolean).join('\n');
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd /path/to/directory';
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { workingDirectory: validatedPath });
      response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>`;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/model': {
      const binding = router.resolve(msg.address);
      if ((store.getSetting('bridge_llm_backend') || '').trim().toLowerCase() === 'codex') {
        try {
          const selection = getModelSelection();
          if (!args) {
            if (adapter.sendModelSelection && adapter.updateModelSelection) {
              await selection.open(adapter, msg, binding);
              return;
            }
            response = escapeHtml(await selection.textView(binding));
          } else {
            const [model, effort, extra] = args.trim().split(/\s+/);
            if (extra || !/^[a-zA-Z0-9._:/-]+$/.test(model) || (effort && !/^[a-zA-Z0-9_-]+$/.test(effort))) {
              response = '用法：/model &lt;model-id&gt; [effort]';
            } else response = escapeHtml(await selection.setText(msg.address, model, effort));
          }
        } catch (error) { response = escapeHtml(error instanceof Error ? error.message : '模型目录请求失败。'); }
        break;
      }
      if (!args) {
        response = `当前模型：<code>${escapeHtml(binding.model || 'default')}</code>\n思考强度：<code>${escapeHtml(binding.reasoningEffort || '由模型目录决定')}</code>\n用法：/model &lt;model-id&gt; [effort]；/model default 恢复默认。下次请求将校验模型目录，不会静默切换型号。`;
        break;
      }
      if (getActiveTaskForChat(msg.address)) {
        response = '请等待当前任务完成，或先 /stop，再切换模型。';
        break;
      }
      const [model, effort, extra] = args.trim().split(/\s+/);
      if (extra || !/^[a-zA-Z0-9._:/-]+$/.test(model) || (effort && !/^[a-zA-Z0-9_-]+$/.test(effort))) {
        response = '用法：/model &lt;model-id&gt; [effort]';
        break;
      }
      store.updateChannelBinding(binding.id, { model, reasoningEffort: effort || '' });
      store.updateSessionModel(binding.codepilotSessionId, model);
      response = `模型已设为 <code>${escapeHtml(model)}</code>${effort ? `，思考强度 <code>${escapeHtml(effort)}</code>` : ''}；下次请求生效。`;
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      const session = store.getSession(binding.codepilotSessionId);
      const effectiveModel = (session?.model || binding.model || 'default').trim() || 'default';
      const backend = (store.getSetting('bridge_llm_backend') || '').trim().toLowerCase();

      const st = getState();
      const activeChatTask = getActiveTaskForChat(msg.address);
      const isRunningTask = Boolean(activeChatTask);
      const startedAtMs = activeChatTask
        ? (activeChatTask.sessionId === binding.codepilotSessionId
          ? st.activeTaskStartedAt.get(binding.codepilotSessionId) ?? activeChatTask.startedAt
          : activeChatTask.startedAt)
        : null;
      const runningForMs = (isRunningTask && startedAtMs) ? (Date.now() - startedAtMs) : null;
      const activeTaskSessionId = activeChatTask?.sessionId ?? binding.codepilotSessionId;
      const hasSessionLock = st.sessionLocks.has(activeTaskSessionId);

      const turnTimeoutSetting = parsePositiveInt(store.getSetting('bridge_codex_turn_timeout_ms'));
      const idleTimeoutSetting = parsePositiveInt(store.getSetting('bridge_codex_turn_idle_timeout_ms'));
      const queueTimeoutSetting = parsePositiveInt(store.getSetting('bridge_session_queue_timeout_ms'));
      const effectiveTurnTimeoutMs = (turnTimeoutSetting != null) ? turnTimeoutSetting : DEFAULT_CODEX_TURN_TIMEOUT_MS;
      const effectiveIdleTimeoutMs = (idleTimeoutSetting != null) ? idleTimeoutSetting : 0;
      const effectiveQueueTimeoutMs = computeSessionQueueTimeoutMs(queueTimeoutSetting, turnTimeoutSetting);

      // Build recent tool calls section
      const recentTools = st.recentToolCalls.get(activeTaskSessionId) || [];
      const toolLines: string[] = [];
      if (recentTools.length > 0) {
        toolLines.push('', '<b>Recent tools:</b>');
        // Show last 5 tool calls with relative timestamps
        const now = Date.now();
        for (const tc of recentTools.slice(-5)) {
          const ago = Math.round((now - tc.timestamp) / 1000);
          const agoStr = ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m${ago % 60}s ago`;
          toolLines.push(`  <code>${escapeHtml(tc.name)}</code> (${agoStr})`);
        }
      } else if (isRunningTask) {
        toolLines.push('', '<i>No tool calls recorded yet.</i>');
      }

      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        ...(activeChatTask && activeChatTask.sessionId !== binding.codepilotSessionId
          ? [`Active task session: <code>${activeChatTask.sessionId.slice(0, 8)}...</code>`]
          : []),
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        ...(backend !== 'codex' ? [`Model: <code>${escapeHtml(effectiveModel)}</code>`] : []),
        ...(backend === 'codex' ? [escapeHtml(describeModelPreferences(binding))] : []),
        `Backend: <code>${escapeHtml(backend || 'default')}</code>`,
        `Task: ${activeChatTask?.abort.signal.aborted ? '<b>cancelling</b>' : isRunningTask ? '<b>running</b>' : '<b>idle</b>'}${runningForMs != null ? ` (<code>${formatTimeoutMs(runningForMs)}</code>)` : ''}`,
        `Session lock: ${hasSessionLock ? '<b>busy</b>' : '<b>free</b>'}`,
        `Turn timeout: <code>${formatTimeoutMs(effectiveTurnTimeoutMs)}</code>`,
        `Turn idle timeout: <code>${formatTimeoutMs(effectiveIdleTimeoutMs)}</code>`,
        `Queue timeout: <code>${formatTimeoutMs(effectiveQueueTimeoutMs)}</code>`,
        ...toolLines,
        `Waiting messages: ${countWaitingMessages(msg.address)}`,
        escapeHtml(getResponseDeliveryStatus(msg.address)),
      ].join('\n');
      break;
    }

    case '/usage':
    case '/tokens': {
      try {
        const filePath = resolveUsageSummaryPath(store);
        const range = parseUsageQueryRange(args, new Date());
        response = await renderUsageReportHtml({
          filePath,
          range,
          options: { topN: 5 },
        });
      } catch (err) {
        response = [
          '<b>Token 用量</b>',
          '',
          '读取统计失败。',
          err instanceof Error ? `原因：<code>${escapeHtml(err.message)}</code>` : '',
        ].filter(Boolean).join('\n');
      }
      break;
    }

    case '/sessions': {
      if (args && !/^[1-9]\d*$/.test(args)) { response = '用法：/sessions [页码]'; break; }
      const current = store.getChannelBinding(msg.address.channelType, msg.address.chatId);
      const history = store.listChannelSessionHistory?.(msg.address.channelType, msg.address.chatId)
        ?? (current ? [{ sessionId: current.codepilotSessionId, title: '当前会话', workingDirectory: current.workingDirectory, updatedAt: current.updatedAt }] : []);
      const entries = [...new Map(history.filter(row => store.getSession(row.sessionId)).map(row => [row.sessionId, row])).values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || Number(b.sessionId === current?.codepilotSessionId) - Number(a.sessionId === current?.codepilotSessionId));
      if (entries.length === 0) {
        response = 'No sessions found.';
      } else {
        const pageSize = 5;
        const pages = Math.ceil(entries.length / pageSize);
        const page = Number(args || '1');
        if (!Number.isSafeInteger(page) || page > pages) { response = `页码超出范围，共 ${pages} 页。`; break; }
        const lines = [`<b>当前聊天的会话（${page}/${pages} 页，共 ${entries.length} 个）</b>`, '复制完整 /bind 命令可切回该会话。', ''];
        for (const row of entries.slice((page - 1) * pageSize, page * pageSize)) {
          lines.push(
            `${row.sessionId === current?.codepilotSessionId ? '[当前] ' : ''}${escapeHtml(row.title.slice(0, 80) || '未命名会话')}`,
            `<code>/bind ${escapeHtml(row.sessionId)}</code>`,
            `目录：${escapeHtml((row.workingDirectory || '~').slice(0, 300))}`,
            `更新：${escapeHtml(row.updatedAt || '未知')}`, '',
          );
        }
        if (page > 1) lines.push(`上一页：<code>/sessions ${page - 1}</code>`);
        if (page < pages) lines.push(`下一页：<code>/sessions ${page + 1}</code>`);
        if (!store.listChannelSessionHistory) lines.push('宿主不支持历史列表，仅显示当前会话。');
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const cancelled = await getState().admissionGate.run(msg.address, () => cancelChat(adapter, msg.address));
      response = cancelled.running
        ? `已请求停止当前任务，正在清理本地执行。${cancelled.dropped ? ` 已取消 ${cancelled.dropped} 条等待消息。` : ''}`
        : cancelled.dropped ? `已取消 ${cancelled.dropped} 条等待消息。` : 'No task is currently running.';
      break;
    }

    case '/retry': {
      const state = getState();
      const epoch = state.runEpoch;
      await state.admissionGate.run(msg.address, () => {
        if (!state.running || state.runEpoch !== epoch) return;
        if (getActiveTaskForChat(msg.address)) { response = '当前任务尚未结束，请稍后重投回答。'; return; }
        startResponseRetry(adapter, msg, args || undefined);
      });
      break;
    }

    case '/git': {
      const binding = router.resolve(msg.address);
      const cwd = binding.workingDirectory || process.cwd();

      store.insertAuditLog({
        channelType: adapter.channelType,
        chatId: msg.address.chatId,
        direction: 'inbound',
        messageId: msg.messageId,
        summary: `[CMD] /git ${args ? args.slice(0, 200) : ''}`.trim(),
      });

      const parsed = parseGitSlashCommandArgs(args);
      const examples = getGitCommitMessageExamples();

      const runGit = async (gitArgs: string[]) => {
        try {
          const { stdout, stderr } = await execFileAsync('git', gitArgs, {
            cwd,
            windowsHide: true,
            timeout: 120_000,
            maxBuffer: 2 * 1024 * 1024,
            encoding: 'utf8',
            env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' },
          });
          return { stdout: String(stdout || ''), stderr: String(stderr || '') };
        } catch (err) {
          const e = err as any;
          const stderr = typeof e?.stderr === 'string' && e.stderr.trim()
            ? e.stderr.trim()
            : typeof e?.message === 'string'
              ? e.message
              : String(err);
          const stdout = typeof e?.stdout === 'string' ? e.stdout.trim() : '';
          const code = typeof e?.code === 'number' ? e.code : undefined;
          const codeHint = typeof code === 'number' ? ` (exit ${code})` : '';
          throw new Error([
            `git ${gitArgs.join(' ')} 执行失败${codeHint}`,
            stdout ? `stdout: ${stdout}` : '',
            stderr ? `stderr: ${stderr}` : '',
          ].filter(Boolean).join('\n'));
        }
      };

      // 确保在 git 仓库内
      try {
        await runGit(['rev-parse', '--is-inside-work-tree']);
      } catch {
        response = [
          '当前工作目录不是 git 仓库，无法执行 /git。',
          `CWD: <code>${escapeHtml(cwd)}</code>`,
          '可先用 /cwd 切换到项目目录。',
        ].join('\n');
        break;
      }

      if (parsed.kind === 'help') {
        response = [
          '<b>/git 用法</b>',
          '',
          '自动提交（包含暂存区 + 工作区，自动生成 message）：',
          '<code>/git</code>',
          '',
          '自定义提交 message：',
          '<code>/git type(scope): subject</code>',
          '',
          '生成 draft（LLM 生成 message+摘要，不提交，可选附带提示）：',
          '<code>/git draft [提示]</code>',
          '',
          '确认提交上一次 draft：',
          '<code>/git draft commit</code>',
          '',
          '清除 draft：',
          '<code>/git draft clear</code>',
          '',
          '推送当前分支：',
          '<code>/git push</code>',
          '',
          '提交信息示例：',
          ...examples.map(e => `- <code>${escapeHtml(e)}</code>`),
          '',
          '可选配置（.env.bridge.local）：',
          '- <code>bridge_git_llm_enabled=true/false</code>（默认 true，生成提交信息与语义摘要）',
          '- <code>bridge_git_llm_include_patch=true/false</code>（默认 false，让模型参考 diff 片段）',
          '- <code>bridge_git_llm_required=true/false</code>（默认 true，开启后：LLM 必须生成提交信息/语义摘要，否则不提交）',
        ].join('\n');
        break;
      }

      if (parsed.kind === 'push') {
        try {
          const result = await runGit(['push']);
          const out = (result.stdout || result.stderr || '').trim();
          response = [
            '<b>已推送到远端。</b>',
            out ? `\n<code>${escapeHtml(out).slice(0, 1800)}</code>` : '',
          ].join('').trim();
        } catch (err) {
          response = [
            '<b>推送失败：</b>',
            `<code>${escapeHtml(err instanceof Error ? err.message : String(err)).slice(0, 1800)}</code>`,
          ].join('\n');
        }
        break;
      }

      if (parsed.kind === 'draft_clear') {
        const st = getState();
        st.gitDrafts.delete(binding.codepilotSessionId);
        response = '<b>Draft 已清除。</b>';
        break;
      }

      if (parsed.kind === 'draft_commit') {
        const st = getState();
        const draft = st.gitDrafts.get(binding.codepilotSessionId);
        if (!draft) {
          response = [
            '<b>没有可提交的 draft。</b>',
            '请先执行 <code>/git draft</code> 生成提交草稿。',
          ].join('\n');
          break;
        }

        try {
          const stagedNow = await runGit(['diff', '--cached', '--name-only']);
          const stagedFilesNow = stagedNow.stdout
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);

          if (stagedFilesNow.length === 0) {
            st.gitDrafts.delete(binding.codepilotSessionId);
            response = [
              '<b>draft 已失效。</b>',
              '原因：当前暂存区为空。',
              '请重新执行 <code>/git draft</code>。',
            ].join('\n');
            break;
          }

          let diffStatNow = '';
          try {
            diffStatNow = (await runGit(['diff', '--cached', '--stat'])).stdout.trim();
          } catch {
            diffStatNow = '';
          }

          const normalizeList = (arr: string[]) => arr.map((s) => s.replaceAll('\\', '/').trim()).filter(Boolean).sort();
          const sameFiles = normalizeList(stagedFilesNow).join('\n') === normalizeList(draft.stagedFiles).join('\n');
          const sameStat = (diffStatNow || '').trim() === (draft.diffStatText || '').trim();
          if (!sameFiles || !sameStat) {
            response = [
              '<b>提交已取消。</b>',
              '原因：暂存区内容与 draft 不一致（可能你又改/又暂存了其他内容）。',
              '',
              '可选：',
              '- 重新执行 <code>/git draft</code> 生成新的草稿',
              '- 或执行 <code>/git draft clear</code> 清除草稿',
            ].join('\n');
            break;
          }

          await runGit(['commit', '-m', draft.commitMessage]);
          st.gitDrafts.delete(binding.codepilotSessionId);

          const hash = (await runGit(['rev-parse', '--short', 'HEAD'])).stdout.trim();
          const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();

          const changeSummary = buildChangeSummaryBlock(draft.stagedFiles, draft.diffStatText || '');
          const semanticSummaryBlock = buildSemanticSummaryBlock(draft.summaryLines || []);

          response = [
            '<b>提交完成。</b>',
            `Branch: <code>${escapeHtml(branch || 'unknown')}</code>`,
            `Commit: <code>${escapeHtml(hash || '')}</code>`,
            `Message: <code>${escapeHtml(draft.commitMessage).slice(0, 300)}</code>`,
            '<i>LLM：提交信息/语义摘要来自 draft（已确认后提交）</i>',
            '',
            changeSummary,
            ...(semanticSummaryBlock ? ['', semanticSummaryBlock] : []),
            '',
            '是否需要推送到远端？如需推送请执行：',
            '<code>/git push</code>',
          ].join('\n');
        } catch (err) {
          response = [
            '<b>提交失败：</b>',
            `<code>${escapeHtml(err instanceof Error ? err.message : String(err)).slice(0, 1800)}</code>`,
          ].join('\n');
        }

        break;
      }

      if (parsed.kind === 'draft') {
        const gitLlmEnabled = parseBooleanSetting(store.getSetting('bridge_git_llm_enabled'), true);
        const gitLlmIncludePatch = parseBooleanSetting(store.getSetting('bridge_git_llm_include_patch'), false);
        const timeoutSetting = parsePositiveInt(store.getSetting('bridge_git_llm_timeout_ms'));
        const gitLlmTimeoutMs = timeoutSetting && timeoutSetting > 0 ? timeoutSetting : 45_000;
        const maxPatchSetting = parsePositiveInt(store.getSetting('bridge_git_llm_max_patch_chars'));
        const gitLlmMaxPatchChars = maxPatchSetting != null ? Math.max(0, maxPatchSetting) : 12_000;

        if (!gitLlmEnabled) {
          response = [
            '<b>Draft 生成失败。</b>',
            '原因：当前已关闭 LLM 生成（bridge_git_llm_enabled=false）。',
            '请在 .env.bridge.local 打开后重试：<code>bridge_git_llm_enabled=true</code>',
          ].join('\n');
          break;
        }

        try {
          const status = await runGit(['status', '--porcelain']);
          if (!status.stdout.trim()) {
            response = '没有可提交的改动。';
            break;
          }

          // draft 的目标就是“先看草稿再确认提交”，因此这里会暂存全部改动（与 /git 行为一致）。
          await runGit(['add', '-A']);

          const staged = await runGit(['diff', '--cached', '--name-only']);
          const stagedFiles = staged.stdout
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
          if (stagedFiles.length === 0) {
            response = '暂存区为空，没有可提交的改动。';
            break;
          }

          let diffStatText = '';
          let changeSummary: string | null = null;
          try {
            diffStatText = (await runGit(['diff', '--cached', '--stat'])).stdout.trim();
            changeSummary = buildChangeSummaryBlock(stagedFiles, diffStatText);
          } catch {
            changeSummary = null;
          }

          // Resolve model for draft LLM
          const sessionForModel = store.getSession(binding.codepilotSessionId);
          const effectiveModelForGit = (sessionForModel?.model || binding.model || store.getSetting('default_model') || 'default').trim() || 'default';

          let diffPatchText: string | undefined;
          if (gitLlmIncludePatch && gitLlmMaxPatchChars > 0) {
            const rawPatch = (await runGit(['diff', '--cached', '--patch', '--unified=1', '--no-color'])).stdout;
            const trimmed = (rawPatch || '').trim();
            if (trimmed) {
              diffPatchText = trimmed.length > gitLlmMaxPatchChars ? trimmed.slice(0, gitLlmMaxPatchChars) + '\n…(truncated)…' : trimmed;
            }
          }

          const llmOut = await generateGitCommitMessageWithLLM({
            llm,
            sessionId: `${binding.codepilotSessionId}:git-draft`,
            model: effectiveModelForGit,
            workingDirectory: cwd,
            stagedFiles,
            diffStat: diffStatText,
            diffPatch: diffPatchText,
            timeoutMs: gitLlmTimeoutMs,
            userHint: parsed.hint,
          });

          const v = llmOut.commitMessage ? validateAndNormalizeConventionalCommitMessage(llmOut.commitMessage) : null;
          if (!v || !v.ok) {
            response = [
              '<b>Draft 生成失败。</b>',
              '原因：LLM 未生成合规的 Conventional Commit 提交信息。',
              llmOut.commitMessage ? `<code>${escapeHtml(String(llmOut.commitMessage)).slice(0, 300)}</code>` : '<code>(empty)</code>',
              '',
              '可选：',
              '- 重新执行 <code>/git draft</code> 再试一次',
              '- 或手动提交：<code>/git feat(scope): 增加xxx</code>',
            ].join('\n');
            break;
          }

          const summaryLines = (llmOut.summaryLines || []).map((s) => s.trim()).filter(Boolean);
          if (summaryLines.length === 0) {
            response = [
              '<b>Draft 生成失败。</b>',
              '原因：LLM 未返回语义摘要。',
              '',
              '可选：',
              '- 重新执行 <code>/git draft</code> 再试一次',
            ].join('\n');
            break;
          }

          const commitMessage = v.normalized;
          const st = getState();
          st.gitDrafts.set(binding.codepilotSessionId, {
            createdAt: Date.now(),
            cwd,
            stagedFiles,
            diffStatText,
            commitMessage,
            summaryLines,
          });

          const semanticSummaryBlock = buildSemanticSummaryBlock(summaryLines);

          response = [
            '<b>Draft 已生成（未提交）。</b>',
            `Message: <code>${escapeHtml(commitMessage).slice(0, 300)}</code>`,
            ...(parsed.hint ? [`Hint: <code>${escapeHtml(parsed.hint).slice(0, 200)}</code>`] : []),
            ...(changeSummary ? ['', changeSummary] : []),
            ...(semanticSummaryBlock ? ['', semanticSummaryBlock] : []),
            '',
            '确认提交请执行：',
            '<code>/git draft commit</code>',
            '',
            '不想用了可执行：',
            '<code>/git draft clear</code>',
          ].join('\n');
        } catch (err) {
          response = [
            '<b>Draft 生成失败：</b>',
            `<code>${escapeHtml(err instanceof Error ? err.message : String(err)).slice(0, 1800)}</code>`,
          ].join('\n');
        }

        break;
      }

      // 手动 message：先校验，避免 message 不合规时产生 `git add -A` 的副作用
      let manualCommitMessage: string | null = null;
      if (parsed.kind === 'commit') {
        const validated = validateAndNormalizeConventionalCommitMessage(parsed.message);
        if (!validated.ok) {
          response = [
            `<b>提交信息不符合规范：</b> ${escapeHtml(validated.error)}`,
            validated.hint ? `\n<code>${escapeHtml(validated.hint)}</code>` : '',
          ].join('').trim();
          break;
        }
        manualCommitMessage = validated.normalized;
      }

      try {
        const status = await runGit(['status', '--porcelain']);
        if (!status.stdout.trim()) {
          response = '没有可提交的改动。';
          break;
        }

        await runGit(['add', '-A']);

        const staged = await runGit(['diff', '--cached', '--name-only']);
        const stagedFiles = staged.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        if (stagedFiles.length === 0) {
          response = '暂存区为空，没有可提交的改动。';
          break;
        }

        // Best-effort build a human-friendly summary before commit (after commit, --cached diff is empty).
        let diffStatText = '';
        let changeSummary: string | null = null;
        try {
          diffStatText = (await runGit(['diff', '--cached', '--stat'])).stdout.trim();
          changeSummary = buildChangeSummaryBlock(stagedFiles, diffStatText);
        } catch {
          // ignore (do not block commit)
          changeSummary = null;
        }

        // Optional: ask LLM to generate a better Conventional Commit message + semantic summary.
        const gitLlmEnabled = parseBooleanSetting(store.getSetting('bridge_git_llm_enabled'), true);
        const gitLlmRequired = parseBooleanSetting(store.getSetting('bridge_git_llm_required'), true);
        const gitLlmIncludePatch = parseBooleanSetting(store.getSetting('bridge_git_llm_include_patch'), false);
        const timeoutSetting = parsePositiveInt(store.getSetting('bridge_git_llm_timeout_ms'));
        const gitLlmTimeoutMs = timeoutSetting && timeoutSetting > 0 ? timeoutSetting : 45_000;
        const maxPatchSetting = parsePositiveInt(store.getSetting('bridge_git_llm_max_patch_chars'));
        const gitLlmMaxPatchChars = maxPatchSetting != null ? Math.max(0, maxPatchSetting) : 12_000;

        // Resolve a model for the LLM helper (isolated, does not resume chat context).
        const sessionForModel = store.getSession(binding.codepilotSessionId);
        const effectiveModelForGit = (sessionForModel?.model || binding.model || store.getSetting('default_model') || 'default').trim() || 'default';

        let llmSummaryLines: string[] = [];
        let llmCommitMessageCandidate: string | null = null;
        let llmError: string | null = null;
        if (gitLlmEnabled) {
          try {
            // Fetch patch lazily only when enabled.
            let diffPatchText: string | undefined;
            if (gitLlmIncludePatch && gitLlmMaxPatchChars > 0) {
              const rawPatch = (await runGit(['diff', '--cached', '--patch', '--unified=1', '--no-color'])).stdout;
              const trimmed = (rawPatch || '').trim();
              if (trimmed) {
                diffPatchText = trimmed.length > gitLlmMaxPatchChars ? trimmed.slice(0, gitLlmMaxPatchChars) + '\n…(truncated)…' : trimmed;
              }
            }

            const llmOut = await generateGitCommitMessageWithLLM({
              llm,
              sessionId: `${binding.codepilotSessionId}:git`,
              model: effectiveModelForGit,
              workingDirectory: cwd,
              stagedFiles,
              diffStat: diffStatText,
              diffPatch: diffPatchText,
              timeoutMs: gitLlmTimeoutMs,
            });

            llmSummaryLines = llmOut.summaryLines || [];
            llmCommitMessageCandidate = llmOut.commitMessage;
          } catch (e) {
            llmError = e instanceof Error ? e.message : String(e);
          }
        }

        let commitMessage = '';
        let usedLlmCommitMessage = false;
        if (parsed.kind === 'auto') {
          let normalizedFromLlm: string | null = null;
          if (llmCommitMessageCandidate) {
            const v = validateAndNormalizeConventionalCommitMessage(llmCommitMessageCandidate);
            if (v.ok) normalizedFromLlm = v.normalized;
          }

          if (normalizedFromLlm) {
            commitMessage = normalizedFromLlm;
            usedLlmCommitMessage = true;
          } else if (gitLlmEnabled && gitLlmRequired) {
            const reason = llmError
              ? `LLM 生成失败：${llmError}`
              : (llmCommitMessageCandidate ? `LLM 提议的提交信息不合规：${llmCommitMessageCandidate}` : 'LLM 未返回提交信息');
            response = [
              '<b>提交已取消。</b>',
              '原因：已启用 LLM 且要求必须生成合规提交信息，但本次未满足。',
              `<code>${escapeHtml(reason).slice(0, 1800)}</code>`,
              '',
              '可选：',
              '- 重新执行 <code>/git</code> 再试一次',
              '- 或在 .env.bridge.local 设置 <code>bridge_git_llm_required=false</code> 允许回退',
              '- 或设置 <code>bridge_git_llm_enabled=false</code> 关闭 LLM 生成',
            ].join('\n');
            break;
          } else {
            commitMessage = generateAutoConventionalCommitMessage(stagedFiles);
          }
        } else {
          commitMessage = manualCommitMessage || '';
        }

        // 当要求“必须 LLM 参与”时，也要求给出至少 1 条语义摘要（避免仅靠工程兜底，满足用户强诉求）。
        if (gitLlmEnabled && gitLlmRequired) {
          const hasSemanticSummary = (llmSummaryLines || []).some((l) => String(l || '').trim());
          if (!hasSemanticSummary) {
            const reason = llmError ? `LLM 生成失败：${llmError}` : 'LLM 未返回语义摘要';
            response = [
              '<b>提交已取消。</b>',
              '原因：已启用 LLM 且要求必须生成语义摘要，但本次未满足。',
              `<code>${escapeHtml(reason).slice(0, 1800)}</code>`,
              '',
              '可选：',
              '- 重新执行 <code>/git</code> 再试一次',
              '- 或在 .env.bridge.local 设置 <code>bridge_git_llm_required=false</code> 允许回退',
              '- 或设置 <code>bridge_git_llm_enabled=false</code> 关闭 LLM 生成',
            ].join('\n');
            break;
          }
        }

        await runGit(['commit', '-m', commitMessage]);
        // 提交完成后清理 draft，避免误用过期草稿。
        try { getState().gitDrafts.delete(binding.codepilotSessionId); } catch { /* 忽略 */ }

        const hash = (await runGit(['rev-parse', '--short', 'HEAD'])).stdout.trim();
        const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();

        const semanticSummaryBlock = buildSemanticSummaryBlock(llmSummaryLines);

        const llmParticipationLine = (() => {
          if (!gitLlmEnabled) return null;
          const messageSource = parsed.kind === 'auto'
            ? (usedLlmCommitMessage ? '提交信息由 LLM 生成' : '提交信息回退为本地推断')
            : '提交信息为手动输入';
          const summarySource = semanticSummaryBlock ? '语义摘要由 LLM 生成' : '语义摘要未生成';
          return `<i>LLM：${escapeHtml(messageSource)}；${escapeHtml(summarySource)}</i>`;
        })();

        response = [
          '<b>提交完成。</b>',
          `Branch: <code>${escapeHtml(branch || 'unknown')}</code>`,
          `Commit: <code>${escapeHtml(hash || '')}</code>`,
          `Message: <code>${escapeHtml(commitMessage).slice(0, 300)}</code>`,
          ...(llmParticipationLine ? [llmParticipationLine] : []),
          ...(changeSummary ? ['', changeSummary] : []),
          ...(semanticSummaryBlock ? ['', semanticSummaryBlock] : []),
          ...(gitLlmEnabled && llmError ? ['', `<i>LLM 生成摘要失败，已忽略：${escapeHtml(llmError).slice(0, 300)}</i>`] : []),
          '',
          '是否需要推送到远端？如需推送请执行：',
          '<code>/git push</code>',
          '',
          '提示：想写更具体的提交信息可用 <code>/git feat(scope): 更新xxx</code>（见 <code>/git help</code>）。',
        ].join('\n');
      } catch (err) {
        response = [
          '<b>提交失败：</b>',
          `<code>${escapeHtml(err instanceof Error ? err.message : String(err)).slice(0, 1800)}</code>`,
        ].join('\n');
      }

      break;
    }

    case '/workflow': {
      const binding = router.resolve(msg.address);
      await handleWorkflowCommand(adapter, msg, args, binding);
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/help':
      response = buildBridgeCommandHelp();
      break;

    default:
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    });
  }
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - 如果 result 返回了 sdkSessionId（非空）→ 始终保存（即使本次 turn 失败）
 * - 否则 → 不更新（保留现有 sdkSessionId）
 *
 * 说明：
 * - “失败也保留 sdkSessionId”可让用户在失败后继续沿用同一上游上下文对话
 * - 如需强制清空上下文，请用 /new 创建新会话（会清空 sdkSessionId）
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  _hasError: boolean,
): string | null {
  if (typeof sdkSessionId === 'string' && sdkSessionId.trim()) return sdkSessionId.trim();
  return null;
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = { handleMessage };
