/** 将模型问答转交 IM，并校验回答来源和生命周期。 */
import type { BaseChannelAdapter } from './channel-adapter.js';
import type { UserInputRequest, UserInputResponse, UserInputPhase, PermissionResolution, PermissionGateway } from './host.js';
import type { ChannelAddress } from './types.js';
import { getBridgeContext } from './context.js';
import { boundedInteraction } from './interaction-lifecycle.js';
import { deliver } from './delivery-layer.js';

export interface UserInputOwnership {
  isCurrent: () => boolean;
  canSupplement: () => boolean;
  allowSupplement: boolean;
}
type PendingInput = {
  request: UserInputRequest; address: ChannelAddress; sessionId: string; messageId: string;
  adapter: BaseChannelAdapter; permissions?: PermissionGateway; ownership?: UserInputOwnership;
  phase: UserInputPhase; closedAt?: number; unsubscribe?: () => void; updating: boolean; rendered?: UserInputPhase;
};
const pendingInputs = new Map<string, PendingInput>();
const CLOSED_TTL_MS = 10 * 60_000;
const MAX_CLOSED_INPUTS = 100;
let expiryTimer: NodeJS.Timeout | undefined;

// 每卡最多一个真实在途 patch。观察超时不能解开串行，否则旧 patch 迟到会覆盖终态。
function updateCard(input: PendingInput): void {
  if (!input.messageId || input.updating || input.rendered === input.phase) return;
  const phase = input.phase;
  const update = input.adapter.updateUserInputRequest
    ? () => input.adapter.updateUserInputRequest!(input.address, input.messageId, input.request, phase)
    : input.adapter.updateInteractionMessage && phase !== 'pending' && phase !== 'closed'
      ? () => input.adapter.updateInteractionMessage!(input.address, input.messageId, phase === 'answered' || phase === 'supplemented' ? 'answered' : phase === 'expired' ? 'expired' : phase === 'failed' ? 'failed' : 'denied') : undefined;
  if (!update) return;
  input.updating = true;
  const work = Promise.resolve().then(update);
  void boundedInteraction(work, 15_000).catch(() => {});
  void work.catch(() => {}).finally(() => {
    input.updating = false; input.rendered = phase;
    if (input.phase !== phase) updateCard(input);
  });
}

function removeInput(input: PendingInput, phase: UserInputPhase): void {
  if (pendingInputs.get(input.request.requestId) === input) pendingInputs.delete(input.request.requestId);
  input.phase = phase; input.unsubscribe?.(); updateCard(input);
}

function pruneClosedInputs(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  const closed = [...pendingInputs.values()].filter(input => input.phase === 'closed').sort((a, b) => a.closedAt! - b.closedAt!);
  const now = Date.now();
  while (closed.length) {
    const input = closed[0];
    if (now - input.closedAt! < CLOSED_TTL_MS && closed.length <= MAX_CLOSED_INPUTS) break;
    closed.shift(); removeInput(input, 'expired');
  }
  const first = closed[0];
  if (first) {
    expiryTimer = setTimeout(pruneClosedInputs, Math.max(1, first.closedAt! + CLOSED_TTL_MS - now));
    expiryTimer.unref?.();
  }
}

function settleInput(input: PendingInput, resolution: PermissionResolution): void {
  if (input.phase !== 'pending') return;
  input.unsubscribe?.();
  const mayClose = resolution.behavior !== 'allow' && (resolution.reason === 'request_closed' || resolution.reason === 'turn_completed')
    && input.address.channelType === 'feishu' && input.address.userId && input.adapter.updateUserInputRequest
    && input.ownership?.allowSupplement && input.ownership.isCurrent();
  if (mayClose) {
    input.phase = 'closed'; input.closedAt = Date.now(); pruneClosedInputs(); updateCard(input);
  } else {
    removeInput(input, resolution.behavior === 'allow' ? 'answered' : resolution.reason === 'expired' ? 'expired' : resolution.reason === 'delivery_failed' ? 'failed' : 'cancelled');
  }
}

