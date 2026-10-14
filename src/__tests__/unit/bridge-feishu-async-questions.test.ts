import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import childProcess from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { initBridgeContext, getBridgeContext } from '../../lib/bridge/context.js';
import type { BridgeSession, BridgeStore } from '../../lib/bridge/host.js';
import type { ChannelBinding, InboundMessage, OutboundMessage } from '../../lib/bridge/types.js';
import { FakeClient } from './codex-test-transport.js';
import { ChatRateLimiter } from '../../lib/bridge/security/rate-limiter.js';
import { CodexAppServerLLMProvider } from '../../../scripts/claude-to-im-bridge/codex-llm.ts';
import { InMemoryPermissionGateway } from '../../../scripts/claude-to-im-bridge/permissions.ts';

const blocked = () => { throw new Error('禁止真实子进程和网络'); };
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) mock.method(childProcess, key, blocked);
mock.method(net.Socket.prototype, 'connect', blocked);
mock.method(globalThis, 'fetch', blocked);
syncBuiltinESMExports();
// 每个 fixture 使用相同假 chat；业务用例不等待进程级真实一分钟限流窗口。
mock.method(ChatRateLimiter.prototype, 'acquire', async () => {});
const manager = await import('../../lib/bridge/bridge-manager.js');
const { FeishuAdapter } = await import('../../lib/bridge/adapters/feishu-adapter.js');

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
async function until(predicate: () => boolean) { for (let i = 0; i < 100 && !predicate(); i++) await delay(5); assert.ok(predicate(), '内存链路应在 500ms 内达到预期状态'); }
const targetSession = 'a'.repeat(32);
type PlatformRequest = { path?: Record<string, string>; data: Record<string, unknown> };
type PlatformResponse = { code: number; data: Record<string, string> };

