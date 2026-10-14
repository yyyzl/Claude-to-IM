import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { initBridgeContext } from '../../lib/bridge/context.js';
import type { BridgeStore, PermissionResolution, UserInputRequest, UserInputResponse } from '../../lib/bridge/host.js';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter.js';
import { clearUserInputRequests, forwardUserInputRequest, handleUserInputResponse, handleUserInputText } from '../../lib/bridge/user-input-broker.js';
import * as broker from '../../lib/bridge/user-input-broker.js';
import { InMemoryPermissionGateway } from '../../../scripts/claude-to-im-bridge/permissions.ts';

const feishu = { channelType: 'feishu', chatId: 'chat', userId: 'owner' };
async function closedSetup(reason: 'request_closed' | 'turn_completed' | 'cancelled' = 'request_closed', send?: () => Promise<{ ok: boolean; messageId?: string }>) {
  const gateway = new InMemoryPermissionGateway({ permissionTimeoutMs: 0 }); const states: string[] = [];
  initBridgeContext({ store: { getSetting: () => '20' } as unknown as BridgeStore, llm: { streamChat: () => new ReadableStream() }, permissions: gateway, lifecycle: {} });
  const fake = { channelType: 'feishu', sendUserInputRequest: send ?? (async () => ({ ok: true, messageId: 'card' })), updateUserInputRequest: async (_a: unknown, _id: string, _r: unknown, state: string) => { states.push(state); } } as unknown as BaseChannelAdapter;
  gateway.waitFor(request.requestId);
  const options = { isCurrent: () => true, canSupplement: () => true, allowSupplement: true };
  const sending = forwardUserInputRequest(fake, feishu, request, 'session', undefined, options);
  gateway.resolvePendingPermission(request.requestId, { behavior: 'deny', reason });
  await sending;
  await new Promise(resolve => setImmediate(resolve));
  return { states, options, gateway, fake };
}
const prepare = broker.prepareUserInputSupplement;

const nativeRequest: UserInputRequest = { requestId: 'native-question', answerChannel: 'message', isBlocking: false, questions: [
  { id: 'q0', question: '报告格式', options: [{ label: 'A' }, { label: 'B' }], allowOther: true }, { id: 'q1', question: '标记' },
] };
async function nativeSetup() {
  let observes = 0; let resolves = 0; const phases: string[] = [];
  const gateway = new InMemoryPermissionGateway({ permissionTimeoutMs: 0 });
  initBridgeContext({ store: { getSetting: () => '20' } as unknown as BridgeStore, llm: { streamChat: () => new ReadableStream() },
    permissions: { onResolution: (...args) => { observes++; return gateway.onResolution(...args); }, resolvePendingPermission: (...args) => { resolves++; return gateway.resolvePendingPermission(...args); } }, lifecycle: {} });
  const fake = { channelType: 'feishu', sendUserInputRequest: async () => ({ ok: true, messageId: 'card' }), updateUserInputRequest: async (_a: unknown, _id: string, _request: unknown, phase: string) => { phases.push(phase); } } as unknown as BaseChannelAdapter;
  const options = { isCurrent: () => true, canSupplement: () => true, allowSupplement: true };
  await forwardUserInputRequest(fake, feishu, nativeRequest, 'session', undefined, options);
  return { counts: () => ({ observes, resolves }), phases, options, fake };
}

test('原生pending答案按消息准入，选择和自由替代不访问权限网关', async () => {
  for (const choice of ['A', '自由替代']) {
    clearUserInputRequests('session'); const { counts } = await nativeSetup();
    assert.deepEqual(counts(), { observes: 0, resolves: 0 });
    const response = { requestId: nativeRequest.requestId, answers: { q0: [choice], q1: ['QA'] } };
    assert.equal(handleUserInputResponse(feishu, response, 'card'), false);
    const ready = prepare(feishu, response, 'card', 'answer');
    assert.equal(ready.status, 'ready'); assert.match(ready.text!, /报告格式/); assert.match(ready.text!, /QA/);
    let admits = 0; assert.equal(ready.claim!(() => { admits++; }), true); assert.equal(ready.claim!(() => { admits++; }), false);
    assert.equal(admits, 1); assert.deepEqual(counts(), { observes: 0, resolves: 0 });
  }
});

test('原生正常clear转closed，原答案动作不自动补充，取消不提供补充', async () => {
  const { phases, options, counts } = await nativeSetup();
  clearUserInputRequests('session', { preserveClosed: true, owner: options.isCurrent });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(phases, ['closed']);
  const response = { requestId: nativeRequest.requestId, answers: { q0: ['B'], q1: ['QA'] } };
  assert.equal(prepare(feishu, response, 'card', 'answer').status, 'invalid');
  assert.equal(prepare(feishu, response, 'card', 'supplement').status, 'ready');
  clearUserInputRequests('session'); assert.equal(prepare(feishu, response, 'card', 'supplement').status, 'invalid');
  assert.deepEqual(counts(), { observes: 0, resolves: 0 });
});

