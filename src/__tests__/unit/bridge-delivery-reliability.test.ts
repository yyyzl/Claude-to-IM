import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { initBridgeContext } from '../../lib/bridge/context.js';
import type { BridgeStore, ResponseDeliveryRecord } from '../../lib/bridge/host.js';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter.js';
import type { SendResult, OutboundMessage } from '../../lib/bridge/types.js';
import { deliver, deliverRendered, deliverSingle } from '../../lib/bridge/delivery-layer.js';
import { deliverResponse, retryResponseDelivery, getResponseDeliveryStatus } from '../../lib/bridge/response-delivery.js';
import { forwardPermissionRequest, handlePermissionCallback } from '../../lib/bridge/permission-broker.js';
import { forwardUserInputRequest, handleUserInputText } from '../../lib/bridge/user-input-broker.js';
import { InMemoryPermissionGateway } from '../../../scripts/claude-to-im-bridge/permissions.js';
import { splitFeishuMarkdown, feishuPayloadBytes } from '../../lib/bridge/markdown/feishu.js';
import { ChatRateLimiter } from '../../lib/bridge/security/rate-limiter.js';

const blocked = () => { throw new Error('测试禁止真实网络和子进程'); };
mock.method(net.Socket.prototype, 'connect', blocked);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const) mock.method(childProcess, name, blocked);
mock.method(globalThis, 'fetch', blocked);
syncBuiltinESMExports();
let sequence = 0;
function fixture(channelType = 'telegram', isDurable = true) {
  const address = { channelType, chatId: `reliable-${++sequence}`, userId: 'owner' };
  const rows = new Map<string, ResponseDeliveryRecord>(); const dedup = new Set<string>();
  const refs: unknown[] = []; const audit: unknown[] = []; const links = new Map<string, any>();
  const store = {
    getSetting: () => null, checkDedup: (key: string) => dedup.has(key), insertDedup: (key: string) => dedup.add(key), cleanupExpiredDedup() {},
    insertOutboundRef: (value: unknown) => refs.push(value), insertAuditLog: (value: unknown) => audit.push(value),
    insertPermissionLink: (value: any) => links.set(value.permissionRequestId, { ...value, resolved: false }), getPermissionLink: (id: string) => links.get(id),
    markPermissionLinkResolved: (id: string) => { const row = links.get(id); if (!row || row.resolved) return false; row.resolved = true; return true; },
    ...(isDurable ? { saveResponseDelivery: (value: ResponseDeliveryRecord) => rows.set(value.id, structuredClone(value)), getResponseDelivery: (id: string) => rows.get(id) ?? null,
      listResponseDeliveries: () => [...rows.values()].map(value => structuredClone(value)), flush: async () => {} } : {}),
  } as unknown as BridgeStore;
  const permissions = new InMemoryPermissionGateway({ permissionTimeoutMs: 0 });
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({ store, permissions, llm: { streamChat: blocked }, lifecycle: {} });
  const sent: OutboundMessage[] = [];
  const adapter = { channelType, send: async (message: OutboundMessage) => { sent.push(message); return { ok: true, messageId: `m${sent.length}` }; } } as BaseChannelAdapter;
  return { address, rows, dedup, refs, audit, links, store, permissions, sent, adapter };
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve: (value: T) => resolve(value) }; }

test('HTML 降级后的 429 按最新错误重试 plain', async () => {
  const f = fixture(); let calls = 0; const modes: unknown[] = [];
  f.adapter.send = async message => { modes.push(message.parseMode); return ++calls === 1 ? { ok: false, httpStatus: 400, error: "can't parse entities" } : calls === 2 ? { ok: false, httpStatus: 429, retryAfter: 0.001, error: 'rate limit' } : { ok: true }; };
  assert.equal((await deliverSingle(f.adapter, { address: f.address, text: '<b>hello', parseMode: 'HTML' }, 'hello')).ok, true);
  assert.deepEqual(modes, ['HTML', 'plain', 'plain']);
});

