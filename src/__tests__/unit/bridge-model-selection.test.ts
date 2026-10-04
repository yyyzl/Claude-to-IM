import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { JsonFileBridgeStore } from '../../../scripts/claude-to-im-bridge/store.ts';
import { initBridgeContext } from '../../lib/bridge/context.js';
import { BaseChannelAdapter } from '../../lib/bridge/channel-adapter.js';
import { ChatAdmissionGate, ModelSelectionCoordinator } from '../../lib/bridge/internal/model-selection.js';
import type { LLMProvider, StreamChatParams } from '../../lib/bridge/host.js';
import type { ChannelAddress, InboundMessage, ModelCatalog, ModelSelectionResponse, ModelSelectionView, OutboundMessage, SendResult } from '../../lib/bridge/types.js';
import * as router from '../../lib/bridge/channel-router.js';
import { processMessage } from '../../lib/bridge/conversation-engine.js';

const address: ChannelAddress = { channelType: 'feishu', chatId: 'chat', userId: 'user' };
const catalog: ModelCatalog = { models: [
  { id: 'next', model: 'next-protocol', displayName: 'Next', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'high', description: '' }], serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }], defaultServiceTier: null },
  { id: 'small', model: 'small', displayName: 'Small', isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }], serviceTiers: [], defaultServiceTier: null },
] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function message(text = '/model'): InboundMessage { return { messageId: 'in', address, text, timestamp: Date.now() }; }
class ModelAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu';
  cards: ModelSelectionView[] = [];
  messages: OutboundMessage[] = [];
  failPatch = false;
  failSend = false;
  delaySend?: Promise<void>;
  delayPatch?: Promise<void>;
  async start() {} async stop() {} isRunning() { return true; }
  async consumeOne() { return null; } validateConfig() { return null; } isAuthorized() { return true; }
  async send(msg: OutboundMessage): Promise<SendResult> { this.messages.push(msg); return { ok: true, messageId: 'text' }; }
  async sendModelSelection(_address: ChannelAddress, view: ModelSelectionView): Promise<SendResult> {
    this.cards.push(structuredClone(view)); await this.delaySend;
    return this.failSend ? { ok: false, error: 'send failed' } : { ok: true, messageId: 'card' };
  }
  async updateModelSelection(_address: ChannelAddress, _id: string, view: ModelSelectionView): Promise<SendResult> {
    this.cards.push(structuredClone(view)); await this.delayPatch;
    return { ok: !this.failPatch, error: this.failPatch ? 'patch failed' : undefined };
  }
}