test('原生卡发送晚到，正常闭合保留补充而取消不复活', async () => {
  for (const cancelled of [false, true]) {
    clearUserInputRequests('session'); const { fake, options, counts, phases } = await nativeSetup(); clearUserInputRequests('session');
    await new Promise(resolve => setImmediate(resolve)); phases.length = 0;
    let release!: (value: { ok: boolean; messageId: string }) => void;
    fake.sendUserInputRequest = () => new Promise(resolve => { release = resolve; });
    const sending = forwardUserInputRequest(fake, feishu, nativeRequest, 'session', undefined, options);
    clearUserInputRequests('session', { preserveClosed: true, owner: options.isCurrent });
    if (cancelled) broker.invalidateUserInputRequests(feishu);
    release({ ok: true, messageId: 'card' }); await sending; await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(phases, [cancelled ? 'cancelled' : 'closed']);
    assert.equal(prepare(feishu, { requestId: nativeRequest.requestId, answers: { q0: ['A'], q1: ['QA'] } }, 'card', 'supplement').status, cancelled ? 'invalid' : 'ready');
    assert.deepEqual(counts(), { observes: 0, resolves: 0 });
  }
});

test('非飞书原生题保留题目选项文字，不创建问答表单或网关请求', async () => {
  const { counts } = await nativeSetup(); clearUserInputRequests('session'); let sent = '';
  const fake = { channelType: 'telegram', send: async (message: { text: string }) => { sent = message.text; return { ok: true, messageId: 'text' }; } } as unknown as BaseChannelAdapter;
  await forwardUserInputRequest(fake, { ...feishu, channelType: 'telegram', chatId: 'native-other' }, nativeRequest, 'session');
  assert.match(sent, /报告格式/); assert.match(sent, /- A/); assert.match(sent, /标记/);
  assert.doesNotMatch(sent, /\/answer/); assert.deepEqual(counts(), { observes: 0, resolves: 0 });
});

test('补充 claim 缺少准入回调时不消费资格，合法回调仅执行一次', async () => {
  const { states } = await closedSetup();
  const response = { requestId: request.requestId, answers: { q1: ['A'] } };
  const ready = prepare(feishu, response, 'card', 'supplement');
  assert.equal(ready.status, 'ready');
  // 模拟 JavaScript 调用方缺参，验证实际行为而不是仅让类型检查失败。
  const claim = ready.claim as unknown as (admit?: () => void) => boolean;
  assert.equal(claim(), false);
  assert.equal(prepare(feishu, response, 'card', 'supplement').status, 'ready');
  assert.deepEqual(states, ['closed']);
  let admitted = 0;
  assert.equal(claim(() => { admitted++; }), true);
  assert.equal(claim(() => { admitted++; }), false);
  assert.equal(admitted, 1);
});

test('服务端闭合保留原题与表单，仅显式补充可 claim 一次', async () => {
  const { states } = await closedSetup();
  assert.deepEqual(states, ['closed']);
  const answer = { requestId: request.requestId, answers: { q1: ['A'] }, question: '伪造原题' };
  assert.equal(handleUserInputResponse(feishu, answer, 'card'), false);
  const ready = prepare(feishu, answer, 'card', 'supplement');
  assert.equal(ready.status, 'ready'); assert.match(ready.text!, /选择/); assert.match(ready.text!, /A/); assert.doesNotMatch(ready.text!, /伪造原题/);
  assert.equal(ready.claim!(() => {}), true); assert.equal(ready.claim!(() => {}), false);
  assert.equal(prepare(feishu, answer, 'card', 'supplement').status, 'invalid');
});

test('闭合补充必须匹配原用户聊天原卡和合法完整答案', async () => {
  await closedSetup(); const response = { requestId: request.requestId, answers: { q1: ['A'] } };
  for (const [a, r, card] of [
    [{ ...feishu, userId: 'other' }, response, 'card'], [{ ...feishu, chatId: 'other' }, response, 'card'], [feishu, response, 'wrong'],
    [feishu, { ...response, answers: { q1: ['C'] } }, 'card'], [feishu, { ...response, answers: { q1: ['A'], forged: ['B'] } }, 'card'],
  ] as [typeof feishu, UserInputResponse, string][]) assert.equal(prepare(a, r, card, 'supplement').status, 'invalid');
  assert.equal(prepare(feishu, response, 'card', 'supplement').status, 'ready');
});

