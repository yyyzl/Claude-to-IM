import assert from 'node:assert/strict';
import { test } from 'node:test';
import { read, setup } from './codex-test-transport.js';

test('目录读取失败保留握手连接，下一次仅重试目录', async () => {
  const { client, provider } = setup();
  const request = client.request.bind(client); let failed = false;
  client.request = async (method, params) => {
    if (method === 'model/list' && !failed) { failed = true; throw new Error('temporary catalog error'); }
    return request(method, params);
  };
  const first = await read(provider.streamChat({ prompt: 'hello', sessionId: 's' }));
  assert.match(first.find(e => e.type === 'error')?.data ?? '', /temporary catalog error/);
  assert.equal(client.isRunning(), true);
  const second = await read(provider.streamChat({ prompt: 'hello', sessionId: 's' }));
  assert.equal(second.some(e => e.type === 'error'), false);
  assert.equal(client.calls.filter(c => c.method === 'initialize').length, 1);
});

test('断开时收到迟到服务端请求的回复错误会被捕获', async () => {
  const { client } = setup();
  const errors: unknown[] = [];
  const oldWarn = console.warn;
  console.warn = (...args) => { errors.push(args); };
  try {
    client.respondError = () => { throw new Error('connection already closed'); };
    client.emitter.emit('request', { id: 'late', method: 'future/request', params: {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.length, 1);
  } finally { console.warn = oldWarn; }
});

test('握手、恢复、会话模型、目录effort、权限与图片真实传递', async () => {
  const { client, provider } = setup();
  const events = await read(provider.streamChat({ prompt: 'hi', sessionId: 's', sdkSessionId: 'thread', model: 'catalog-id ultra', permissionMode: 'default', files: [{ id: 'i', name: 'image.png', type: 'image/png', size: 1, data: 'YQ==' }] }));
  assert.deepEqual(client.calls.slice(0, 4).map(c => c.method), ['initialize', 'initialized', 'model/list', 'thread/resume']);
  assert.equal((client.calls[0].params.capabilities as Record<string, unknown>).experimentalApi, true);
  const turn = client.calls.find(c => c.method === 'turn/start')!.params;
  assert.equal(turn.model, 'model-next'); assert.equal(turn.effort, 'ultra');
  assert.equal(turn.approvalPolicy, 'on-request'); assert.deepEqual(turn.sandboxPolicy, { type: 'workspaceWrite' });
  assert.deepEqual((turn.input as unknown[])[1], { type: 'image', url: 'data:image/png;base64,YQ==' });
  assert.equal(JSON.parse(events.find(e => e.type === 'status' && JSON.parse(e.data).model)!.data).model, 'model-next');
});

test('failed终态不会被报告成功，未知模型不会静默替换', async () => {
  const { client, provider } = setup();
  client.onTurn = () => client.publish('turn/completed', { turn: { id: 'turn', status: 'failed', error: { message: 'upstream failed' } } });
  const events = await read(provider.streamChat({ prompt: 'hi', sessionId: 's' }));
  assert.match(events.find(e => e.type === 'error')!.data, /Codex 回合执行失败/);
  assert.equal(JSON.parse(events.find(e => e.type === 'result')!.data).is_error, true);
  const invalid = await read(provider.streamChat({ prompt: 'hi', sessionId: 's', model: 'unavailable' }));
  assert.match(invalid.find(e => e.type === 'error')!.data, /unavailable/);
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('取消等待会发送turn/interrupt', async () => {
  const { client, provider } = setup(); const abortController = new AbortController();
  client.onTurn = () => { setTimeout(() => abortController.abort(), 10); };
  await read(provider.streamChat({ prompt: 'hi', sessionId: 's', abortController }));
  assert.deepEqual(client.calls.find(c => c.method === 'turn/interrupt')?.params, { threadId: 'thread', turnId: 'turn' });
});

test('审批、问答回传真实答案，未知服务端请求明确失败', async () => {
  const { client, provider, permissions } = setup();
  client.onTurn = () => {
    client.emitter.emit('request', { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'cmd', command: 'test' } });
    client.emitter.emit('request', { id: 'q', method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'input', isBlocking: true, questions: [{ id: 'choice', question: 'Choose', header: 'Choice', isOther: true, isSecret: false, options: [{ label: 'A', description: '' }] }] } });
    client.emitter.emit('request', { id: 'unknown', method: 'future/request', params: {} });
  };
  const originalRespond = client.respond.bind(client);
  client.respond = (id, result) => { originalRespond(id, result); if (id === 'q') client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } }); };
  await read(provider.streamChat({ prompt: 'hi', sessionId: 's' }), event => {
    const data = event.type.endsWith('request') ? JSON.parse(event.data) : null;
    if (event.type === 'permission_request') permissions.resolvePendingPermission(data.permissionRequestId, { behavior: 'allow', scope: 'session' });
    if (event.type === 'user_input_request') permissions.resolvePendingPermission(data.requestId, { behavior: 'allow', updatedInput: { answers: { choice: ['Custom'] } } });
  });
  assert.ok(client.replies.some(r => JSON.stringify(r) === JSON.stringify({ id: 7, result: { decision: 'acceptForSession' } })));
  assert.ok(client.replies.some(r => JSON.stringify(r) === JSON.stringify({ id: 'q', result: { answers: { choice: { answers: ['Custom'] } } } })));
  assert.ok(client.replies.some(r => (r as { error?: { code: number } }).error?.code === -32601));
});

test('现代工具收尾、commentary进度与turn用量，不扫描rollout文件', async () => {
  const { client, provider } = setup();
  client.onTurn = () => {
    client.publish('item/started', { item: { id: 'cmd', type: 'commandExecution', command: 'build' } });
    client.publish('item/completed', { item: { id: 'cmd', type: 'commandExecution', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 } });
    client.publish('item/completed', { item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'Working' } });
    client.publish('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 }, total: { inputTokens: 1100, cachedInputTokens: 400, outputTokens: 110 }, modelContextWindow: 200000 } });
    client.publish('item/completed', { item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Done' } });
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  const events = await read(provider.streamChat({ prompt: 'hi', sessionId: 's' }));
  assert.equal(events.find(e => e.type === 'progress')?.data, 'Working');
  assert.equal(events.filter(e => e.type === 'text').map(e => e.data).join(''), 'Done');
  assert.equal(JSON.parse(events.find(e => e.type === 'tool_result')!.data).is_error, false);
  const result = JSON.parse(events.find(e => e.type === 'result')!.data);
  assert.deepEqual(result.usage, { input_tokens: 60, output_tokens: 10, cache_read_input_tokens: 40 });
  assert.equal(result.context_window, 200000);
});
