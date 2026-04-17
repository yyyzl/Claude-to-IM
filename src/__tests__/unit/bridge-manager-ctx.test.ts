import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import { initBridgeContext } from '../../lib/bridge/context';
import type { BridgeSession, BridgeStore, LLMProvider, UpsertChannelBindingInput } from '../../lib/bridge/host';
import type { ChannelBinding, InboundMessage, OutboundMessage, SendResult } from '../../lib/bridge/types';

function sse(type: 'text' | 'result', data: string | Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type, data: typeof data === 'string' ? data : JSON.stringify(data) })}\n`;
}

function streamFromChunks(chunks: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function createStore(): BridgeStore {
  const sessions = new Map<string, BridgeSession>();
  const bindings = new Map<string, ChannelBinding>();
  let sessionSeq = 0;

  const upsertBinding = (data: UpsertChannelBindingInput) => {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = bindings.get(key);
    const mode: ChannelBinding['mode'] = data.mode === 'plan' || data.mode === 'ask' ? data.mode : 'code';
    const next: ChannelBinding = existing ?? {
      id: `binding-${bindings.size + 1}`,
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: '',
      workingDirectory: data.workingDirectory || 'G:\\project\\Claude-to-IM',
      model: data.model || 'gpt-5',
      mode,
      backend: data.backend || 'codex',
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const merged: ChannelBinding = {
      ...next,
      ...data,
      mode,
      updatedAt: new Date().toISOString(),
    };
    bindings.set(key, merged);
    return merged;
  };

  return {
    getSetting: (key: string) => {
      if (key === 'bridge_llm_backend') return 'codex';
      if (key === 'bridge_default_model') return 'claude-sonnet-test';
      return null;
    },
    getChannelBinding: (channelType: string, chatId: string) => bindings.get(`${channelType}:${chatId}`) ?? null,
    upsertChannelBinding: (data) => upsertBinding(data),
    updateChannelBinding: (id: string, updates: Partial<ChannelBinding>) => {
      const entry = [...bindings.values()].find((binding) => binding.id === id);
      if (!entry) return;
      bindings.set(`${entry.channelType}:${entry.chatId}`, {
        ...entry,
        ...updates,
        updatedAt: new Date().toISOString(),
      });
    },
    listChannelBindings: (channelType?: string) => {
      const all = [...bindings.values()];
      return channelType ? all.filter((binding) => binding.channelType === channelType) : all;
    },
    getSession: (id: string) => sessions.get(id) ?? null,
    createSession: (_name: string, model: string, _systemPrompt?: string, cwd?: string) => {
      sessionSeq += 1;
      const session: BridgeSession = {
        id: `session-${sessionSeq}`,
        working_directory: cwd || 'G:\\project\\Claude-to-IM',
        model,
      };
      sessions.set(session.id, session);
      return session;
    },
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: (sessionId: string, sdkSessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      sessions.set(sessionId, { ...session, sdkSessionId } as BridgeSession);
    },
    updateSessionModel: (sessionId: string, model: string) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      sessions.set(sessionId, { ...session, model });
    },
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

function createAdapter() {
  const sent: OutboundMessage[] = [];
  const streamEndCalls: Array<{ status: string; responseText: string; extras?: { ctx?: string } }> = [];

  class MockCardAdapter extends BaseChannelAdapter {
    readonly channelType = 'feishu';

    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    isRunning(): boolean { return true; }
    async consumeOne(): Promise<InboundMessage | null> { return null; }
    async send(message: OutboundMessage): Promise<SendResult> {
      sent.push(message);
      return { ok: true, messageId: 'msg-1' };
    }
    validateConfig(): string | null { return null; }
    isAuthorized(): boolean { return true; }
    onStreamText(): void {}
    async onStreamEnd(
      _chatId: string,
      status: 'completed' | 'interrupted' | 'error',
      responseText: string,
      extras?: { ctx?: string },
    ): Promise<boolean> {
      streamEndCalls.push({ status, responseText, extras });
      return true;
    }
  }

  return { adapter: new MockCardAdapter(), sent, streamEndCalls };
}

async function runHandleMessage(stream: ReadableStream<string>) {
  const llm: LLMProvider = { streamChat: () => stream };
  const store = createStore();
  initBridgeContext({
    store,
    llm,
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });

  const { adapter, sent, streamEndCalls } = createAdapter();
  const { _testOnly } = await import('../../lib/bridge/bridge-manager');
  const msg: InboundMessage = {
    messageId: 'in-1',
    address: { channelType: 'feishu', chatId: 'chat-1', userId: 'user-1' },
    text: 'hello',
    timestamp: Date.now(),
  };

  await _testOnly.handleMessage(adapter, msg);
  return { sent, streamEndCalls };
}

describe('bridge-manager ctx footer', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    delete (globalThis as Record<string, unknown>).__bridge_manager__;
  });

  it('prefers last_usage over cumulative usage for ctx footer', async () => {
    const { sent, streamEndCalls } = await runHandleMessage(streamFromChunks([
      sse('text', 'ok'),
      sse('result', {
        usage: { input_tokens: 661_504, output_tokens: 153 },
        last_usage: { input_tokens: 6_708, output_tokens: 51 },
        context_window: 258_400,
        is_error: false,
        session_id: 'sdk-1',
      }),
    ]));

    assert.equal(sent.length, 0);
    assert.equal(streamEndCalls.length, 1);
    assert.equal(streamEndCalls[0].extras?.ctx, 'ctx 3% (6.7k/258.4k)');
  });

  it('omits ctx footer when only cumulative usage exists', async () => {
    const { streamEndCalls } = await runHandleMessage(streamFromChunks([
      sse('text', 'ok'),
      sse('result', {
        usage: { input_tokens: 661_504, output_tokens: 153 },
        context_window: 258_400,
        is_error: false,
        session_id: 'sdk-1',
      }),
    ]));

    assert.equal(streamEndCalls.length, 1);
    assert.equal(streamEndCalls[0].extras, undefined);
  });
});
