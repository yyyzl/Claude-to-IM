import assert from 'node:assert/strict';
import { test } from 'node:test';
import { read, setup } from './codex-test-transport.js';

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
