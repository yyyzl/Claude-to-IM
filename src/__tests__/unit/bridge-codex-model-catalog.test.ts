import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServerLLMProvider } from '../../../scripts/claude-to-im-bridge/codex-llm.ts';
import type { CodexAppServerLLMProviderOptions } from '../../../scripts/claude-to-im-bridge/codex-llm.ts';
import { parseCodexModelPage } from '../../../scripts/claude-to-im-bridge/codex-utils.ts';
import { InMemoryPermissionGateway } from '../../../scripts/claude-to-im-bridge/permissions.ts';
import type { CodexModelPreferences } from '../../lib/bridge/types.js';
import { FakeClient, read } from './codex-test-transport.js';

function model(id = 'catalog-a', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, model: `runtime-${id}`, displayName: `Model ${id}`, isDefault: true, hidden: false,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '高' }, { reasoningEffort: 'low', description: '低' }],
    serviceTiers: [{ id: 'fast', name: 'Fast', description: '更快' }], defaultServiceTier: null,
    inputModalities: ['text', 'image'], ...overrides,
  };
}

function page(...models: Record<string, unknown>[]): Record<string, unknown> { return { data: models, nextCursor: null }; }

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setupCatalog(options: Partial<CodexAppServerLLMProviderOptions> = {}) {
  const client = new FakeClient();
  const permissions = new InMemoryPermissionGateway();
  const provider = new CodexAppServerLLMProvider({ projectRoot: process.cwd(), permissions, keepAliveMs: 0, turnTimeoutMs: 2_000, ...options, client });
  assert.equal((provider as unknown as { client: unknown }).client, client, '测试必须使用 fake transport');
  const source = { read: async (_params: Record<string, unknown>): Promise<Record<string, unknown>> => page(model()) };
  const request = client.request.bind(client);
  client.request = async (method, params = {}) => {
    if (method !== 'model/list') return request(method, params);
    client.calls.push({ method, params });
    return source.read(params);
  };
  return { client, provider, source, permissions };
}

const preferences = (overrides: Partial<CodexModelPreferences> = {}): CodexModelPreferences => ({ model: 'default', reasoningEffort: null, speed: 'normal', ...overrides });

test('目录归一化保留真实强度、速度和默认值，不采用废弃速度字段', () => {
  const parsed = parseCodexModelPage(page(model('one', { displayName: undefined, serviceTiers: undefined, additionalSpeedTiers: ['fast'], defaultServiceTier: 'default', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] })));
  assert.equal(parsed.models[0].displayName, 'runtime-one');
  assert.deepEqual(parsed.models[0].serviceTiers, []);
  assert.equal(parsed.models[0].defaultServiceTier, 'default');
  assert.deepEqual(parsed.models[0].supportedReasoningEfforts, [{ reasoningEffort: 'high', description: '' }]);
});

for (const [name, response] of [
  ['非对象响应', null],
  ['非数组data', { data: {} }],
  ['错误id', page(model('one', { id: 3 }))],
  ['空id', page(model('one', { id: ' ' }))],
  ['错误model', page(model('one', { model: null }))],
  ['错误displayName', page(model('one', { displayName: 7 }))],
  ['错误默认标记', page(model('one', { isDefault: 'true' }))],
  ['错误hidden', page(model('one', { hidden: 'false' }))],
  ['错误强度列表', page(model('one', { supportedReasoningEfforts: {} }))],
  ['重复强度', page(model('one', { supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'high' }] }))],
  ['无效默认强度', page(model('one', { defaultReasoningEffort: 'missing' }))],
  ['非数组速度', page(model('one', { serviceTiers: 'fast' }))],
  ['非对象速度', page(model('one', { serviceTiers: ['fast'] }))],
  ['错误速度名', page(model('one', { serviceTiers: [{ id: 'fast', name: 2 }] }))],
  ['错误速度说明', page(model('one', { serviceTiers: [{ id: 'fast', name: 'Fast', description: false }] }))],
  ['重复速度', page(model('one', { serviceTiers: [{ id: 'fast', name: 'Fast' }, { id: 'fast', name: 'Fast' }] }))],
  ['错误默认速度', page(model('one', { defaultServiceTier: true }))],
  ['无效默认速度', page(model('one', { defaultServiceTier: 'unknown' }))],
  ['错误输入能力', page(model('one', { inputModalities: ['text', false] }))],
  ['错误游标', { data: [model()], nextCursor: 3 }],
] as const) {
  test(`损坏目录明确拒绝：${name}`, () => assert.throws(() => parseCodexModelPage(response), /Codex 模型目录/));
}

