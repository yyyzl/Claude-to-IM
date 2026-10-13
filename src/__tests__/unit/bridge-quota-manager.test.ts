import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { BaseChannelAdapter } from '../../lib/bridge/channel-adapter.js';
import { initBridgeContext } from '../../lib/bridge/context.js';
import { deliver } from '../../lib/bridge/delivery-layer.js';
import type { AccountQuota, AuditLogInput, BridgeSession, BridgeStore, LLMProvider, PermissionResolution } from '../../lib/bridge/host.js';
import type { ChannelBinding, InboundMessage, OutboundMessage, SendResult } from '../../lib/bridge/types.js';

for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  mock.method(childProcess, key, () => { throw new Error(`禁止真实子进程：${key}`); });
}
syncBuiltinESMExports();
mock.method(globalThis, 'fetch', () => { throw new Error('禁止真实网络'); });
const manager = await import('../../lib/bridge/bridge-manager.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 150 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), '预期行为未在消费循环中发生');
}
const snapshot = (): AccountQuota => ({ queriedAt: Date.now(), buckets: [{ limitId: 'codex', limitName: null, primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null }, secondary: null }] });
let serial = 0;

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__bridge_manager__;
  delete (globalThis as Record<string, unknown>).__bridge_context__;
});

function fixture(backend = 'codex') {
  const address = { channelType: 'feishu', chatId: `quota-${++serial}`, userId: 'synthetic' };
  const sessions = new Map<string, BridgeSession>();
  const bindings = new Map<string, ChannelBinding>();
  const audits: AuditLogInput[] = [];
  const mutations: string[] = [];
  const approvals: Array<{ id: string; resolution: PermissionResolution }> = [];
  const link = { permissionRequestId: 'synthetic-perm', chatId: address.chatId, messageId: 'card', resolved: false, suggestions: '' };
  const store: BridgeStore = {
    getSetting: key => ({ remote_bridge_enabled: 'true', bridge_llm_backend: backend, bridge_delivery_timeout_ms: '1000', bridge_default_work_dir: process.cwd(), bridge_input_debounce_ms: '0' })[key] ?? null,
    getChannelBinding: (channel, chat) => bindings.get(`${channel}:${chat}`) ?? null,
    upsertChannelBinding: data => {
      mutations.push('binding');
      const value: ChannelBinding = { id: `binding-${address.chatId}`, ...data, sdkSessionId: '', mode: 'code', active: true, createdAt: '', updatedAt: '' };
      bindings.set(`${data.channelType}:${data.chatId}`, value);
      return value;
    },
    updateChannelBinding: (id, updates) => {
      mutations.push('binding');
      for (const [key, binding] of bindings) if (binding.id === id) bindings.set(key, { ...binding, ...updates });
    },
    listChannelBindings: () => [...bindings.values()],
    getSession: id => sessions.get(id) ?? null,
    createSession: (_name, model, _prompt, cwd) => {
      mutations.push('session');
      const value = { id: `session-${sessions.size + 1}`, model, working_directory: cwd || '' };
      sessions.set(value.id, value); return value;
    },
    updateSessionProviderId: () => { mutations.push('provider'); },
    addMessage: () => { mutations.push('message'); }, getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true, renewSessionLock: () => {}, releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => { mutations.push('runtime'); }, updateSdkSessionId: () => { mutations.push('sdk'); },
    updateSessionModel: () => { mutations.push('model'); }, syncSdkTasks: () => { mutations.push('tasks'); },
    getProvider: () => undefined, getDefaultProviderId: () => null,
    insertAuditLog: entry => { audits.push(entry); }, checkDedup: () => false, insertDedup: () => {}, cleanupExpiredDedup: () => {},
    insertOutboundRef: () => { mutations.push('reference'); }, insertPermissionLink: () => {},
    getPermissionLink: id => id === link.permissionRequestId ? link : null,
    markPermissionLinkResolved: id => { if (id !== link.permissionRequestId || link.resolved) return false; link.resolved = true; return true; },
    listPendingPermissionLinksByChat: chat => chat === address.chatId && !link.resolved ? [link] : [],
    getChannelOffset: () => '0', setChannelOffset: () => {},
  };
  const source = { read: async (): Promise<AccountQuota> => snapshot() };
  let queries = 0; let modelCalls = 0;
  const llm: LLMProvider = { getAccountQuota: async () => { queries++; return source.read(); }, streamChat: () => { modelCalls++; throw new Error('额度命令不得调用模型'); } };
  initBridgeContext({ store, llm, lifecycle: {}, permissions: { resolvePendingPermission: (id, resolution) => { approvals.push({ id, resolution }); return true; } } });
  const sent: OutboundMessage[] = [];
  const acks: number[] = [];
  const sender = { send: async (_msg: OutboundMessage): Promise<SendResult> => ({ ok: true, messageId: 'synthetic-sent' }) };
  class MemoryAdapter extends BaseChannelAdapter {
    readonly channelType = 'feishu';
    running = false;
    queue: InboundMessage[] = [];
    waiter?: (msg: InboundMessage | null) => void;
    async start() { this.running = true; }
    async stop() { this.running = false; this.waiter?.(null); this.waiter = undefined; }
    isRunning() { return this.running; }
    consumeOne(): Promise<InboundMessage | null> {
      const next = this.queue.shift();
      if (next) return Promise.resolve(next);
      if (!this.running) return Promise.resolve(null);
      return new Promise(resolve => { this.waiter = resolve; });
    }
    async send(msg: OutboundMessage) { sent.push(msg); return sender.send(msg); }
    validateConfig() { return null; }
    isAuthorized() { return true; }
    acknowledgeUpdate(id: number) { acks.push(id); }
    push(msg: InboundMessage) {
      if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(msg); }
      else this.queue.push(msg);
    }
  }
  const adapter = new MemoryAdapter();
  let messageSeq = 0;
  const push = (text: string) => { const id = ++messageSeq; adapter.push({ address, text, messageId: `in-${id}`, updateId: id, timestamp: Date.now() }); return id; };
  const start = async () => { manager.registerAdapter(adapter); await manager.start(); };
  return { address, store, llm, source, sender, sent, acks, audits, mutations, approvals, sessions, bindings, adapter, push, start, queries: () => queries, modelCalls: () => modelCalls };
}