function fixture(settingsOverride: Record<string, string> = {}) {
  delete (globalThis as Record<string, unknown>).__bridge_manager__;
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  const settings: Record<string, string> = {
    remote_bridge_enabled: 'true', bridge_llm_backend: 'codex', bridge_input_debounce_ms: '0',
    bridge_feishu_allowed_users: 'owner,other', bridge_feishu_stream_card_notify_on_complete: 'false',
    bridge_feishu_stream_card_throttle_ms: '0', ...settingsOverride,
  };
  const sessions = new Map<string, BridgeSession>([['session', { id: 'session', working_directory: '', model: '' }], [targetSession, { id: targetSession, working_directory: '', model: '' }]]);
  const bindings = new Map<string, ChannelBinding>([['chat', {
    id: 'binding', channelType: 'feishu', chatId: 'chat', codepilotSessionId: 'session', sdkSessionId: '',
    model: '', backend: 'codex', workingDirectory: '', mode: 'code', active: true, createdAt: '', updatedAt: '',
  }]]);
  const records: Array<{ session: string; role: string; text: string }> = [];
  const audit: string[] = [];
  const locks = new Set<string>();
  const noop = () => {};
  const store: BridgeStore = {
    getSetting: key => settings[key] ?? null,
    getChannelBinding: (_type, chat) => bindings.has(chat) ? { ...bindings.get(chat)! } : null,
    upsertChannelBinding: data => { const next: ChannelBinding = { ...bindings.get('chat')!, ...data, id: `binding-${data.chatId}`, mode: data.mode === 'ask' || data.mode === 'plan' ? data.mode : 'code' }; bindings.set(data.chatId, next); return next; },
    updateChannelBinding: (id, changes) => { for (const [chat, row] of bindings) if (row.id === id) bindings.set(chat, { ...row, ...changes }); },
    listChannelBindings: () => [...bindings.values()], getSession: id => sessions.get(id) ?? null,
    createSession: (_title, model, _system, cwd) => { const row = { id: `session-${sessions.size}`, model, working_directory: cwd ?? '' }; sessions.set(row.id, row); return row; },
    updateSessionProviderId: noop, addMessage: (session, role, text) => { records.push({ session, role, text }); },
    getMessages: session => ({ messages: records.filter(row => row.session === session).map((row, index) => ({ id: String(index), role: row.role, content: row.text, created_at: '' })) }),
    acquireSessionLock: session => { if (locks.has(session)) return false; locks.add(session); return true; }, renewSessionLock: noop, releaseSessionLock: session => { locks.delete(session); },
    setSessionRuntimeStatus: noop, updateSdkSessionId: noop, updateSessionModel: noop, syncSdkTasks: noop,
    getProvider: () => undefined, getDefaultProviderId: () => null,
    insertAuditLog: entry => { audit.push(entry.summary); }, checkDedup: () => false, insertDedup: noop, cleanupExpiredDedup: noop, insertOutboundRef: noop,
    insertPermissionLink: noop, getPermissionLink: () => null, markPermissionLinkResolved: () => false, listPendingPermissionLinksByChat: () => [], getChannelOffset: () => '0', setChannelOffset: noop,
  };
  const client: Omit<FakeClient, 'request'> & { request(method: string, params?: Record<string, unknown>): Promise<unknown> } = new FakeClient(); client.onTurn = () => {};
  const turns: Array<{ threadId: string; turnId: string; input: unknown }> = [];
  let threadSerial = 0;
  const baseRequest = client.request.bind(client);
  client.request = async (method, params = {}) => {
    if (method === 'thread/start' || method === 'thread/resume') {
      client.running = true; client.calls.push({ method, params });
      return { thread: { id: method === 'thread/resume' ? params.threadId : ++threadSerial === 1 ? 'thread' : `thread-${threadSerial}` } };
    }
    if (method === 'turn/start') {
      client.calls.push({ method, params });
      const turnId = turns.length === 0 ? 'turn' : `turn-${turns.length + 1}`;
      turns.push({ threadId: String(params.threadId), turnId, input: params.input }); client.onTurn(params);
      return { turn: { id: turnId } };
    }
    return baseRequest(method, params);
  };
  const permissions = new InMemoryPermissionGateway();
  const provider = new CodexAppServerLLMProvider({ projectRoot: process.cwd(), client, permissions, keepAliveMs: 0, turnTimeoutMs: 4000 });
  assert.equal((provider as unknown as { client: unknown }).client, client);
  initBridgeContext({ store, llm: provider, permissions, lifecycle: {} }); assert.equal(getBridgeContext().llm, provider);
  const calls: Array<{ kind: string; request: PlatformRequest }> = [];
  let platformSerial = 0;
  const call = (kind: string) => async (request: PlatformRequest): Promise<PlatformResponse> => { calls.push({ kind, request }); const id = String(++platformSerial); return { code: 0, data: { card_id: `card-${id}`, message_id: `message-${id}`, reaction_id: `reaction-${id}` } }; };
  const transport = { cardkit: { v1: { card: { create: call('card.create'), update: call('card.update'), settings: call('card.settings'), batchUpdate: call('batch') }, cardElement: { content: call('content') } } }, im: { message: { create: call('message.create'), reply: call('reply'), patch: call('patch') }, messageReaction: { create: call('reaction.create'), delete: call('reaction.delete') } } };
  const adapter = new FeishuAdapter();
  const internal = adapter as unknown as { restClient: unknown; running: boolean; enqueue(msg: InboundMessage): void; lastIncomingMessageId: Map<string, string>; activeCards: Map<string, { appendNotice: string | null }>; handleIncomingEvent(event: unknown): Promise<void> };
  internal.restClient = transport; assert.equal(internal.restClient, transport);
  const enqueue = internal.enqueue.bind(internal); let callbackSerial = 1000;
  internal.enqueue = msg => { if (msg.callbackMessageId && msg.updateId == null) msg.updateId = ++callbackSerial; enqueue(msg); };
  adapter.start = async () => { internal.running = true; };
  adapter.validateConfig = () => null;
  let inputSerial = 0;
  const acked: number[] = []; adapter.acknowledgeUpdate = id => { acked.push(id); };
  const consumed: InboundMessage[] = []; const consume = adapter.consumeOne.bind(adapter);
  adapter.consumeOne = async () => { const msg = await consume(); if (msg) consumed.push(msg); return msg; };
  function push(text: string, owner = 'owner', attachments?: InboundMessage['attachments'], chatId = 'chat') {
    const msg: InboundMessage = { address: { channelType: 'feishu', chatId, userId: owner }, messageId: `input-${++inputSerial}`, updateId: inputSerial, text, attachments, timestamp: Date.now() };
    internal.lastIncomingMessageId.set(chatId, msg.messageId); internal.enqueue(msg); return msg;
  }
  function complete(text = '覆盖补充的最终答复', index = 0) { const turn = turns[index]; client.publish('item/completed', { threadId: turn.threadId, turnId: turn.turnId, item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text } }); client.publish('turn/completed', { threadId: turn.threadId, turnId: turn.turnId, turn: { id: turn.turnId, status: 'completed' } }); }
  async function launch() { internal.restClient = transport; manager.registerAdapter(adapter); await manager.start(); }
  async function cleanup() { await manager.stop(); provider.stop(); }
  return { client, provider, permissions, adapter, internal, transport, calls, records, audit, acked, consumed, locks, store, settings, turns, push, complete, launch, cleanup, binding: () => bindings.get('chat')! };
}