test('答案不能借用原型上的数组填补缺少的问题', async () => {
  await forwardUserInputRequest(adapter, address, request, 'session');
  const inherited = Object.create({ q1: ['A'] }) as Record<string, string[]>;
  assert.equal(handleUserInputResponse(address, { requestId: request.requestId, answers: inherited }, 'card'), false);
  assert.equal(resolutions.length, 0);
  assert.equal(handleUserInputResponse(address, { requestId: request.requestId, answers: { q1: ['A'] } }, 'card'), true);
});

test('订阅前已闭合的真实网关同步回放，原卡晚到仍只提供显式补充', async () => {
  const gateway = new InMemoryPermissionGateway({ permissionTimeoutMs: 0 });
  const states: string[] = [];
  let sends = 0;
  const next = { ...request, requestId: 'resolved-before-forward' };
  gateway.waitFor(next.requestId);
  gateway.resolvePendingPermission(next.requestId, { behavior: 'deny', reason: 'turn_completed' });
  initBridgeContext({ store: { getSetting: () => null } as unknown as BridgeStore, llm: { streamChat: () => new ReadableStream() }, permissions: gateway, lifecycle: {} });
  const fake = {
    sendUserInputRequest: async () => { sends++; return { ok: true, messageId: 'late-card' }; },
    updateUserInputRequest: async (_address: unknown, _id: string, _request: unknown, phase: string) => { states.push(phase); },
  } as unknown as BaseChannelAdapter;
  await forwardUserInputRequest(fake, feishu, next, 'session', undefined, { isCurrent: () => true, canSupplement: () => true, allowSupplement: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 1);
  assert.deepEqual(states, ['closed']);
  assert.equal(handleUserInputResponse(feishu, { requestId: next.requestId, answers: { q1: ['A'] } }, 'late-card'), false);
  assert.equal(prepare(feishu, { requestId: next.requestId, answers: { q1: ['A'] } }, 'late-card', 'supplement').status, 'ready');
});

test('同 session 的两张闭合卡按聊天独立取消，回合清理不误伤另一 owner', async () => {
  const { gateway, fake, options } = await closedSetup();
  const second = { ...request, requestId: 'other-owner' };
  const other = { ...feishu, chatId: 'other-chat' };
  const otherOptions = { isCurrent: () => true, canSupplement: () => true, allowSupplement: true };
  gateway.waitFor(second.requestId);
  await forwardUserInputRequest(fake, other, second, 'session', undefined, otherOptions);
  gateway.resolvePendingPermission(second.requestId, { behavior: 'deny', reason: 'request_closed' });
  clearUserInputRequests('session', { owner: options.isCurrent });
  assert.equal(prepare(feishu, { requestId: request.requestId, answers: { q1: ['A'] } }, 'card', 'supplement').status, 'invalid');
  assert.equal(prepare(other, { requestId: second.requestId, answers: { q1: ['A'] } }, 'card', 'supplement').status, 'ready');
  broker.invalidateUserInputRequests(feishu);
  assert.equal(prepare(other, { requestId: second.requestId, answers: { q1: ['A'] } }, 'card', 'supplement').status, 'ready');
  broker.invalidateUserInputRequests(other);
  assert.equal(prepare(other, { requestId: second.requestId, answers: { q1: ['A'] } }, 'card', 'supplement').status, 'invalid');
});

test('正常完成可补充，主动取消与已回答不能复活', async () => {
  assert.deepEqual((await closedSetup('turn_completed')).states, ['closed']);
  clearUserInputRequests('session');
  assert.deepEqual((await closedSetup('cancelled')).states, ['cancelled']);
  assert.equal(prepare(feishu, { requestId: request.requestId, answers: { q1: ['A'] } }, 'card', 'supplement').status, 'invalid');
});

test('补充资格变化在 claim 时复查，不消耗其他 active 回合拒绝的旧卡', async () => {
  const { options } = await closedSetup(); const response = { requestId: request.requestId, answers: { q1: ['A'] } };
  const ready = prepare(feishu, response, 'card', 'supplement'); options.canSupplement = () => false;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.claim!(() => {}), false);
  assert.equal(prepare(feishu, response, 'card', 'supplement').status, 'unavailable');
  options.canSupplement = () => true;
  const retried = prepare(feishu, response, 'card', 'supplement'); assert.equal(retried.status, 'ready');
  assert.equal(retried.claim(() => {}), true);
});

test('闭合记录十分钟到期并关闭卡片入口', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { states } = await closedSetup();
  t.mock.timers.tick(10 * 60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prepare(feishu, { requestId: request.requestId, answers: { q1: ['A'] } }, 'card', 'supplement').status, 'invalid');
  assert.equal(states.at(-1), 'expired');
});

