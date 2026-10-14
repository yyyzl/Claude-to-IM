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
  return { client, provider, permissions, adapter, internal, transport, calls, records, audit, acked, consumed, locks, store, turns, push, complete, launch, cleanup, binding: () => bindings.get('chat')! };
}

test('忙时连续补充进入原 Codex 回合和同一真实飞书卡片，收据前不假报追加', async () => {
  const f = fixture(); const receipt = deferred<{ turnId: string }>(); const request = f.client.request.bind(f.client);
  f.client.request = async (method, params) => {
    if (method !== 'turn/steer') return request(method, params);
    f.client.calls.push({ method, params: params ?? {} });
    return f.client.calls.filter(row => row.method === 'turn/steer').length === 1 ? receipt.promise : { turnId: 'turn' };
  };
  try {
    await f.launch(); f.push('原问题'); await until(() => f.calls.some(row => row.kind === 'card.create') && f.client.calls.some(row => row.method === 'turn/start'));
    const one = f.push('补充1'); const two = f.push('补充2');
    await until(() => f.client.calls.some(row => row.method === 'turn/steer'));
    assert.equal(f.internal.activeCards.get('chat')?.appendNotice, null);
    assert.equal(f.client.calls.filter(row => row.method === 'turn/steer').length, 1);
    assert.ok(!f.acked.includes(one.updateId!) && !f.acked.includes(two.updateId!));
    receipt.resolve({ turnId: 'turn' });
    await until(() => f.client.calls.filter(row => row.method === 'turn/steer').length === 2);
    await until(() => f.records.length === 3);
    f.client.publish('item/started', { item: { type: 'commandExecution', id: 'extra', command: '重新计算' } });
    assert.ok(f.internal.activeCards.get('chat')?.appendNotice?.includes('追加'));
    f.complete(); await until(() => f.acked.length === 3);
    assert.equal(f.client.calls.filter(row => row.method === 'turn/start').length, 1);
    assert.equal(f.calls.filter(row => row.kind === 'card.create').length, 1);
    assert.equal(f.calls.filter(row => row.kind === 'card.update').length, 0);
    assert.equal(f.calls.filter(row => row.kind === 'batch' && JSON.parse(String(row.request.data.actions)).some((action: { params: { element_id: string; partial_element?: { content?: string } } }) => action.params.element_id === 'task_status' && action.params.partial_element?.content?.startsWith('✅ 已完成'))).length, 1);
    assert.deepEqual(f.records.slice(0, 3).map(row => [row.role, row.text]), [['user', '原问题'], ['user', '补充1'], ['user', '补充2']]);
    assert.equal(f.records[3].role, 'assistant');
    const blocks = JSON.parse(f.records[3].text) as Array<{ type: string; text?: string; id?: string }>;
    assert.ok(blocks.some(block => block.type === 'tool_use' && block.id === 'extra'));
    assert.ok(blocks.some(block => block.type === 'text' && block.text === '覆盖补充的最终答复'));
    assert.deepEqual(f.acked, [1, 2, 3]);
  } finally { receipt.resolve({ turnId: 'turn' }); await f.cleanup(); }
});

for (const outcome of ['accepted', 'unknown']) {
  test(`完成先于 steer 收据：${outcome} 不被 finally 自动再送`, async () => {
    const f = fixture(); const receipt = deferred<{ turnId: string }>(); const request = f.client.request.bind(f.client);
    f.client.request = async (method, params) => {
      if (method !== 'turn/steer') return request(method, params);
      f.client.calls.push({ method, params: params ?? {} }); return receipt.promise;
    };
    try {
      await f.launch(); f.push('原始'); await until(() => f.turns.length === 1);
      const append = f.push('补充'); await until(() => f.client.calls.some(call => call.method === 'turn/steer'));
      f.complete('最终'); await delay(20);
      assert.deepEqual(f.records.map(row => row.role), ['user']); assert.ok(!f.acked.includes(append.updateId!));
      receipt.resolve({ turnId: outcome === 'accepted' ? 'turn' : 'wrong' });
      await until(() => f.acked.includes(append.updateId!)); await delay(20);
      assert.equal(f.turns.length, 1); assert.equal(f.calls.filter(row => row.kind === 'card.create').length, 1);
      assert.deepEqual(f.records.map(row => row.role), outcome === 'accepted' ? ['user', 'user', 'assistant'] : ['user', 'assistant']);
      if (outcome === 'unknown') assert.ok(f.calls.some(row => String(row.request.data.content).includes('结果未知')));
    } finally { receipt.resolve({ turnId: 'turn' }); await f.cleanup(); }
  });
}

