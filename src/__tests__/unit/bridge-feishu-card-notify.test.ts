/**
 * Unit tests for Feishu streaming card completion notice.
 *
 * Goal:
 * - When a streaming card is finalized, send a new text message to trigger unread/push.
 * - Allow disabling via setting: bridge_feishu_stream_card_notify_on_complete=false
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter';
import type { BridgeStore } from '../../lib/bridge/host';

function setupContext(settings: Record<string, string> = {}) {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store: {
      getSetting: (key: string) => settings[key] ?? null,
    } as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

function seedActiveCard(adapter: FeishuAdapter, chatId: string, startTime: number) {
  (adapter as any).activeCards.set(chatId, {
    cardId: 'card-1',
    messageId: 'msg-1',
    sequence: 0,
    startTime,
    toolCalls: [],
    thinking: false,
    pendingText: null,
    lastUpdateAt: 0,
    throttleTimer: null,
    nextFlushAt: null,
    inFlight: false,
    needsFlush: false,
    cooldownUntil: 0,
    rateLimitBackoffMs: 5_000,
    lastRateLimitLogAt: 0,
  });
}

describe('feishu-adapter - streaming card completion notice', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('sends a completion notice message after card finalized (default enabled)', async () => {
    setupContext();

    const adapter = new FeishuAdapter();
    const calls: { update: any[]; create: any[] } = { update: [], create: [] };

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            update: async (req: any) => {
              calls.update.push(req);
              return { data: {} };
            },
          },
        },
      },
      im: {
        message: {
          create: async (req: any) => {
            calls.create.push(req);
            return { data: { message_id: 'msg-notify-1' } };
          },
        },
      },
    };

    const chatId = 'chat-1';
    seedActiveCard(adapter, chatId, Date.now() - 1200);

    const ok = await adapter.onStreamEnd(chatId, 'completed', 'hello');
    assert.equal(ok, true);

    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0]?.data?.sequence, 1);

    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0]?.data?.receive_id, chatId);
    assert.equal(calls.create[0]?.data?.msg_type, 'text');
    const payload = JSON.parse(calls.create[0]?.data?.content);
    assert.match(payload.text, /任务已完成/);
    assert.match(payload.text, /耗时/);

    assert.equal((adapter as any).activeCards.has(chatId), false, 'Card state should be cleared after finalize');
  });

  it('does not send completion notice when disabled by setting', async () => {
    setupContext({ bridge_feishu_stream_card_notify_on_complete: 'false' });

    const adapter = new FeishuAdapter();
    const calls: { update: any[]; create: any[] } = { update: [], create: [] };

    (adapter as any).restClient = {
      cardkit: { v1: { card: { update: async (req: any) => { calls.update.push(req); return { data: {} }; } } } },
      im: { message: { create: async (req: any) => { calls.create.push(req); return { data: { message_id: 'msg-notify-1' } }; } } },
    };

    const chatId = 'chat-2';
    seedActiveCard(adapter, chatId, Date.now() - 500);

    const ok = await adapter.onStreamEnd(chatId, 'completed', 'hello');
    assert.equal(ok, true);
    assert.equal(calls.update.length, 1);
    assert.equal(calls.create.length, 0);
  });

  it('does not send error notice when responseText is empty (avoid duplicate error messages)', async () => {
    setupContext();

    const adapter = new FeishuAdapter();
    const calls: { update: any[]; create: any[] } = { update: [], create: [] };

    (adapter as any).restClient = {
      cardkit: { v1: { card: { update: async (req: any) => { calls.update.push(req); return { data: {} }; } } } },
      im: { message: { create: async (req: any) => { calls.create.push(req); return { data: { message_id: 'msg-notify-1' } }; } } },
    };

    const chatId = 'chat-3';
    seedActiveCard(adapter, chatId, Date.now() - 500);

    const ok = await adapter.onStreamEnd(chatId, 'error', '');
    assert.equal(ok, true);
    assert.equal(calls.update.length, 1);
    assert.equal(calls.create.length, 0);
  });
});