async function ask(f: ReturnType<typeof fixture>) {
  const turn = f.turns[0];
  f.client.emitter.emit('request', { id: 'raw-q', method: 'item/tool/requestUserInput', params: {
    threadId: turn.threadId, turnId: turn.turnId, itemId: 'input', isBlocking: false,
    questions: [{ id: 'choice', header: '选择', question: '保留哪个目录？', options: [{ label: 'A', description: '选项A' }], isOther: true }, { id: 'free', header: '说明', question: '还有什么要求？', options: null }],
  } });
  await until(() => f.calls.some(row => String(row.request.data.content).includes('user_input_request_id')));
  const row = f.calls.find(row => String(row.request.data.content).includes('user_input_request_id'))!;
  const card = JSON.parse(String(row.request.data.content));
  const button = card.body.elements[0].elements.find((e: { tag: string }) => e.tag === 'button');
  return { value: button.behaviors[0].value as Record<string, unknown>, messageId: `message-${f.calls.indexOf(row) + 1}` };
}
async function submit(f: ReturnType<typeof fixture>, question: Awaited<ReturnType<typeof ask>>, supplement = false, owner = 'owner', chat = 'chat', cardId = question.messageId, freeAnswer = '排除隐藏目录') {
  const value = { ...question.value };
  if (supplement) { value.user_input_supplement_request_id = value.user_input_request_id; delete value.user_input_request_id; }
  const internal = f.adapter as unknown as { handleCardAction(event: unknown): Promise<unknown> };
  return internal.handleCardAction({ action: { value, form_value: { q0: 'A', q1: freeAnswer } }, context: { open_chat_id: chat, open_message_id: cardId }, operator: { open_id: owner } });
}
function close(f: ReturnType<typeof fixture>) { f.client.publish('serverRequest/resolved', { threadId: f.turns[0].threadId, requestId: 'raw-q' }); }

async function askNative(f: ReturnType<typeof fixture>) {
  const turn = f.turns[0];
  // 合法合成app-server通知，字段映射真实内部async事件；不冒充wire抓包。
  const item = { type: 'agentMessage', id: 'native-live-item', phase: 'final_answer', delivery: 'async', text: '原生测试题', questions: [
    { title: '保留哪个目录？', options: ['A', 'B'] }, { title: '还有什么要求？', options: null },
  ] };
  f.client.publish('item/started', { threadId: turn.threadId, turnId: turn.turnId, item });
  f.client.publish('item/completed', { threadId: turn.threadId, turnId: turn.turnId, item });
  await until(() => f.calls.some(row => String(row.request.data.content).includes('user_input_request_id')));
  const row = f.calls.find(row => String(row.request.data.content).includes('user_input_request_id'))!;
  const card = JSON.parse(String(row.request.data.content)); const button = card.body.elements[0].elements.find((e: { tag: string }) => e.tag === 'button');
  return { value: button.behaviors[0].value as Record<string, unknown>, messageId: `message-${f.calls.indexOf(row) + 1}` };
}