test('初始化时补充等待原 turn ready；early completed 只将未提交来源转为一次后轮', async () => {
  for (const early of [false, true]) {
    const f = fixture(); const init = deferred<void>(); const request = f.client.request.bind(f.client);
    f.client.request = async (method, params) => {
      if (method === 'initialize') await init.promise;
      if (method === 'turn/steer') { f.client.calls.push({ method, params: params ?? {} }); return { turnId: params?.expectedTurnId }; }
      return request(method, params);
    };
    if (early) f.client.onTurn = () => { if (f.turns.length === 1) f.complete('原始结果'); };
    try {
      await f.launch(); f.push('原始'); await until(() => f.calls.some(row => row.kind === 'card.create'));
      const append = f.push('补充'); await until(() => f.consumed.length === 2);
      assert.equal(f.turns.length, 0); assert.equal(f.client.calls.some(call => call.method === 'turn/steer'), false);
      init.resolve(); await until(() => f.turns.length === (early ? 2 : 1));
      if (early) { assert.equal(f.client.calls.some(call => call.method === 'turn/steer'), false); assert.ok(!f.acked.includes(append.updateId!)); f.complete('补充后轮', 1); }
      else { await until(() => f.records.length === 2); f.complete(); }
      await until(() => f.acked.includes(append.updateId!));
      assert.equal(f.turns.length, early ? 2 : 1); assert.equal(f.records.filter(row => row.role === 'user' && row.text === '补充').length, 1);
    } finally { init.resolve(); await f.cleanup(); }
  }
});

test('模型已结束而原卡还在收尾，补充走正常后轮且来源由后轮确认', async () => {
  const f = fixture(); const finalize = deferred<PlatformResponse>(); const update = f.transport.cardkit.v1.card.batchUpdate;
  let finalizing = false;
  f.transport.cardkit.v1.card.batchUpdate = async request => {
    if (JSON.parse(String(request.data.actions)).some((action: { params: { element_id: string; partial_element?: { content?: string } } }) => action.params.element_id === 'task_status' && action.params.partial_element?.content?.startsWith('✅ 已完成'))) {
      finalizing = true; f.transport.cardkit.v1.card.batchUpdate = update;
      await finalize.promise;
    }
    return update(request);
  };
  try {
    await f.launch(); f.push('原始'); await until(() => f.turns.length === 1); f.complete('第一轮'); await until(() => finalizing);
    const append = f.push('后来'); await until(() => f.consumed.length === 2); await delay(20);
    assert.equal(f.client.calls.some(row => row.method === 'turn/steer'), false); assert.ok(!f.acked.includes(append.updateId!));
    finalize.resolve({ code: 0, data: {} }); await until(() => f.turns.length === 2);
    assert.ok(!f.acked.includes(append.updateId!)); f.complete('后轮', 1); await until(() => f.acked.includes(append.updateId!));
    assert.equal(f.turns.length, 2); assert.equal(f.calls.filter(row => row.kind === 'card.create').length, 2);
  } finally { finalize.resolve({ code: 0, data: {} }); await f.cleanup(); }
});

