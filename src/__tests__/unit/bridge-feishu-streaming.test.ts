import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context.js';
import type { BridgeStore } from '../../lib/bridge/host.js';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';
import { buildPermissionButtonCard, buildUserInputCard } from '../../lib/bridge/markdown/feishu.js';

type Request = { path?: Record<string, string>; data: Record<string, unknown> };
type Response = { code: number; data?: Record<string, string> };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function fixture(settings: Record<string, string> = {}) {
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({
    store: { getSetting: (key: string) => ({ bridge_feishu_stream_card_notify_on_complete: 'false', bridge_feishu_stream_card_throttle_ms: '0', ...settings })[key] ?? null } as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() }, permissions: { resolvePendingPermission: () => false }, lifecycle: {},
  });
  const calls: { method: string; request: Request }[] = [];
  const methods = Object.fromEntries(['create', 'update', 'settings', 'batchUpdate', 'content'].map((method) => [method, async (request: Request): Promise<Response> => {
    calls.push({ method, request });
    return { code: 0, data: { card_id: 'card-1', message_id: 'message-1' } };
  }]));
  const adapter = new FeishuAdapter();
  const internal = adapter as unknown as {
    restClient: unknown;
    createStreamingCard(chat: string): Promise<boolean>;
    activeCards: Map<string, { closing: boolean; operation: Promise<void> | null; throttleTimer: NodeJS.Timeout | null; cooldownUntil: number; sequence: number }>;
    handleCardAction(event: unknown): Promise<unknown>;
    queue: unknown[];
  };
  internal.restClient = { cardkit: { v1: { card: methods, cardElement: methods } }, im: { message: { create: methods.create, reply: methods.create } } };
  return { adapter, internal, methods, calls };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 270));

