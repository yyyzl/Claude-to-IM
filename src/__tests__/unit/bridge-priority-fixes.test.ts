import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { initBridgeContext } from '../../lib/bridge/context.js';
import type { BridgeStore, ResponseDeliveryRecord } from '../../lib/bridge/host.js';
import type { InboundMessage, OutboundMessage, SendResult } from '../../lib/bridge/types.js';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter.js';
import { JsonFileBridgeStore } from '../../../scripts/claude-to-im-bridge/store.js';

for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  mock.method(childProcess, key, () => { throw new Error(`禁止真实子进程：${key}`); });
}
syncBuiltinESMExports();
mock.method(globalThis, 'fetch', () => { throw new Error('禁止真实网络'); });
const manager = await import('../../lib/bridge/bridge-manager.js');

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__bridge_manager__;
  delete (globalThis as Record<string, unknown>).__bridge_context__;
});

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 400;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), 'fake 应在 400ms 内满足条件');
}

let serial = 0;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-priority-test-'));
  const file = path.join(root, 'synthetic.json');
  const store = new JsonFileBridgeStore({ projectRoot: root, dataPath: file });
  const chatId = `priority-${++serial}`;
  const address = { channelType: 'telegram' as const, chatId, userId: 'synthetic-user' };
  const old = store.createSession('旧项目', 'model', undefined, root);
  const target = store.createSession('另一个会话', 'model', undefined, root);
  store.upsertChannelBinding({ ...address, codepilotSessionId: old.id, workingDirectory: root, model: 'model' });
  const settings: Record<string, string> = { remote_bridge_enabled: 'true', bridge_llm_backend: 'claude', bridge_input_debounce_ms: '0', bridge_delivery_timeout_ms: '800' };
  store.getSetting = key => settings[key] ?? null;
  let modelCalls = 0;
  const permissions: string[] = [];
  initBridgeContext({ store, llm: { streamChat: () => { modelCalls++; throw new Error('本回归禁止模型调用'); } }, permissions: { resolvePendingPermission: id => { permissions.push(id); return true; } }, lifecycle: {} });
  let running = false;
  let waiter: ((message: InboundMessage | null) => void) | undefined;
  const queue: InboundMessage[] = [];
  const sent: OutboundMessage[] = [];
  const consumed: InboundMessage[] = [];
  const acked = new Set<number>();
  let messageId = 0;
  const message = (text: string, chat = chatId): InboundMessage => ({ messageId: `message-${++messageId}`, updateId: messageId, address: { ...address, chatId: chat }, text, timestamp: Date.now() });
  const adapter = {
    channelType: 'telegram', start: async () => { running = true; }, stop: async () => { running = false; waiter?.(null); waiter = undefined; },
    isRunning: () => running, validateConfig: () => null, isAuthorized: () => true,
    consumeOne: async () => { const m = queue.length ? queue.shift()! : await new Promise<InboundMessage | null>(resolve => { waiter = resolve; }); if (m) consumed.push(m); return m; },
    send: async (out: OutboundMessage) => { sent.push(out); return { ok: true, messageId: `sent-${sent.length}` }; },
    acknowledgeUpdate: (id: number) => { acked.add(id); },
  } as unknown as BaseChannelAdapter;
  function push(text: string, chat = chatId) { const m = message(text, chat); if (waiter) { const w = waiter; waiter = undefined; w(m); } else queue.push(m); return m; }
  function seedDelivery() {
    const now = new Date().toISOString();
    const row: ResponseDeliveryRecord = { id: `answer-${serial}`, sessionId: old.id, address, responseText: 'first\nsecond', chunks: [{ text: 'first', sent: false, parseMode: 'plain' }, { text: 'second', sent: false, parseMode: 'plain' }], status: 'failed', attempts: 1, createdAt: now, updatedAt: now };
    store.saveResponseDelivery(row); return row.id;
  }
  async function launch() { manager.registerAdapter(adapter); await manager.start(); }
  async function cleanup() { await manager.stop(); await store.close(); }
  return { root, file, store, address, old, target, adapter, message, push, sent, consumed, acked, permissions, settings, seedDelivery, launch, cleanup, modelCalls: () => modelCalls };
}