test('原生两题有效答案携原题即时追加一次，无权限请求/RPC回复或新过程卡', async () => {
  const f = fixture(); const request = f.client.request.bind(f.client); let observes = 0; let resolves = 0;
  const observe = f.permissions.onResolution.bind(f.permissions); const resolve = f.permissions.resolvePendingPermission.bind(f.permissions);
  f.permissions.onResolution = (...args) => { observes++; return observe(...args); };
  f.permissions.resolvePendingPermission = (...args) => { resolves++; return resolve(...args); };
  f.client.request = async (method, params) => { if (method !== 'turn/steer') return request(method, params); f.client.calls.push({ method, params: params ?? {} }); return { turnId: params?.expectedTurnId }; };
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await askNative(f);
    assert.equal(observes, 0); await submit(f, q); await until(() => f.client.calls.some(r => r.method === 'turn/steer'));
    await submit(f, q); await until(() => f.consumed.length === 3);
    assert.equal(f.client.calls.filter(r => r.method === 'turn/steer').length, 1);
    const steer = f.client.calls.find(r => r.method === 'turn/steer')!.params;
    assert.equal(steer.threadId, f.turns[0].threadId); assert.equal(steer.expectedTurnId, f.turns[0].turnId);
    assert.match(JSON.stringify(steer.input), /保留哪个目录/); assert.match(JSON.stringify(steer.input), /排除隐藏目录/);
    assert.equal(f.turns.length, 1); assert.equal(f.calls.filter(r => r.kind === 'card.create').length, 1);
    assert.deepEqual(f.client.replies, []); assert.equal(resolves, 0);
    f.complete(); await until(() => f.locks.size === 0); assert.equal(f.acked.filter(id => id === 1001).length, 1);
    assert.equal(f.records.some(r => r.role === 'assistant' && r.text.includes('原生测试题')), false);
  } finally { await f.cleanup(); }
});

test('原生题正常完成转closed，旧提交拒绝而显式补充仅开一次后轮', async () => {
  const f = fixture();
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await askNative(f);
    f.complete(); await until(() => f.locks.size === 0);
    assert.ok(f.calls.some(r => r.kind === 'patch' && String(r.request.data.content).includes('作为任务补充发送')));
    await submit(f, q); await until(() => f.acked.includes(1001)); assert.equal(f.turns.length, 1);
    await submit(f, q, true); await until(() => f.turns.length === 2); await submit(f, q, true);
    f.complete('原生补充后轮', 1); await until(() => f.locks.size === 0); assert.equal(f.turns.length, 2); assert.deepEqual(f.client.replies, []);
  } finally { await f.cleanup(); }
});

test('原生选择题自由替代走真实表单并补充到原回合', async () => {
  const f = fixture(); const request = f.client.request.bind(f.client);
  f.client.request = async (method, params) => { if (method !== 'turn/steer') return request(method, params); f.client.calls.push({ method, params: params ?? {} }); return { turnId: params?.expectedTurnId }; };
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await askNative(f);
    const internal = f.adapter as unknown as { handleCardAction(event: unknown): Promise<unknown> };
    await internal.handleCardAction({ action: { value: q.value, form_value: { q0_other: '选择自定义目录', q1: 'QA_NATIVE_FREE' } }, context: { open_chat_id: 'chat', open_message_id: q.messageId }, operator: { open_id: 'owner' } });
    await until(() => f.client.calls.some(r => r.method === 'turn/steer'));
    const input = JSON.stringify(f.client.calls.find(r => r.method === 'turn/steer')!.params.input);
    assert.match(input, /选择自定义目录/); assert.match(input, /QA_NATIVE_FREE/);
    f.complete(); await until(() => f.locks.size === 0);
  } finally { await f.cleanup(); }
});

for (const command of ['/stop', '/new', `/bind ${targetSession}`, 'bridge-stop', 'failed']) {
  test(`原生pending题在 ${command} 后不可回答或补充`, async () => {
    const f = fixture();
    try {
      await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await askNative(f);
      if (command === 'bridge-stop') { await manager.stop(); await f.launch(); }
      else if (command === 'failed') { f.client.publish('turn/completed', { turn: { id: f.turns[0].turnId, status: 'failed' } }); await until(() => f.locks.size === 0); }
      else { const control = f.push(command); await until(() => f.acked.includes(control.updateId!)); }
      await submit(f, q); await submit(f, q, true); await until(() => f.acked.includes(1002));
      assert.equal(f.turns.length, 1); assert.equal(f.client.calls.some(r => r.method === 'turn/steer'), false); assert.deepEqual(f.client.replies, []);
    } finally { await f.cleanup(); }
  });
}

