import assert from 'node:assert/strict';
import { describe, it, beforeEach, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

import { initBridgeContext } from '../../lib/bridge/context';
import { processMessage } from '../../lib/bridge/conversation-engine';
import type { ActiveTurnInput, BridgeStore, LLMProvider, StreamChatParams, TurnInputResult } from '../../lib/bridge/host';
import type { ChannelBinding } from '../../lib/bridge/types';
import { resolveBridgeSetting } from '../../../scripts/claude-to-im-bridge/settings.ts';

const blocked = () => { throw new Error('禁止真实子进程和网络'); };
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) mock.method(childProcess, key, blocked);
mock.method(globalThis, 'fetch', blocked);
syncBuiltinESMExports();

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

  it('leaves the model unset for a Codex catalog default even when Claude has a configured default', async () => {
    const binding = { ...createBinding('code'), backend: 'codex', model: '' };
    const store = createStore();
    store.getSetting = key => resolveBridgeSetting(key, 'G:/target', { bridge_llm_backend: 'codex', bridge_default_model: 'claude-only' });
    store.getSession = id => ({ id, model: '', working_directory: 'G:/target' });
    const seen: Array<string | undefined> = [];
    initBridgeContext({ store, llm: { streamChat: params => { seen.push(params.model); return streamFromChunks([sse('result', { is_error: false })]); } }, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
    await processMessage(binding, 'hi');
    assert.deepEqual(seen, [undefined]);
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

describe('当前回合补充历史栅栏', () => {
  it('正常初始化等待 ready 不提前 unknown，结算封口后的迟到收据不写历史', async () => {
    const records: string[] = [];
    const store = createStore(); store.addMessage = (_session, _role, text) => { records.push(text); };
    let receipt: ((value: TurnInputResult) => void) | undefined;
    let controller: ReadableStreamDefaultController<string> | undefined;
    initBridgeContext({ store, llm: { streamChat: params => {
      params.onActiveTurnInput?.({ seal: () => {}, submitText: () => new Promise(done => { receipt = done; }) });
      return new ReadableStream({ start: value => { controller = value; } });
    } }, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
    let input: ActiveTurnInput | undefined;
    const work = processMessage(createBinding('code'), '原始', undefined, undefined, undefined, undefined, undefined,
      { onActiveTurnInput: value => { input = value; } });
    assert.ok(input);
    let resolved = false;
    const pending = input.submitText('补充').then(value => { resolved = true; return value; });
    await new Promise(done => setTimeout(done, 3_100));
    const prematurelyResolved = resolved;
    controller!.enqueue(sse('text', '最终')); controller!.close();
    await work;
    assert.equal((await pending).status, 'unknown');
    receipt?.({ status: 'accepted' }); await new Promise(done => setImmediate(done));
    assert.deepEqual(records, ['原始', '最终']);
    assert.equal(prematurelyResolved, false, '正常初始化不能受 RPC 回执 deadline 影响');
  });
  it('同步登记连续补充，EOF 等待回执，按 user/user/user/assistant 保存', async () => {
    const records: Array<{ session: string; role: string; text: string }> = [];
    const store = createStore();
    store.addMessage = (session, role, text) => { records.push({ session, role, text }); };
    let finishFirst: ((value: TurnInputResult) => void) | undefined;
    const submitted: string[] = [];
    let controller: ReadableStreamDefaultController<string> | undefined;
    const llm: LLMProvider = { streamChat: params => {
      params.onActiveTurnInput?.({ seal: () => {}, submitText: text => {
        submitted.push(text);
        return text === '补充1' ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve({ status: 'accepted' });
      } });
      return new ReadableStream({ start: value => { controller = value; } });
    } };
    initBridgeContext({ store, llm, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
    let input: ActiveTurnInput | undefined;
    const work = processMessage(createBinding('code'), '原始', undefined, undefined, undefined, undefined, undefined,
      { onActiveTurnInput: (value: ActiveTurnInput) => { input = value; } });
    assert.ok(input, 'engine 必须包装并发布当前输入');
    const first = input.submitText('补充1');
    const second = input.submitText('补充2');
    controller!.enqueue(sse('text', '最终'));
    controller!.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(submitted, ['补充1']);
    assert.deepEqual(records.map(record => record.role), ['user']);
    assert.ok(finishFirst);
    finishFirst({ status: 'accepted' });
    await Promise.all([first, second, work]);
    assert.deepEqual(submitted, ['补充1', '补充2']);
    assert.deepEqual(records.map(record => [record.role, record.text]), [['user', '原始'], ['user', '补充1'], ['user', '补充2'], ['assistant', '最终']]);
    assert.ok(records.every(record => record.session === 'session-code'));
    assert.equal((await input.submitText('迟到')).status, 'not-submitted');
  });

  for (const streamError of [false, true]) {
  it(`accepted 后历史保存失败保留接收事实，不重送且不掩盖缺失历史（streamError=${streamError}）`, async () => {
    const store = createStore();
    const recorded: string[] = [];
    store.addMessage = (_session, _role, text) => { if (text === '补充') throw new Error('disk'); recorded.push(text); };
    let calls = 0;
    let controller: ReadableStreamDefaultController<string> | undefined;
    initBridgeContext({ store, llm: { streamChat: params => {
      params.onActiveTurnInput?.({ seal: () => {}, submitText: async () => { calls++; return { status: 'accepted' }; } });
      return new ReadableStream({ start: value => { controller = value; } });
    } }, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
    let input: ActiveTurnInput | undefined;
    const work = processMessage(createBinding('code'), '原始', undefined, undefined, undefined, undefined, undefined,
      { onActiveTurnInput: (value: ActiveTurnInput) => { input = value; } });
    assert.ok(input, 'engine 必须提供输入');
    assert.deepEqual(await input.submitText('补充'), { status: 'accepted', historyError: true });
    if (streamError) controller!.error(new Error('模型流失败'));
    else { controller!.enqueue(sse('text', '最终')); controller!.close(); }
    const result = await work;
    assert.equal(calls, 1);
    assert.equal(result.hasError, true);
    assert.match(result.errorMessage, /记录/);
    assert.deepEqual(recorded, ['原始']);
  });
  }
});
