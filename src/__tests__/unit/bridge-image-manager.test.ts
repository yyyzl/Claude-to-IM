import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { initBridgeContext, getBridgeContext } from '../../lib/bridge/context.js';
import { JsonFileBridgeStore } from '../../../scripts/claude-to-im-bridge/store.js';
import { createGeneratedImage } from '../../lib/bridge/internal/generated-image.js';
import type { GeneratedImage, StreamChatParams } from '../../lib/bridge/host.js';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter.js';
import type { InboundMessage, OutboundMessage } from '../../lib/bridge/types.js';

for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  mock.method(childProcess, key, () => { throw new Error(`禁止真实子进程：${key}`); });
}
syncBuiltinESMExports();
mock.method(globalThis, 'fetch', () => { throw new Error('禁止真实网络'); });
const manager = await import('../../lib/bridge/bridge-manager.js');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const image = createGeneratedImage('synthetic-image', png);
const sse = (type: string, data: unknown) => `data: ${JSON.stringify({ type, data: typeof data === 'string' ? data : JSON.stringify(data) })}\n`;

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  delete (globalThis as Record<string, unknown>).__bridge_manager__;
});

let serial = 0;
function fixture(events: string[], finalize = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-image-manager-'));
  const store = new JsonFileBridgeStore({ projectRoot: root, dataPath: path.join(root, 'synthetic.json') });
  store.getSetting = key => key === 'bridge_llm_backend' ? 'codex' : key === 'bridge_delivery_timeout_ms' ? '100' : null;
  const address = { channelType: 'feishu', chatId: `images-${++serial}`, userId: 'synthetic' };
  const messages: OutboundMessage[] = [];
  const uploaded: GeneratedImage[] = [];
  const ended: Array<{ status: string; text: string }> = [];
  const audits: string[] = [];
  store.insertAuditLog = row => { audits.push(row.summary); };
  let modelCalls = 0;
  const llm = { streamChat: (_params: StreamChatParams) => {
    modelCalls++;
    return new ReadableStream<string>({ start(controller) { for (const event of events) controller.enqueue(event); controller.close(); } });
  } };
  initBridgeContext({ store, llm, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
  assert.equal(getBridgeContext().llm, llm);
  const adapter = {
    channelType: 'feishu', isRunning: () => true, send: async (message: OutboundMessage) => { messages.push(message); return { ok: true, messageId: `sent-${messages.length}` }; },
    uploadImage: async (value: GeneratedImage) => { uploaded.push(value); return { ok: true, imageKey: `key-${uploaded.length}` }; },
    onStreamText: () => {}, onStreamEnd: async (_chat: string, status: string, text: string) => { ended.push({ status, text }); return finalize; },
    onMessageStart: () => {}, onMessageEnd: () => {},
  } as unknown as BaseChannelAdapter;
  const message = (text = 'draw'): InboundMessage => ({ messageId: `in-${serial}`, address, text, timestamp: Date.now() });
  return { store, llm, adapter, address, message, messages, uploaded, ended, audits, modelCalls: () => modelCalls };
}

for (const finalize of [false, true]) {
  test(`纯图自动进入 outbox 并发送，流卡 finalize=${finalize} 不能吞掉图片`, async () => {
    const f = fixture([sse('generated_image', image), sse('result', { is_error: false })], finalize);
    try {
      await manager._testOnly.handleMessage(f.adapter, f.message());
      assert.equal(f.uploaded.length, 1);
      assert.equal(f.messages.filter(message => message.image).length, 1);
      assert.ok(f.messages.every(message => message.image || message.text.trim()));
      assert.equal(f.ended.length, 1);
      assert.equal(f.store.listResponseDeliveries('feishu', f.address.chatId)[0].status, 'delivered');
      assert.ok(!f.audits.some(row => row.includes(png)));
      const sessionId = f.store.getChannelBinding('feishu', f.address.chatId)!.codepilotSessionId;
      assert.ok(!JSON.stringify(f.store.getMessages(sessionId)).includes(png));
    } finally { await f.store.close(); }
  });
}

test('文字卡已显示仍发送多图；普通回合错误保留图片和可见错误说明', async () => {
  const f = fixture([sse('text', '说明'), sse('generated_image', image), sse('generated_image', { ...image, id: 'second' }), sse('error', 'Codex 回合执行失败，请稍后重试。'), sse('result', { is_error: true })], true);
  try {
    await manager._testOnly.handleMessage(f.adapter, f.message());
    assert.equal(f.messages.filter(message => message.image).length, 2);
    assert.match(f.ended[0].text, /说明/);
    assert.match(f.ended[0].text, /Codex 回合执行失败/);
    assert.equal(f.ended[0].status, 'error');
  } finally { await f.store.close(); }
});

for (const code of ['abort', 'timeout']) {
  test(`${code} 后不自动发送已经完成的图片`, async () => {
    const f = fixture([sse('generated_image', image), sse('result', { is_error: true, error_code: code })]);
    try {
      await manager._testOnly.handleMessage(f.adapter, f.message());
      assert.equal(f.uploaded.length, 0);
      assert.equal(f.messages.filter(message => message.image).length, 0);
    } finally { await f.store.close(); }
  });
}

test('图片投递失败明确给出补发入口，不能只写日志', async () => {
  const f = fixture([sse('generated_image', image), sse('result', { is_error: false })]);
  f.adapter.uploadImage = async () => ({ ok: false, error: 'synthetic upload failed' });
  try {
    await manager._testOnly.handleMessage(f.adapter, f.message());
    assert.ok(f.messages.some(message => message.text.includes('/retry')));
    assert.equal(f.store.listResponseDeliveries('feishu', f.address.chatId)[0].status, 'failed');
    assert.equal(f.modelCalls(), 1);
  } finally { await f.store.close(); }
});

for (const command of ['/stop', '/new']) {
  test(`生成图完成后但回合尚未结束，${command} 阻止自动回传`, async () => {
    const f = fixture([]);
    let started = false;
    f.llm.streamChat = () => new ReadableStream<string>({ start(controller) { controller.enqueue(sse('generated_image', image)); started = true; } });
    try {
      const pending = manager._testOnly.handleMessage(f.adapter, f.message());
      while (!started) await delay(5);
      await delay(10);
      await manager._testOnly.handleMessage(f.adapter, f.message(command));
      await pending;
      assert.equal(f.uploaded.length, 0);
      assert.equal(f.messages.filter(message => message.image).length, 0);
    } finally { await f.store.close(); }
  });
}
