import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import net from 'node:net';
import * as lark from '@larksuiteoapi/node-sdk';
import { AxiosError, AxiosHeaders } from 'axios';
import * as feishu from '../../lib/bridge/adapters/feishu-adapter.js';
import { createGeneratedImage } from '../../lib/bridge/internal/generated-image.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const image = createGeneratedImage('image-fixture', PNG);
const blocked = () => { throw new Error('测试禁止真实网络'); };
mock.method(net.Socket.prototype, 'connect', blocked);
mock.method(globalThis, 'fetch', blocked);
function fixture() {
  const uploads: unknown[] = [], messages: unknown[] = [];
  const client = { im: {
    image: { create: async (request: unknown): Promise<{ image_key?: string } | null> => { uploads.push(request); return { image_key: 'flat-key' }; } },
    message: { create: async (request: unknown): Promise<{ code?: number; data?: { message_id?: string }; msg?: string }> => { messages.push(request); return { code: 0, data: { message_id: 'image-message' } }; } },
  } };
  const adapter = new feishu.FeishuAdapter();
  (adapter as unknown as { restClient: typeof client }).restClient = client;
  return { adapter, client, uploads, messages };
}

test('飞书上传使用message+Buffer并读取扁平image_key，发送原聊天和稳定uuid', async () => {
  const f = fixture();
  assert.deepEqual(await f.adapter.uploadImage(image), { ok: true, imageKey: 'flat-key' });
  assert.deepEqual(f.uploads[0], { data: { image_type: 'message', image: Buffer.from(PNG, 'base64') } });
  const result = await f.adapter.send({ address: { channelType: 'feishu', chatId: 'original-chat' }, text: '', image: { imageKey: 'flat-key', sendUuid: 'stable-uuid' } });
  assert.deepEqual(result, { ok: true, messageId: 'image-message' });
  assert.deepEqual(f.messages, [{ params: { receive_id_type: 'chat_id' }, data: {
    receive_id: 'original-chat', msg_type: 'image', content: JSON.stringify({ image_key: 'flat-key' }), uuid: 'stable-uuid',
  } }]);
});

test('上传null或空key失败；图片发送非零code或缺message_id不降级为空文字', async () => {
  for (const response of [null, {}, { image_key: ' ' }]) {
    const f = fixture(); f.client.im.image.create = async () => response;
    assert.equal((await f.adapter.uploadImage(image)).ok, false);
    assert.equal(f.messages.length, 0);
  }
  for (const response of [{ code: 999, data: { message_id: 'must-not-count' } }, { code: 0 }, { data: { message_id: 'missing-code' } }]) {
    const f = fixture(); let calls = 0;
    f.client.im.message.create = async () => { calls++; return response; };
    assert.equal((await f.adapter.send({ address: { channelType: 'feishu', chatId: 'chat' }, text: 'should not fallback', image: { imageKey: 'key', sendUuid: 'uuid' } })).ok, false);
    assert.equal(calls, 1);
  }
});

test('图片上传异常及SDK自动multipart日志不输出媒体、令牌或原始错误', async t => {
  const logged: unknown[][] = [];
  for (const level of ['error', 'warn', 'info', 'debug', 'log'] as const) t.mock.method(console, level, (...values: unknown[]) => { logged.push(values); });
  assert.ok(feishu.feishuSdkLogger);
  const marker = 'synthetic-secret-never-log';
  const config = {
    headers: new AxiosHeaders({ Authorization: marker }),
    data: { image: Buffer.from(PNG, 'base64'), base64: PNG, token: marker },
  };
  const error = new AxiosError(marker + PNG, 'ERR_BAD_REQUEST', config);
  error.response = { status: 400, statusText: marker, data: { code: 999, msg: marker }, headers: {}, config };
  const fail = async (): Promise<never> => { throw error; };
  const http: lark.HttpInstance = { request: fail, get: fail, delete: fail, head: fail, options: fail, post: fail, put: fail, patch: fail };
  const client = new lark.Client({ appId: 'synthetic', appSecret: 'synthetic', disableTokenCache: true, httpInstance: http, logger: feishu.feishuSdkLogger });
  const adapter = new feishu.FeishuAdapter();
  (adapter as unknown as { restClient: lark.Client }).restClient = client;
  const result = await adapter.uploadImage(image);
  assert.equal(result.ok, false);
  assert.ok(logged.length > 0, '须触发真实SDK的logger路径');
  const combined = JSON.stringify({ logged, result });
  assert.doesNotMatch(combined, /synthetic-secret-never-log|iVBORw0KGgo|Buffer|Authorization/);
  assert.match(combined, /400|999/);
});