function setup(t: TestContext, provider?: LLMProvider) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-picker-'));
  const dataPath = path.join(directory, 'state.json');
  const store = new JsonFileBridgeStore({ projectRoot: directory, dataPath });
  store.getSetting = key => key === 'bridge_llm_backend' ? 'codex' : key === 'bridge_codex_model_hint' ? 'legacy' : null;
  const llm: LLMProvider = provider ?? { getModelCatalog: async () => structuredClone(catalog), streamChat: () => { throw new Error('选择模型不得请求模型'); } };
  initBridgeContext({ store, llm, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const binding = router.resolve(address);
  let generation = 0;
  let epoch = 0;
  let busy = false;
  let now = 0;
  const gate = new ChatAdmissionGate();
  const selection = new ModelSelectionCoordinator({ store, llm, gate,
    capture: addr => { const current = router.resolve(addr); return { bindingId: current.id, sessionId: current.codepilotSessionId, generation, epoch }; },
    isCurrent: (addr, owner) => { const current = store.getChannelBinding(addr.channelType, addr.chatId); return current?.id === owner.bindingId && current.codepilotSessionId === owner.sessionId && generation === owner.generation && epoch === owner.epoch; },
    isBusy: () => busy, now: () => now, ttlMs: 100,
  });
  const adapter = new ModelAdapter();
  const respond = (action: ModelSelectionResponse['action'], fields: Partial<ModelSelectionResponse> = {}, source: Partial<InboundMessage> = {}) => {
    const card = adapter.cards.at(-1)!;
    return selection.respond(adapter, { ...message(''), callbackMessageId: 'card', modelSelectionResponse: { requestId: card.requestId, revision: card.revision, action, ...fields }, ...source });
  };
  return { store, llm, binding, gate, selection, adapter, respond, dataPath, directory,
    expire: () => { now = 101; }, busy: () => { busy = true; }, switchGeneration: () => { generation++; }, restart: () => { epoch++; } };
}

describe('Codex 模型选择协调与持久偏好', () => {
  beforeEach(() => { delete (globalThis as Record<string, unknown>).__bridge_context__; delete (globalThis as Record<string, unknown>).__bridge_manager__; });

  it('两步草稿不写入，应用完整偏好，new/bind/restart继承且聊天隔离', async t => {
    const h = setup(t);
    await h.selection.open(h.adapter, message(), h.binding);
    await h.respond('next', { model: 'next' });
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences, undefined);
    await h.respond('apply', { reasoningEffort: 'high', speed: 'fast' });
    const expected = { model: 'next', reasoningEffort: 'high', speed: 'fast' };
    assert.deepEqual(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences, expected);
    assert.equal(h.adapter.cards.at(-1)?.step, 'applied');
    const next = router.startNewSession(address);
    assert.equal(next.sdkSessionId, ''); assert.deepEqual(next.codexModelPreferences, expected);
    assert.deepEqual(router.bindToSession(address, h.binding.codepilotSessionId)?.codexModelPreferences, expected);
    assert.equal(router.resolve({ ...address, chatId: 'other' }).codexModelPreferences, undefined);
    await h.store.flush();
    const reopened = new JsonFileBridgeStore({ projectRoot: h.directory, dataPath: h.dataPath });
    assert.deepEqual(reopened.getChannelBinding('feishu', 'chat')?.codexModelPreferences, expected);
    await reopened.close();
    await assert.rejects(h.respond('apply'), /已处理/);
  });

  it('取消未落盘，模型切换必须重新确认受支持强度和速度', async t => {
    const h = setup(t);
    h.store.updateChannelBinding(h.binding.id, { codexModelPreferences: { model: 'next', reasoningEffort: 'high', speed: 'fast' } });
    await h.selection.open(h.adapter, message(), h.store.getChannelBinding('feishu', 'chat')!);
    await h.respond('next', { model: 'small' });
    assert.equal(h.adapter.cards.at(-1)?.reasoningEffort, 'high');
    assert.equal(h.adapter.cards.at(-1)?.speed, 'fast');
    await assert.rejects(h.respond('apply'), /不支持/);
    await h.respond('cancel');
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences?.model, 'next');
  });

  it('文字命令即时目录校验，沿用Fast不兼容时拒绝且不写入', async t => {
    const h = setup(t);
    await assert.rejects(h.selection.setText(address, 'missing'), /没有模型/);
    await assert.rejects(h.selection.setText(address, 'next', 'low'), /不支持/);
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences, undefined);
    await h.selection.setText(address, 'default');
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences?.speed, 'normal');
    h.store.updateChannelBinding(h.binding.id, { codexModelPreferences: { model: 'next', reasoningEffort: null, speed: 'fast' } });
    await assert.rejects(h.selection.setText(address, 'small'), /未提供 Fast/);
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences?.model, 'next');
  });

  it('同型号目录移除原强度和Fast时保留失效草稿，缺值apply不能自动降档', async t => {
    const h = setup(t);
    h.store.updateChannelBinding(h.binding.id, { codexModelPreferences: { model: 'next', reasoningEffort: 'high', speed: 'fast' } });
    await h.selection.open(h.adapter, message(), h.store.getChannelBinding('feishu', 'chat')!);
    h.llm.getModelCatalog = async () => ({ models: [{ ...catalog.models[0], supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }], serviceTiers: [] }] });
    await h.respond('refresh'); await h.respond('next', { model: 'next' });
    assert.equal(h.adapter.cards.at(-1)?.reasoningEffort, 'high'); assert.equal(h.adapter.cards.at(-1)?.speed, 'fast');
    await assert.rejects(h.respond('apply'), /不支持思考强度/);
    await assert.rejects(h.respond('apply', { reasoningEffort: '' }), /未提供 Fast/);
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences?.speed, 'fast');
    await h.respond('apply', { reasoningEffort: '', speed: 'normal' });
    assert.deepEqual(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences, { model: 'next', reasoningEffort: null, speed: 'normal' });
  });

  for (const invalid of ['user', 'chat', 'message', 'revision', 'generation', 'epoch', 'expiry'] as const) {
    it(`拒绝 ${invalid} 归属不符且不修改配置`, async t => {
      const h = setup(t); await h.selection.open(h.adapter, message(), h.binding);
      await h.respond('next', { model: 'next' });
      if (invalid === 'generation') h.switchGeneration();
      if (invalid === 'epoch') h.restart();
      if (invalid === 'expiry') h.expire();
      const source = invalid === 'user' ? { address: { ...address, userId: 'other' } }
        : invalid === 'chat' ? { address: { ...address, chatId: 'other' } }
          : invalid === 'message' ? { callbackMessageId: 'wrong' } : {};
      await assert.rejects(h.respond('apply', invalid === 'revision' ? { revision: 0 } : {}, source), /过期|无效/);
      assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences, undefined);
    });
  }

  it('目录加载晚到及卡片发送晚到均不会登记到新会话', async t => {
    const delayed = deferred<ModelCatalog>();
    const h = setup(t, { getModelCatalog: () => delayed.promise, streamChat: () => { throw new Error('unexpected'); } });
    const opening = h.selection.open(h.adapter, message(), h.binding); h.switchGeneration();
    delayed.resolve(catalog); await assert.rejects(opening, /过期/); assert.equal(h.adapter.cards.length, 0);
    const sent = deferred<void>(); h.adapter.delaySend = sent.promise;
    const sending = h.selection.open(h.adapter, message(), h.binding);
    await new Promise(r => setTimeout(r, 0)); h.restart(); sent.resolve();
    await assert.rejects(sending, /过期|失效/); assert.equal(h.adapter.cards.at(-1)?.step, 'expired');
  });

  it('busy拒绝，重复apply只有一次写入', async t => {
    const h = setup(t); await h.selection.open(h.adapter, message(), h.binding); await h.respond('next', { model: 'next' });
    const applying = h.respond('apply', { speed: 'normal', reasoningEffort: '' });
    const duplicate = h.respond('apply', { speed: 'normal', reasoningEffort: '' });
    const result = await Promise.allSettled([applying, duplicate]);
    assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
    await h.selection.open(h.adapter, message(), h.binding); await h.respond('next', { model: 'next' }); h.busy();
    await assert.rejects(h.respond('apply'), /等待当前任务/);
  });

  it('flush失败回滚内存，下一请求不可使用失败的配置', async t => {
    const h = setup(t); await h.selection.setText(address, 'next', 'high');
    const before = h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences;
    const flush = h.store.flush.bind(h.store); h.store.flush = async () => { throw new Error('disk full'); };
    await assert.rejects(h.selection.setText(address, 'small'), /保存失败.*disk full/);
    assert.deepEqual(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences, before);
    h.store.flush = flush;
  });

  it('flush失败仍回滚偏好，同时保留并行的无关目录修改', async t => {
    const h = setup(t); await h.selection.setText(address, 'next');
    const flush = h.store.flush.bind(h.store);
    h.store.flush = async () => {
      h.store.updateChannelBinding(h.binding.id, { workingDirectory: '/new-directory', updatedAt: 'later-version' });
      throw new Error('disk error');
    };
    await assert.rejects(h.selection.setText(address, 'small'), /保存失败/);
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences?.model, 'next');
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.workingDirectory, '/new-directory');
    h.store.flush = flush;
  });

  it('保存期间新消息准入等待确认，卡片patch失败不撤销已保存配置', async t => {
    const h = setup(t); await h.selection.open(h.adapter, message(), h.binding); await h.respond('next', { model: 'next' });
    const release = deferred<void>(); const entered = deferred<void>();
    const flush = h.store.flush.bind(h.store); h.store.flush = async () => { entered.resolve(); await release.promise; await flush(); };
    h.adapter.failPatch = true;
    const applying = h.respond('apply', { speed: 'fast' }); await entered.promise;
    let admitted = false;
    const admission = h.gate.run(address, () => { admitted = true; }); await new Promise(r => setTimeout(r, 0));
    assert.equal(admitted, false); release.resolve();
    assert.match(await applying ?? '', /已持久保存[\s\S]*原卡更新失败/); await admission;
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences?.speed, 'fast');
  });

  it('目录刷新失败保留原卡可重试，分页完整且受字节预算约束', async t => {
    let fail = false;
    const many = { models: Array.from({ length: 35 }, (_, i) => ({ ...catalog.models[0], id: `model-${i}-${'x'.repeat(750)}`, isDefault: i === 0 })) };
    const h = setup(t, { getModelCatalog: async () => { if (fail) throw new Error('offline'); return many; }, streamChat: () => { throw new Error('unexpected'); } });
    await h.selection.open(h.adapter, message(), h.binding);
    assert.ok(h.adapter.cards[0].models.length < 20);
    const seen = [...h.adapter.cards[0].models]; const count = h.adapter.cards[0].pageCount;
    for (let i = 1; i < count; i++) { await h.respond('next_page'); seen.push(...h.adapter.cards.at(-1)!.models); }
    assert.equal(seen.length, 35);
    fail = true; await assert.rejects(h.respond('refresh'), /offline/);
    fail = false; await h.respond('refresh'); assert.equal(h.adapter.cards.at(-1)?.page, 0);
  });

  it('默认偏好跨两轮不被实际型号覆盖，Claude不使用Codex偏好', async t => {
    const params: StreamChatParams[] = [];
    const h = setup(t, { getModelCatalog: async () => catalog, streamChat: value => {
      params.push(value);
      return new ReadableStream({ start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'status', data: JSON.stringify({ model: 'actual-model', reasoning_effort: 'high' }) })}\n\n`);
        controller.close();
      } });
    } });
    await h.selection.setText(address, 'default');
    for (let i = 0; i < 2; i++) await processMessage(h.store.getChannelBinding('feishu', 'chat')!, 'hello');
    assert.equal(params.length, 2); assert.ok(params.every(value => value.codexModelPreferences?.model === 'default'));
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences?.model, 'default');
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.lastModelRuntime?.model, 'actual-model');
    h.store.getSetting = key => key === 'bridge_llm_backend' ? 'claude' : null;
    await processMessage(h.store.getChannelBinding('feishu', 'chat')!, 'hello');
    assert.equal(params.at(-1)?.codexModelPreferences, undefined);
  });

  it('发送失败、空目录、没有默认项均明确拒绝', async t => {
    const h = setup(t);
    h.adapter.failSend = true;
    await assert.rejects(h.selection.open(h.adapter, message(), h.binding), /发送失败/);
    h.llm.getModelCatalog = async () => ({ models: [] });
    await assert.rejects(h.selection.setText(address, 'default'), /没有可用模型/);
    h.llm.getModelCatalog = async () => ({ models: catalog.models.map(model => ({ ...model, isDefault: false })) });
    await assert.rejects(h.selection.setText(address, 'default'), /未提供默认模型/);
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences, undefined);
  });

  it('刷新或返回后的旧revision失效，切走再切回同session也失效', async t => {
    const h = setup(t); await h.selection.open(h.adapter, message(), h.binding);
    const old = h.adapter.cards[0]; await h.respond('next', { model: 'next' }); await h.respond('back');
    await assert.rejects(h.respond('next', { model: 'next', revision: old.revision }), /已更新/);
    router.startNewSession(address); h.switchGeneration(); router.bindToSession(address, h.binding.codepilotSessionId); h.switchGeneration();
    await assert.rejects(h.respond('next', { model: 'next' }), /过期/);
  });

  it('保存异步结束后归属失效会回滚，而且不覆盖同时写入的新偏好', async t => {
    const h = setup(t); await h.selection.setText(address, 'next');
    const flush = h.store.flush.bind(h.store);
    let invalidated = false;
    h.store.flush = async () => { if (!invalidated) { invalidated = true; h.restart(); } await flush(); };
    await assert.rejects(h.selection.setText(address, 'small'), /保存期间会话/);
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences?.model, 'next');
    h.store.flush = async () => {
      h.store.updateChannelBinding(h.binding.id, { codexModelPreferences: { model: 'next', reasoningEffort: 'high', speed: 'fast' } });
      throw new Error('concurrent write');
    };
    await assert.rejects(h.selection.setText(address, 'small'), /保存失败/);
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences?.speed, 'fast');
    h.store.flush = flush;
  });

  it('命令入口展示卡片、应用、status回显、new继承且旧卡不能再用', async t => {
    const h = setup(t); const { _testOnly } = await import('../../lib/bridge/bridge-manager.js');
    await _testOnly.handleMessage(h.adapter, message());
    let card = h.adapter.cards.at(-1)!;
    const action = (action: ModelSelectionResponse['action'], fields: Partial<ModelSelectionResponse> = {}) => {
      card = h.adapter.cards.at(-1)!;
      return _testOnly.handleMessage(h.adapter, { ...message(''), callbackMessageId: 'card', modelSelectionResponse: { requestId: card.requestId, revision: card.revision, action, ...fields } });
    };
    await action('next', { model: 'default' }); await action('apply', { reasoningEffort: 'high', speed: 'fast' });
    await _testOnly.handleMessage(h.adapter, message('/status'));
    assert.match(h.adapter.messages.at(-1)?.text ?? '', /跟随 Codex 默认[\s\S]*high[\s\S]*Fast/);
    await _testOnly.handleMessage(h.adapter, message('/new'));
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences?.model, 'default');
    await action('apply'); assert.match(h.adapter.messages.at(-1)?.text ?? '', /无效/);
  });

  it('运行中可以查看卡片但不能应用；请求持有完整配置快照', async t => {
    const finish = deferred<void>(); const started = deferred<void>(); let observed: StreamChatParams | undefined;
    const h = setup(t, { getModelCatalog: async () => catalog, streamChat: params => {
      observed = params; started.resolve();
      return new ReadableStream({ start: async controller => { await finish.promise; controller.close(); } });
    } });
    await h.selection.setText(address, 'next', 'high');
    const { _testOnly } = await import('../../lib/bridge/bridge-manager.js');
    const running = _testOnly.handleMessage(h.adapter, message('hello')); await started.promise;
    await _testOnly.handleMessage(h.adapter, message('/model small'));
    assert.match(h.adapter.messages.at(-1)?.text ?? '', /等待当前任务/);
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences?.model, 'next');
    await _testOnly.handleMessage(h.adapter, message('/model')); assert.equal(h.adapter.cards.at(-1)?.step, 'model');
    assert.deepEqual(observed?.codexModelPreferences, { model: 'next', reasoningEffort: 'high', speed: 'normal' });
    finish.resolve(); await running;
  });

  it('目录请求不阻塞new，迟到卡片不能绑定新会话', async t => {
    const load = deferred<ModelCatalog>();
    const h = setup(t, { getModelCatalog: () => load.promise, streamChat: () => { throw new Error('unexpected'); } });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager.js');
    const opening = _testOnly.handleMessage(h.adapter, message('/model'));
    await _testOnly.handleMessage(h.adapter, message('/new'));
    assert.notEqual(h.store.getChannelBinding('feishu', 'chat')?.codepilotSessionId, h.binding.codepilotSessionId);
    load.resolve(catalog); await opening; assert.equal(h.adapter.cards.length, 0);
    assert.ok(h.adapter.messages.some(msg => /过期|失效/.test(msg.text)));
  });

  it('原卡patch永不返回时失效立即解锁，新卡仍能完成选择', async t => {
    const h = setup(t); await h.selection.open(h.adapter, message(), h.binding);
    h.adapter.delayPatch = new Promise(() => {});
    const blocked = h.respond('next', { model: 'next' });
    await new Promise(r => setTimeout(r, 0));
    h.selection.invalidate(address); h.switchGeneration();
    await assert.rejects(blocked, /失效/);
    h.adapter.delayPatch = undefined;
    await h.selection.open(h.adapter, message(), h.binding);
    await h.respond('next', { model: 'small' }); await h.respond('apply');
    assert.equal(h.store.getChannelBinding('feishu', 'chat')?.codexModelPreferences?.model, 'small');
  });
});
