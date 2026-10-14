import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { read, setup } from './codex-test-transport.js';
import type { ActiveTurnInput } from '../../lib/bridge/host.js';

const blocked = () => { throw new Error('禁止真实子进程和网络'); };
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) mock.method(childProcess, key, blocked);
mock.method(globalThis, 'fetch', blocked);
syncBuiltinESMExports();

type InputHandle = ActiveTurnInput;
function liveSetup() {
  const f = setup();
  const client: Omit<typeof f.client, 'request'> & { request(method: string, params?: Record<string, unknown>): Promise<unknown> } = f.client;
  return { ...f, client };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('初始化取消唤醒未提交输入，旧 closure 不进入后来的同 ID 回合', async () => {
  const { client, provider } = liveSetup();
  const request = client.request.bind(client);
  let release: () => void = () => {};
  client.request = async (method, params) => {
    if (method === 'initialize') await new Promise<void>(resolve => { release = resolve; });
    if (method === 'turn/steer') { client.calls.push({ method, params: params ?? {} }); return { turnId: 'turn' }; }
    return request(method, params);
  };
  const abortController = new AbortController(); let oldInput: ActiveTurnInput | undefined;
  const old = provider.streamChat({ prompt: 'old', sessionId: 's', abortController, onActiveTurnInput: input => { oldInput = input; } });
  assert.ok(oldInput);
  const waiting = oldInput.submitText('取消前等待'); abortController.abort();
  assert.equal((await waiting).status, 'not-submitted'); release(); await read(old);
  provider.stop(); client.request = async (method, params) => method === 'turn/steer'
    ? (client.calls.push({ method, params: params ?? {} }), { turnId: 'turn' }) : request(method, params);
  client.onTurn = () => {}; let nextInput: ActiveTurnInput | undefined;
  const next = provider.streamChat({ prompt: 'next', sessionId: 's', onActiveTurnInput: input => { nextInput = input; } });
  assert.ok(nextInput);
  assert.equal((await oldInput.submitText('旧消息')).status, 'not-submitted');
  assert.equal((await nextInput.submitText('新消息')).status, 'accepted');
  client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } }); await read(next);
  assert.deepEqual(client.calls.filter(row => row.method === 'turn/steer').map(row => row.params.input), [[{ type: 'text', text: '新消息', text_elements: [] }]]);
});

test('已调用 steer 后的断连、超时都为 unknown，不自动重试', async () => {
  for (const failure of ['disconnect', 'timeout']) {
    const { client, provider } = liveSetup(); client.onTurn = () => {};
    const request = client.request.bind(client); let reject: ((error: Error) => void) | undefined;
    client.request = async (method, params) => {
      if (method !== 'turn/steer') return request(method, params);
      client.calls.push({ method, params: params ?? {} }); return new Promise((_, done) => { reject = done; });
    };
    let input: ActiveTurnInput | undefined;
    const stream = provider.streamChat({ prompt: 'first', sessionId: 's', onActiveTurnInput: value => { input = value; } });
    assert.ok(input); const pending = input.submitText('补充');
    while (!reject) await tick();
    if (failure === 'disconnect') { client.emitter.emit('disconnect', new Error('连接终止')); reject(new Error('连接终止')); }
    else client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    assert.equal((await pending).status, 'unknown'); await read(stream);
    reject(new Error('最终结束')); assert.equal(client.calls.filter(row => row.method === 'turn/steer').length, 1);
  }
});

