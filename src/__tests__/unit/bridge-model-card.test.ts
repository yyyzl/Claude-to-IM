import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { initBridgeContext } from '../../lib/bridge/context.js';
import type { BridgeStore } from '../../lib/bridge/host.js';
import type { InboundMessage, ModelCatalogEntry, ModelSelectionResponse, ModelSelectionView } from '../../lib/bridge/types.js';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';
import { buildModelSelectionCard, MODEL_DEFAULT_EFFORT_OPTION } from '../../lib/bridge/markdown/feishu.js';

const blocked = () => { throw new Error('测试禁止真实网络和子进程'); };
mock.method(net.Socket.prototype, 'connect', blocked);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const) mock.method(childProcess, name, blocked);
mock.method(globalThis, 'fetch', blocked);
syncBuiltinESMExports();

const address = { channelType: 'feishu' as const, chatId: 'real-chat', userId: 'real-user' };
const entry = (model = 'model-a', fast = true): ModelCatalogEntry => ({
  id: `catalog-${model}`, model, displayName: `显示名 ${model}`, isDefault: true,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '均衡' }, { reasoningEffort: 'high', description: '复杂问题' }],
  serviceTiers: fast ? [{ id: 'fast', name: 'Fast', description: '更快' }] : [], defaultServiceTier: 'default',
});
const view = (overrides: Partial<ModelSelectionView> = {}): ModelSelectionView => ({
  requestId: 'draft-1', revision: 2, step: 'model', summary: '当前偏好：跟随默认；运行时速度未指定',
  models: [entry()], page: 0, pageCount: 2, selectedModel: 'default', selectedModelEntry: entry(), reasoningEffort: '', speed: 'normal',
  ...overrides,
});
interface Element {
  tag: string;
  name?: string;
  content?: string;
  initial_option?: string;
  required?: boolean;
  form_action_type?: string;
  text?: { content: string };
  options?: Array<{ value: string; text: { content: string } }>;
  elements?: Element[];
  behaviors?: Array<{ value: Record<string, unknown> }>;
}
function cardElements(cardView: ModelSelectionView) {
  const card = JSON.parse(buildModelSelectionCard(cardView)) as { schema: string; body: { elements: Element[] } };
  assert.equal(card.schema, '2.0');
  return card.body.elements.flatMap(element => [element, ...(element.elements ?? [])]);
}
const select = (elements: Element[], name: string) => elements.find(element => element.tag === 'select_static' && element.name === name)!;
interface RestRequest { data: { content: string; receive_id?: string; msg_type?: string }; path?: { message_id: string } }
interface RestResponse { code?: number; msg?: string; data?: { message_id?: string } }
function fixture() {
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({ store: { getSetting: () => null, insertAuditLog() {} } as unknown as BridgeStore, permissions: { resolvePendingPermission: () => false }, llm: { streamChat: blocked }, lifecycle: {} });
  const calls: Array<{ kind: string; request: RestRequest }> = [];
  let response: RestResponse = { code: 0, data: { message_id: 'sent-card' } };
  const call = (kind: string) => async (request: RestRequest) => { calls.push({ kind, request }); return response; };
  const client = { im: { message: { create: call('create'), reply: call('reply'), patch: call('patch') } } };
  const adapter = new FeishuAdapter();
  const internal = adapter as unknown as { restClient: unknown; queue: InboundMessage[]; isAuthorized: (userId: string, chatId: string) => boolean; handleCardAction: (data: unknown) => Promise<{ toast: { type: string; content: string } }> };
  internal.restClient = client;
  internal.isAuthorized = (userId, chatId) => userId === address.userId && chatId === address.chatId;
  return { adapter, internal, calls, respond: (next: RestResponse) => { response = next; } };
}
function event(action: ModelSelectionResponse['action'], form?: unknown) {
  return {
    operator: { open_id: address.userId }, context: { open_chat_id: address.chatId, open_message_id: 'real-card' },
    action: { value: { model_selection_request_id: 'draft-1', model_selection_revision: 2, model_selection_action: action, chatId: 'forged-chat', userId: 'forged-user', messageId: 'forged-card' }, form_value: form },
  };
}

test('模型页使用原生单选表单，默认项合法并携带独立回调版本', () => {
  const elements = cardElements(view());
  const model = select(elements, 'model');
  assert.equal(model.initial_option, 'default');
  assert.deepEqual(model.options?.map(option => option.value), ['default', 'catalog-model-a']);
  const next = elements.find(element => element.name === 'model_next')!;
  assert.equal(next.form_action_type, 'submit');
  assert.deepEqual(next.behaviors?.[0].value, { model_selection_request_id: 'draft-1', model_selection_revision: 2, model_selection_action: 'next' });
  assert.ok(elements.some(element => element.name === 'model_next_page'));
  assert.ok(!elements.some(element => element.name === 'model_previous_page'));
  for (const name of ['model_refresh', 'model_cancel']) assert.ok(elements.some(element => element.name === name));
  assert.match(buildModelSelectionCard(view()), /当前聊天生效，\/new 后保留/);
  assert.match(buildModelSelectionCard(view()), /运行时速度未指定/);
});

