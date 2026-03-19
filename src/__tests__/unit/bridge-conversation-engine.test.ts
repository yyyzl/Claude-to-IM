import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { initBridgeContext } from '../../lib/bridge/context';
import { processMessage } from '../../lib/bridge/conversation-engine';
import type { BridgeStore, LLMProvider, StreamChatParams } from '../../lib/bridge/host';
import type { ChannelBinding } from '../../lib/bridge/types';

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

function createBinding(mode: ChannelBinding['mode']): ChannelBinding {
  return {
    id: `binding-${mode}`,
    channelType: 'telegram',
    chatId: `chat-${mode}`,
    codepilotSessionId: `session-${mode}`,
    sdkSessionId: '',
    workingDirectory: 'G:\\project\\Claude-to-IM',
    model: 'claude-sonnet-test',
    mode,
    backend: 'claude',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createStore(): BridgeStore {
  return {
    getSetting: () => null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({ } as ChannelBinding),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: (id: string) => ({
      id,
      working_directory: 'G:\\project\\Claude-to-IM',
      model: 'claude-sonnet-test',
    }),
    createSession: () => ({
      id: 'session-new',
      working_directory: 'G:\\project\\Claude-to-IM',
      model: 'claude-sonnet-test',
    }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
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

describe('conversation-engine permission mode mapping', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__bridge_context__;
  });

  it('uses dontAsk for code mode, while ask/plan still require approvals', async () => {
    const seenModes: string[] = [];
    const llm: LLMProvider = {
      streamChat: (params: StreamChatParams) => {
        seenModes.push(params.permissionMode || '');
        return streamFromChunks([
          sse('text', 'ok'),
          sse('result', { is_error: false, usage: null, session_id: 'sdk-session-1' }),
        ]);
      },
    };

    initBridgeContext({
      store: createStore(),
      llm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const codeResult = await processMessage(createBinding('code'), 'code request');
    const askResult = await processMessage(createBinding('ask'), 'ask request');
    const planResult = await processMessage(createBinding('plan'), 'plan request');

    assert.equal(codeResult.responseText, 'ok');
    assert.equal(askResult.responseText, 'ok');
    assert.equal(planResult.responseText, 'ok');
    assert.deepEqual(seenModes, ['dontAsk', 'default', 'plan']);
  });
});