test('/quota@bot、非法参数与失败经过真实消费循环，不修改会话/模型/Token 统计或泄漏私有错误', async () => {
  const f = fixture(); await f.start();
  try {
    f.push('/quota@bot'); await until(() => f.acks.includes(1));
    assert.equal(f.queries(), 1); assert.match(f.sent[0].text, /Codex 账号额度/);
    f.push('/quota extra'); await until(() => f.acks.includes(2));
    assert.equal(f.queries(), 1); assert.match(f.sent.at(-1)?.text || '', /用法：\/quota/);
    f.source.read = async () => { throw new Error('private@example.test private-token private-response'); };
    f.push('/quota'); await until(() => f.acks.includes(3));
    assert.match(f.sent.at(-1)?.text || '', /未能获取账号额度/);
    assert.doesNotMatch(JSON.stringify([f.sent, f.audits]), /private/);
    assert.deepEqual(f.mutations, []); assert.equal(f.modelCalls(), 0);
  } finally { await manager.stop(); }
});

for (const backend of ['claude', 'codex']) {
  test(`${backend} 未提供能力时清楚说明，不创建会话`, async () => {
    const f = fixture(backend); delete f.llm.getAccountQuota; await f.start();
    try { f.push('/quota'); await until(() => f.acks.includes(1)); assert.match(f.sent[0].text, /不支持|未提供.*能力/); assert.deepEqual(f.mutations, []); }
    finally { await manager.stop(); }
  });
}

for (const phase of ['query', 'send']) {
  test(`额度 ${phase} 挂起时 /stop、/new、审批继续消费`, async () => {
    const f = fixture(); const gate = deferred<AccountQuota>(); const sendGate = deferred<SendResult>();
    let entered = false;
    if (phase === 'query') f.source.read = async () => { entered = true; return gate.promise; };
    else f.sender.send = async msg => { if (msg.text.includes('Codex 账号额度')) { entered = true; return sendGate.promise; } return { ok: true }; };
    await f.start();
    try {
      f.push('/quota'); await until(() => entered);
      const stopId = f.push('/stop'); const newId = f.push('/new'); const permId = f.push('/perm allow synthetic-perm');
      await until(() => f.acks.includes(stopId) && f.acks.includes(newId) && f.acks.includes(permId));
      assert.equal(f.sessions.size, 1); assert.equal(f.approvals.length, 1); assert.equal(f.approvals[0].resolution.behavior, 'allow');
      assert.ok(!f.acks.includes(1), '额度尚未结束，控制消息已处理');
      assert.equal(f.modelCalls(), 0);
    } finally { gate.resolve(snapshot()); sendGate.resolve({ ok: true }); await manager.stop(); }
  });
}