test('翻页保留页外已选目录 ID，展示型号与回传 ID 分离', () => {
  const elements = cardElements(view({ page: 1, selectedModel: 'catalog-model-b', selectedModelEntry: entry('model-b') }));
  const model = select(elements, 'model');
  assert.equal(model.initial_option, 'catalog-model-b');
  assert.ok(model.options?.some(option => option.value === 'catalog-model-b' && option.text.content.includes('model-b')));
  assert.ok(!model.options?.some(option => option.value === 'model-b'));
  assert.ok(elements.some(element => element.name === 'model_previous_page'));
  assert.ok(!elements.some(element => element.name === 'model_next_page'));
});

test('同实际型号的不同目录 ID 不合并，两个目录选项都能选择', () => {
  const models = [entry(), { ...entry(), id: 'second-catalog-id' }];
  const model = select(cardElements(view({ models, selectedModel: 'second-catalog-id' })), 'model');
  assert.deepEqual(model.options?.map(option => option.value), ['default', 'catalog-model-a', 'second-catalog-id']);
  assert.equal(model.initial_option, 'second-catalog-id');
});

test('强度和速度页只含目录选项，跟随默认使用有效初始值', () => {
  const elements = cardElements(view({ step: 'settings', speed: 'fast' }));
  const effort = select(elements, 'reasoning_effort');
  assert.deepEqual(effort.options?.map(option => option.value), [MODEL_DEFAULT_EFFORT_OPTION, 'medium', 'high']);
  assert.equal(effort.initial_option, MODEL_DEFAULT_EFFORT_OPTION);
  assert.equal(select(elements, 'speed').initial_option, 'fast');
  assert.equal(elements.find(element => element.name === 'model_apply')?.form_action_type, 'submit');
  assert.match(buildModelSelectionCard(view({ step: 'settings' })), /Fast 会消耗更多用量/);
});

test('失效强度和不支持 Fast 的旧偏好不注入非法初始值或静默降档', () => {
  const state = view({ step: 'settings', selectedModelEntry: entry('model-b', false), reasoningEffort: 'xhigh', speed: 'fast' });
  const elements = cardElements(state);
  assert.equal(select(elements, 'reasoning_effort').initial_option, undefined);
  assert.equal(select(elements, 'speed').initial_option, undefined);
  assert.deepEqual(select(elements, 'speed').options?.map(option => option.value), ['normal']);
  assert.match(buildModelSelectionCard(state), /请重新选择后再应用/);
  assert.throws(() => buildModelSelectionCard(view({ step: 'settings', selectedModelEntry: undefined })), /不在目录/);
});

test('终态卡片保留结果但去掉表单和全部回调按钮', () => {
  for (const step of ['applied', 'cancelled', 'expired'] as const) {
    const elements = cardElements(view({ step, notice: '最终结果' }));
    assert.ok(elements.some(element => element.content === '最终结果'));
    assert.ok(elements.every(element => element.tag !== 'form' && element.tag !== 'button' && !element.behaviors));
  }
});

test('模型回调只使用真实 operator/context 并快速入队，不触发 REST', async () => {
  const f = fixture();
  const modelId = select(cardElements(view()), 'model').options![1].value;
  const result = await f.internal.handleCardAction(event('next', { model: modelId }));
  assert.equal(result.toast.type, 'info');
  assert.equal(f.calls.length, 0);
  assert.equal(f.internal.queue.length, 1);
  const message = f.internal.queue[0];
  assert.deepEqual(message.address, address);
  assert.equal(message.callbackMessageId, 'real-card');
  assert.deepEqual(message.modelSelectionResponse, { requestId: 'draft-1', revision: 2, action: 'next', model: 'catalog-model-a' });
  assert.equal(message.userInputResponse, undefined);
  assert.equal(message.callbackData, undefined);
});

test('应用表单将飞书默认哨兵转换为核心跟随值，普通速度明确回传', async () => {
  const f = fixture();
  await f.internal.handleCardAction(event('apply', { reasoning_effort: MODEL_DEFAULT_EFFORT_OPTION, speed: 'normal', model: 'forged' }));
  assert.deepEqual(f.internal.queue[0].modelSelectionResponse, { requestId: 'draft-1', revision: 2, action: 'apply', reasoningEffort: '', speed: 'normal' });
});

test('刷新、分页、返回、取消不需要表单，不等待目录服务', async () => {
  const f = fixture();
  for (const action of ['refresh', 'previous_page', 'next_page', 'back', 'cancel'] as const) {
    assert.equal((await f.internal.handleCardAction(event(action))).toast.type, 'info');
  }
  assert.deepEqual(f.internal.queue.map(message => message.modelSelectionResponse?.action), ['refresh', 'previous_page', 'next_page', 'back', 'cancel']);
  assert.equal(f.calls.length, 0);
});

