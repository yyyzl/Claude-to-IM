import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { initBridgeContext } from '../../lib/bridge/context.js';
import { BaseChannelAdapter } from '../../lib/bridge/channel-adapter.js';
import type { BridgeStore, ResponseDeliveryRecord } from '../../lib/bridge/host.js';
import type { OutboundMessage, SendResult } from '../../lib/bridge/types.js';
import { deliverResponse, retryResponseDelivery } from '../../lib/bridge/response-delivery.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const image = (id = 'image-1') => ({ id, mimeType: 'image/png' as const, data: PNG,
  byteLength: Buffer.from(PNG, 'base64').length, sha256: createHash('sha256').update(Buffer.from(PNG, 'base64')).digest('hex') });
const blocked = () => { throw new Error('测试禁止真实网络或模型'); };
mock.method(net.Socket.prototype, 'connect', blocked);
mock.method(globalThis, 'fetch', blocked);
let sequence = 0;
class ImageAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu';
  async start() {}
  async stop() {}
  isRunning() { return true; }
  async consumeOne() { return null; }
  validateConfig() { return null; }
  isAuthorized() { return true; }
  send = async (_message: OutboundMessage): Promise<SendResult> => ({ ok: true, messageId: 'sent' });
  uploadImage = async (_image: ReturnType<typeof image>): Promise<{ ok: boolean; imageKey?: string; error?: string }> => ({ ok: true, imageKey: 'key' });
}
function fixture() {
  const address = { channelType: 'feishu', chatId: `media-${++sequence}`, userId: 'owner' };
  const rows = new Map<string, ResponseDeliveryRecord>();
  const snapshots: ResponseDeliveryRecord[] = [];
  const audit: string[] = [];
  const store = {
    getSetting: () => null,
    saveResponseDelivery: (record: ResponseDeliveryRecord) => rows.set(record.id, structuredClone(record)),
    getResponseDelivery: (id: string) => rows.get(id) ?? null,
    listResponseDeliveries: () => [...rows.values()].map(row => structuredClone(row)),
    flush: async () => { snapshots.push(...[...rows.values()].map(row => structuredClone(row))); },
    insertOutboundRef() {}, insertAuditLog: (record: { summary: string }) => audit.push(record.summary),
  } as unknown as BridgeStore;
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({ store, permissions: { resolvePendingPermission: () => false }, llm: { streamChat: blocked }, lifecycle: {} });
  const adapter = new ImageAdapter();
  const sent: OutboundMessage[] = [];
  const uploaded: string[] = [];
  adapter.send = async message => { sent.push(message); return { ok: true, messageId: `m-${sent.length}` }; };
  adapter.uploadImage = async value => { uploaded.push(value.id); return { ok: true, imageKey: `key-${value.id}` }; };
  return { address, rows, snapshots, audit, store, adapter, sent, uploaded };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(r => { resolve = r; }), resolve: (value: T) => resolve(value) };
}

test('流卡确认只保存文字进度，随后上传并发送图片；审计不含Base64', async () => {
  const f = fixture();
  f.adapter.uploadImage = async () => {
    const record = f.snapshots.at(-1);
    assert.ok(record);
    assert.equal(record.chunks[0].sent, true);
    assert.equal(record.chunks[1].sent, false);
    return { ok: true, imageKey: 'uploaded' };
  };
  f.adapter.send = async message => {
    const chunk = f.snapshots.at(-1)?.chunks[1];
    assert.equal(chunk?.kind, 'image');
    if (chunk?.kind === 'image') assert.equal(chunk.imageKey, 'uploaded');
    f.sent.push(message);
    return { ok: true, messageId: 'image-message' };
  };
  const result = await deliverResponse(f.adapter, f.address, '说明', 'session', undefined, { images: [image()], finalize: async () => true });
  assert.equal(result.ok, true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].image?.imageKey, 'uploaded');
  assert.deepEqual([...f.rows.values()][0].chunks, []);
  assert.ok(f.audit.every(summary => !summary.includes(PNG)));
});

test('图文部分失败补发复用上传key和uuid，不重复已发文字或首图', async () => {
  const f = fixture(); let fail = true;
  f.adapter.send = async message => {
    f.sent.push(message);
    return fail && message.image?.imageKey === 'key-image-2'
      ? { ok: false, httpStatus: 400, error: 'synthetic reject' }
      : { ok: true, messageId: `m-${f.sent.length}` };
  };
  assert.equal((await deliverResponse(f.adapter, f.address, '说明', 'session', 'incoming', { images: [image(), image('image-2')] })).ok, false);
  const record = [...f.rows.values()][0];
  assert.deepEqual(record.chunks.map(chunk => chunk.sent), [true, true, false]);
  assert.equal(f.uploaded.length, 2);
  const oldUuid = f.sent.at(-1)?.image?.sendUuid;
  fail = false;
  assert.equal((await retryResponseDelivery(f.adapter, f.address, record.id)).ok, true);
  assert.equal(f.uploaded.length, 2);
  assert.equal(f.sent.length, 4);
  assert.equal(f.sent.at(-1)?.image?.sendUuid, oldUuid);
});