test('原生答案unknown且重复原/补充动作都不重放，控制仍可消费', async () => {
  const f = fixture(); const receipt = deferred<{ turnId: string }>(); const request = f.client.request.bind(f.client);
  f.client.request = async (method, params) => { if (method !== 'turn/steer') return request(method, params); f.client.calls.push({ method, params: params ?? {} }); return receipt.promise; };
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await askNative(f);
    await submit(f, q); await until(() => f.client.calls.some(r => r.method === 'turn/steer'));
    const status = f.push('/status'); await until(() => f.acked.includes(status.updateId!));
    receipt.resolve({ turnId: 'wrong' }); await until(() => f.calls.some(r => String(r.request.data.content).includes('结果未知')));
    await submit(f, q); await submit(f, q, true); f.complete(); await until(() => f.locks.size === 0);
    assert.equal(f.turns.length, 1); assert.equal(f.client.calls.filter(r => r.method === 'turn/steer').length, 1); assert.deepEqual(f.client.replies, []);
  } finally { receipt.resolve({ turnId: 'wrong' }); await f.cleanup(); }
});

test('有效异步答案回原 RPC，没有 steer 或第二张过程卡', async () => {
  const f = fixture();
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1);
    const q = await ask(f); await submit(f, q);
    await until(() => f.client.replies.some(r => (r as { id: string }).id === 'raw-q'));
    assert.deepEqual(f.client.replies.find(r => (r as { id: string }).id === 'raw-q'), { id: 'raw-q', result: { answers: { choice: { answers: ['A'] }, free: { answers: ['排除隐藏目录'] } } } });
    assert.equal(f.client.calls.some(r => r.method === 'turn/steer'), false); assert.equal(f.turns.length, 1);
    f.complete(); await until(() => f.locks.size === 0);
  } finally { await f.cleanup(); }
});

test('原问题关闭后原答案按钮不自动追加，显式补充即时一次且仍使用原过程卡', async () => {
  const f = fixture(); const request = f.client.request.bind(f.client);
  f.client.request = async (method, params) => { if (method !== 'turn/steer') return request(method, params); f.client.calls.push({ method, params: params ?? {} }); return { turnId: params?.expectedTurnId }; };
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await ask(f); close(f);
    await until(() => f.calls.some(r => r.kind === 'patch' && String(r.request.data.content).includes('作为任务补充发送')));
    await submit(f, q); await until(() => f.consumed.length === 2);
    assert.equal(f.client.calls.some(r => r.method === 'turn/steer'), false);
    await submit(f, q, true); await until(() => f.client.calls.some(r => r.method === 'turn/steer'));
    assert.equal(f.acked.includes(1002), false);
    await submit(f, q, true); await until(() => f.consumed.length === 4);
    assert.equal(f.client.calls.filter(r => r.method === 'turn/steer').length, 1);
    const input = JSON.stringify(f.client.calls.find(r => r.method === 'turn/steer')!.params.input);
    assert.match(input, /保留哪个目录/); assert.match(input, /还有什么要求/); assert.match(input, /排除隐藏目录/);
    assert.equal(f.turns.length, 1); assert.equal(f.calls.filter(r => r.kind === 'card.create').length, 1);
    f.complete(); await until(() => f.locks.size === 0);
    assert.equal(f.acked.filter(id => id === 1002).length, 1);
  } finally { await f.cleanup(); }
});

test('另一 active 回合拒绝旧卡且不消费资格，结束后用户再次明确操作可后轮', async () => {
  const f = fixture();
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await ask(f); close(f);
    f.complete(); await until(() => f.locks.size === 0);
    f.push('新任务'); await until(() => f.turns.length === 2); await submit(f, q, true);
    await until(() => f.acked.includes(1001));
    assert.equal(f.client.calls.some(r => r.method === 'turn/steer'), false);
    assert.equal(f.turns.length, 2);
    f.complete('新任务结果', 1); await until(() => f.locks.size === 0);
    await submit(f, q, true); await until(() => f.turns.length === 3);
    f.complete('问题补充后轮', 2); await until(() => f.locks.size === 0);
  } finally { await f.cleanup(); }
});

