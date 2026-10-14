import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context.js';
import type { BridgeStore, UserInputPhase, UserInputRequest } from '../../lib/bridge/host.js';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';
import { buildPermissionButtonCard, buildUserInputCard } from '../../lib/bridge/markdown/feishu.js';

type Request = { path?: Record<string, string>; data: Record<string, unknown> };
type Response = { code: number; data?: Record<string, string> };
type InputField = { name: unknown; maxLength: unknown };
function inputs(value: unknown): InputField[] {
  if (Array.isArray(value)) return value.flatMap(inputs);
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  return node.tag === 'input' ? [{ name: node.name, maxLength: node.max_length }] : Object.values(node).flatMap(inputs);
}
function assertInputRange(fields: InputField[]): void {
  assert.ok(fields.length > 0, '问答表单应包含输入框');
  for (const field of fields) {
    assert.ok(typeof field.maxLength === 'number' && Number.isInteger(field.maxLength)
      && field.maxLength >= 1 && field.maxLength <= 1_000, `${String(field.name)} max_length应在1…1000内`);
  }
}
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
  internal.restClient = { cardkit: { v1: { card: methods, cardElement: methods } }, im: { message: { create: methods.create, reply: methods.create, patch: methods.update } } };
  return { adapter, internal, methods, calls };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 270));