test('纯图无空文字；重复生成ID只投递一次，不同图片不混用记录', async () => {
  const f = fixture();
  let finalized = 0;
  assert.equal((await deliverResponse(f.adapter, f.address, '', 'session', 'same', { images: [image(), image()], finalize: async () => { finalized++; return true; } })).ok, true);
  assert.equal(finalized, 1);
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].image);
  assert.equal((await deliverResponse(f.adapter, f.address, '', 'session', 'same', { images: [image('different')] })).ok, true);
  assert.equal(f.sent.length, 2);
  assert.equal(f.rows.size, 2);
});

test('初始flush失败不上传；上传key保存失败不发送', async () => {
  for (const phase of ['initial', 'uploaded']) {
    const f = fixture();
    f.store.flush = async () => {
      const row = [...f.rows.values()][0];
      if (phase === 'initial' || row.chunks.some(chunk => chunk.kind === 'image' && chunk.imageKey)) throw new Error('synthetic disk failure');
    };
    assert.equal((await deliverResponse(f.adapter, f.address, '', 'session', undefined, { images: [image()] })).ok, false);
    assert.equal(f.uploaded.length, phase === 'initial' ? 0 : 1);
    assert.equal(f.sent.length, 0);
  }
});

test('取消期间迟到上传保存原key但不发送，手动补发复用key', async () => {
  const f = fixture(); let current = true;
  const gate = deferred<{ ok: boolean; imageKey: string }>(); const entered = deferred<void>();
  f.adapter.uploadImage = async () => { f.uploaded.push('one'); entered.resolve(); return gate.promise; };
  const delivery = deliverResponse(f.adapter, f.address, '', 'session', undefined, { images: [image()], isCurrent: () => current });
  await entered.promise; current = false; gate.resolve({ ok: true, imageKey: 'late-key' });
  assert.equal((await delivery).ok, false);
  assert.equal(f.sent.length, 0);
  const row = [...f.rows.values()][0];
  assert.equal(row.chunks[0].kind === 'image' && row.chunks[0].imageKey, 'late-key');
  assert.equal((await retryResponseDelivery(f.adapter, f.address, row.id)).ok, true);
  assert.equal(f.uploaded.length, 1);
});

test('已确认的图片发送先记进度，再响应取消且不继续第二图', async () => {
  const f = fixture(); let current = true;
  f.adapter.send = async message => { f.sent.push(message); current = false; return { ok: true, messageId: 'confirmed' }; };
  assert.equal((await deliverResponse(f.adapter, f.address, '', 'session', undefined, { images: [image(), image('two')], isCurrent: () => current })).ok, false);
  assert.equal(f.sent.length, 1);
  assert.deepEqual([...f.rows.values()][0].chunks.map(chunk => chunk.sent), [true, false]);
});

test('上传及流卡超时有界，图片保持可补发；迟到上传不继续send', async () => {
  for (const phase of ['upload', 'finalize']) {
    const f = fixture(); f.store.getSetting = () => '5';
    const gate = deferred<{ ok: boolean; imageKey: string }>();
    f.adapter.uploadImage = async () => gate.promise;
    const options = { images: [image()], ...(phase === 'finalize' ? { finalize: () => new Promise<boolean>(() => {}) } : {}) };
    const result = await deliverResponse(f.adapter, f.address, '', 'session', undefined, options);
    assert.equal(result.ok, false); assert.match(result.error ?? '', /超时/);
    assert.equal([...f.rows.values()][0].chunks[0].sent, false);
    gate.resolve({ ok: true, imageKey: 'too-late' });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.sent.length, 0);
  }
});

test('不支持图片的平台先送文字，再明确失败且不把图片当空文字成功', async () => {
  const f = fixture();
  f.adapter.uploadImage = BaseChannelAdapter.prototype.uploadImage;
  const result = await deliverResponse(f.adapter, f.address, '文字仍可阅读', 'session', undefined, { images: [image()] });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /不支持生成图片/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, '文字仍可阅读');
  assert.deepEqual([...f.rows.values()][0].chunks.map(chunk => chunk.sent), [true, false]);
});

test('同一图片补发在上传等待时仍互斥', async () => {
  const f = fixture();
  f.adapter.uploadImage = async () => ({ ok: false, error: 'synthetic upload failure' });
  await deliverResponse(f.adapter, f.address, '', 'session', undefined, { images: [image()] });
  const id = [...f.rows.keys()][0];
  const gate = deferred<{ ok: boolean; imageKey: string }>(); const entered = deferred<void>();
  f.adapter.uploadImage = async () => { f.uploaded.push('one'); entered.resolve(); return gate.promise; };
  const first = retryResponseDelivery(f.adapter, f.address, id);
  await entered.promise;
  assert.match((await retryResponseDelivery(f.adapter, f.address, id)).error ?? '', /正在发送/);
  gate.resolve({ ok: true, imageKey: 'key' });
  assert.equal((await first).ok, true);
  assert.equal(f.uploaded.length, 1);
  assert.equal(f.sent.length, 1);
});