test('完整读取分页、过滤隐藏项，返回目录不能反向修改内部缓存', async () => {
  const { client, provider, source } = setupCatalog();
  source.read = async params => params.cursor
    ? page(model('two', { isDefault: false }), model('hidden', { isDefault: false, hidden: true }))
    : { data: [model('one')], nextCursor: 'cursor-2' };
  const catalog = await provider.getModelCatalog();
  assert.deepEqual(catalog.models.map(item => item.id), ['one', 'two']);
  assert.equal(client.calls.filter(call => call.method === 'model/list')[1].params.cursor, 'cursor-2');
  catalog.models[0].serviceTiers.length = 0;
  catalog.models[0].supportedReasoningEfforts[0].reasoningEffort = 'bad';
  const unchanged = await provider.getModelCatalog();
  assert.equal(unchanged.models[0].serviceTiers[0].id, 'fast');
  assert.equal(unchanged.models[0].supportedReasoningEfforts[0].reasoningEffort, 'high');
});

test('初始化、强制刷新与普通目录请求合并，刷新绕过短缓存', async () => {
  const { client, provider, source } = setupCatalog();
  const gate = deferred<Record<string, unknown>>();
  source.read = async () => gate.promise;
  const first = provider.getModelCatalog();
  const second = provider.getModelCatalog({ refresh: true });
  gate.resolve(page(model()));
  assert.deepEqual(await first, await second);
  assert.equal(client.calls.filter(call => call.method === 'initialize').length, 1);
  assert.equal(client.calls.filter(call => call.method === 'model/list').length, 1);
  await provider.getModelCatalog();
  assert.equal(client.calls.filter(call => call.method === 'model/list').length, 1);
  source.read = async () => page(model('new'));
  assert.equal((await provider.getModelCatalog({ refresh: true })).models[0].id, 'new');
  assert.equal(client.calls.filter(call => call.method === 'initialize').length, 1);
});

test('分页失败不发布半套目录，也不关闭正在运行的聊天', async () => {
  const { client, provider, source } = setupCatalog();
  const started = deferred<void>();
  client.onTurn = () => started.resolve();
  const events = read(provider.streamChat({ prompt: 'hello', sessionId: 's' }));
  await started.promise;
  source.read = async params => {
    if (params.cursor) throw new Error('page 2 unavailable');
    return { data: [model('uncommitted')], nextCursor: 'next' };
  };
  await assert.rejects(provider.getModelCatalog({ refresh: true }), /page 2 unavailable/);
  assert.equal(client.isRunning(), true);
  assert.equal((await provider.getModelCatalog()).models[0].id, 'catalog-a');
  assert.equal(client.calls.some(call => call.method === 'turn/interrupt'), false);
  client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  assert.equal((await events).some(event => event.type === 'error'), false);
  source.read = async () => page(model('recovered'));
  assert.equal((await provider.getModelCatalog({ refresh: true })).models[0].id, 'recovered');
});