test('当前回合输入在初始化前发布，等待 ready 并精确 steer 原回合', async () => {
  const { client, provider } = liveSetup();
  client.onTurn = () => {};
  const request = client.request.bind(client);
  client.request = async (method, params) => method === 'turn/steer'
    ? (client.calls.push({ method, params: params ?? {} }), { turnId: 'turn' }) : request(method, params);
  let input: InputHandle | undefined;
  const stream = provider.streamChat({ prompt: 'first', sessionId: 's',
    onActiveTurnInput: (value: InputHandle) => { input = value; },
  });
  assert.ok(input, '初始化前必须发布本 stream 的输入能力');
  const result = await input.submitText('补充');
  assert.deepEqual(result, { status: 'accepted' });
  assert.deepEqual(client.calls.find(call => call.method === 'turn/steer')?.params, {
    threadId: 'thread', expectedTurnId: 'turn', input: [{ type: 'text', text: '补充', text_elements: [] }],
  });
  client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  assert.equal((await input.submitText('late')).status, 'not-submitted');
  await read(stream);
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('early completed backlog 封闭初始化中的输入，不调用 steer', async () => {
  const { client, provider } = liveSetup();
  let input: InputHandle | undefined;
  const stream = provider.streamChat({ prompt: 'first', sessionId: 's',
    onActiveTurnInput: (value: InputHandle) => { input = value; },
  });
  assert.ok(input, '必须发布输入能力');
  assert.equal((await input.submitText('late')).status, 'not-submitted');
  await read(stream);
  assert.equal(client.calls.some(call => call.method === 'turn/steer'), false);
});

test('steer 发出后的异常和错 ID 为 unknown，completed 先到不否定成功收据', async () => {
  for (const receipt of ['accepted', 'wrong-id', 'error']) {
    const { client, provider } = liveSetup();
    client.onTurn = () => {};
    const request = client.request.bind(client);
    let finish: (() => void) | undefined;
    client.request = async (method, params) => {
      if (method !== 'turn/steer') return request(method, params);
      client.calls.push({ method, params: params ?? {} });
      await new Promise<void>(resolve => { finish = resolve; });
      if (receipt === 'error') throw new Error('remote failed');
      return { turnId: receipt === 'accepted' ? 'turn' : 'other' };
    };
    let input: InputHandle | undefined;
    const stream = provider.streamChat({ prompt: 'first', sessionId: 's',
      onActiveTurnInput: (value: InputHandle) => { input = value; },
    });
    assert.ok(input, '必须发布输入能力');
    const pending = input.submitText('补充');
    while (!finish) await tick();
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    await read(stream);
    finish();
    assert.equal((await pending).status, receipt === 'accepted' ? 'accepted' : 'unknown');
    assert.equal((await input.submitText('late')).status, 'not-submitted');
  }
});

test('只将 final_answer delta 交给正文，commentary 单独展示', async () => {
  const { client, provider } = setup();
  client.onTurn = () => {
    client.publish('item/started', { item: { type: 'agentMessage', id: 'comment', phase: 'commentary' } });
    client.publish('item/agentMessage/delta', { itemId: 'comment', delta: 'Working' });
    client.publish('item/completed', { item: { type: 'agentMessage', id: 'comment', phase: 'commentary', text: 'Working' } });
    client.publish('item/started', { item: { type: 'agentMessage', id: 'answer', phase: 'final_answer' } });
    client.publish('item/agentMessage/delta', { itemId: 'answer', delta: 'final ' });
    client.publish('item/agentMessage/delta', { itemId: 'answer', delta: 'answer' });
    client.publish('item/completed', { item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'final answer' } });
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  const events = await read(provider.streamChat({ prompt: 'hello', sessionId: 's' }));
  assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.data), ['final ', 'answer']);
  assert.deepEqual(events.filter(e => e.type === 'progress').map(e => e.data), ['Working']);
});

test('delta 早于 started 仍保留，只有 completed 的最终消息也不会丢失', async () => {
  const { client, provider } = setup();
  client.onTurn = () => {
    client.publish('item/agentMessage/delta', { itemId: 'answer', delta: 'first ' });
    client.publish('item/completed', { item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'first answer' } });
    client.publish('item/completed', { item: { type: 'agentMessage', id: 'last', phase: 'final_answer', text: '\nlast answer' } });
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  const events = await read(provider.streamChat({ prompt: 'hello', sessionId: 's' }));
  assert.equal(events.filter(e => e.type === 'text').map(e => e.data).join(''), 'first answer\nlast answer');
});

test('公开 tokenUsage 事件保留压缩后的上下文估计，重复事件不重复累计', async () => {
  const { client, provider } = setup();
  client.onTurn = () => {
    const tokenUsage = { last: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 45000 }, total: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 100, totalTokens: 1000 }, modelContextWindow: 200000 };
    client.publish('thread/tokenUsage/updated', { tokenUsage });
    client.publish('thread/tokenUsage/updated', { tokenUsage });
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  const events = await read(provider.streamChat({ prompt: 'hello', sessionId: 's' }));
  const result = JSON.parse(events.find(e => e.type === 'result')!.data);
  assert.equal(result.context_tokens, 45000);
  assert.equal(result.context_window, 200000);
  assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
});

test('恢复失败保留thread ID并明确报错，不无提示创建新对话', async () => {
  const { client, provider } = setup();
  const request = client.request.bind(client);
  client.request = async (method, params) => { if (method === 'thread/resume') throw new Error('thread not found'); return request(method, params); };
  const events = await read(provider.streamChat({ prompt: 'hello', sessionId: 's', sdkSessionId: 'existing' }));
  assert.equal(client.calls.some(c => c.method === 'thread/start'), false);
  assert.equal(JSON.parse(events.find(e => e.type === 'result')!.data).session_id, 'existing');
  assert.match(events.find(e => e.type === 'error')!.data, /thread not found/);
});
