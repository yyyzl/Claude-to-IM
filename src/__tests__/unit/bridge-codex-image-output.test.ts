import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClient, read, setup } from './codex-test-transport.js';
import { CodexAppServerLLMProvider } from '../../../scripts/claude-to-im-bridge/codex-llm.ts';
import { InMemoryPermissionGateway } from '../../../scripts/claude-to-im-bridge/permissions.ts';

// 真实 rust-v0.160.0 item/completed.imageGeneration 结构；内容为研究中的合成 PNG。
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const imageItem = (id = 'image-fixture', result = png) => ({ type: 'imageGeneration', id, status: 'completed', result, failure: null, transparentBackground: false, revisedPrompt: 'synthetic' });

test('early backlog 中纯图 completed 自动产出独立 SSE，同 item 只发一次', async () => {
  const { client, provider } = setup();
  client.onTurn = () => {
    client.publish('item/started', { item: { ...imageItem(), status: 'in_progress', result: '' } });
    client.publish('item/completed', { completedAtMs: 1791158400000, item: imageItem() });
    client.publish('item/completed', { completedAtMs: 1791158400000, item: imageItem() });
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  const events = await read(provider.streamChat({ prompt: 'draw', sessionId: 's' }));
  const images = events.filter(event => event.type === 'generated_image').map(event => JSON.parse(event.data));
  assert.equal(images.length, 1);
  assert.equal(images[0].data, png);
  assert.equal(images[0].mimeType, 'image/png');
  assert.ok(images[0].byteLength > 0);
  assert.ok(!events.filter(event => event.type !== 'generated_image').some(event => event.data.includes(png)));
});

test('只接受精确当前 thread/turn，忽略 imageView 和模型文字路径', async () => {
  const { client, provider } = setup();
  client.onTurn = () => {
    client.publish('item/completed', { threadId: 'other', item: imageItem('other-thread') });
    client.publish('item/completed', { turnId: 'other', item: imageItem('other-turn') });
    client.publish('item/completed', { threadId: ' thread ', item: imageItem('trimmed-thread') });
    client.publish('item/completed', { item: { type: 'imageView', id: 'input-image', path: '/private/image.png' } });
    client.publish('item/completed', { item: { type: 'agentMessage', id: 'text', text: '/private/output.png', phase: 'final_answer' } });
    client.publish('item/completed', { item: imageItem('one') });
    client.publish('item/completed', { item: imageItem('two') });
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  const events = await read(provider.streamChat({ prompt: 'draw', sessionId: 's' }));
  assert.equal(events.filter(event => event.type === 'generated_image').length, 2);
  assert.ok(events.filter(event => event.type === 'text').some(event => event.data.includes('/private/output.png')));
});

test('失败、空媒体、坏编码、未完成与第9张都有可见说明，保留前8张', async () => {
  const { client, provider } = setup();
  client.onTurn = () => {
    client.publish('item/completed', { item: { ...imageItem('failed', ''), status: 'failed', failure: { type: 'usageLimitExceeded', limitId: 'synthetic', resetsAt: null } } });
    client.publish('item/completed', { item: { ...imageItem('empty', ''), savedPath: '/must/not/read.png' } });
    client.publish('item/completed', { item: imageItem('invalid', 'secret-invalid-data!') });
    client.publish('item/started', { item: { ...imageItem('unfinished', ''), status: 'in_progress' } });
    for (let i = 0; i < 9; i++) client.publish('item/completed', { item: imageItem(`success-${i}`) });
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  const events = await read(provider.streamChat({ prompt: 'draw', sessionId: 's' }));
  assert.equal(events.filter(event => event.type === 'generated_image').length, 8);
  const text = events.filter(event => event.type === 'text').map(event => event.data).join('');
  assert.match(text, /失败/);
  assert.match(text, /数据/);
  assert.match(text, /Base64/);
  assert.match(text, /未完成/);
  assert.match(text, /8/);
  assert.ok(!text.includes('secret-invalid-data') && !text.includes('/must/not/read'));
});

test('回合普通错误保留已完成图片事件并明确失败', async () => {
  const { client, provider } = setup();
  client.onTurn = () => {
    client.publish('item/completed', { item: imageItem() });
    client.publish('turn/completed', { turn: { id: 'turn', status: 'failed', error: { message: 'synthetic turn failure' } } });
  };
  const events = await read(provider.streamChat({ prompt: 'draw', sessionId: 's' }));
  assert.equal(events.filter(event => event.type === 'generated_image').length, 1);
  assert.match(events.find(event => event.type === 'error')!.data, /Codex 回合执行失败/);
});

for (const source of ['notification-message', 'notification-object', 'turn-failed']) {
  test(`服务端 ${source} 中的原始媒体和私有字段不进入错误 SSE`, async () => {
    const { client, provider } = setup();
    const privateMarker = 'synthetic-private-request-field';
    client.onTurn = () => {
      client.publish('item/completed', { item: imageItem() });
      const error = source === 'notification-object'
        ? { media: png, requestField: privateMarker }
        : { message: `${privateMarker} ${png}` };
      if (source === 'turn-failed') {
        client.publish('turn/completed', { turn: { id: 'turn', status: 'failed', error } });
      } else {
        client.publish('error', { willRetry: false, error });
      }
    };
    const events = await read(provider.streamChat({ prompt: 'draw', sessionId: 's' }));
    assert.equal(events.filter(event => event.type === 'generated_image').length, 1);
    const visible = JSON.stringify(events.filter(event => event.type !== 'generated_image'));
    assert.ok(!visible.includes(png), '原始图片不得进入普通 SSE/后续日志');
    assert.ok(!visible.includes(privateMarker), '服务端原始错误字段不得进入可见说明');
    assert.match(events.find(event => event.type === 'error')!.data, /失败/);
    assert.equal(JSON.parse(events.find(event => event.type === 'result')!.data).error_code, 'error');
  });
}

test('超时明确标记 timeout，中断等待期间晚到图片也不再产出', async () => {
  const client = new FakeClient();
  client.onTurn = () => { client.publish('item/completed', { item: imageItem('before-timeout') }); };
  const request = client.request.bind(client);
  client.request = async (method, params = {}) => {
    if (method === 'turn/interrupt') client.publish('item/completed', { item: imageItem('late-timeout') });
    return request(method, params);
  };
  const provider = new CodexAppServerLLMProvider({ client, projectRoot: process.cwd(), permissions: new InMemoryPermissionGateway(), keepAliveMs: 0, turnTimeoutMs: 20 });
  const events = await read(provider.streamChat({ prompt: 'draw', sessionId: 's' }));
  assert.equal(events.filter(event => event.type === 'generated_image').length, 1);
  assert.equal(JSON.parse(events.find(event => event.type === 'result')!.data).error_code, 'timeout');
});

test('stdio 子进程最后明确要求保留通知媒体，仅构造命令不启动运行时', () => {
  const provider = new CodexAppServerLLMProvider({ projectRoot: process.cwd(), codexBin: process.execPath, permissions: new InMemoryPermissionGateway(), cliConfig: 'features.omit_app_server_notification_media=true' });
  // 构造器无进程副作用；检查实际 transport 的启动参数，禁止调用其 request/start。
  const transport = Reflect.get(provider, 'client') as { command: string[]; isRunning(): boolean };
  assert.equal(transport.isRunning(), false);
  assert.deepEqual(transport.command.slice(-2), ['-c', 'features.omit_app_server_notification_media=false']);
});