test('畸形模型回调拒绝入队，不退回权限回调分支', async () => {
  const f = fixture();
  const invalid: unknown[] = [
    event('next', { model: ['model-a'] }), event('next', {}), event('next', { model: 'x'.repeat(30_001) }),
    event('apply', { reasoning_effort: ['high'], speed: 'fast' }), event('apply', { reasoning_effort: 'high', speed: 'inherited' }),
    event('apply', { reasoning_effort: '', speed: 'normal' }), event('apply', undefined),
    ...[
      { model_selection_request_id: '' }, { model_selection_revision: '2' }, { model_selection_revision: -1 },
      { model_selection_revision: 1.5 }, { model_selection_action: 'allow' },
    ].map(patch => { const data = event('cancel'); return { ...data, action: { value: { ...data.action.value, ...patch, callback_data: 'perm:allow:forged' } } }; }),
  ];
  for (const data of invalid) assert.equal((await f.internal.handleCardAction(data)).toast.type, 'error');
  assert.equal(f.internal.queue.length, 0);
  assert.equal(f.calls.length, 0);
});

test('来源缺失或未授权不能借按钮 value 伪造聊天或操作者', async () => {
  const f = fixture(); const data = event('cancel');
  for (const invalid of [
    { ...data, context: undefined }, { ...data, operator: undefined },
    { ...data, context: { open_chat_id: 'other', open_message_id: 'real-card' } },
    { ...data, operator: { open_id: 'other' } }, { ...data, context: { open_chat_id: address.chatId } },
  ]) assert.equal((await f.internal.handleCardAction(invalid)).toast.type, 'error');
  assert.equal(f.internal.queue.length, 0);
});

test('既有问答表单和权限按钮继续走各自独立事件', async () => {
  const f = fixture(); const data = event('cancel');
  await f.internal.handleCardAction({ ...data, action: { value: { user_input_request_id: 'question', fields: { q0: 'question-id' } }, form_value: { q0: 'answer' } } });
  await f.internal.handleCardAction({ ...data, action: { value: { callback_data: 'perm:allow:permission' } } });
  assert.equal(f.internal.queue[0].userInputResponse?.requestId, 'question');
  assert.deepEqual(f.internal.queue[0].userInputResponse?.answers['question-id'], ['answer']);
  assert.equal(f.internal.queue[1].callbackData, 'perm:allow:permission');
  assert.ok(f.internal.queue.every(message => message.modelSelectionResponse === undefined));
});

test('发送、回复和更新模型卡走正确原消息，patch 成功沿用既有 ID', async () => {
  const f = fixture();
  assert.deepEqual(await f.adapter.sendModelSelection(address, view()), { ok: true, messageId: 'sent-card' });
  assert.deepEqual(await f.adapter.sendModelSelection(address, view(), 'user-message'), { ok: true, messageId: 'sent-card' });
  f.respond({ code: 0 });
  assert.deepEqual(await f.adapter.updateModelSelection(address, 'original-card', view({ step: 'applied' })), { ok: true, messageId: 'original-card' });
  assert.deepEqual(f.calls.map(call => call.kind), ['create', 'reply', 'patch']);
  assert.equal(f.calls[0].request.data.receive_id, address.chatId);
  assert.equal(f.calls[1].request.path?.message_id, 'user-message');
  assert.equal(f.calls[2].request.path?.message_id, 'original-card');
});

test('发送和 patch 均检查飞书业务错误，缺少有效消息 ID 不宣称发送成功', async () => {
  const f = fixture(); f.respond({ code: 230001, msg: 'bad card', data: { message_id: 'misleading' } });
  for (const result of [await f.adapter.sendModelSelection(address, view()), await f.adapter.sendModelSelection(address, view(), 'reply'), await f.adapter.updateModelSelection(address, 'original', view())]) {
    assert.equal(result.ok, false); assert.match(result.error ?? '', /230001/);
  }
  for (const id of [undefined, '', ' ']) {
    f.respond({ code: 0, data: { message_id: id } });
    assert.equal((await f.adapter.sendModelSelection(address, view())).ok, false);
    assert.equal((await f.adapter.sendModelSelection(address, view(), 'reply')).ok, false);
  }
  const count = f.calls.length;
  assert.equal((await f.adapter.updateModelSelection(address, '', view())).ok, false);
  assert.equal(f.calls.length, count);
});

test('预算计算外层 JSON 转义后的真实字节，超限在调用 REST 前拒绝', async () => {
  const f = fixture(); const oversized = view({ summary: '"'.repeat(8_000) });
  assert.ok(Buffer.byteLength(buildModelSelectionCard(oversized), 'utf8') < 30_000);
  for (const result of [await f.adapter.sendModelSelection(address, oversized), await f.adapter.sendModelSelection(address, oversized, 'reply'), await f.adapter.updateModelSelection(address, 'original', oversized)]) {
    assert.equal(result.ok, false); assert.equal(result.httpStatus, 413);
  }
  assert.equal(f.calls.length, 0);
});
