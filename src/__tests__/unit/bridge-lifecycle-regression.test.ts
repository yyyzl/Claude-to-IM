import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { initBridgeContext, getBridgeContext } from '../../lib/bridge/context.js';
import type { BridgeSession, BridgeStore, StreamChatParams } from '../../lib/bridge/host.js';
import type { ChannelBinding, InboundMessage, OutboundMessage } from '../../lib/bridge/types.js';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter.js';

// 显式 fake 加入口硬阻断：回归测试不允许启动登录过的运行时或连接平台。
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  mock.method(childProcess, key, () => { throw new Error(`禁止真实子进程：${key}`); });
}
syncBuiltinESMExports();
mock.method(globalThis, 'fetch', () => { throw new Error('禁止网络 fetch'); });
const manager = await import('../../lib/bridge/bridge-manager.js');
const engine = await import('../../lib/bridge/conversation-engine.js');

const event = (type: string, data: unknown) => `data: ${JSON.stringify({ type, data: typeof data === 'string' ? data : JSON.stringify(data) })}\n`;
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), 'fake 应在 500ms 内满足条件');
}
let serial = 0;
const targetSession = 'a'.repeat(32);

function setup(overrides: Record<string, string> = {}) {
  delete (globalThis as Record<string, unknown>).__bridge_manager__;
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  const chatId = `lifecycle-${++serial}`;
  const address = { channelType: 'telegram' as const, chatId, userId: 'test-user' };
  const sessions = new Map<string, BridgeSession>([
    ['session-old', { id: 'session-old', working_directory: '', model: 'model-old' }],
    [targetSession, { id: targetSession, working_directory: '', model: 'target-model' }],
  ]);
  const bindings = new Map<string, ChannelBinding>([[chatId, {
    id: 'binding-reused', channelType: 'telegram', chatId, codepilotSessionId: 'session-old',
    sdkSessionId: '', model: 'model-old', backend: 'claude', workingDirectory: '', mode: 'ask',
    active: true, createdAt: '', updatedAt: '',
  }]]);
  const settings: Record<string, string> = { remote_bridge_enabled: 'true', bridge_llm_backend: 'claude', bridge_input_debounce_ms: '0', bridge_codex_turn_timeout_ms: '5000', ...overrides };
  const locks = new Set<string>();
  const runtime = new Map<string, string>();
  const noop = () => {};
  const store: BridgeStore = {
    getSetting: key => settings[key] ?? null,
    getChannelBinding: (_type, chat) => bindings.has(chat) ? { ...bindings.get(chat)! } : null,
    upsertChannelBinding: data => {
      const previous = bindings.get(data.chatId) ?? { ...bindings.get(chatId)!, id: `binding-${data.chatId}` };
      const next: ChannelBinding = { ...previous, ...data, mode: data.mode === 'ask' || data.mode === 'plan' ? data.mode : previous.mode };
      bindings.set(data.chatId, next); return { ...next };
    },
    updateChannelBinding: (id, changes) => {
      const current = [...bindings.values()].find(row => row.id === id);
      if (current) bindings.set(current.chatId, { ...current, ...changes });
    },
    listChannelBindings: () => [...bindings.values()], getSession: id => sessions.get(id) ?? null,
    createSession: (_title, model, _prompt, cwd) => {
      const session = { id: `session-new-${sessions.size}`, working_directory: cwd ?? '', model };
      sessions.set(session.id, session); return session;
    },
    updateSessionProviderId: noop, addMessage: noop, getMessages: () => ({ messages: [] }),
    acquireSessionLock: id => { if (locks.has(id)) return false; locks.add(id); return true; },
    renewSessionLock: noop, releaseSessionLock: id => { locks.delete(id); },
    setSessionRuntimeStatus: (id, status) => { runtime.set(id, status); },
    updateSdkSessionId: noop, updateSessionModel: (id, model) => { const row = sessions.get(id); if (row) row.model = model; },
    syncSdkTasks: noop, getProvider: () => undefined, getDefaultProviderId: () => null,
    insertAuditLog: noop, checkDedup: () => false, insertDedup: noop, cleanupExpiredDedup: noop,
    insertOutboundRef: noop, insertPermissionLink: noop, getPermissionLink: () => null,
    markPermissionLinkResolved: () => false, listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0', setChannelOffset: noop,
  };
  const turns: Array<{ params: StreamChatParams; controller: ReadableStreamDefaultController<string>; stream: ReadableStream<string>; closed: boolean }> = [];
  const fakeLLM = { streamChat: (params: StreamChatParams) => {
    let controller!: ReadableStreamDefaultController<string>;
    const index = turns.length;
    const stream = new ReadableStream<string>({ start(c) { controller = c; }, cancel() { turns[index].closed = true; } });
    turns.push({ params, controller, stream, closed: false }); return stream;
  } };
  initBridgeContext({ store, llm: fakeLLM, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
  assert.equal(getBridgeContext().llm, fakeLLM);
  let running = false;
  let waiter: ((value: InboundMessage | null) => void) | undefined;
  const queue: InboundMessage[] = [];
  const sent: OutboundMessage[] = [];
  const consumed: InboundMessage[] = [];
  const ended: string[] = [];
  const acked = new Set<number>();
  let messageId = 0;
  const message = (text: string, chat = chatId): InboundMessage => ({ messageId: `m-${++messageId}`, updateId: messageId, address: { ...address, chatId: chat }, text, timestamp: Date.now() });
  const adapter = {
    channelType: 'telegram', start: async () => { running = true; },
    stop: async () => { running = false; waiter?.(null); waiter = undefined; },
    isRunning: () => running, validateConfig: () => null, isAuthorized: () => true,
    consumeOne: async () => { const value = queue.length ? queue.shift()! : await new Promise<InboundMessage | null>(resolve => { waiter = resolve; }); if (value) consumed.push(value); return value; },
    send: async (out: OutboundMessage) => { sent.push(out); return { ok: true, messageId: `sent-${sent.length}` }; },
    onMessageEnd: (chat: string) => { ended.push(chat); }, acknowledgeUpdate: (id: number) => { acked.add(id); },
  } as unknown as BaseChannelAdapter;
  function push(text: string, chat = chatId) { const value = message(text, chat); if (waiter) { const w = waiter; waiter = undefined; w(value); } else queue.push(value); return value; }
  function close(index: number, sdk = 'old-sdk', text = '') { const turn = turns[index]; if (turn.closed) return; turn.closed = true; if (text) turn.controller.enqueue(event('text', text)); turn.controller.enqueue(event('result', { is_error: false, session_id: sdk })); turn.controller.close(); }
  async function launch() { manager.registerAdapter(adapter); await manager.start(); }
  async function cleanup() { await manager.stop(); for (let i = 0; i < turns.length; i++) close(i); await delay(10); }
  return { address, adapter, store, message, push, sent, consumed, ended, acked, turns, locks, runtime, close, launch, cleanup, getBinding: () => ({ ...bindings.get(chatId)! }) };
}

for (const command of ['//review test', '/codex:review test']) {
  test(`透传 ${command} 不阻塞控制消息及其他会话`, { timeout: 1500 }, async () => {
    const f = setup();
    try {
      await f.launch(); f.push(command); await until(() => f.turns.length === 1);
      f.push('/answer expired A'); f.push('other chat', 'other-chat');
      await until(() => f.turns.length === 2);
      assert.ok(f.sent.some(row => row.text.includes('回答无效')));
      assert.equal(f.turns[0].closed, false);
      f.push('/stop'); await until(() => f.turns[0].params.abortController?.signal.aborted === true);
      assert.equal(f.turns[1].params.abortController?.signal.aborted, false);
      f.close(1);
    } finally { await f.cleanup(); }
  });
}

for (const command of ['/new', `/bind ${targetSession}`]) {
  test(`${command} 隔离旧回合的状态及迟到投递，不关闭新回合 UI`, { timeout: 1500 }, async () => {
    const f = setup();
    let finishOld!: (value: boolean) => void;
    let finalizing = false;
    f.adapter.onStreamText = () => {};
    f.adapter.onStreamEnd = async (_chat, status) => {
      if (status !== 'completed' || finalizing) return false;
      finalizing = true;
      return new Promise<boolean>(resolve => { finishOld = resolve; });
    };
    try {
      await f.launch(); f.push('old'); await until(() => f.turns.length === 1);
      f.close(0, 'old-result-sdk', 'old answer'); await until(() => finalizing);
      await manager._testOnly.handleMessage(f.adapter, f.message(command));
      const nextBinding = f.getBinding();
      assert.notEqual(nextBinding.codepilotSessionId, 'session-old');
      f.push('new'); await until(() => f.turns.length === 2);
      const endCount = f.ended.length;
      f.turns[0].params.onRuntimeStatusChange?.('old-late-state');
      finishOld(true); await delay(25);
      assert.equal(f.getBinding().sdkSessionId, '');
      assert.equal(f.getBinding().model, nextBinding.model);
      assert.equal(f.runtime.get('session-old'), 'idle');
      assert.equal(f.ended.length, endCount);
      assert.equal(f.runtime.get(nextBinding.codepilotSessionId), 'running');
      f.close(1, 'new-sdk');
    } finally { finishOld?.(false); await f.cleanup(); }
  });
}

test('bridge stop 取消活跃任务、排空 append，重启不执行旧消息', { timeout: 1500 }, async () => {
  const f = setup();
  try {
    await f.launch(); f.push('first'); await until(() => f.turns.length === 1);
    const append = f.push('follow-up'); await until(() => f.consumed.length === 2);
    await manager.stop();
    assert.equal(manager.getStatus().running, false);
    assert.equal(f.turns[0].params.abortController?.signal.aborted, true);
    assert.equal(f.locks.size, 0);
    assert.ok(f.acked.has(append.updateId!));
    await f.launch(); await delay(20);
    assert.equal(f.turns.length, 1);
    f.push('after restart'); await until(() => f.turns.length === 2); f.close(1);
  } finally { await f.cleanup(); }
});

test('取消先等待旧卡终结，再结束仍属于旧回合的 UI', { timeout: 1500 }, async () => {
  const f = setup();
  let finishCard!: (value: boolean) => void;
  f.adapter.onStreamEnd = async () => new Promise<boolean>(resolve => { finishCard = resolve; });
  try {
    await f.launch(); f.push('first'); await until(() => f.turns.length === 1);
    await manager._testOnly.handleMessage(f.adapter, f.message('/stop'));
    await until(() => f.turns[0].closed);
    assert.equal(f.ended.length, 0);
    finishCard(true); await until(() => f.ended.length === 1);
  } finally { finishCard?.(false); await f.cleanup(); }
});

for (const command of ['/stop', '/new', `/bind ${targetSession}`]) {
  test(`${command} 取消 debounce 中的消息并确认 offset`, { timeout: 1500 }, async () => {
    const f = setup({ bridge_input_debounce_ms: '60' });
    try {
      await f.launch(); const pending = f.push('pending'); await until(() => f.consumed.length === 1);
      f.push(command); await until(() => f.consumed.length === 2); await delay(90);
      assert.equal(f.turns.length, 0);
      assert.ok(f.acked.has(pending.updateId!));
      assert.ok(!f.sent.some(row => row.text.includes('No task is currently running')));
    } finally { await f.cleanup(); }
  });
  for (const stage of ['queued', 'append']) {
  test(`${command} 取消同会话的 ${stage} 消息，不迁移到新会话`, { timeout: 1500 }, async () => {
    const f = setup({ bridge_append_enabled: stage === 'append' ? 'true' : 'false' });
    try {
      await f.launch(); f.push('first'); await until(() => f.turns.length === 1);
      const queued = f.push('old queued'); await until(() => f.consumed.length === 2);
      f.push(command); await until(() => f.consumed.length === 3); await delay(25);
      assert.equal(f.turns.length, 1);
      assert.ok(f.acked.has(queued.updateId!));
      f.push('fresh'); await until(() => f.turns.length === 2);
      assert.equal(f.turns[1].params.prompt, 'fresh'); f.close(1);
    } finally { await f.cleanup(); }
  });
  }
}

test('绑定切走再切回同一 session，旧回合仍不能写回 SDK ID', { timeout: 1500 }, async () => {
  const f = setup();
  f.store.updateChannelBinding('binding-reused', { codepilotSessionId: targetSession });
  let finishOld!: (value: boolean) => void;
  let finalizing = false;
  f.adapter.onStreamText = () => {};
  f.adapter.onStreamEnd = async (_chat, status) => {
    if (status !== 'completed' || finalizing) return false;
    finalizing = true;
    return new Promise<boolean>(resolve => { finishOld = resolve; });
  };
  try {
    await f.launch(); f.push('old'); await until(() => f.turns.length === 1);
    f.close(0, 'old-aba-sdk', 'old answer'); await until(() => finalizing);
    await manager._testOnly.handleMessage(f.adapter, f.message('/new'));
    await manager._testOnly.handleMessage(f.adapter, f.message(`/bind ${targetSession}`));
    finishOld(true); await delay(20);
    assert.equal(f.getBinding().codepilotSessionId, targetSession);
    assert.equal(f.getBinding().sdkSessionId, '');
    f.push('fresh'); await until(() => f.turns.length === 2);
    assert.equal(f.turns[1].params.sdkSessionId, undefined); f.close(1);
  } finally { finishOld?.(false); await f.cleanup(); }
});

test('turn 超时能结束不响应 abort 的 reader，并释放本地锁', { timeout: 1500 }, async () => {
  const f = setup({ bridge_codex_turn_timeout_ms: '20' });
  const result = await engine.processMessage(f.getBinding(), 'stalled stream');
  assert.equal(result.errorCode, 'timeout');
  assert.equal(f.turns[0].params.abortController?.signal.aborted, true);
  assert.equal(f.turns[0].stream.locked, false);
  assert.equal(f.locks.size, 0);
  f.turns[0].params.onRuntimeStatusChange?.('late');
  assert.equal(f.runtime.get('session-old'), 'idle');
});

test('同会话透传与普通请求串行，并使用前一回合刚保存的 SDK ID', { timeout: 1500 }, async () => {
  const f = setup({ bridge_append_enabled: 'false' });
  try {
    await f.launch(); f.push('first'); await until(() => f.turns.length === 1);
    f.push('//review next'); await until(() => f.consumed.length === 2); await delay(20);
    assert.equal(f.turns.length, 1);
    f.close(0, 'fresh-resume-id'); await until(() => f.turns.length === 2);
    assert.equal(f.turns[1].params.sdkSessionId, 'fresh-resume-id');
    assert.equal(f.turns[1].params.prompt, '/review next'); f.close(1);
  } finally { await f.cleanup(); }
});

test('stop/start 后旧 consumeOne 迟到返回不能进入新运行周期', { timeout: 1500 }, async () => {
  const f = setup();
  const readers: Array<(message: InboundMessage | null) => void> = [];
  f.adapter.consumeOne = () => new Promise(resolve => { readers.push(resolve); });
  f.adapter.stop = async () => {}; // 模拟不会唤醒旧 reader 的平台
  try {
    await f.launch(); await until(() => readers.length === 1);
    await manager.stop(); await f.launch(); await until(() => readers.length === 2);
    readers[0](f.message('late old reader')); await delay(20);
    assert.equal(f.turns.length, 0);
    readers[1](f.message('new reader')); await until(() => f.turns.length === 1);
    assert.equal(f.turns[0].params.prompt, 'new reader'); f.close(0);
  } finally { await f.cleanup(); for (const resolve of readers) resolve(null); }
});

test('/retry 补发失败的回答，不再次执行模型', { timeout: 1500 }, async () => {
  const f = setup();
  const originalSend = f.adapter.send.bind(f.adapter);
  let fail = true;
  f.adapter.send = async out => fail && out.text.includes('saved answer') ? { ok: false, error: 'bad request', httpStatus: 400 } : originalSend(out);
  try {
    await f.launch(); const inbound = f.push('question'); await until(() => f.turns.length === 1);
    f.close(0, 'sdk', 'saved answer'); await until(() => f.acked.has(inbound.updateId!));
    await manager._testOnly.handleMessage(f.adapter, f.message('/status'));
    assert.ok(f.sent.some(out => out.text.includes('待补发')));
    fail = false;
    await manager._testOnly.handleMessage(f.adapter, f.message('/retry'));
    await until(() => f.sent.some(out => out.text.includes('saved answer')));
    assert.equal(f.turns.length, 1);
    assert.ok(f.sent.some(out => out.text.includes('saved answer')));
  } finally { await f.cleanup(); }
});

for (const hasError of [true, false]) {
  test(`无正文${hasError ? '错误' : '成功'}回合的卡片终结超时不阻塞下一回合`, { timeout: 1500 }, async () => {
    const f = setup({ bridge_delivery_timeout_ms: '20' });
    const finalizers: Array<(value: boolean) => void> = [];
    f.adapter.onStreamText = () => {};
    f.adapter.onStreamEnd = () => new Promise<boolean>(resolve => { finalizers.push(resolve); });
    try {
      await f.launch(); const first = f.push('empty result'); await until(() => f.turns.length === 1);
      if (hasError) f.turns[0].controller.enqueue(event('error', 'expected failure'));
      f.close(0); await until(() => f.acked.has(first.updateId!));
      assert.equal(finalizers.length, 1);
      if (hasError) assert.ok(f.sent.some(out => out.text.includes('expected failure')));
      f.push('next turn'); await until(() => f.turns.length === 2);
      assert.equal(f.turns[1].params.prompt, 'next turn');
    } finally {
      f.adapter.onStreamEnd = async () => false;
      for (const resolve of finalizers) resolve(false);
      await f.cleanup();
    }
  });
}

test('问答发送悬挂时，取消仍能结束等待和释放 reader', { timeout: 1500 }, async () => {
  const f = setup();
  const abort = new AbortController();
  let forwarding = false;
  const pending = engine.processMessage(f.getBinding(), 'question', undefined, abort.signal, undefined, undefined, undefined, {
    onUserInputRequest: () => { forwarding = true; return new Promise<void>(() => {}); },
  });
  await until(() => f.turns.length === 1);
  f.turns[0].controller.enqueue(event('user_input_request', { requestId: 'fake-question', questions: [] }));
  await until(() => forwarding); abort.abort();
  assert.equal((await pending).errorCode, 'abort');
  assert.equal(f.locks.size, 0);
  assert.equal(f.turns[0].stream.locked, false);
});
