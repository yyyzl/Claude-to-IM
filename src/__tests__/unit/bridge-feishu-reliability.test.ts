import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { initBridgeContext } from '../../lib/bridge/context.js';
import type { BridgeStore } from '../../lib/bridge/host.js';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';
import { splitFeishuMarkdown } from '../../lib/bridge/markdown/feishu.js';

const blocked = () => { throw new Error('测试禁止真实网络和子进程'); };
mock.method(net.Socket.prototype, 'connect', blocked);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const) mock.method(childProcess, name, blocked);
mock.method(globalThis, 'fetch', blocked); syncBuiltinESMExports();
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve: (value: T) => resolve(value) }; }
function fixture() {
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({ store: { getSetting: (key: string) => key === 'bridge_feishu_stream_card_notify_on_complete' ? 'false' : null, insertAuditLog() {} } as unknown as BridgeStore, permissions: { resolvePendingPermission: () => false }, llm: { streamChat: blocked }, lifecycle: {} });
  const calls: Array<{ kind: string; request: any }> = []; let sequence = 0;
  const call = (kind: string) => async (request: any) => { calls.push({ kind, request }); return { code: 0, data: { card_id: `card-${++sequence}`, message_id: `m-${sequence}`, reaction_id: `r-${sequence}` } }; };
  const client = { cardkit: { v1: { card: { create: call('card.create'), update: call('card.update'), settings: call('card.settings'), batchUpdate: call('batch') }, cardElement: { content: call('content') } } }, im: { message: { create: call('message.create'), reply: call('reply'), patch: call('patch') }, messageReaction: { create: call('reaction.create'), delete: call('reaction.delete') } } };
  const adapter = new FeishuAdapter();
  const internal = adapter as any;
  internal.restClient = client; internal.isAuthorized = () => true;
  return { adapter, internal, client, calls };
}
const tick = () => new Promise<void>(r => setImmediate(r));

test('取消旧卡创建后新回合开始，旧创建和旧finalize不改新卡', async () => {
  const f = fixture(); const old = deferred<any>(); let creating = 0;
  f.client.cardkit.v1.card.create = async () => ++creating === 1 ? old.promise : { code: 0, data: { card_id: 'new', message_id: '', reaction_id: '' } };
  f.internal.lastIncomingMessageId.set('chat', 'old-user'); f.adapter.onMessageStart('chat');
  f.adapter.onStreamText('chat', 'old text'); f.adapter.onProgress('chat', 'old progress');
  const finishOld = f.adapter.onStreamEnd('chat', 'interrupted', 'old');
  f.adapter.onMessageEnd('chat');
  f.internal.lastIncomingMessageId.set('chat', 'new-user'); f.adapter.onMessageStart('chat'); await tick();
  const newState = f.internal.activeCards.get('chat'); assert.equal(newState.cardId, 'new');
  old.resolve({ code: 0, data: { card_id: 'old' } }); assert.equal(await finishOld, false); await tick();
  assert.equal(f.internal.activeCards.get('chat'), newState);
  assert.equal(newState.pendingText, null); assert.equal(newState.progress, '');
  assert.equal(f.calls.filter(call => call.kind === 'card.update').length, 0);
  f.adapter.onMessageEnd('chat');
});

test('旧正文更新在等待时取消，新卡不被旧收尾删除或完成通知污染', async () => {
  const f = fixture(); await f.internal.createStreamingCard('chat');
  const operation = deferred<void>(); const oldState = f.internal.activeCards.get('chat'); oldState.operation = operation.promise;
  const ending = f.adapter.onStreamEnd('chat', 'completed', 'old');
  f.adapter.onMessageStart('chat'); await f.internal.createStreamingCard('chat');
  const newState = f.internal.activeCards.get('chat'); operation.resolve();
  assert.equal(await ending, false); assert.equal(f.internal.activeCards.get('chat'), newState);
  assert.equal(f.calls.filter(call => call.kind === 'card.update').length, 0); f.adapter.onMessageEnd('chat');
});