test('部分失败不误标整条去重，重试不再发送已成功块', async () => {
  const f = fixture(); let fail = true; const content: string[] = [];
  f.adapter.send = async message => { content.push(message.text); return message.text === 'two' && fail ? { ok: false, httpStatus: 400, error: 'bad' } : { ok: true, messageId: 'm' }; };
  const chunks = ['one', 'two'].map(text => ({ text, html: text }));
  assert.equal((await deliverRendered(f.adapter, f.address, chunks, { dedupKey: 'partial' })).ok, false);
  assert.equal(f.dedup.has('partial'), false); fail = false;
  assert.equal((await deliverRendered(f.adapter, f.address, chunks, { dedupKey: 'partial' })).ok, true);
  assert.equal(content.filter(text => text === 'one').length, 1);
  assert.equal(content.filter(text => text === 'two').length, 2);
});

test('durable 回答先 flush；逐块保存进度，补发不调用模型并保留引用审计', async () => {
  const f = fixture(); let fail = true;
  f.adapter.send = async message => {
    assert.ok(f.rows.size); f.sent.push(message);
    return f.sent.length === 2 && fail ? { ok: false, httpStatus: 400, error: 'rejected' } : { ok: true, messageId: `m${f.sent.length}` };
  };
  const result = await deliverResponse(f.adapter, f.address, 'x'.repeat(6000), 's', 'inbound');
  assert.equal(result.ok, false); const row = [...f.rows.values()][0];
  assert.equal(row.status, 'failed'); assert.equal(row.chunks[0].sent, true); assert.equal(row.chunks[1].sent, false);
  assert.match(getResponseDeliveryStatus(f.address), /\/retry/);
  fail = false;
  assert.equal((await retryResponseDelivery(f.adapter, f.address, row.id)).ok, true);
  assert.equal(f.sent.length, 3); assert.equal(f.refs.length, 2); assert.equal(f.audit.length, 2);
  assert.deepEqual(f.rows.get(row.id)?.chunks, []); assert.equal(f.rows.get(row.id)?.responseText, '');
});

test('持久化失败不发送、不finalize，内存降级明确提示', async () => {
  const f = fixture(); let finalized = false;
  f.store.flush = async () => { throw new Error('disk full'); };
  assert.equal((await deliverResponse(f.adapter, f.address, 'answer', 's', undefined, { finalize: async () => { finalized = true; return true; } })).ok, false);
  assert.equal(f.sent.length, 0); assert.equal(finalized, false);
  const weak = fixture('telegram', false); weak.adapter.send = async () => ({ ok: false, httpStatus: 400, error: 'bad' });
  assert.match((await deliverResponse(weak.adapter, weak.address, 'answer', 's')).error!, /重启可能丢失/);
});

test('补发校验来源并按记录互斥；取消后不继续发送下一块', async () => {
  const f = fixture(); f.adapter.send = async () => ({ ok: false, httpStatus: 400, error: 'bad' });
  await deliverResponse(f.adapter, f.address, 'answer', 's'); const id = [...f.rows.keys()][0];
  assert.equal((await retryResponseDelivery(f.adapter, { ...f.address, userId: 'stranger' }, id)).ok, false);
  const wait = deferred<SendResult>(); f.adapter.send = async () => wait.promise;
  const first = retryResponseDelivery(f.adapter, f.address, id);
  assert.match((await retryResponseDelivery(f.adapter, f.address, id)).error!, /正在发送/);
  wait.resolve({ ok: true }); assert.equal((await first).ok, true);
  const newer = fixture(); let current = true;
  newer.adapter.send = async message => { newer.sent.push(message); current = false; return { ok: true }; };
  assert.equal((await deliverResponse(newer.adapter, newer.address, 'x'.repeat(6000), 's', undefined, { isCurrent: () => current })).ok, false);
  assert.equal(newer.sent.length, 1);
});