export async function forwardUserInputRequest(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  request: UserInputRequest,
  sessionId: string,
  replyToMessageId?: string,
  ownership?: UserInputOwnership,
): Promise<void> {
  const { permissions } = getBridgeContext();
  if (!request.requestId || !Array.isArray(request.questions) || request.questions.length === 0 || request.questions.length > 50
    || new Set(request.questions.map(q => q.id)).size !== request.questions.length || JSON.stringify(request).length > 32_000) {
    if (request.answerChannel !== 'message') permissions.resolvePendingPermission(request.requestId, { behavior: 'deny', reason: 'delivery_failed' }); return;
  }
  if (request.answerChannel === 'message' && (address.channelType !== 'feishu' || !ownership?.allowSupplement || !address.userId)) {
    // 原生通知在其他渠道保留问题/选项文字；没有可回传的权限或 RPC。
    const text = request.questions.map(q => [q.question, ...(q.options ?? []).map(option => `- ${option.label}`)].join('\n')).join('\n\n');
    try { await boundedInteraction(deliver(adapter, { address, text: `${text}\n\n请以普通消息补充回答。`, parseMode: 'plain', replyToMessageId }, { isCurrent: ownership?.isCurrent }), 15_000); } catch { /* 展示失败不伪造回答请求。 */ }
    return;
  }
  if (pendingInputs.has(request.requestId)) return;
  const rpcPermissions = request.answerChannel === 'message' ? undefined : permissions;
  const input: PendingInput = { request, address: { ...address }, sessionId, messageId: '', adapter, permissions: rpcPermissions, ownership, phase: 'pending', updating: false };
  pendingInputs.set(request.requestId, input);
  input.unsubscribe = rpcPermissions?.onResolution?.(request.requestId, resolution => settleInput(input, resolution));
  if (input.phase !== 'pending') input.unsubscribe?.();
  try {
    // 普通群消息无法提供秘密输入通道，不能降级成明文回答。
    if (request.questions.some(question => question.isSecret)) throw new Error('此聊天不支持安全输入，请在本地完成。');
    if (input.phase !== 'pending' && input.phase !== 'closed') return;
    const text = request.questions.map(question => [
      `${question.id}: ${question.question}`,
      ...(question.options ?? []).map(option => `- ${option.label}${option.description ? `：${option.description}` : ''}`),
    ].join('\n')).join('\n\n');
    const example = request.questions.length === 1 ? '<答案>' : JSON.stringify(Object.fromEntries(request.questions.map(q => [q.id, ['答案']])));
    const configured = Number(getBridgeContext().store.getSetting('bridge_interaction_timeout_ms'));
    const sending = adapter.sendUserInputRequest
      ? adapter.sendUserInputRequest(address, request, replyToMessageId)
      : deliver(adapter, { address, text: `${text}\n\n/answer ${request.requestId} ${example}`, parseMode: 'plain', replyToMessageId });
    void sending.then(result => {
      if (result.ok && result.messageId) {
        input.messageId = result.messageId;
        if (input.phase !== 'pending') updateCard(input);
      }
    }).catch(() => {});
    const result = await boundedInteraction(sending, configured > 0 ? configured : 15_000);
    if (!result.ok || !result.messageId) throw new Error(result.error || '问答消息发送失败');
  } catch (error) {
    removeInput(input, 'failed'); pruneClosedInputs();
    const resolution = { behavior: 'deny' as const, reason: 'delivery_failed' as const, message: error instanceof Error ? error.message : '问答消息发送失败' };
    rpcPermissions?.resolvePendingPermission(request.requestId, resolution);
  }
}

function resolveAnswer(address: ChannelAddress, response: UserInputResponse, messageId?: string): boolean {
  const pending = pendingInputs.get(response.requestId);
  if (!pending || pending.phase !== 'pending' || !pending.permissions) return false;
  const answers = validateAnswer(pending, address, response, messageId);
  if (!answers) return false;
  // 先消耗资格，禁止同步网关观察或双击再次取得答案。
  pendingInputs.delete(response.requestId);
  const resolved = pending.permissions.resolvePendingPermission(response.requestId, { behavior: 'allow', updatedInput: { answers } });
  settleInput(pending, { behavior: resolved ? 'allow' : 'deny' });
  return resolved;
}

function validateAnswer(pending: PendingInput, address: ChannelAddress, response: UserInputResponse, messageId?: string): Record<string, string[]> | null {
  if (pending.address.channelType !== address.channelType || pending.address.chatId !== address.chatId) return null;
  if (pending.address.userId && pending.address.userId !== address.userId) return null;
  if (messageId !== undefined && pending.messageId !== messageId) return null;
  if (!response.answers || typeof response.answers !== 'object' || Array.isArray(response.answers)) return null;
  const answers: Record<string, string[]> = Object.create(null);
  if (Object.keys(response.answers).some(id => !pending.request.questions.some(q => q.id === id))) return null;
  for (const question of pending.request.questions) {
    if (!Object.hasOwn(response.answers, question.id)) return null;
    const values = response.answers[question.id];
    if (!Array.isArray(values) || values.length === 0 || values.length > 50 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 32_000)) return null;
    if (!question.multiSelect && values.length !== 1) return null;
    if (question.options?.length && !question.allowOther && values.some(value => !question.options!.some(option => option.label === value))) return null;
    answers[question.id] = [...values];
  }
  if (pending.ownership && !pending.ownership.isCurrent()) return null;
  return { ...answers };
}