test('Typing 删除绑定创建时用户消息，迟到 reaction 只删自身', async () => {
  const f = fixture(); const pending = deferred<any>(); f.client.im.messageReaction.create = async () => pending.promise;
  f.internal.lastIncomingMessageId.set('chat', 'original'); f.adapter.onMessageStart('chat');
  f.internal.lastIncomingMessageId.set('chat', 'stop-command'); f.adapter.onMessageEnd('chat');
  pending.resolve({ code: 0, data: { reaction_id: 'old-reaction' } }); await tick();
  const deletion = f.calls.find(call => call.kind === 'reaction.delete');
  assert.equal(deletion?.request.path.message_id, 'original');
});

test('审批终态 patch 原卡并移除所有按钮', async () => {
  const f = fixture(); await f.adapter.updateInteractionMessage({ channelType: 'feishu', chatId: 'chat' }, 'original', 'expired');
  const patch = f.calls.find(call => call.kind === 'patch'); assert.equal(patch?.request.path.message_id, 'original');
  assert.match(patch?.request.data.content, /过期/); assert.doesNotMatch(patch?.request.data.content, /callback|button/);
});

test('分块在真实 send 构造后的 payload 仍在 30KB 内；超长直发明确拒绝', async () => {
  const f = fixture(); const text = '```ts\n' + 'const 中文 = "😀\\";\n'.repeat(4000) + '```';
  for (const part of splitFeishuMarkdown(text)) assert.equal((await f.adapter.send({ address: { channelType: 'feishu', chatId: 'chat' }, text: part, parseMode: 'Markdown' })).ok, true);
  assert.ok(f.calls.filter(call => call.kind === 'message.create').every(call => Buffer.byteLength(JSON.stringify(call.request.data), 'utf8') <= 30000));
  const count = f.calls.length; assert.equal((await f.adapter.send({ address: { channelType: 'feishu', chatId: 'chat' }, text, parseMode: 'Markdown' })).httpStatus, 413); assert.equal(f.calls.length, count);
});

const event = (id: string, type: string, content: unknown) => ({ sender: { sender_type: 'user', sender_id: { open_id: 'user' } }, message: { message_id: id, chat_id: 'chat', chat_type: 'p2p', create_time: '123', message_type: type, content: JSON.stringify(content) } });
test('富文本图片部分失败明确提示，保留成功附件；全部失败不交模型', async () => {
  const f = fixture(); let calls = 0;
  f.internal.downloadResource = async () => ++calls === 1 ? { type: 'image/png', data: 'abc', name: 'one.png' } : null;
  const content = { title: '材料', content: [[{ tag: 'text', text: '分析' }, { tag: 'img', image_key: 'one' }, { tag: 'img', image_key: 'two' }]] };
  await f.internal.handleIncomingEvent(event('partial', 'post', content));
  assert.equal(f.internal.queue.length, 1); assert.equal(f.internal.queue[0].attachments.length, 1); assert.match(f.internal.queue[0].text, /图片 2 未能读取/);
  await f.internal.handleIncomingEvent(event('allfailed', 'image', { image_key: 'nope' }));
  assert.equal(f.internal.queue.length, 1); assert.ok(f.calls.some(call => String(call.request.data.content).includes('本条未交给模型')));
});

test('不支持类型不下载；异常不提前dedup，重复事件可重试', async () => {
  const f = fixture(); let downloads = 0;
  f.internal.downloadResource = async () => { downloads++; throw new Error('should not'); };
  await f.internal.handleIncomingEvent(event('file', 'file', { file_key: 'file' }));
  assert.equal(downloads, 0); assert.equal(f.internal.queue.length, 0);
  f.internal.downloadResource = async () => { if (++downloads === 1) throw new Error('temporary'); return { type: 'image/png', data: 'a' }; };
  await f.internal.handleIncomingEvent(event('retryable', 'image', { image_key: 'pic' })); assert.equal(f.internal.seenMessageIds.has('retryable'), false);
  await f.internal.handleIncomingEvent(event('retryable', 'image', { image_key: 'pic' })); assert.equal(f.internal.queue.length, 1);
  await f.internal.handleIncomingEvent(event('retryable', 'image', { image_key: 'pic' })); assert.equal(f.internal.queue.length, 1);
});