test('/retry 网络等待不占控制通道，其他聊天 stop 与审批可继续', { timeout: 2500 }, async () => {
  const f = fixture();
  const id = f.seedDelivery();
  const originalSend = f.adapter.send.bind(f.adapter);
  let release!: (value: SendResult) => void;
  f.adapter.send = out => out.text === 'first' ? new Promise(resolve => { release = resolve; }) : originalSend(out);
  try {
    await f.launch(); f.push(`/retry ${id}`); await until(() => Boolean(release));
    f.store.insertPermissionLink({ permissionRequestId: 'pending', channelType: 'telegram', chatId: 'other', messageId: 'card', toolName: 'fake', suggestions: '[]' });
    const stop = f.push('/stop', 'other');
    f.push('/perm allow pending', 'other');
    await until(() => f.acked.has(stop.updateId!) && f.permissions.includes('pending'));
    assert.equal(f.modelCalls(), 0);
  } finally { release?.({ ok: true, messageId: 'first-sent' }); await f.cleanup(); }
});

for (const command of ['/stop', '/new', '/bind']) {
  test(`${command} 取消补发后续块，保留已进入平台且成功的块，旧完成消息不污染新会话`, { timeout: 2500 }, async () => {
    const f = fixture();
    const id = f.seedDelivery();
    const originalSend = f.adapter.send.bind(f.adapter);
    let release!: (value: SendResult) => void;
    f.adapter.send = out => out.text === 'first' ? new Promise(resolve => { release = resolve; }) : originalSend(out);
    try {
      await f.launch(); f.push(`/retry ${id}`); await until(() => Boolean(release));
      const control = f.push(command === '/bind' ? `/bind ${f.target.id}` : command);
      await until(() => f.acked.has(control.updateId!));
      release({ ok: true, messageId: 'first-sent' });
      await until(() => f.store.getResponseDelivery(id)?.status === 'failed');
      assert.equal(f.store.getResponseDelivery(id)?.chunks[0].sent, true);
      assert.equal(f.store.getResponseDelivery(id)?.chunks[1].sent, false);
      assert.ok(!f.sent.some(out => out.text === 'second' || out.text.includes('回答已送达') || out.text.includes('重投失败')));
      await f.store.flush();
      await new Promise(resolve => setImmediate(resolve));
      f.adapter.send = originalSend;
      f.push(`/retry ${id}`);
      await until(() => f.store.getResponseDelivery(id)?.status === 'delivered');
      assert.equal(f.sent.filter(out => out.text === 'first').length, 0);
      assert.equal(f.sent.filter(out => out.text === 'second').length, 1);
      assert.equal(f.modelCalls(), 0);
    } finally { release?.({ ok: true }); await f.cleanup(); }
  });
}

test('重复 /retry 不重复发送；停机有界且晚到成功不触发后续块', { timeout: 3000 }, async () => {
  const f = fixture();
  const id = f.seedDelivery();
  const originalSend = f.adapter.send.bind(f.adapter);
  let release!: (value: SendResult) => void;
  let sends = 0;
  f.adapter.send = out => out.text === 'first' ? new Promise(resolve => { sends++; release = resolve; }) : originalSend(out);
  try {
    await f.launch(); f.push(`/retry ${id}`); await until(() => Boolean(release));
    const duplicate = f.push(`/retry ${id}`); await until(() => f.acked.has(duplicate.updateId!));
    assert.equal(sends, 1);
    const stopping = manager.stop();
    release({ ok: true, messageId: 'first-sent' });
    await stopping;
    assert.equal(f.store.getResponseDelivery(id)?.chunks[0].sent, true);
    assert.equal(f.store.getResponseDelivery(id)?.chunks[1].sent, false);
    assert.ok(!f.sent.some(out => out.text === 'second' || out.text.includes('回答已送达')));
  } finally { release?.({ ok: true }); await f.cleanup(); }
});