export function prepareUserInputSupplement(address: ChannelAddress, response: UserInputResponse, callbackMessageId: string | undefined, action: 'answer' | 'supplement'):
  | { status: 'invalid' | 'unavailable' | 'rpc' }
  | { status: 'ready'; text: string; sessionId: string; claim: (admit: () => void) => boolean; isCurrent: () => boolean } {
  pruneClosedInputs();
  const input = pendingInputs.get(response.requestId);
  if (!callbackMessageId || !input || !input.messageId || (action !== 'answer' && action !== 'supplement')) return { status: 'invalid' };
  const expectedPhase = action === 'answer' ? 'pending' : 'closed';
  if (input.phase !== expectedPhase) return { status: 'invalid' };
  const answers = validateAnswer(input, address, response, callbackMessageId);
  if (!answers) return { status: 'invalid' };
  if (action === 'answer' && input.permissions) return { status: 'rpc' };
  if (!input.ownership?.canSupplement()) return { status: 'unavailable' };
  const text = [action === 'answer' ? '回答当前任务中的问题：' : '补充此前任务中已关闭的问题：', ...input.request.questions.map(q => `原问题：${q.question}\n我的答案：${answers[q.id].join('；')}`)].join('\n\n');
  return { status: 'ready', text, sessionId: input.sessionId, isCurrent: input.ownership.isCurrent, claim: admit => {
    if (typeof admit !== 'function') return false;
    pruneClosedInputs();
    if (pendingInputs.get(response.requestId) !== input || input.phase !== expectedPhase || !input.ownership?.isCurrent() || !input.ownership.canSupplement()) return false;
    removeInput(input, 'supplemented'); pruneClosedInputs();
    try { admit(); } catch { removeInput(input, 'failed'); return false; }
    return true;
  } };
}

export function isUserInputClosed(address: ChannelAddress, requestId: string, messageId?: string): boolean {
  pruneClosedInputs();
  const input = pendingInputs.get(requestId);
  return Boolean(input?.phase === 'closed' && input.messageId && input.messageId === messageId
    && input.address.chatId === address.chatId && input.address.channelType === address.channelType && input.address.userId === address.userId);
}

export function handleUserInputResponse(address: ChannelAddress, response: UserInputResponse, callbackMessageId?: string): boolean {
  if (!callbackMessageId) return false;
  return resolveAnswer(address, response, callbackMessageId);
}

export function handleUserInputText(address: ChannelAddress, text: string): boolean {
  const match = text.match(/^\/answer\s+(\S+)\s+([\s\S]+)$/);
  if (!match) return false;
  const pending = pendingInputs.get(match[1]);
  if (!pending) return false;
  let answers: Record<string, string[]>;
  try {
    if (match[2].trim().startsWith('{')) {
      const parsed: unknown = JSON.parse(match[2]);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      answers = Object.fromEntries(Object.entries(parsed).map(([id, value]) => [id, typeof value === 'string' ? [value] : value]));
    } else {
      if (pending.request.questions.length !== 1) return false;
      answers = { [pending.request.questions[0].id]: [match[2].trim()] };
    }
  } catch { return false; }
  return resolveAnswer(address, { requestId: match[1], answers });
}

export function clearUserInputRequests(sessionId: string, options?: { preserveClosed?: boolean; owner?: () => boolean }): void {
  for (const [id, pending] of pendingInputs) {
    if (pending.sessionId === sessionId && (!options?.owner || pending.ownership?.isCurrent === options.owner) && !(options?.preserveClosed && pending.phase === 'closed')) {
      if (options?.preserveClosed && pending.phase === 'pending' && !pending.permissions) {
        settleInput(pending, { behavior: 'deny', reason: 'turn_completed' }); continue;
      }
      removeInput(pending, 'cancelled');
      const resolution = { behavior: 'deny' as const, reason: 'cancelled' as const, message: '会话已结束' };
      pending.permissions?.resolvePendingPermission(id, resolution);
    }
  }
  pruneClosedInputs();
}

/** stop/new/bind 按聊天清理，停机不传地址时清空全部问答。 */
export function invalidateUserInputRequests(address?: ChannelAddress): void {
  for (const [id, input] of pendingInputs) {
    if (address && (input.address.channelType !== address.channelType || input.address.chatId !== address.chatId)) continue;
    removeInput(input, 'cancelled'); input.permissions?.resolvePendingPermission(id, { behavior: 'deny', reason: 'cancelled' });
  }
  pruneClosedInputs();
}