test('停机并重启后，旧额度读取成功不发送回执', async () => {
  const f = fixture(); const gate = deferred<AccountQuota>(); f.source.read = async () => gate.promise;
  await f.start();
  try {
    f.push('/quota'); await until(() => f.queries() === 1);
    await manager.stop(); await f.start();
    gate.resolve(snapshot()); await until(() => f.acks.includes(1));
    assert.equal(f.sent.length, 0);
    f.source.read = async () => snapshot(); f.push('/quota'); await until(() => f.acks.includes(2));
    assert.equal(f.sent.length, 1);
  } finally { gate.resolve(snapshot()); await manager.stop(); }
});

test('停机后旧额度读取失败不发送脱敏错误回执', async () => {
  const f = fixture(); const gate = deferred<AccountQuota>(); f.source.read = async () => gate.promise;
  await f.start();
  try {
    f.push('/quota'); await until(() => f.queries() === 1);
    const stopping = manager.stop();
    gate.reject(new Error('synthetic old error'));
    await stopping; await f.start();
    assert.equal(f.sent.length, 0);
  } finally { gate.resolve(snapshot()); await manager.stop(); }
});

test('首块发送挂起后停机，即使首块成功返回也不发送其它额度桶或记录旧审计', async () => {
  const f = fixture(); const gate = deferred<SendResult>();
  f.source.read = async () => ({ queriedAt: Date.now(), buckets: Array.from({ length: 180 }, (_, i) => ({ ...snapshot().buckets[0], limitId: `bucket-${i}`, limitName: '合成额度'.repeat(20) })) });
  f.sender.send = async () => gate.promise;
  await f.start();
  try {
    f.push('/quota'); await until(() => f.sent.length === 1);
    assert.match(f.sent[0].text, /Codex 账号额度/);
    const stopping = manager.stop();
    gate.resolve({ ok: true, messageId: 'old-success' });
    await stopping; await f.start();
    assert.equal(f.sent.length, 1);
    assert.equal(f.audits.filter(row => row.direction === 'outbound').length, 0);
  } finally { gate.resolve({ ok: true }); await manager.stop(); }
});

test('额度发送处于重试退避时停机，不启动第二次发送', async () => {
  const f = fixture();
  f.sender.send = async () => ({ ok: false, httpStatus: 500, error: 'synthetic retry' });
  await f.start();
  try {
    f.push('/quota'); await until(() => f.sent.length === 1);
    await manager.stop(); await f.start();
    assert.equal(f.sent.length, 1);
  } finally { await manager.stop(); }
});

test('多桶首块发送等待中停机，重启后迟到结果不继续分块或重试', async () => {
  const f = fixture(); const gate = deferred<SendResult>();
  f.source.read = async () => ({ queriedAt: Date.now(), buckets: Array.from({ length: 180 }, (_, i) => ({ ...snapshot().buckets[0], limitId: `bucket-${i}`, limitName: '合成额度'.repeat(20) })) });
  f.sender.send = async msg => msg.text.includes('Codex 账号额度') ? gate.promise : { ok: true };
  await f.start();
  try {
    f.push('/quota'); await until(() => f.sent.length === 1);
    assert.match(f.sent[0].text, /Codex 账号额度/);
    await manager.stop(); await f.start();
    gate.resolve({ ok: false, httpStatus: 500, error: 'synthetic stale failure' });
    await delay(30);
    assert.equal(f.sent.length, 1);
  } finally { gate.resolve({ ok: true }); await manager.stop(); }
});

test('额度平台发送微任务尚未开始时失效，不发起发送或写入审计', async () => {
  const f = fixture();
  let current = true;
  const pending = deliver(f.adapter, { address: f.address, text: '合成额度回执', parseMode: 'HTML' }, { isCurrent: () => current });
  // acquire 已恢复，但 adapter.send 仍等待微任务；模拟同一边界的停机。
  await Promise.resolve();
  current = false;
  assert.equal((await pending).ok, false);
  assert.equal(f.sent.length, 0);
  assert.equal(f.audits.length, 0);
});

test('被安全校验拒绝的额度命令回执停机后也不重试', async () => {
  const f = fixture();
  f.sender.send = async () => ({ ok: false, httpStatus: 500, error: 'synthetic retry' });
  await f.start();
  try {
    f.push('/quota ../');
    await until(() => f.sent.length === 1);
    assert.match(f.sent[0].text, /Command rejected/);
    await manager.stop();
    assert.equal(f.queries(), 0);
    assert.equal(f.sent.length, 1);
  } finally { await manager.stop(); }
});