for (const command of ['/stop', '/new', `/bind ${targetSession}`, 'bridge-stop']) {
  test(`${command} 与 steer 并发时隔离迟到收据并确认来源，其他聊天可消费`, async () => {
    const f = fixture(); const receipt = deferred<{ turnId: string }>(); const request = f.client.request.bind(f.client);
    f.client.request = async (method, params) => { if (method !== 'turn/steer') return request(method, params); f.client.calls.push({ method, params: params ?? {} }); return receipt.promise; };
    try {
      await f.launch(); f.push('原始'); await until(() => f.turns.length === 1);
      const append = f.push('补充'); await until(() => f.client.calls.some(row => row.method === 'turn/steer'));
      f.push('/answer expired A'); f.push('其他聊天', 'owner', undefined, 'other-chat'); await until(() => f.turns.length === 2);
      assert.ok(f.calls.some(row => String(row.request.data.content).includes('回答无效')));
      f.complete('其他答复', 1);
      let stopping: Promise<void> | undefined;
      if (command === 'bridge-stop') stopping = manager.stop();
      else { const control = f.push(command); await until(() => f.acked.includes(control.updateId!)); }
      receipt.resolve({ turnId: 'turn' }); await until(() => f.acked.includes(append.updateId!));
      if (stopping) { await stopping; await f.launch(); }
      f.push('新输入'); await until(() => f.turns.length === 3);
      assert.equal(f.internal.activeCards.get('chat')?.appendNotice, null);
      assert.equal(f.client.calls.filter(row => row.method === 'turn/steer').length, 1);
      assert.ok(f.records.filter(row => row.text === '补充').every(row => row.session === 'session'));
      f.complete('新答复', 2); await until(() => f.locks.size === 0);
    } finally { receipt.resolve({ turnId: 'turn' }); await f.cleanup(); }
  });
}

for (const scenario of ['disabled', 'other-owner', 'attachment', 'passthrough']) {
  test(`${scenario} 沿原后轮路径，不进入当前输入`, async () => {
    const f = fixture(scenario === 'disabled' ? { bridge_append_enabled: 'false' } : {});
    try {
      await f.launch(); f.push('原始'); await until(() => f.turns.length === 1);
      const append = f.push(scenario === 'passthrough' ? '//review next' : '补充', scenario === 'other-owner' ? 'other' : 'owner', scenario === 'attachment' ? [{ id: 'img', name: 'synthetic.png', type: 'image/png', size: 1, data: 'YQ==' }] : undefined);
      await until(() => f.consumed.length === 2); await delay(20);
      assert.equal(f.client.calls.some(row => row.method === 'turn/steer'), false); assert.equal(f.internal.activeCards.get('chat')?.appendNotice, null);
      f.complete('原答'); await until(() => f.turns.length === 2);
      if (scenario === 'passthrough') assert.match(JSON.stringify(f.turns[1].input), /\/review next/);
      f.complete('后答', 1); await until(() => f.acked.includes(append.updateId!));
    } finally { await f.cleanup(); }
  });
}

test('纯文字 post 归一化及文字清理、截断审计在即时入口仍生效', async () => {
  const f = fixture(); const request = f.client.request.bind(f.client);
  f.client.request = async (method, params) => { if (method !== 'turn/steer') return request(method, params); f.client.calls.push({ method, params: params ?? {} }); return { turnId: 'turn' }; };
  try {
    await f.launch(); f.push('原始'); await until(() => f.turns.length === 1);
    await f.internal.handleIncomingEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'owner' } }, message: { message_id: 'post', chat_id: 'chat', chat_type: 'p2p', create_time: '123', message_type: 'post', content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: '补\u0000充' + '长'.repeat(40000) }]] }) } });
    await until(() => f.client.calls.some(row => row.method === 'turn/steer'));
    const params = f.client.calls.find(row => row.method === 'turn/steer')!.params;
    assert.ok(!JSON.stringify(params).includes('\\u0000')); assert.ok(f.audit.some(row => row.includes('TRUNCATED')));
    f.complete(); await until(() => f.locks.size === 0);
  } finally { await f.cleanup(); }
});