test('同 session 的其他聊天 active 也拒绝旧卡，取消该聊天不误伤原问题资格', async () => {
  const f = fixture();
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await ask(f);
    f.complete(); await until(() => f.locks.size === 0);
    f.store.upsertChannelBinding({ channelType: 'feishu', chatId: 'shared-chat', codepilotSessionId: 'session', sdkSessionId: '', model: '', workingDirectory: '', mode: 'code' });
    f.push('同会话其他聊天任务', 'owner', undefined, 'shared-chat'); await until(() => f.turns.length === 2);
    await submit(f, q, true); await until(() => f.acked.includes(1001));
    assert.equal(f.client.calls.some(r => r.method === 'turn/steer'), false);
    assert.equal(f.turns.length, 2);
    const stop = f.push('/stop', 'owner', undefined, 'shared-chat');
    await until(() => f.acked.includes(stop.updateId!) && f.locks.size === 0);
    await submit(f, q, true); await until(() => f.turns.length === 3);
    assert.match(JSON.stringify(f.turns[2].input), /保留哪个目录/);
    f.complete('原问题补充结果', 2); await until(() => f.locks.size === 0);
    assert.equal(f.acked.filter(id => id === 1002).length, 1);
  } finally { await f.cleanup(); }
});

for (const command of ['/stop', '/new', `/bind ${targetSession}`, 'bridge-stop']) {
  test(`闲置 closed 卡在 ${command} 后失效，不能恢复旧任务`, async () => {
    const f = fixture();
    try {
      await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await ask(f);
      f.complete(); await until(() => f.locks.size === 0);
      if (command === 'bridge-stop') { await manager.stop(); await f.launch(); }
      else { const control = f.push(command); await until(() => f.acked.includes(control.updateId!)); }
      await submit(f, q, true); await until(() => f.acked.includes(1001));
      assert.equal(f.turns.length, 1); assert.equal(f.client.calls.some(r => r.method === 'turn/steer'), false);
    } finally { await f.cleanup(); }
  });
}

test('其他用户聊天或伪造原卡无法补充；有效原来源仍可使用', async () => {
  const f = fixture(); const request = f.client.request.bind(f.client);
  f.client.request = async (method, params) => { if (method !== 'turn/steer') return request(method, params); f.client.calls.push({ method, params: params ?? {} }); return { turnId: params?.expectedTurnId }; };
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await ask(f); close(f);
    await submit(f, q, true, 'other'); await submit(f, q, true, 'owner', 'other-chat'); await submit(f, q, true, 'owner', 'chat', 'forged-card');
    await until(() => f.acked.includes(1003)); assert.equal(f.client.calls.some(r => r.method === 'turn/steer'), false);
    await submit(f, q, true); await until(() => f.client.calls.some(r => r.method === 'turn/steer'));
    f.complete(); await until(() => f.locks.size === 0);
  } finally { await f.cleanup(); }
});

test('补充 steer 结果 unknown 不后轮重送，重复回调不能重放', async () => {
  const f = fixture(); const request = f.client.request.bind(f.client);
  f.client.request = async (method, params) => { if (method !== 'turn/steer') return request(method, params); f.client.calls.push({ method, params: params ?? {} }); throw new Error('网络结果未知'); };
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await ask(f); close(f);
    await submit(f, q, true); await until(() => f.client.calls.some(r => r.method === 'turn/steer'));
    await submit(f, q, true); f.complete(); await until(() => f.locks.size === 0); await delay(30);
    assert.equal(f.turns.length, 1); assert.equal(f.client.calls.filter(r => r.method === 'turn/steer').length, 1);
    assert.equal(f.acked.filter(id => id === 1001).length, 1);
  } finally { await f.cleanup(); }
});

test('卡 patch 与回答反馈挂起仍消费其他聊天和停止，释放后终态最后写入', async () => {
  const f = fixture(); const patchGate = deferred<PlatformResponse>(); const feedbackGate = deferred<PlatformResponse>();
  const patch = f.transport.im.message.patch; const create = f.transport.im.message.create;
  let patching = false; let waitingFeedback = false;
  f.transport.im.message.patch = async req => {
    if (String(req.data.content).includes('作为任务补充发送')) { patching = true; await patchGate.promise; }
    return patch(req);
  };
  f.transport.im.message.create = async req => {
    if (String(req.data.content).includes('原问答已关闭')) { waitingFeedback = true; await feedbackGate.promise; }
    return create(req);
  };
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await ask(f); close(f); await until(() => patching);
    await submit(f, q); await until(() => waitingFeedback);
    f.push('其他聊天', 'owner', undefined, 'other-chat'); await until(() => f.turns.length === 2);
    const stop = f.push('/stop'); await until(() => f.acked.includes(stop.updateId!));
    patchGate.resolve({ code: 0, data: {} }); feedbackGate.resolve({ code: 0, data: {} });
    await until(() => f.calls.some(r => r.kind === 'patch' && String(r.request.data.content).includes('问答已取消')));
    assert.match(String(f.calls.filter(r => r.kind === 'patch').at(-1)?.request.data.content), /问答已取消/);
    f.complete('其他结果', 1); await until(() => f.locks.size === 0);
  } finally { patchGate.resolve({ code: 0, data: {} }); feedbackGate.resolve({ code: 0, data: {} }); await f.cleanup(); }
});