describe('飞书流式卡片协议', () => {
  it('原生问答的自由/其他输入满足飞书1…1000上限，pending发送与closed更新均成功', async () => {
    const { adapter, internal } = fixture();
    const received: Array<{ kind: string; fields: InputField[] }> = [];
    // 飞书 JSON 2.0 input 官方范围与真实11310收据的最小平台边界，不复制渲染逻辑。
    const platform = (kind: string) => async (request: Request) => {
      const fields = inputs(JSON.parse(String(request.data.content)));
      received.push({ kind, fields });
      try { assertInputRange(fields); }
      catch { return { code: 11310, msg: 'max_length exceed the default maximum 1000' }; }
      return { code: 0, data: { message_id: 'validated-card' } };
    };
    internal.restClient = { im: { message: { create: platform('create'), reply: platform('reply'), patch: platform('patch') } } };
    const request: UserInputRequest = { requestId: 'platform-input-limit', isBlocking: false, answerChannel: 'message', questions: [
      { id: 'choice', question: '报告格式', options: [{ label: '简短' }, { label: '详细' }], allowOther: true },
      { id: 'free', question: '验收标记' },
    ] };
    const address = { channelType: 'feishu', chatId: 'chat' };
    for (const replyTo of [undefined, 'original-user-message']) {
      const sent = await adapter.sendUserInputRequest(address, request, replyTo);
      assert.equal(sent.ok, true, '平台应接受pending原生问答卡的input范围');
      assert.equal(sent.messageId, 'validated-card');
    }
    await adapter.updateUserInputRequest(address, 'validated-card', request, 'closed');
    // 独立核对真实patch正文，不能仅凭void返回或字段名称推断closed格式有效。
    for (const outbound of received) assertInputRange(outbound.fields);
    const fields = [{ name: 'q0_other', maxLength: 1_000 }, { name: 'q1', maxLength: 1_000 }];
    assert.deepEqual(received, [
      { kind: 'create', fields },
      { kind: 'reply', fields },
      { kind: 'patch', fields },
    ]);
  });
  it('input合同负面自检能抓closed超限，adapter不会吞掉patch的11310拒绝', async () => {
    const { adapter, internal } = fixture();
    const request: UserInputRequest = { requestId: 'closed-limit-self-check', answerChannel: 'message', questions: [
      { id: 'choice', question: '报告格式', options: [{ label: '简短' }], allowOther: true }, { id: 'free', question: '验收标记' },
    ] };
    const closed = JSON.parse(buildUserInputCard(request, 'closed'));
    assertInputRange(inputs(closed));
    // 仅改变测试fixture，验证边界确实拒绝旧4000配置；不改生产制造RED。
    for (const name of ['q0_other', 'q1']) {
      const invalid = structuredClone(closed);
      const field = invalid.body.elements[0].elements.find((element: { name?: string }) => element.name === name);
      assert.ok(field);
      field.max_length = 4_000;
      assert.throws(() => assertInputRange(inputs(invalid)), /max_length应在1…1000内/);
    }
    internal.restClient = { im: { message: { patch: async () => ({ code: 11310, msg: 'max_length exceed the default maximum 1000' }) } } };
    await assert.rejects(adapter.updateUserInputRequest({ channelType: 'feishu', chatId: 'chat' }, 'closed-card', request, 'closed'), /FeishuError\(11310\)/);
  });
  it('原生消息题明确说明答案作为当前任务补充，选择与自由输入仍在同卡', () => {
    const content = buildUserInputCard({ requestId: 'native-card', isBlocking: false, answerChannel: 'message', questions: [
      { id: 'q0', question: '选择', options: [{ label: 'A' }], allowOther: true }, { id: 'q1', question: '标记' },
    ] });
    assert.match(content, /回答会作为当前任务补充/);
    const form = JSON.parse(content).body.elements[0];
    assert.ok(form.elements.some((e: { tag: string }) => e.tag === 'select_static'));
    assert.ok(form.elements.some((e: { name: string }) => e.name === 'q0_other'));
    assert.ok(form.elements.some((e: { name: string }) => e.name === 'q1'));
  });
  it('非阻塞问题说明继续工作，closed 保留原生表单并显式补充，终态移除入口', async () => {
    const { adapter, internal, calls } = fixture();
    const request = { requestId: 'async-form', isBlocking: false, questions: [
      { id: 'choice', question: '原选择', options: [{ label: 'A' }] }, { id: 'free', question: '原输入' },
    ] };
    assert.match(buildUserInputCard(request), /继续工作/);
    assert.match(buildUserInputCard({ ...request, isBlocking: true }), /等待/);
    for (const phase of ['closed', 'answered', 'supplemented', 'expired', 'cancelled', 'failed'] as UserInputPhase[]) {
      await adapter.updateUserInputRequest!({ channelType: 'feishu', chatId: 'chat' }, 'original-card', request, phase);
      const card = JSON.parse(String(calls.at(-1)!.request.data.content));
      const form = card.body?.elements.find((element: { tag: string }) => element.tag === 'form');
      if (phase !== 'closed') { assert.equal(form, undefined); continue; }
      assert.ok(form.elements.some((e: { tag: string }) => e.tag === 'select_static'));
      assert.ok(form.elements.some((e: { tag: string }) => e.tag === 'input'));
      const button = form.elements.find((e: { tag: string }) => e.tag === 'button');
      assert.equal(button.text.content, '作为任务补充发送');
      await internal.handleCardAction({ action: { value: { ...button.behaviors[0].value, chatId: 'forged', sessionId: 'forged', question: 'forged' }, form_value: { q0: 'A', q1: '答案' } }, context: { open_chat_id: 'chat', open_message_id: 'original-card' }, operator: { open_id: 'user' } });
      const message = internal.queue[0] as { address: { chatId: string }; callbackMessageId: string; userInputResponse?: unknown; userInputSupplementResponse: { requestId: string; answers: Record<string, string[]> } };
      assert.equal(message.address.chatId, 'chat'); assert.equal(message.callbackMessageId, 'original-card');
      assert.equal(message.userInputResponse, undefined);
      assert.deepEqual({ ...message.userInputSupplementResponse.answers }, { choice: ['A'], free: ['答案'] });
    }
  });
  it('等待正在发送的正文完成，进入收尾后不再调度旧内容', async () => {
    const { adapter, internal, methods, calls } = fixture();
    await internal.createStreamingCard('chat');
    calls.length = 0;
    const pending = deferred<Response>();
    methods.batchUpdate = async (request: Request) => { calls.push({ method: 'batchUpdate', request }); return pending.promise; };
    let finishing: Promise<boolean> | undefined;
    try {
      adapter.onStreamText('chat', '正文');
      await tick();
      finishing = adapter.onStreamEnd('chat', 'completed', '正文完成');
      adapter.onStreamText('chat', '不应发送');
      await tick();
      assert.equal(internal.activeCards.get('chat')?.closing, true);
      assert.deepEqual(calls.map(c => c.method), ['batchUpdate']);
      pending.resolve({ code: 0 });
      assert.equal(await finishing, true);
      await tick();
      assert.deepEqual(calls.map(c => c.method), ['batchUpdate', 'batchUpdate', 'batchUpdate']);
      assert.deepEqual(JSON.parse(String(calls[2].request.data.actions)), [{ action: 'delete_elements', params: { element_ids: ['progress_history'] } }]);
      assert.deepEqual(calls.map(c => c.request.data.sequence), [1, 2, 3]);
    } finally {
      // 旧协议的预期RED也必须释放fixture，不能把悬挂promise算成功取证。
      pending.resolve({ code: 0 });
      if (finishing) await finishing;
      adapter.onMessageEnd('chat');
    }
  });

  it('非零业务错误不能假成功，最终失败交还完整投递，普通卡无需关闭流式', async () => {
    const { adapter, internal, methods, calls } = fixture();
    await internal.createStreamingCard('chat');
    methods.batchUpdate = async (request: Request) => { calls.push({ method: 'batchUpdate', request }); return { code: 200860 }; };
    assert.equal(await adapter.onStreamEnd('chat', 'completed', '完整回答'), false);
    const create = calls.find(c => c.method === 'create' && c.request.data.type === 'card_json')!;
    assert.equal(JSON.parse(String(create.request.data.data)).config.streaming_mode, false);
    assert.equal(calls.filter(c => c.method === 'settings').length, 0);
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
    const bodyWrites = calls.filter(c => c.method === 'batchUpdate').flatMap(c => JSON.parse(String(c.request.data.actions)))
      .filter((action: { params: { element_id: string } }) => action.params.element_id === 'streaming_content')
      .map((action: { params: { partial_element: { content: string } } }) => action.params.partial_element.content);
    assert.deepEqual(bodyWrites, ['A', 'AB']);
    assert.equal(calls.some(c => c.method === 'content' || c.method === 'settings'), false);
    assert.ok(calls.some(c => c.method === 'batchUpdate'));
    const sequences = calls.map(c => Number(c.request.data.sequence));
    assert.ok(sequences.every((seq, i) => i === 0 || seq > sequences[i - 1]));
    await adapter.onStreamEnd('chat', 'completed', 'AB');
  });

  it('频控业务响应触发退避，收尾清理重试定时器', async () => {
    const { adapter, internal, methods } = fixture();
    await internal.createStreamingCard('chat');
    methods.batchUpdate = async () => ({ code: 99991400 });
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

  it('任意问题 ID 在补充表单真实回调中保留为自有答案字段', async () => {
    const { internal } = fixture();
    const request = { requestId: 'prototype-form', questions: [{ id: '__proto__', question: '原题' }, { id: 'constructor', question: '另一原题' }] };
    const card = JSON.parse(buildUserInputCard(request, 'closed'));
    const button = card.body.elements[0].elements.find((e: { tag: string }) => e.tag === 'button');
    await internal.handleCardAction({ action: { value: button.behaviors[0].value, form_value: { q0: '内容', q1: '要求' } }, context: { open_chat_id: 'chat', open_message_id: 'original-message' }, operator: { open_id: 'user' } });
    const message = internal.queue[0] as { userInputSupplementResponse: { answers: Record<string, string[]> } };
    assert.deepEqual(Object.keys(message.userInputSupplementResponse.answers), ['__proto__', 'constructor']);
    assert.equal(Object.hasOwn(message.userInputSupplementResponse.answers, '__proto__'), true);
    assert.deepEqual(message.userInputSupplementResponse.answers.__proto__, ['内容']);
    assert.deepEqual(message.userInputSupplementResponse.answers.constructor, ['要求']);
  });

  it('超长回答返回 false交由核心完整投递，不写配置收尾', async () => {
    const { adapter, internal, calls } = fixture();
    await internal.createStreamingCard('chat');
    const text = '汉'.repeat(12_000);
    assert.equal(await adapter.onStreamEnd('chat', 'completed', text), false);
    assert.equal(calls.filter(call => call.method === 'update').length, 0);
    assert.equal(calls.filter(call => call.method === 'settings' || call.method === 'content').length, 0);
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