test('未提交补充与不同发送者的后轮来源保持原顺序，不跨用户合并', async () => {
  const f = fixture(); const init = deferred<void>(); const request = f.client.request.bind(f.client);
  f.client.request = async (method, params) => { if (method === 'initialize') await init.promise; return request(method, params); };
  f.client.onTurn = () => { if (f.turns.length === 1) f.complete('原始结果'); };
  try {
    await f.launch(); f.push('原始'); await until(() => f.calls.some(row => row.kind === 'card.create'));
    f.push('补充1'); f.push('另一人', 'other'); f.push('补充2'); await until(() => f.consumed.length === 4);
    init.resolve(); await until(() => f.turns.length === 2);
    assert.match(JSON.stringify(f.turns[1].input), /补充1/);
    f.complete('后轮1', 1); await until(() => f.turns.length === 3); assert.match(JSON.stringify(f.turns[2].input), /另一人/);
    f.complete('后轮2', 2); await until(() => f.turns.length === 4); assert.match(JSON.stringify(f.turns[3].input), /补充2/);
    f.complete('后轮3', 3); await until(() => f.acked.length === 4);
    assert.equal(f.client.calls.some(row => row.method === 'turn/steer'), false);
  } finally { init.resolve(); await f.cleanup(); }
});

for (const boundary of ['other-owner', 'attachment']) {
  test(`即时补充之后的 ${boundary} 后轮边界阻止后来文本插回原回合`, async () => {
    const f = fixture(); const request = f.client.request.bind(f.client);
    f.client.request = async (method, params) => { if (method !== 'turn/steer') return request(method, params); f.client.calls.push({ method, params: params ?? {} }); return { turnId: 'turn' }; };
    try {
      await f.launch(); f.push('原始'); await until(() => f.turns.length === 1);
      f.push('即时补充'); await until(() => f.records.length === 2);
      f.push('边界消息', boundary === 'other-owner' ? 'other' : 'owner', boundary === 'attachment' ? [{ id: 'img', name: 'synthetic.png', type: 'image/png', size: 1, data: 'YQ==' }] : undefined);
      f.push('后来文本'); await until(() => f.consumed.length === 4); await delay(20);
      const steers = f.client.calls.filter(row => row.method === 'turn/steer');
      assert.equal(steers.length, 1); assert.match(JSON.stringify(steers[0].params.input), /即时补充/);
      f.complete('原答'); await until(() => f.turns.length === 2);
      assert.match(JSON.stringify(f.turns[1].input), /边界消息/);
      if (boundary === 'other-owner') { assert.doesNotMatch(JSON.stringify(f.turns[1].input), /后来文本/); f.complete('另一人答复', 1); await until(() => f.turns.length === 3); assert.match(JSON.stringify(f.turns[2].input), /后来文本/); f.complete('后来答复', 2); }
      else { assert.match(JSON.stringify(f.turns[1].input), /后来文本/); assert.match(JSON.stringify(f.turns[1].input), /image/); f.complete('后轮答复', 1); }
      await until(() => f.acked.length === 4);
    } finally { await f.cleanup(); }
  });
}

for (const command of ['/stop', '/new', `/bind ${targetSession}`]) {
  test(`${command} 取消初始化中的补充，不启动原模型或迁移旧来源`, async () => {
    const f = fixture(); const init = deferred<void>(); const request = f.client.request.bind(f.client);
    f.client.request = async (method, params) => { if (method === 'initialize') await init.promise; return request(method, params); };
    try {
      await f.launch(); f.push('原始'); await until(() => f.calls.some(row => row.kind === 'card.create'));
      const append = f.push('旧补充'); await until(() => f.consumed.length === 2);
      const control = f.push(command); await until(() => f.acked.includes(control.updateId!));
      await until(() => f.acked.includes(append.updateId!)); init.resolve(); await delay(20);
      assert.equal(f.client.calls.some(row => row.method === 'turn/steer' || row.method === 'turn/start'), false);
      assert.equal(f.records.filter(row => row.text === '旧补充').length, 0);
      f.push('新输入'); await until(() => f.turns.length === 1); f.complete('新答'); await until(() => f.locks.size === 0);
    } finally { init.resolve(); await f.cleanup(); }
  });
}