test('空目录、隐藏目录、重复ID和重复默认模型不替换有效缓存', async () => {
  const { provider, source } = setupCatalog();
  await provider.getModelCatalog();
  for (const response of [page(), page(model('hidden', { hidden: true })), page(model(), model()), page(model('a'), model('b'))]) {
    source.read = async () => response;
    await assert.rejects(provider.getModelCatalog({ refresh: true }), /空目录|重复 ID|多个默认模型/);
    assert.equal((await provider.getModelCatalog()).models[0].id, 'catalog-a');
  }
});

test('跨页重复ID及重复分页游标均拒绝', async () => {
  const { provider, source } = setupCatalog();
  source.read = async params => params.cursor ? page(model()) : { data: [model()], nextCursor: 'next' };
  await assert.rejects(provider.getModelCatalog(), /重复 ID/);
  let index = 0;
  source.read = async () => ({ data: [model(String(index++), { isDefault: false })], nextCursor: 'same' });
  await assert.rejects(provider.getModelCatalog(), /重复分页游标/);
});

test('断开重连期间旧刷新结果不能覆盖新连接目录', async () => {
  const { client, provider, source } = setupCatalog();
  await provider.getModelCatalog();
  const oldPage = deferred<Record<string, unknown>>();
  const entered = deferred<void>();
  source.read = async () => { entered.resolve(); return oldPage.promise; };
  const stale = provider.getModelCatalog({ refresh: true });
  const rejected = assert.rejects(stale, /连接已结束/);
  await entered.promise;
  client.running = false;
  client.emitter.emit('disconnect', new Error('disconnected'));
  source.read = async () => page(model('new-connection'));
  assert.equal((await provider.getModelCatalog()).models[0].id, 'new-connection');
  oldPage.resolve(page(model('old-connection')));
  await rejected;
  assert.equal((await provider.getModelCatalog()).models[0].id, 'new-connection');
  assert.equal(client.calls.filter(call => call.method === 'initialize').length, 2);
});

test('握手失败后重建连接，不留下失败的共享初始化promise', async () => {
  const { client, provider } = setupCatalog();
  const request = client.request.bind(client);
  let first = true;
  client.request = async (method, params) => {
    const response = await request(method, params);
    if (method === 'initialize' && first) { first = false; throw new Error('initialize failed'); }
    return response;
  };
  await assert.rejects(provider.getModelCatalog(), /initialize failed/);
  assert.equal(client.isRunning(), false);
  assert.equal((await provider.getModelCatalog()).models[0].id, 'catalog-a');
  assert.equal(client.calls.filter(call => call.method === 'initialize').length, 2);
});

test('stop期间迟到的握手失败不能关闭新连接或清空新目录', async () => {
  const { client, provider } = setupCatalog();
  const request = client.request.bind(client);
  const oldInit = deferred<Record<string, unknown>>();
  const entered = deferred<void>();
  let first = true;
  client.request = async (method, params) => {
    if (method === 'initialize' && first) { first = false; entered.resolve(); return oldInit.promise; }
    return request(method, params);
  };
  const stale = provider.getModelCatalog();
  const rejected = assert.rejects(stale, /old initialization failed/);
  await entered.promise;
  provider.stop();
  await provider.getModelCatalog();
  oldInit.reject(new Error('old initialization failed'));
  await rejected;
  assert.equal(client.isRunning(), true);
  assert.equal((await provider.getModelCatalog()).models[0].id, 'catalog-a');
});

test('stop之后迟到目录不启动线程或覆盖重启后的目录', async () => {
  const { client, provider, source } = setupCatalog();
  const gate = deferred<Record<string, unknown>>();
  const entered = deferred<void>();
  source.read = async () => { entered.resolve(); return gate.promise; };
  const pendingTurn = read(provider.streamChat({ prompt: 'old', sessionId: 's' }));
  await entered.promise;
  provider.stop();
  source.read = async () => page(model('after-stop'));
  await provider.getModelCatalog();
  gate.resolve(page(model('stale')));
  assert.match((await pendingTurn).find(event => event.type === 'error')?.data ?? '', /连接已结束/);
  assert.equal(client.calls.some(call => call.method === 'thread/start'), false);
  assert.equal((await provider.getModelCatalog()).models[0].id, 'after-stop');
});

