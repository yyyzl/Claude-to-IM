// 仅审计用：全部状态、模型和渠道均为内存 fake，不读取配置或运行真实客户端。
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { initBridgeContext, getBridgeContext } from '../../../../src/lib/bridge/context.ts';
import type { BridgeStore, StreamChatParams } from '../../../../src/lib/bridge/host.ts';
import type { ChannelBinding, InboundMessage, OutboundMessage } from '../../../../src/lib/bridge/types.ts';
import type { BaseChannelAdapter } from '../../../../src/lib/bridge/channel-adapter.ts';

// 第二道隔离：如生产代码意外试图启动子进程或 fetch，立即使研究失败。
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  mock.method(childProcess, key, () => { throw new Error(`研究禁止真实子进程：${key}`); });
}
syncBuiltinESMExports();
mock.method(globalThis, 'fetch', () => { throw new Error('研究禁止网络 fetch'); });

const manager = await import('../../../../src/lib/bridge/bridge-manager.ts');
const engine = await import('../../../../src/lib/bridge/conversation-engine.ts');
const event = (type: string, data: unknown) => `data: ${JSON.stringify({ type, data: typeof data === 'string' ? data : JSON.stringify(data) })}\n`;
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), '内存 fake 在 500ms 内应满足条件');
}

let serial = 0;
function setup(overrides: Record<string, string> = {}) {
  delete (globalThis as Record<string, unknown>).__bridge_manager__;
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  const chatId = `audit-only-${++serial}`;
  const address = { channelType: 'telegram' as const, chatId, userId: 'audit-user' };
  const sessions = new Map<string, any>([['session-old', { id: 'session-old', working_directory: '', model: 'model-old' }]]);
  let binding: ChannelBinding = { id: 'binding-reused', channelType: 'telegram', chatId, codepilotSessionId: 'session-old', sdkSessionId: '', model: 'model-old', backend: 'claude', workingDirectory: '', mode: 'ask', active: true, createdAt: '', updatedAt: '' };
  const settings = { remote_bridge_enabled: 'true', bridge_llm_backend: 'claude', bridge_input_debounce_ms: '0', bridge_codex_turn_timeout_ms: '5000', ...overrides };
  const noop = () => {};
  const store = {
    getSetting: (key: string) => settings[key as keyof typeof settings] ?? null,
    getChannelBinding: () => ({ ...binding }),
    upsertChannelBinding: (changes: any) => { binding = { ...binding, ...changes }; return { ...binding }; },
    updateChannelBinding: (_id: string, changes: any) => { binding = { ...binding, ...changes }; },
    listChannelBindings: () => [binding], getSession: (id: string) => sessions.get(id),
    createSession: (_title: string, model: string, _prompt: unknown, cwd: string) => {
      const session = { id: `session-new-${sessions.size}`, working_directory: cwd, model };
      sessions.set(session.id, session); return session;
    },
    updateSessionProviderId: noop, addMessage: noop, getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true, renewSessionLock: noop, releaseSessionLock: noop,
    setSessionRuntimeStatus: noop, updateSdkSessionId: noop, updateSessionModel: noop,
    syncSdkTasks: noop, getProvider: () => undefined, getDefaultProviderId: () => null,
    insertAuditLog: noop, checkDedup: () => false, insertDedup: noop, cleanupExpiredDedup: noop,
    insertOutboundRef: noop, insertPermissionLink: noop, getPermissionLink: () => null,
    markPermissionLinkResolved: () => false, listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0', setChannelOffset: noop,
  } as unknown as BridgeStore;
  const turns: Array<{ params: StreamChatParams; controller: ReadableStreamDefaultController<string>; closed: boolean }> = [];
  const fakeLLM = { streamChat: (params: StreamChatParams) => new ReadableStream<string>({ start(controller) { turns.push({ params, controller, closed: false }); } }) };
  initBridgeContext({ store, llm: fakeLLM, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
  assert.equal(getBridgeContext().llm, fakeLLM);
  let running = false;
  let waiter: ((value: InboundMessage | null) => void) | undefined;
  const queue: InboundMessage[] = [];
  const sent: OutboundMessage[] = [];
  const consumed: InboundMessage[] = [];
  let messageId = 0;
  const message = (text: string): InboundMessage => ({ messageId: `audit-${++messageId}`, address, text, timestamp: Date.now() });
  const adapter = {
    channelType: 'telegram', start: async () => { running = true; }, stop: async () => { running = false; waiter?.(null); waiter = undefined; },
    isRunning: () => running, validateConfig: () => null, isAuthorized: () => true,
    consumeOne: async () => { const value = queue.length ? queue.shift()! : await new Promise<InboundMessage | null>(resolve => { waiter = resolve; }); if (value) consumed.push(value); return value; },
    send: async (out: OutboundMessage) => { sent.push(out); return { ok: true, messageId: `sent-${sent.length}` }; },
  } as unknown as BaseChannelAdapter;
  function push(text: string) { const value = message(text); if (waiter) { const w = waiter; waiter = undefined; w(value); } else queue.push(value); }
  function close(index: number, sdk = 'audit-sdk-old') { const turn = turns[index]; if (turn.closed) return; turn.closed = true; turn.controller.enqueue(event('result', { is_error: false, session_id: sdk })); turn.controller.close(); }
  async function launch() { manager.registerAdapter(adapter); await manager.start(); }
  async function cleanup() { await manager.stop(); for (let i = 0; i < turns.length; i++) close(i); await delay(20); for (let i = 0; i < turns.length; i++) close(i); await delay(10); }
  return { address, adapter, store, message, push, sent, consumed, turns, close, launch, cleanup, getBinding: () => ({ ...binding }) };
}

test('确认：透传命令占住渠道接收循环，后续 /stop 直到模型结束才被消费', { timeout: 1500 }, async () => {
  const f = setup();
  try {
    await f.launch(); f.push('//review audit-only'); await until(() => f.turns.length === 1);
    f.push('/stop'); await delay(30);
    assert.equal(f.consumed.length, 1);
    assert.equal(f.turns[0].params.abortController.signal.aborted, false);
    f.close(0); await until(() => f.consumed.length === 2);
    await until(() => f.sent.some(m => m.text.includes('No task is currently running')));
  } finally { await f.cleanup(); }
});

test('确认：旧回合在 /new 后把旧模型与 SDK 会话写回新绑定', { timeout: 1500 }, async () => {
  const f = setup();
  const oldTask = manager._testOnly.handleMessage(f.adapter, f.message('old request'));
  try {
    await until(() => f.turns.length === 1);
    await manager._testOnly.handleMessage(f.adapter, f.message('/new'));
    assert.notEqual(f.getBinding().codepilotSessionId, 'session-old');
    assert.equal(f.getBinding().sdkSessionId, '');
    f.turns[0].controller.enqueue(event('status', { model: 'old-late-model' }));
    f.close(0); await oldTask;
    assert.equal(f.getBinding().model, 'old-late-model');
    assert.equal(f.getBinding().sdkSessionId, 'audit-sdk-old');
  } finally { await f.cleanup(); await oldTask; }
});

test('确认：bridge stop 不取消当前回合，且停止后还会启动追加回合', { timeout: 1500 }, async () => {
  const f = setup();
  try {
    await f.launch(); f.push('first'); await until(() => f.turns.length === 1);
    f.push('follow-up'); await until(() => f.consumed.length === 2);
    await manager.stop();
    assert.equal(manager.getStatus().running, false);
    assert.equal(f.turns[0].params.abortController.signal.aborted, false);
    f.close(0); await until(() => f.turns.length === 2);
    assert.equal(f.turns[1].params.prompt, 'follow-up'); f.close(1);
  } finally { await f.cleanup(); }
});

test('确认：debounce 等待中的请求无法用 /stop 取消', { timeout: 1500 }, async () => {
  const f = setup({ bridge_input_debounce_ms: '80' });
  try {
    await f.launch(); f.push('pending request'); await until(() => f.consumed.length === 1);
    f.push('/stop'); await until(() => f.sent.some(m => m.text.includes('No task is currently running')));
    await until(() => f.turns.length === 1); assert.equal(f.turns[0].params.prompt, 'pending request');
    f.close(0);
  } finally { await f.cleanup(); }
});

test('确认：排队请求在 /new 后按新会话执行，却持有旧会话的队列锁', { timeout: 1500 }, async () => {
  const f = setup({ bridge_append_enabled: 'false' });
  try {
    await f.launch(); f.push('first'); await until(() => f.turns.length === 1);
    f.push('queued-old-context'); await until(() => f.consumed.length === 2);
    await manager._testOnly.handleMessage(f.adapter, f.message('/new'));
    const newSession = f.getBinding().codepilotSessionId;
    f.close(0); await until(() => f.turns.length === 2);
    assert.equal(f.turns[1].params.prompt, 'queued-old-context');
    assert.equal(f.turns[1].params.sessionId, newSession); f.close(1);
  } finally { await f.cleanup(); }
});

test('确认：turn 超时仅通知 abort，不会使不响应 abort 的 stream read 结束', { timeout: 1500 }, async () => {
  const f = setup({ bridge_codex_turn_timeout_ms: '20' });
  let finished = false;
  const pending = engine.processMessage(f.getBinding(), 'in-memory stalled stream').then(result => { finished = true; return result; });
  try {
    await until(() => f.turns.length === 1); await delay(50);
    assert.equal(f.turns[0].params.abortController.signal.aborted, true);
    assert.equal(finished, false);
    f.close(0); await pending;
  } finally { await f.cleanup(); await pending; }
});