for (const outcome of ['unknown', 'history-error']) {
  test(`限流中的 ${outcome} 独立结果提示在原任务正常结束和新卡开启后仍发送`, async () => {
    const f = fixture(); const limit = deferred<void>(); const receipt = deferred<{ turnId: string }>();
    const limiter = mock.method(ChatRateLimiter.prototype, 'acquire', async () => limit.promise);
    const sent: OutboundMessage[] = []; const send = f.adapter.send.bind(f.adapter);
    f.adapter.send = async message => { sent.push(message); return send(message); };
    const request = f.client.request.bind(f.client);
    f.client.request = async (method, params) => {
      if (method !== 'turn/steer') return request(method, params);
      f.client.calls.push({ method, params: params ?? {} }); return receipt.promise;
    };
    if (outcome === 'history-error') {
      const record = f.store.addMessage.bind(f.store);
      f.store.addMessage = (session, role, text, usage) => {
        if (text === '补充') throw new Error('内存记录故障');
        return record(session, role, text, usage);
      };
    }
    try {
      await f.launch(); f.push('原始'); await until(() => f.turns.length === 1);
      const append = f.push('补充'); await until(() => f.client.calls.some(row => row.method === 'turn/steer'));
      f.complete('原答'); receipt.resolve({ turnId: outcome === 'unknown' ? 'wrong' : 'turn' });
      await until(() => f.acked.includes(append.updateId!));
      assert.equal(limiter.mock.callCount(), 1);
      f.push('下一轮'); await until(() => f.turns.length === 2);
      assert.equal(f.internal.activeCards.get('chat')?.appendNotice, null);
      limit.resolve();
      const expected = outcome === 'unknown' ? '结果未知' : '记录保存失败';
      await until(() => f.calls.some(row => String(row.request.data?.content).includes(expected)));
      const notice = f.calls.find(row => String(row.request.data?.content).includes(expected))!;
      assert.equal(sent.find(message => message.text.includes(expected))?.replyToMessageId, append.messageId);
      assert.deepEqual(sent.find(message => message.text.includes(expected))?.address, append.address);
      assert.equal(notice.kind, 'message.create');
      assert.equal(notice.request.data.receive_id, append.address.chatId);
      assert.equal(f.internal.activeCards.get('chat')?.appendNotice, null);
      assert.equal(f.client.calls.filter(row => row.method === 'turn/steer').length, 1);
      f.complete('新答', 1); await until(() => f.locks.size === 0);
    } finally { limit.resolve(); receipt.resolve({ turnId: 'turn' }); limiter.mock.restore(); await f.cleanup(); }
  });
}

for (const command of ['/stop', '/new', `/bind ${targetSession}`, 'bridge-stop']) {
  test(`${command} 仍取消限流等待中的旧补充结果提示`, async () => {
    const f = fixture(); const limit = deferred<void>(); const receipt = deferred<{ turnId: string }>();
    const limiter = mock.method(ChatRateLimiter.prototype, 'acquire', async () => limit.promise);
    const request = f.client.request.bind(f.client);
    f.client.request = async (method, params) => {
      if (method !== 'turn/steer') return request(method, params);
      f.client.calls.push({ method, params: params ?? {} }); return receipt.promise;
    };
    try {
      await f.launch(); f.push('原始'); await until(() => f.turns.length === 1);
      const append = f.push('补充'); await until(() => f.client.calls.some(row => row.method === 'turn/steer'));
      f.complete('原答'); receipt.resolve({ turnId: 'wrong' });
      await until(() => f.acked.includes(append.updateId!));
      assert.equal(limiter.mock.callCount(), 1);
      let stopping: Promise<void> | undefined;
      if (command === 'bridge-stop') stopping = manager.stop();
      else {
        f.push(command); await until(() => limiter.mock.callCount() >= 2);
      }
      limit.resolve(); if (stopping) await stopping;
      else await until(() => f.acked.length === 3);
      await delay(20);
      assert.equal(f.calls.some(row => String(row.request.data?.content).includes('结果未知')), false);
      assert.equal(f.client.calls.filter(row => row.method === 'turn/steer').length, 1);
    } finally { limit.resolve(); receipt.resolve({ turnId: 'turn' }); limiter.mock.restore(); await f.cleanup(); }
  });
}
