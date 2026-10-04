import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { initBridgeContext } from '../../lib/bridge/context.js';
import type { BridgeStore, PermissionResolution, UserInputRequest } from '../../lib/bridge/host.js';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter.js';
import { clearUserInputRequests, forwardUserInputRequest, handleUserInputResponse, handleUserInputText } from '../../lib/bridge/user-input-broker.js';

const address = { channelType: 'test', chatId: 'chat', userId: 'owner' };
const request: UserInputRequest = { requestId: 'question-1', questions: [{ id: 'q1', question: '选择', options: [{ label: 'A' }, { label: 'B' }] }] };
let resolutions: PermissionResolution[];
beforeEach(() => {
  clearUserInputRequests('session');
  resolutions = [];
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({ store: { getSetting: () => null } as unknown as BridgeStore, llm: { streamChat: () => new ReadableStream() }, permissions: { resolvePendingPermission: (_id, resolution) => { resolutions.push(resolution); return true; } }, lifecycle: {} });
});
const adapter = { sendUserInputRequest: async () => ({ ok: true, messageId: 'card' }) } as unknown as BaseChannelAdapter;

test('问答验证聊天、用户、原卡、选项并且只接受一次', async () => {
  await forwardUserInputRequest(adapter, address, request, 'session');
  const response = { requestId: request.requestId, answers: { q1: ['A'] } };
  assert.equal(handleUserInputResponse({ ...address, chatId: 'other' }, response, 'card'), false);
  assert.equal(handleUserInputResponse({ ...address, userId: 'other' }, response, 'card'), false);
  assert.equal(handleUserInputResponse(address, response, 'wrong'), false);
  assert.equal(handleUserInputResponse(address, { ...response, answers: { q1: ['C'] } }, 'card'), false);
  assert.equal(handleUserInputResponse(address, response, 'card'), true);
  assert.equal(handleUserInputResponse(address, response, 'card'), false);
  assert.deepEqual(resolutions, [{ behavior: 'allow', updatedInput: { answers: { q1: ['A'] } } }]);
});

test('文本答案入口可解开正在等待的流，结束后旧答案失效', async () => {
  await forwardUserInputRequest(adapter, address, request, 'session');
  assert.equal(handleUserInputText(address, '/answer question-1 B'), true);
  await forwardUserInputRequest(adapter, address, request, 'session');
  clearUserInputRequests('session');
  assert.equal(handleUserInputText(address, '/answer question-1 A'), false);
});

test('敏感问题拒绝通过公开文本降级', async () => {
  let sends = 0;
  const plainAdapter = { send: async () => { sends++; return { ok: true, messageId: 'plain' }; } } as unknown as BaseChannelAdapter;
  await forwardUserInputRequest(plainAdapter, address, { requestId: 'secret', questions: [{ id: 'q', question: '凭据', isSecret: true }] }, 'session');
  assert.equal(sends, 0);
  assert.equal(resolutions[0].behavior, 'deny');
});
