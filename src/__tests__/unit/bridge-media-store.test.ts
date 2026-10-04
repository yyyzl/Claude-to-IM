import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { initBridgeContext } from '../../lib/bridge/context.js';
import { retryResponseDelivery } from '../../lib/bridge/response-delivery.js';
import { BaseChannelAdapter } from '../../lib/bridge/channel-adapter.js';
import { JsonFileBridgeStore } from '../../../scripts/claude-to-im-bridge/store.js';
import { createGeneratedImage } from '../../lib/bridge/internal/generated-image.js';
import type { ResponseDeliveryRecord } from '../../lib/bridge/host.js';
import type { BridgeStore } from '../../lib/bridge/host.js';
import type { OutboundMessage, SendResult } from '../../lib/bridge/types.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const image = createGeneratedImage('generated-fixture', PNG);
const record = (): ResponseDeliveryRecord => ({
  id: 'media-delivery', sessionId: 'session', address: { channelType: 'feishu', chatId: 'chat', userId: 'owner' },
  responseText: '说明', chunks: [
    { text: '说明', parseMode: 'plain', sent: true, messageId: 'text-message' },
    { kind: 'image', image, imageKey: 'uploaded-key', sendUuid: randomUUID(), sent: false },
  ], status: 'failed', attempts: 1, createdAt: '', updatedAt: '',
});

test('混合待发记录关闭重开后保留文字进度、图片key和稳定uuid', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-media-store-'));
  const file = path.join(root, 'store.json');
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('bridge-media-store-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new JsonFileBridgeStore({ projectRoot: root, dataPath: file });
  const row = record(); store.saveResponseDelivery(row); await store.close();
  const reopened = new JsonFileBridgeStore({ projectRoot: root, dataPath: file });
  assert.deepEqual(reopened.getResponseDelivery(row.id), row);
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({ store: reopened as unknown as BridgeStore, permissions: { resolvePendingPermission: () => false },
    llm: { streamChat: () => { throw new Error('补发不应调用模型'); } }, lifecycle: {} });
  const sent: OutboundMessage[] = [];
  class RecoveredAdapter extends BaseChannelAdapter {
    readonly channelType = 'feishu';
    async start() {}
    async stop() {}
    isRunning() { return true; }
    async consumeOne() { return null; }
    validateConfig() { return null; }
    isAuthorized() { return true; }
    async uploadImage(): Promise<never> { throw new Error('已有key不能重复上传'); }
    async send(message: OutboundMessage): Promise<SendResult> { sent.push(message); return { ok: true, messageId: 'recovered-image' }; }
  }
  assert.equal((await retryResponseDelivery(new RecoveredAdapter(), row.address, row.id)).ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].image?.imageKey, 'uploaded-key');
  assert.equal(sent[0].image?.sendUuid, row.chunks[1].kind === 'image' && row.chunks[1].sendUuid);
  await reopened.close();
  const finished = new JsonFileBridgeStore({ projectRoot: root, dataPath: file });
  assert.equal(finished.getResponseDelivery(row.id)?.status, 'delivered');
  assert.deepEqual(finished.getResponseDelivery(row.id)?.chunks, []);
  assert.equal(finished.getResponseDelivery(row.id)?.responseText, '');
  await finished.close();
});

for (const damage of ['mime', 'base64', 'hash', 'bytes', 'uuid', 'key', 'kind', 'count'] as const) {
  test(`损坏图片待发记录 ${damage} 拒绝空载且保留原件`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-media-store-'));
    const file = path.join(root, 'store.json');
    t.after(() => {
      assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
      assert.ok(path.basename(root).startsWith('bridge-media-store-'));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const row = record();
    const broken: Record<string, unknown> = structuredClone(row.chunks[1]);
    const badImage: Record<string, unknown> = { ...image };
    broken.image = badImage;
    if (damage === 'mime') badImage.mimeType = 'image/jpeg';
    if (damage === 'base64') badImage.data = 'data:image/png;base64,' + PNG;
    if (damage === 'hash') badImage.sha256 = 'wrong';
    if (damage === 'bytes') badImage.byteLength = 10000001;
    if (damage === 'uuid') broken.sendUuid = '';
    if (damage === 'key') broken.imageKey = 42;
    if (damage === 'kind') broken.kind = 'unknown-media';
    const chunks = damage === 'count'
      ? Array.from({ length: 9 }, (_, i) => ({ ...broken, image: { ...image, id: `image-${i}` } }))
      : [row.chunks[0], broken];
    const payload = JSON.stringify({ sessions: {}, bindings: {}, messages: {}, channelOffsets: {}, responseDeliveries: { [row.id]: { ...row, chunks } } });
    fs.writeFileSync(file, payload);
    assert.throws(() => new JsonFileBridgeStore({ projectRoot: root, dataPath: file }), /存储|persist|corrupt/i);
    assert.equal(fs.readFileSync(file, 'utf8'), payload);
  });
}

test('损坏JSON的错误cause不回显原始图片数据', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-media-store-'));
  const file = path.join(root, 'store.json');
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('bridge-media-store-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(file, PNG);
  let failure: unknown;
  try { new JsonFileBridgeStore({ projectRoot: root, dataPath: file }); }
  catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /主存储损坏且没有有效备份/);
  assert.match(inspect(failure), /Invalid store JSON syntax/);
  assert.ok(!inspect(failure).includes(PNG.slice(0, 8)), '错误cause不能回显媒体片段');
  assert.equal(fs.readFileSync(file, 'utf8'), PNG);
});
