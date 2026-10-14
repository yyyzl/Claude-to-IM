/** 完成通知只在完整正文已写入后发送，沿用现有启用配置。 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context.js';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';
import type { BridgeStore } from '../../lib/bridge/host.js';

type Request = { path?: Record<string, string>; data: Record<string, unknown> };
async function fixture(settings: Record<string, string> = {}) {
  initBridgeContext({ store: { getSetting: (key: string) => settings[key] ?? null } as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() }, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
  const adapter = new FeishuAdapter();
  const calls: Array<{ method: string; request: Request }> = [];
  const call = (method: string) => async (request: Request) => { calls.push({ method, request }); return { code: 0, data: { card_id: 'card-1', message_id: 'message-1' } }; };
  const internal = adapter as unknown as { restClient: unknown; createStreamingCard(chatId: string): Promise<boolean> };
  internal.restClient = { cardkit: { v1: { card: { create: call('card.create'), batchUpdate: call('batch'), settings: call('settings') } } }, im: { message: { create: call('message.create') } } };
  assert.equal(await internal.createStreamingCard('chat'), true);
  calls.length = 0;
  return { adapter, calls };
}

describe('飞书过程卡完成通知', () => {
  beforeEach(() => { delete (globalThis as Record<string, unknown>).__bridge_context__; });
  it('默认启用：局部收尾后发送一条通知，并清理原卡', async () => {
    const { adapter, calls } = await fixture();
    assert.equal(await adapter.onStreamEnd('chat', 'completed', 'hello'), true);
    assert.deepEqual(calls.map(call => call.method), ['batch', 'batch', 'message.create']);
    assert.equal(calls[0].request.data.sequence, 1);
    const notice = calls[2].request.data;
    assert.equal(notice.receive_id, 'chat'); assert.equal(notice.msg_type, 'text');
    assert.match(JSON.parse(String(notice.content)).text, /任务已完成/);
    assert.match(JSON.parse(String(notice.content)).text, /耗时/);
    assert.equal(adapter.hasActiveCard('chat'), false);
  });
  it('关闭配置时仍收尾原卡但不发通知', async () => {
    const { adapter, calls } = await fixture({ bridge_feishu_stream_card_notify_on_complete: 'false' });
    assert.equal(await adapter.onStreamEnd('chat', 'completed', 'hello'), true);
    assert.deepEqual(calls.map(call => call.method), ['batch', 'batch']);
  });
  it('空正文错误回合不重复发送错误通知', async () => {
    const { adapter, calls } = await fixture();
    assert.equal(await adapter.onStreamEnd('chat', 'error', ''), true);
    assert.deepEqual(calls.map(call => call.method), ['batch', 'batch']);
  });
});