test('QQ 保留最多三段策略', async () => {
  const f = fixture('qq'); assert.equal((await deliverResponse(f.adapter, f.address, 'x'.repeat(10000), 's')).ok, true);
  assert.equal(f.sent.length, 3); assert.match(f.sent[2].text, /truncated/);
});

test('中文 emoji 转义与代码围栏按完整 UTF8 payload 分块', () => {
  for (const text of ['😀', '中文😀"\\'.repeat(10000), '```ts\n' + 'const x = "中文😀\\";\n'.repeat(4000) + '```']) {
    const parts = splitFeishuMarkdown(text);
    assert.ok(parts.every(part => feishuPayloadBytes(part) <= 28000));
    assert.ok(parts.every(part => !/[\uD800-\uDBFF]$/.test(part)));
    if (text.startsWith('```')) assert.ok(parts.every(part => part.startsWith('```ts\n') && part.trimEnd().endsWith('```')));
    else assert.equal(parts.join(''), text);
  }
});

test('审批发送失败/登记失败立即 deny，失败去重可重试', async () => {
  const f = fixture(); const id = `perm-${sequence}`; let sends = 0;
  f.adapter.send = async () => { sends++; return { ok: false, httpStatus: 400, error: 'bad' }; };
  const waiting = f.permissions.waitFor(id); await forwardPermissionRequest(f.adapter, f.address, id, 'tool', {});
  assert.equal((await waiting).reason, 'delivery_failed');
  const again = f.permissions.waitFor(id); await forwardPermissionRequest(f.adapter, f.address, id, 'tool', {});
  assert.equal((await again).behavior, 'deny'); assert.equal(sends, 2);
  f.adapter.send = async () => ({ ok: true, messageId: 'card' }); f.store.insertPermissionLink = () => { throw new Error('store failed'); };
  const second = f.permissions.waitFor(`${id}-register`); await forwardPermissionRequest(f.adapter, f.address, `${id}-register`, 'tool', {});
  assert.equal((await second).reason, 'delivery_failed');
});

test('审批真实允许与到期回写原卡；迟到投递不登记可批准链接', async () => {
  const f = fixture(); const updates: string[] = [];
  f.adapter.updateInteractionMessage = async (_address, message, status) => { updates.push(`${message}:${status}`); };
  const id = `allow-${sequence}`; const waiting = f.permissions.waitFor(id);
  await forwardPermissionRequest(f.adapter, f.address, id, 'tool', {});
  assert.equal(handlePermissionCallback(`perm:allow:${id}`, f.address.chatId, 'm1'), true); await waiting;
  assert.deepEqual(updates, ['m1:allowed']);
  const slow = deferred<SendResult>(); f.adapter.send = async () => slow.promise;
  const expired = `${id}-expired`; const pending = f.permissions.waitFor(expired);
  const forwarding = forwardPermissionRequest(f.adapter, f.address, expired, 'tool', {});
  f.permissions.resolvePendingPermission(expired, { behavior: 'deny', reason: 'expired' }); await pending;
  slow.resolve({ ok: true, messageId: 'late' }); await forwarding;
  assert.equal(f.links.has(expired), false); assert.ok(updates.includes('late:expired'));
});

test('问答使用网关真实期限，终态移除入口并回写卡片', async () => {
  const f = fixture(); const updates: string[] = [];
  f.adapter.sendUserInputRequest = async () => ({ ok: true, messageId: 'question' });
  f.adapter.updateInteractionMessage = async (_a, _m, status) => { updates.push(status); };
  const id = `question-${sequence}`; const pending = f.permissions.waitFor(id);
  await forwardUserInputRequest(f.adapter, f.address, { requestId: id, questions: [{ id: 'q', question: 'answer' }] }, 's');
  f.permissions.resolvePendingPermission(id, { behavior: 'deny', reason: 'expired' }); await pending;
  assert.equal(handleUserInputText(f.address, `/answer ${id} hello`), false); assert.deepEqual(updates, ['expired']);
});

