/** 将模型问答转交 IM，并校验回答来源和生命周期。 */
import type { BaseChannelAdapter } from './channel-adapter.js';
import type { UserInputRequest, UserInputResponse } from './host.js';
import type { ChannelAddress } from './types.js';
import { getBridgeContext } from './context.js';
import { observeInteraction, boundedInteraction } from './interaction-lifecycle.js';
import { deliver } from './delivery-layer.js';

type PendingInput = { request: UserInputRequest; address: ChannelAddress; sessionId: string; messageId: string; interaction: ReturnType<typeof observeInteraction> };
const pendingInputs = new Map<string, PendingInput>();

export async function forwardUserInputRequest(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  request: UserInputRequest,
  sessionId: string,
  replyToMessageId?: string,
): Promise<void> {
  const { permissions } = getBridgeContext();
  if (!request.requestId || !Array.isArray(request.questions) || request.questions.length === 0) return;
  if (pendingInputs.has(request.requestId)) return;
  const interaction = observeInteraction(adapter, address, request.requestId, permissions, true, () => pendingInputs.delete(request.requestId));
  if (interaction.settled) return;
  pendingInputs.set(request.requestId, { request, address, sessionId, messageId: '', interaction });
  try {
    // 普通群消息无法提供秘密输入通道，不能降级成明文回答。
    if (request.questions.some(question => question.isSecret)) throw new Error('此聊天不支持安全输入，请在本地完成。');
    const text = request.questions.map(question => [
      `${question.id}: ${question.question}`,
      ...(question.options ?? []).map(option => `- ${option.label}${option.description ? `：${option.description}` : ''}`),
    ].join('\n')).join('\n\n');
    const example = request.questions.length === 1 ? '<答案>' : JSON.stringify(Object.fromEntries(request.questions.map(q => [q.id, ['答案']])));
    const configured = Number(getBridgeContext().store.getSetting('bridge_interaction_timeout_ms'));
    const sending = adapter.sendUserInputRequest
      ? adapter.sendUserInputRequest(address, request, replyToMessageId)
      : deliver(adapter, { address, text: `${text}\n\n/answer ${request.requestId} ${example}`, parseMode: 'plain', replyToMessageId });
    void sending.then(result => { if (result.messageId) interaction.sent(result.messageId); }).catch(() => {});
    const result = await boundedInteraction(sending, configured > 0 ? configured : 15_000);
    if (!result.ok || !result.messageId) throw new Error(result.error || '问答消息发送失败');
    if (!interaction.settled) pendingInputs.set(request.requestId, { request, address, sessionId, messageId: result.messageId, interaction });
  } catch (error) {
    pendingInputs.delete(request.requestId);
    const resolution = { behavior: 'deny' as const, reason: 'delivery_failed' as const, message: error instanceof Error ? error.message : '问答消息发送失败' };
    permissions.resolvePendingPermission(request.requestId, resolution);
    interaction.resolve(resolution);
  }
}

function resolveAnswer(address: ChannelAddress, response: UserInputResponse, messageId?: string): boolean {
  const pending = pendingInputs.get(response.requestId);
  if (!pending || pending.interaction.settled) {
    pendingInputs.delete(response.requestId);
    return false;
  }
  if (pending.address.channelType !== address.channelType || pending.address.chatId !== address.chatId) return false;
  if (pending.address.userId && pending.address.userId !== address.userId) return false;
  if (messageId !== undefined && pending.messageId !== messageId) return false;
  if (!response.answers || typeof response.answers !== 'object') return false;
  const answers: Record<string, string[]> = {};
  if (Object.keys(response.answers).some(id => !pending.request.questions.some(q => q.id === id))) return false;
  for (const question of pending.request.questions) {
    const values = response.answers[question.id];
    if (!Array.isArray(values) || values.length === 0 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 32_000)) return false;
    if (!question.multiSelect && values.length !== 1) return false;
    if (question.options?.length && !question.allowOther && values.some(value => !question.options!.some(option => option.label === value))) return false;
    answers[question.id] = [...values];
  }
  pendingInputs.delete(response.requestId);
  const resolved = getBridgeContext().permissions.resolvePendingPermission(response.requestId, { behavior: 'allow', updatedInput: { answers } });
  pending.interaction.resolve({ behavior: resolved ? 'allow' : 'deny' });
  return resolved;
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

export function clearUserInputRequests(sessionId: string): void {
  for (const [id, pending] of pendingInputs) {
    if (pending.sessionId === sessionId) {
      pendingInputs.delete(id);
      const resolution = { behavior: 'deny' as const, reason: 'cancelled' as const, message: '会话已结束' };
      getBridgeContext().permissions.resolvePendingPermission(id, resolution);
      pending.interaction.resolve(resolution);
    }
  }
}