test('JSON 历史随绑定持久化，new 后列表可复制完整 ID 并切回，跨聊天与渠道隔离', async () => {
  const f = fixture();
  try {
    f.store.upsertChannelBinding({ channelType: 'telegram', chatId: 'other', codepilotSessionId: f.target.id, workingDirectory: '/private', model: 'model' });
    f.store.upsertChannelBinding({ channelType: 'feishu', chatId: f.address.chatId, codepilotSessionId: f.target.id, workingDirectory: '/private', model: 'model' });
    await manager._testOnly.handleMessage(f.adapter, f.message('/new'));
    const current = f.store.getChannelBinding('telegram', f.address.chatId)!.codepilotSessionId;
    await manager._testOnly.handleMessage(f.adapter, f.message('/sessions'));
    const listing = f.sent.at(-1)!.text;
    assert.ok(listing.includes(`/bind ${f.old.id}`));
    assert.ok(listing.includes(current));
    assert.ok(listing.includes('当前'));
    assert.ok(listing.includes('旧项目'));
    assert.ok(!listing.includes(f.target.id) && !listing.includes('/private'));
    await manager._testOnly.handleMessage(f.adapter, f.message(`/bind ${f.old.id}`));
    assert.equal(f.store.getChannelBinding('telegram', f.address.chatId)!.codepilotSessionId, f.old.id);
    await f.store.close();
    const reopened = new JsonFileBridgeStore({ projectRoot: f.root, dataPath: f.file }) as BridgeStore;
    assert.deepEqual(new Set(reopened.listChannelSessionHistory!('telegram', f.address.chatId).map(row => row.sessionId)), new Set([f.old.id, current]));
    await reopened.close!();
  } finally { await f.cleanup(); }
});

test('旧 JSON 只导入有明确绑定的会话，不猜孤立会话归属', async () => {
  const f = fixture();
  await f.store.close();
  const raw = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  delete raw.channelSessionHistory;
  fs.writeFileSync(f.file, JSON.stringify(raw));
  const reopened = new JsonFileBridgeStore({ projectRoot: f.root, dataPath: f.file }) as BridgeStore;
  try {
    assert.deepEqual(reopened.listChannelSessionHistory!('telegram', f.address.chatId).map(row => row.sessionId), [f.old.id]);
    assert.deepEqual(reopened.listChannelSessionHistory!('telegram', 'unrelated'), []);
  } finally { await reopened.close!(); }
});

test('没有历史能力的宿主只展示当前聊天，并说明范围', async () => {
  const f = fixture();
  (f.store as BridgeStore).listChannelSessionHistory = undefined;
  try {
    f.store.upsertChannelBinding({ channelType: 'telegram', chatId: 'other', codepilotSessionId: f.target.id, workingDirectory: '/private', model: 'model' });
    await manager._testOnly.handleMessage(f.adapter, f.message('/sessions'));
    const listing = f.sent.at(-1)!.text;
    assert.ok(listing.includes(f.old.id));
    assert.ok(listing.includes('仅显示当前会话'));
    assert.ok(!listing.includes(f.target.id));
  } finally { await f.cleanup(); }
});

test('补发发送永久悬挂时停机仍有界，迟到返回不继续发送', { timeout: 2000 }, async () => {
  const f = fixture();
  f.settings.bridge_delivery_timeout_ms = '100';
  const id = f.seedDelivery();
  const originalSend = f.adapter.send.bind(f.adapter);
  let release!: (value: SendResult) => void;
  f.adapter.send = out => out.text === 'first' ? new Promise(resolve => { release = resolve; }) : originalSend(out);
  try {
    await f.launch(); f.push(`/retry ${id}`); await until(() => Boolean(release));
    const started = Date.now();
    await manager.stop();
    assert.ok(Date.now() - started < 1500);
    assert.equal(f.store.getResponseDelivery(id)?.status, 'failed');
    release({ ok: true, messageId: 'late-unknown' });
    await delay(25);
    assert.ok(!f.sent.some(out => out.text === 'second' || out.text.includes('回答已送达')));
  } finally { release?.({ ok: true }); await f.cleanup(); }
});