test('网关真实超时和 abort 通知只发一次', async () => {
  const gateway = new InMemoryPermissionGateway({ permissionTimeoutMs: 5 });
  const seen: string[] = []; gateway.onResolution('expiring', resolution => seen.push(resolution.reason!));
  assert.equal((await gateway.waitFor('expiring')).reason, 'expired');
  assert.equal(gateway.resolvePendingPermission('expiring', { behavior: 'allow' }), false);
  const controller = new AbortController(); gateway.onResolution('abort', resolution => seen.push(resolution.reason!));
  const pending = gateway.waitFor('abort', controller.signal); controller.abort(); await pending;
  assert.deepEqual(seen, ['expired', 'cancelled']);
});

test('卡片或发送永久挂起有界释放 running，未知结果不自动 fallback', async () => {
  for (const mode of ['finalize', 'send']) {
    const f = fixture(); f.store.getSetting = () => '5';
    const never = new Promise<boolean>(() => {});
    if (mode === 'send') f.adapter.send = async () => { f.sent.push({ address: f.address, text: 'pending' }); await never; return { ok: true }; };
    const result = await deliverResponse(f.adapter, f.address, 'answer', 's', undefined, mode === 'finalize' ? { finalize: () => never } : {});
    assert.equal(result.ok, false); assert.match(result.error!, /超时/); assert.equal(f.sent.length, mode === 'send' ? 1 : 0);
    f.adapter.send = async () => ({ ok: true }); assert.equal((await retryResponseDelivery(f.adapter, f.address)).ok, true);
  }
});

test('rate limiter 等待也有界，迟到许可不会再发送', async () => {
  const f = fixture(); f.store.getSetting = () => '5'; const gate = deferred<void>();
  const acquire = mock.method(ChatRateLimiter.prototype, 'acquire', () => gate.promise);
  try {
    assert.equal((await deliverResponse(f.adapter, f.address, 'answer', 's')).ok, false);
    gate.resolve(); await new Promise<void>(r => setImmediate(r)); assert.equal(f.sent.length, 0);
  } finally { acquire.mock.restore(); }
});

test('无持久宿主的成功元数据最多保留 100 条', async () => {
  const f = fixture('telegram', false);
  for (let i = 0; i < 105; i++) assert.equal((await deliverResponse(f.adapter, f.address, `answer-${i}`, 's', undefined, { turnId: String(i), finalize: async () => true })).ok, true);
  assert.equal(f.sent.length, 0);
  // 最旧记录会被淘汰；重投同一 identity 会重新执行 finalize。
  let repeated = false;
  await deliverResponse(f.adapter, f.address, 'answer-0', 's', undefined, { turnId: '0', finalize: async () => { repeated = true; return true; } });
  assert.equal(repeated, true);
});

test('发送成功后进度 flush 失败，当前进程补发跳过已确认送达块', async () => {
  const f = fixture(); let flushes = 0;
  f.store.flush = async () => { if (++flushes === 2) throw new Error('progress disk failure'); };
  assert.equal((await deliverResponse(f.adapter, f.address, 'x'.repeat(6000), 's')).ok, false);
  assert.equal(f.sent.length, 1); assert.equal((await retryResponseDelivery(f.adapter, f.address)).ok, true);
  assert.equal(f.sent.length, 2);
});

test('broker 消费事件前已过期，不再发送永久等待的审批或问答卡', async () => {
  const f = fixture(); const id = `already-expired-${sequence}`;
  const pending = f.permissions.waitFor(id); f.permissions.resolvePendingPermission(id, { behavior: 'deny', reason: 'expired' }); await pending;
  await forwardPermissionRequest(f.adapter, f.address, id, 'tool', {});
  await forwardUserInputRequest(f.adapter, f.address, { requestId: id, questions: [{ id: 'q', question: 'answer' }] }, 's');
  assert.equal(f.sent.length, 0); assert.equal(f.links.has(id), false);
});