test('旧线程恢复结束后的清理不移除新连接的活跃请求', async () => {
  const { client, provider, permissions } = setupCatalog();
  const request = client.request.bind(client);
  const oldResume = deferred<Record<string, unknown>>();
  const entered = deferred<void>();
  const newTurn = deferred<void>();
  client.request = async (method, params) => {
    if (method === 'thread/resume') { entered.resolve(); return oldResume.promise; }
    return request(method, params);
  };
  const oldEvents = read(provider.streamChat({ prompt: 'old', sessionId: 's', sdkSessionId: 'thread' }));
  await entered.promise;
  provider.stop();
  client.onTurn = () => newTurn.resolve();
  const newEvents = read(provider.streamChat({ prompt: 'new', sessionId: 's' }), event => {
    if (event.type === 'permission_request') permissions.resolvePendingPermission(JSON.parse(event.data).permissionRequestId, { behavior: 'allow' });
  });
  await newTurn.promise;
  oldResume.resolve({ thread: { id: 'thread' } });
  assert.match((await oldEvents).find(event => event.type === 'error')?.data ?? '', /连接已结束/);
  client.emitter.emit('request', { id: 'current-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', command: 'test' } });
  await new Promise(resolve => setImmediate(resolve));
  client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  assert.ok((await newEvents).some(event => event.type === 'permission_request'));
  assert.ok(client.replies.some(reply => JSON.stringify(reply) === JSON.stringify({ id: 'current-approval', result: { decision: 'accept' } })));
});

test('显式跟随默认跨两轮读取真实默认，忽略旧型号和宿主强度hint', async () => {
  const { client, provider, source } = setupCatalog({ modelHint: 'missing-model', cliConfig: 'model_reasoning_effort="low"' });
  const choice = preferences();
  const first = await read(provider.streamChat({ prompt: '1', sessionId: 's', model: 'old-model', reasoningEffort: 'low', codexModelPreferences: choice }));
  assert.equal(first.some(event => event.type === 'error'), false);
  source.read = async () => page(model('catalog-b', { defaultReasoningEffort: 'low' }));
  await read(provider.streamChat({ prompt: '2', sessionId: 's', sdkSessionId: 'thread', codexModelPreferences: choice }));
  const turns = client.calls.filter(call => call.method === 'turn/start');
  assert.deepEqual(turns.map(call => [call.params.model, call.params.effort]), [['runtime-catalog-a', 'high'], ['runtime-catalog-b', 'low']]);
  assert.equal(choice.model, 'default');
});

test('恢复线程后的Fast切回正常必须每轮显式覆盖', async () => {
  const { client, provider } = setupCatalog();
  const fastEvents = await read(provider.streamChat({ prompt: 'fast', sessionId: 's', codexModelPreferences: preferences({ speed: 'fast' }) }));
  await read(provider.streamChat({ prompt: 'normal', sessionId: 's', sdkSessionId: 'thread', codexModelPreferences: preferences() }));
  const turns = client.calls.filter(call => call.method === 'turn/start');
  assert.deepEqual(turns.map(call => call.params.serviceTierForTurn), ['fast', 'default']);
  assert.equal(client.calls.filter(call => call.method === 'thread/resume').length, 1);
  assert.equal(JSON.parse(fastEvents.find(event => event.type === 'status' && JSON.parse(event.data).model)!.data).service_tier, 'fast');
  assert.equal(turns.some(call => 'serviceTier' in call.params), false);
});