test('补充 RPC 挂起仍消费控制取消，迟到收据不启动后轮', async () => {
  const f = fixture(); const receipt = deferred<{ turnId: string }>(); const request = f.client.request.bind(f.client);
  f.client.request = async (method, params) => { if (method !== 'turn/steer') return request(method, params); f.client.calls.push({ method, params: params ?? {} }); return receipt.promise; };
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await ask(f); close(f);
    await submit(f, q, true); await until(() => f.client.calls.some(r => r.method === 'turn/steer'));
    f.push('其他聊天', 'owner', undefined, 'other-chat'); await until(() => f.turns.length === 2);
    const stop = f.push('/stop'); await until(() => f.acked.includes(stop.updateId!));
    receipt.resolve({ turnId: 'turn' }); f.complete('其他结果', 1); await until(() => f.locks.size === 0);
    assert.equal(f.turns.length, 2); assert.equal(f.client.calls.filter(r => r.method === 'turn/steer').length, 1);
  } finally { receipt.resolve({ turnId: 'turn' }); await f.cleanup(); }
});

test('正常完成后的闭合补充进入一次后轮', async () => {
  const f = fixture();
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await ask(f);
    f.complete(); await until(() => f.locks.size === 0);
    await submit(f, q, true); await until(() => f.turns.length === 2);
    await submit(f, q, true); await delay(30);
    assert.equal(f.turns.length, 2); assert.equal(f.client.calls.some(r => r.method === 'turn/steer'), false);
    f.complete('后轮答案', 1); await until(() => f.locks.size === 0);
  } finally { await f.cleanup(); }
});

test('旧 Codex 问题在后端切换后不能创建新会话或任务', async () => {
  const f = fixture();
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await ask(f);
    f.complete(); await until(() => f.locks.size === 0); f.settings.bridge_llm_backend = 'claude';
    await submit(f, q, true); await until(() => f.acked.includes(1001));
    assert.equal(f.turns.length, 1); assert.equal(f.binding().codepilotSessionId, 'session');
  } finally { await f.cleanup(); }
});

test('追加关闭设置沿后轮处理，合成补充不能变成控制命令', async () => {
  const f = fixture({ bridge_append_enabled: 'false' });
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await ask(f); close(f);
    await submit(f, q, true, 'owner', 'chat', q.messageId, '/stop'); await until(() => f.consumed.length === 2);
    assert.equal(f.client.calls.some(r => r.method === 'turn/steer'), false); assert.equal(f.acked.includes(1001), false);
    f.complete(); await until(() => f.turns.length === 2); assert.match(JSON.stringify(f.turns[1].input), /我的答案：\/stop/);
    f.complete('补充结果', 1); await until(() => f.acked.includes(1001)); assert.equal(f.acked.filter(id => id === 1001).length, 1);
  } finally { await f.cleanup(); }
});

test('原题加答案超总限额拒绝而不消费资格，正常补充不会打印答案', async () => {
  const f = fixture(); const logs: string[] = []; const log = console.log; console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    await f.launch(); f.push('原任务'); await until(() => f.turns.length === 1); const q = await ask(f);
    f.complete(); await until(() => f.locks.size === 0);
    await submit(f, q, true, 'owner', 'chat', q.messageId, '长'.repeat(32_000)); await until(() => f.acked.includes(1001));
    assert.equal(f.turns.length, 1);
    await submit(f, q, true, 'owner', 'chat', q.messageId, 'answer-no-log'); await until(() => f.turns.length === 2);
    assert.equal(logs.some(line => line.includes('answer-no-log')), false);
    f.complete('后轮答案', 1); await until(() => f.locks.size === 0);
  } finally { console.log = log; await f.cleanup(); }
});
