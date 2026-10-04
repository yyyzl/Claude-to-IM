import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initBridgeContext, getBridgeContext } from '../../lib/bridge/context.js';
import { processMessage } from '../../lib/bridge/conversation-engine.js';
import { createGeneratedImage } from '../../lib/bridge/internal/generated-image.js';
import { JsonFileBridgeStore } from '../../../scripts/claude-to-im-bridge/store.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const image = createGeneratedImage('synthetic-image', png);
const sse = (type: string, data: unknown) => `data: ${JSON.stringify({ type, data: typeof data === 'string' ? data : JSON.stringify(data) })}\n`;
beforeEach(() => { delete (globalThis as Record<string, unknown>).__bridge_context__; });

async function run(events: string[], error?: Error) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-image-conversation-'));
  const store = new JsonFileBridgeStore({ projectRoot: root, dataPath: path.join(root, 'synthetic.json') });
  store.getSetting = key => key === 'bridge_llm_backend' ? 'codex' : null;
  const session = store.createSession('synthetic', 'model', undefined, root);
  const binding = store.upsertChannelBinding({ channelType: 'feishu', chatId: 'synthetic-chat', codepilotSessionId: session.id, model: 'model', workingDirectory: root });
  const llm = { streamChat: () => new ReadableStream<string>({ pull(controller) { const event = events.shift(); if (event) controller.enqueue(event); else if (error) controller.error(error); else controller.close(); } }) };
  initBridgeContext({ store, llm, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
  assert.equal(getBridgeContext().llm, llm);
  const tools: string[] = [];
  try {
    const result = await processMessage(binding, 'draw', undefined, undefined, undefined, undefined, (_id, name) => { tools.push(name); });
    return { result, messages: store.getMessages(session.id).messages, tools };
  } finally { await store.close(); }
}

test('图片独立于正文历史与工具记录，重复事件去重且顺序保留', async () => {
  const { result, messages, tools } = await run([
    sse('text', 'Here'), sse('generated_image', image), sse('generated_image', image),
    sse('generated_image', { ...image, id: 'second' }), sse('result', { is_error: false }),
  ]);
  assert.equal(result.responseText, 'Here');
  assert.deepEqual(result.generatedImages?.map(row => row.id), ['synthetic-image', 'second']);
  assert.ok(!JSON.stringify(messages).includes(png));
  assert.deepEqual(tools, []);
});

test('纯图结果无空文字占位，正常流错误仍保留已经完成的产物和文字', async () => {
  const pure = await run([sse('generated_image', image), sse('result', { is_error: false })]);
  assert.equal(pure.result.responseText, '');
  assert.equal(pure.result.generatedImages?.length, 1);
  const failed = await run([sse('text', 'partial'), sse('generated_image', image)], new Error('synthetic broken stream'));
  assert.equal(failed.result.hasError, true);
  assert.equal(failed.result.responseText, 'partial');
  assert.equal(failed.result.generatedImages?.length, 1);
  assert.ok(!JSON.stringify(failed.messages).includes(png));
});

for (const code of ['abort', 'timeout']) {
  test(`${code} 不返回可自动投递的图片`, async () => {
    const { result } = await run([sse('generated_image', image), sse('result', { is_error: true, error_code: code })]);
    assert.equal(result.errorCode, code);
    assert.equal(result.generatedImages?.length ?? 0, 0);
  });
}

test('事件畸形与摘要不符明确说明，错误正文不包含原始媒体', async () => {
  const { result, messages } = await run([
    sse('generated_image', `{"data":"${png}`),
    sse('generated_image', { ...image, sha256: 'invalid' }),
    sse('result', { is_error: false }),
  ]);
  assert.match(result.responseText, /图片交付/);
  assert.equal(result.generatedImages?.length ?? 0, 0);
  assert.ok(!JSON.stringify(messages).includes(png));
});