test('旧路径未配置速度时不伪造正常，显式default也不再回退宿主型号', async () => {
  const { client, provider } = setupCatalog({ modelHint: 'unavailable' });
  const events = await read(provider.streamChat({ prompt: 'legacy', sessionId: 's', model: 'default' }));
  assert.equal(events.some(event => event.type === 'error'), false);
  const turn = client.calls.find(call => call.method === 'turn/start')!;
  assert.equal(turn.params.model, 'runtime-catalog-a');
  assert.equal('serviceTierForTurn' in turn.params, false);
});

test('请求开始时固定偏好快照，目录await期间外部修改不影响本轮', async () => {
  const { client, provider, source } = setupCatalog();
  const gate = deferred<Record<string, unknown>>();
  source.read = async () => gate.promise;
  const choice = preferences({ reasoningEffort: 'high', speed: 'fast' });
  const events = read(provider.streamChat({ prompt: 'snapshot', sessionId: 's', codexModelPreferences: choice }));
  choice.model = 'missing'; choice.reasoningEffort = 'low'; choice.speed = 'normal';
  gate.resolve(page(model()));
  assert.equal((await events).some(event => event.type === 'error'), false);
  const turn = client.calls.find(call => call.method === 'turn/start')!.params;
  assert.equal(turn.model, 'runtime-catalog-a');
  assert.equal(turn.effort, 'high');
  assert.equal(turn.serviceTierForTurn, 'fast');
});

test('保存后目录变化造成型号、强度或Fast失效时不启动新回合', async () => {
  const { client, provider, source } = setupCatalog();
  await provider.getModelCatalog();
  source.read = async () => page(model('catalog-b', { serviceTiers: [], supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }));
  for (const choice of [preferences({ model: 'catalog-a' }), preferences({ reasoningEffort: 'low' }), preferences({ speed: 'fast' })]) {
    const events = await read(provider.streamChat({ prompt: 'invalid', sessionId: 's', sdkSessionId: 'thread', codexModelPreferences: choice }));
    assert.ok(events.some(event => event.type === 'error'));
  }
  assert.equal(client.calls.some(call => call.method === 'turn/start' || call.method === 'thread/resume'), false);
});

test('无目录默认项时显式default失败，仍能明确选择型号', async () => {
  const { client, provider, source } = setupCatalog();
  source.read = async () => page(model('catalog-a', { isDefault: false }));
  assert.equal((await provider.getModelCatalog()).models.length, 1);
  const invalid = await read(provider.streamChat({ prompt: 'default', sessionId: 's', codexModelPreferences: preferences() }));
  assert.match(invalid.find(event => event.type === 'error')?.data ?? '', /未指定默认模型/);
  const valid = await read(provider.streamChat({ prompt: 'exact', sessionId: 's', codexModelPreferences: preferences({ model: 'catalog-a' }) }));
  assert.equal(valid.some(event => event.type === 'error'), false);
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('服务端拒绝Fast后报告真实错误，不自动重试正常速度', async () => {
  const { client, provider } = setupCatalog();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'turn/start') throw new Error('Fast is unavailable for this account');
    return result;
  };
  const events = await read(provider.streamChat({ prompt: 'fast', sessionId: 's', codexModelPreferences: preferences({ speed: 'fast' }) }));
  assert.match(events.find(event => event.type === 'error')?.data ?? '', /Fast is unavailable for this account/);
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.deepEqual(events.filter(event => event.type === 'status').map(event => JSON.parse(event.data)), [{ session_id: 'thread' }]);
});

test('等待turn/start时取消仍中断已接受回合，不发布配置为实际使用', async () => {
  const { client, provider } = setupCatalog();
  const abortController = new AbortController();
  client.onTurn = () => abortController.abort();
  const events = await read(provider.streamChat({ prompt: 'cancel', sessionId: 's', abortController, codexModelPreferences: preferences({ speed: 'fast' }) }));
  assert.ok(client.calls.some(call => call.method === 'turn/interrupt'));
  assert.deepEqual(events.filter(event => event.type === 'status').map(event => JSON.parse(event.data)), [{ session_id: 'thread' }]);
});