test('会话历史分页可遍历全部条目，特殊字符转义且校验页码', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 7; i++) {
      const session = f.store.createSession(`<项目&${i}>`, 'model', undefined, `/tmp/<${i}>`);
      f.store.upsertChannelBinding({ ...f.address, codepilotSessionId: session.id, workingDirectory: session.working_directory, model: 'model' });
    }
    await manager._testOnly.handleMessage(f.adapter, f.message('/sessions'));
    const first = f.sent.at(-1)!.text;
    await manager._testOnly.handleMessage(f.adapter, f.message('/sessions 2'));
    const second = f.sent.at(-1)!.text;
    assert.ok(first.includes('/sessions 2'));
    assert.ok(second.includes('/sessions 1'));
    const ids = [...(first + second).matchAll(/\/bind ([\da-f-]+)/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, 8);
    assert.ok((first + second).includes('&lt;项目&amp;'));
    assert.ok(!(first + second).includes('<项目&'));
    await manager._testOnly.handleMessage(f.adapter, f.message('/sessions 3'));
    assert.ok(f.sent.at(-1)!.text.includes('页码超出范围'));
    await manager._testOnly.handleMessage(f.adapter, f.message('/sessions 0'));
    assert.ok(f.sent.at(-1)!.text.includes('用法'));
  } finally { await f.cleanup(); }
});

test('历史去重并返回独立副本，绑定更新和重载保留目录', async () => {
  const f = fixture();
  try {
    const binding = f.store.getChannelBinding('telegram', f.address.chatId)!;
    f.store.updateChannelBinding(binding.id, { workingDirectory: '/new-cwd' });
    const rows = (f.store as BridgeStore).listChannelSessionHistory!('telegram', f.address.chatId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].workingDirectory, '/new-cwd');
    rows[0].title = '改坏副本';
    assert.equal((f.store as BridgeStore).listChannelSessionHistory!('telegram', f.address.chatId)[0].title, '旧项目');
    await f.store.close();
    const reopened = new JsonFileBridgeStore({ projectRoot: f.root, dataPath: f.file }) as BridgeStore;
    assert.equal(reopened.listChannelSessionHistory!('telegram', f.address.chatId)[0].workingDirectory, '/new-cwd');
    await reopened.close!();
  } finally { await f.cleanup(); }
});

test('损坏历史字段拒绝空载启动，不吞掉其余有效数据', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-history-invalid-'));
  const file = path.join(root, 'synthetic.json');
  fs.writeFileSync(file, JSON.stringify({ sessions: {}, bindings: {}, messages: {}, channelOffsets: {}, channelSessionHistory: { 'telegram:chat': [{ sessionId: 123 }] } }));
  assert.throws(() => new JsonFileBridgeStore({ projectRoot: root, dataPath: file }), /存储损坏/);
});

for (const failure of ['flush', 'list']) {
  test(`后台补发 ${failure} 失败对当前聊天明确反馈，不发送正文或重调模型`, { timeout: 2000 }, async () => {
    const f = fixture();
    const id = f.seedDelivery();
    await f.store.flush();
    const originalFlush = f.store.flush.bind(f.store);
    const originalList = f.store.listResponseDeliveries.bind(f.store);
    if (failure === 'flush') f.store.flush = async () => { throw new Error('synthetic flush failed'); };
    else f.store.listResponseDeliveries = () => { throw new Error('synthetic list failed'); };
    try {
      await f.launch(); f.push(`/retry ${id}`);
      await until(() => f.sent.some(out => out.text.includes(`synthetic ${failure} failed`)));
      assert.ok(!f.sent.some(out => out.text === 'first' || out.text === 'second'));
      assert.equal(f.store.getResponseDelivery(id)?.chunks[0].sent, false);
      assert.equal(f.modelCalls(), 0);
    } finally { f.store.flush = originalFlush; f.store.listResponseDeliveries = originalList; await f.cleanup(); }
  });
}
