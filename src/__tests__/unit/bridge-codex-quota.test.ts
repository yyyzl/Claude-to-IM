import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { parseCodexAccountQuota } from '../../../scripts/claude-to-im-bridge/codex-quota.ts';
import { setup, read } from './codex-test-transport.js';

// 固定 Codex 0.160.0 GetAccountRateLimitsResponse schema 的合成数据。
const window = (usedPercent = 25, windowDurationMins: number | null = 300, resetsAt: number | null = 1791900000) => ({ usedPercent, windowDurationMins, resetsAt });
const bucket = (overrides: Record<string, unknown> = {}) => ({ limitId: 'codex', limitName: null, primary: window(), secondary: window(60, 10080), ...overrides });
const response = (overrides: Record<string, unknown> = {}) => ({ rateLimits: bucket(), rateLimitsByLimitId: null, ...overrides });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('单桶只投影额度白名单，不保留账号、积分和重置券', () => {
  const parsed = parseCodexAccountQuota(response({
    account: { email: 'private@example.test', id: 'private-account' },
    rateLimits: bucket({ credits: { balance: 'private-balance' }, resetCreditDetails: { token: 'private-token' } }),
  }), 1791868800000);
  assert.deepEqual(parsed, { queriedAt: 1791868800000, buckets: [bucket()] });
  assert.doesNotMatch(JSON.stringify(parsed), /private|credits|account|token/);
});

test('多桶为准，不重复单桶镜像，并保留未知周期与空窗口', () => {
  const parsed = parseCodexAccountQuota(response({ rateLimitsByLimitId: {
    codex: bucket(),
    extra: bucket({ limitId: null, limitName: '额外额度', primary: window(110, 60, null), secondary: null }),
    unknown: bucket({ limitId: 'unknown', primary: window(0, null, null), secondary: null }),
  } }), 1);
  assert.equal(parsed.buckets.length, 3);
  assert.equal(parsed.buckets[1].limitId, 'extra');
  assert.equal(parsed.buckets[1].primary?.usedPercent, 110);
  assert.equal(parsed.buckets[2].primary?.windowDurationMins, null);
  assert.equal(parseCodexAccountQuota(response({ rateLimits: bucket({ primary: null, secondary: null }) })).buckets[0].primary, null);
  assert.equal(parseCodexAccountQuota(response({ rateLimitsByLimitId: {} })).buckets.length, 1);
});

for (const [name, raw] of [
  ['空响应', null], ['缺失桶', {}], ['错误多桶', response({ rateLimitsByLimitId: [] })],
  ['错误名称', response({ rateLimits: bucket({ limitName: 3 }) })],
  ['错误窗口', response({ rateLimits: bucket({ primary: 'bad' }) })],
  ...[-1, NaN, Infinity, '25', null, 1.5].map(value => [`错误比例 ${String(value)}`, response({ rateLimits: bucket({ primary: { ...window(), usedPercent: value } }) })]),
  ...[-1, 0, '300', 1.5].map(value => [`错误周期 ${String(value)}`, response({ rateLimits: bucket({ primary: { ...window(), windowDurationMins: value } }) })]),
  ...[-1, '1791900000', 1.5, 9e15].map(value => [`错误时间 ${String(value)}`, response({ rateLimits: bucket({ primary: { ...window(), resetsAt: value } }) })]),
] as Array<[string, unknown]>) {
  test(`损坏额度明确拒绝：${name}`, () => assert.throws(() => parseCodexAccountQuota(raw), /额度.*格式/));
}

function setupQuota() {
  const f = setup();
  const source = { read: async (): Promise<unknown> => response() };
  const timeouts: number[] = [];
  const original = f.client.request.bind(f.client);
  mock.method(f.client, 'request', async (method: string, params: Record<string, unknown> = {}, timeoutMs?: number) => {
    if (method !== 'account/rateLimits/read') return original(method, params);
    f.client.calls.push({ method, params });
    timeouts.push(timeoutMs ?? 0);
    return source.read();
  });
  return { ...f, source, timeouts };
}

test('读取复用握手，按固定协议设置参数及超时，每次主动读取且不启动模型', async () => {
  const { client, provider, timeouts } = setupQuota();
  const [first, second] = await Promise.all([provider.getAccountQuota(), provider.getAccountQuota()]);
  assert.deepEqual(first.buckets, second.buckets);
  assert.deepEqual(client.calls.map(call => call.method), ['initialize', 'initialized', 'account/rateLimits/read', 'account/rateLimits/read']);
  assert.deepEqual(client.calls.at(-1)?.params, { excludeResetCreditDetails: true });
  assert.deepEqual(timeouts, [15000, 15000]);
  assert.ok(first.queriedAt <= Date.now());
});

test('额度超时、未登录或格式失败不重置连接、不打断运行中的回合，并可重试', async () => {
  const { client, provider, source } = setupQuota();
  const entered = deferred<void>();
  client.onTurn = () => entered.resolve();
  const events = read(provider.streamChat({ prompt: 'synthetic', sessionId: 's' }));
  await entered.promise;
  for (const error of [new Error('请求超时: account/rateLimits/read'), new Error('not logged in: private@example.test token-secret')]) {
    source.read = async () => { throw error; };
    await assert.rejects(provider.getAccountQuota());
    assert.equal(client.isRunning(), true);
    assert.equal(client.calls.some(call => call.method === 'turn/interrupt'), false);
  }
  source.read = async () => null;
  await assert.rejects(provider.getAccountQuota(), /额度.*格式/);
  source.read = async () => response();
  assert.equal((await provider.getAccountQuota()).buckets[0].primary?.usedPercent, 25);
  assert.equal(client.calls.filter(call => call.method === 'initialize').length, 1);
  client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  assert.equal((await events).some(event => event.type === 'error'), false);
});

test('断开重连后迟到额度被拒绝，不影响新连接', async () => {
  const { client, provider, source } = setupQuota();
  await provider.getAccountQuota();
  const old = deferred<unknown>();
  const entered = deferred<void>();
  source.read = async () => { entered.resolve(); return old.promise; };
  const stale = assert.rejects(provider.getAccountQuota(), /连接已结束/);
  await entered.promise;
  client.running = false;
  client.emitter.emit('disconnect', new Error('synthetic disconnect'));
  source.read = async () => response({ rateLimits: bucket({ primary: window(80) }) });
  assert.equal((await provider.getAccountQuota()).buckets[0].primary?.usedPercent, 80);
  old.resolve(response());
  await stale;
  assert.equal(client.isRunning(), true);
});