describe('飞书流式卡片协议', () => {
  it('等待正在发送的正文完成，进入收尾后不再调度旧内容', async () => {
    const { adapter, internal, methods, calls } = fixture();
    await internal.createStreamingCard('chat');
    calls.length = 0;
    const pending = deferred<Response>();
    methods.content = async (request: Request) => { calls.push({ method: 'content', request }); return pending.promise; };
    adapter.onStreamText('chat', '正文');
    await tick();
    const finishing = adapter.onStreamEnd('chat', 'completed', '正文完成');
    adapter.onStreamText('chat', '不应发送');
    await tick();
    assert.equal(internal.activeCards.get('chat')?.closing, true);
    assert.deepEqual(calls.map(c => c.method), ['content']);
    pending.resolve({ code: 0 });
    assert.equal(await finishing, true);
    await tick();
    assert.deepEqual(calls.map(c => c.method), ['content', 'update']);
    assert.deepEqual(calls.map(c => c.request.data.sequence), [1, 2]);
  });

  it('非零业务错误不能假成功，最终更新失败仍关闭流式并交还完整回答投递', async () => {
    const { adapter, internal, methods, calls } = fixture();
    await internal.createStreamingCard('chat');
    methods.update = async (request: Request) => { calls.push({ method: 'update', request }); return { code: 200860 }; };
    assert.equal(await adapter.onStreamEnd('chat', 'completed', '完整回答'), false);
    const close = calls.find(c => c.method === 'settings');
    assert.ok(close);
    const config = JSON.parse(String(close.request.data.settings)).config;
    assert.equal(config.streaming_mode, false);
    assert.match(config.summary.content, /完整回答/);
    assert.equal(calls.filter(c => c.method === 'content').length, 0);
  });

  it('工具、模型进度和追加通知不改变正文，重复快照不发请求', async () => {
    const { adapter, internal, calls } = fixture();
    await internal.createStreamingCard('chat');
    calls.length = 0;
    adapter.onStreamText('chat', 'A');
    await tick();
    adapter.onToolEvent('chat', [{ id: 't', name: 'Read', status: 'running' }]);
    adapter.onProgress('chat', '正在检查');
    adapter.notifyAppend('chat', 1, '追加');
    await tick();
    adapter.onStreamText('chat', 'AB');
    await tick();
    const count = calls.length;
    adapter.onStreamText('chat', 'AB');
    await tick();
    assert.equal(calls.length, count);
    assert.deepEqual(calls.filter(c => c.method === 'content').map(c => c.request.data.content), ['A', 'AB']);
    assert.ok(calls.some(c => c.method === 'batchUpdate'));
    const sequences = calls.map(c => Number(c.request.data.sequence));
    assert.ok(sequences.every((seq, i) => i === 0 || seq > sequences[i - 1]));
    await adapter.onStreamEnd('chat', 'completed', 'AB');
  });

  it('频控业务响应触发退避，收尾清理重试定时器', async () => {
    const { adapter, internal, methods } = fixture();
    await internal.createStreamingCard('chat');
    methods.content = async () => ({ code: 99991400 });
    adapter.onStreamText('chat', '最新正文');
    await tick();
    assert.ok((internal.activeCards.get('chat')?.cooldownUntil ?? 0) > Date.now());
    const state = internal.activeCards.get('chat');
    await adapter.onStreamEnd('chat', 'interrupted', '最新正文');
    assert.equal(state?.throttleTimer, null);
  });

  it('卡片回调要求有效的真实上下文及 allowlist', async () => {
    const { internal } = fixture({ bridge_feishu_allowed_users: 'allowed' });
    const event = { action: { value: { callback_data: 'perm:allow:p1' } }, context: { open_chat_id: 'chat', open_message_id: 'msg' }, operator: { open_id: 'denied' } };
    await internal.handleCardAction(event);
    assert.equal(internal.queue.length, 0);
    await internal.handleCardAction({ ...event, operator: { open_id: 'allowed' }, context: undefined });
    assert.equal(internal.queue.length, 0);
    await internal.handleCardAction({ ...event, operator: { open_id: 'allowed' } });
    assert.equal(internal.queue.length, 1);
  });

  it('问答表单以真实来源回传单选、多选和其他答案，拒绝畸形值', async () => {
    const { adapter, internal, calls } = fixture();
    const request = { requestId: 'request-1', questions: [
      { id: 'choice', question: '选哪项？', options: [{ label: 'A' }, { label: 'B' }], allowOther: true },
      { id: 'multi', question: '选择工具', options: [{ label: 'Read' }, { label: 'Bash' }], multiSelect: true },
      { id: 'free', question: '补充说明' },
    ] };
    const sent = await adapter.sendUserInputRequest({ channelType: 'feishu', chatId: 'chat' }, request);
    assert.equal(sent.ok, true);
    const card = JSON.parse(String(calls[0].request.data.content));
    assert.equal(card.schema, '2.0');
    const form = card.body.elements[0];
    assert.equal(form.tag, 'form');
    const button = form.elements.find((element: { tag: string }) => element.tag === 'button');
    assert.equal(button.form_action_type, 'submit');
    assert.equal(button.action_type, undefined);
    const event = { action: { value: button.behaviors[0].value, form_value: { q0: 'A', q0_other: 'C', q1: ['Read', 'Bash'], q2: '说明' } }, context: { open_chat_id: 'chat', open_message_id: 'original-message' }, operator: { open_id: 'user' } };
    await internal.handleCardAction(event);
    const message = internal.queue[0] as { callbackMessageId: string; userInputResponse: { requestId: string; answers: Record<string, string[]> } };
    assert.equal(message.callbackMessageId, 'original-message');
    assert.equal(message.userInputResponse.requestId, 'request-1');
    assert.deepEqual({ ...message.userInputResponse.answers }, { choice: ['C'], multi: ['Read', 'Bash'], free: ['说明'] });
    await internal.handleCardAction({ ...event, action: { ...event.action, form_value: { q0: { invalid: 'object' } } } });
    assert.equal(internal.queue.length, 1);
  });

  it('敏感问答不会发送到聊天，审批不硬编码错误有效期', async () => {
    const { adapter, calls } = fixture();
    const result = await adapter.sendUserInputRequest({ channelType: 'feishu', chatId: 'chat' }, { requestId: 'secret', questions: [{ id: 'secret', question: '输入密钥', isSecret: true }] });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(buildPermissionButtonCard('授权', 'p'), /5 minutes|5 分钟/);
    assert.match(buildUserInputCard({ requestId: 'r', questions: [{ id: 'free', question: '内容' }] }), /form_action_type/);
  });

  it('超长回答结束流式但返回 false，交由核心投递全部内容', async () => {
    const { adapter, internal, calls } = fixture();
    await internal.createStreamingCard('chat');
    const text = '汉'.repeat(12_000);
    assert.equal(await adapter.onStreamEnd('chat', 'completed', text), false);
    assert.equal(calls.filter(call => call.method === 'update').length, 0);
    assert.equal(calls.filter(call => call.method === 'settings').length, 1);
  });

  it('工作流更新与结束串行，失败请求也消耗序号', async () => {
    const { adapter, methods, calls } = fixture();
    assert.equal(await adapter.createWorkflowCard('chat', '{}'), 'card-1');
    calls.length = 0;
    const pending = deferred<Response>();
    methods.update = async (request: Request) => {
      calls.push({ method: 'update', request });
      return calls.length === 1 ? pending.promise : { code: 0 };
    };
    const updating = adapter.updateWorkflowCard('chat', 'running');
    await tick();
    const ending = adapter.finalizeWorkflowCard('chat', 'completed');
    assert.equal(await adapter.updateWorkflowCard('chat', 'obsolete'), false);
    await tick();
    assert.equal(calls.length, 1);
    pending.resolve({ code: 200860 });
    assert.equal(await updating, false);
    assert.equal(await ending, true);
    assert.deepEqual(calls.map(call => call.request.data.sequence), [1, 2]);
    assert.deepEqual(calls.map(call => (call.request.data.card as { data: string }).data), ['running', 'completed']);
  });
});