test('三个同时到期的闭合记录全部失效，不遗漏中间项', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { gateway, fake, options } = await closedSetup();
  for (const id of ['expiry-middle', 'expiry-last']) {
    gateway.waitFor(id);
    await forwardUserInputRequest(fake, feishu, { ...request, requestId: id }, 'session', undefined, options);
    gateway.resolvePendingPermission(id, { behavior: 'deny', reason: 'request_closed' });
  }
  t.mock.timers.tick(10 * 60_000);
  for (const id of [request.requestId, 'expiry-middle', 'expiry-last']) {
    assert.equal(prepare(feishu, { requestId: id, answers: { q1: ['A'] } }, 'card', 'supplement').status, 'invalid');
  }
});

test('原发送者缺失时不提供补充，非飞书旧问答保留正常回答语义', async () => {
  const { gateway, fake, options } = await closedSetup(); clearUserInputRequests('session');
  gateway.waitFor('no-owner');
  await forwardUserInputRequest(fake, { ...feishu, userId: undefined }, { ...request, requestId: 'no-owner' }, 'session', undefined, options);
  gateway.resolvePendingPermission('no-owner', { behavior: 'deny', reason: 'request_closed' });
  assert.equal(prepare(feishu, { requestId: 'no-owner', answers: { q1: ['A'] } }, 'card', 'supplement').status, 'invalid');
});

test('清理按原聊天且涵盖闲置 closed 卡，不误伤同 session 其他聊天', async () => {
  await closedSetup();
  broker.invalidateUserInputRequests({ ...feishu, chatId: 'other' });
  const response = { requestId: request.requestId, answers: { q1: ['A'] } };
  assert.equal(prepare(feishu, response, 'card', 'supplement').status, 'ready');
  broker.invalidateUserInputRequests(feishu);
  assert.equal(prepare(feishu, response, 'card', 'supplement').status, 'invalid');
});

test('闭合数量最多100，淘汰最早项且已回答不能被闭合通知复活', async () => {
  const { gateway, fake, options } = await closedSetup();
  for (let i = 0; i < 100; i++) {
    const next = { ...request, requestId: `bounded-${i}` };
    gateway.waitFor(next.requestId);
    await forwardUserInputRequest(fake, feishu, next, 'session', undefined, options);
    gateway.resolvePendingPermission(next.requestId, { behavior: 'deny', reason: 'request_closed' });
  }
  assert.equal(prepare(feishu, { requestId: request.requestId, answers: { q1: ['A'] } }, 'card', 'supplement').status, 'invalid');
  assert.equal(prepare(feishu, { requestId: 'bounded-99', answers: { q1: ['A'] } }, 'card', 'supplement').status, 'ready');
  const answered = { ...request, requestId: 'answered' };
  gateway.waitFor(answered.requestId);
  await forwardUserInputRequest(fake, feishu, answered, 'session', undefined, options);
  assert.equal(handleUserInputResponse(feishu, { requestId: 'answered', answers: { q1: ['B'] } }, 'card'), true);
  assert.equal(gateway.resolvePendingPermission('answered', { behavior: 'deny', reason: 'request_closed' }), false);
  assert.equal(prepare(feishu, { requestId: 'answered', answers: { q1: ['B'] } }, 'card', 'supplement').status, 'invalid');
});

test('发送超时后迟到成功只显示失败，不重建 closed 资格', async () => {
  let finish!: (value: { ok: boolean; messageId: string }) => void;
  const sending = new Promise<{ ok: boolean; messageId: string }>(resolve => { finish = resolve; });
  const { states } = await closedSetup('request_closed', () => sending);
  finish({ ok: true, messageId: 'card' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(states, ['failed']);
  assert.equal(prepare(feishu, { requestId: request.requestId, answers: { q1: ['A'] } }, 'card', 'supplement').status, 'invalid');
});

test('在途 closed patch 结束后回写补充终态，不能乱序覆盖', async () => {
  const { gateway, fake, options } = await closedSetup(); clearUserInputRequests('session');
  await new Promise(resolve => setImmediate(resolve));
  const next = { ...request, requestId: 'slow-patch' }; const states: string[] = [];
  let release!: () => void;
  fake.updateUserInputRequest = async (_a, _id, _request, phase) => {
    if (phase === 'closed') await new Promise<void>(resolve => { release = resolve; });
    states.push(phase);
  };
  gateway.waitFor(next.requestId);
  await forwardUserInputRequest(fake, feishu, next, 'session', undefined, options);
  gateway.resolvePendingPermission(next.requestId, { behavior: 'deny', reason: 'request_closed' });
  await new Promise(resolve => setImmediate(resolve));
  const ready = prepare(feishu, { requestId: next.requestId, answers: { q1: ['A'] } }, 'card', 'supplement');
  assert.equal(ready.status, 'ready'); assert.equal(ready.claim(() => {}), true);
  assert.deepEqual(states, []);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(states, ['closed', 'supplemented']);
});

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
