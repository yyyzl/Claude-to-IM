/** 飞书过程卡：真实事件、固定折叠组件与逐步实体预算的内存平台回归。 */
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';
import { initBridgeContext } from '../../lib/bridge/context.js';
import type { BridgeStore } from '../../lib/bridge/host.js';
import type { ToolCallInfo } from '../../lib/bridge/types.js';

const blocked = () => { throw new Error('测试禁止真实网络和子进程'); };
mock.method(net.Socket.prototype, 'connect', blocked);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const) mock.method(childProcess, name, blocked);
mock.method(globalThis, 'fetch', blocked);
syncBuiltinESMExports();
type Element = { tag: string; element_id?: string; content?: string; expanded?: boolean; elements?: Element[] };
type Card = { config: Record<string, unknown>; body: { elements: Element[] } };
type Request = { path?: Record<string, string>; data: Record<string, unknown> };
type Response = { code: number; data?: { card_id?: string; message_id?: string } };
type Call = { method: string; request: Request };
function find(elements: Element[], id: string): Element | undefined {
  for (const element of elements) {
    if (element.element_id === id) return element;
    const nested = find(element.elements ?? [], id);
    if (nested) return nested;
  }
}
const fixtures: Array<{ adapter: FeishuAdapter }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.adapter.onMessageEnd('chat'); mock.timers.reset(); });
function fixture() {
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({ store: { getSetting: (key: string) => ({ bridge_feishu_stream_card_notify_on_complete: 'false', bridge_feishu_stream_card_throttle_ms: '250' })[key] ?? null } as unknown as BridgeStore,
    llm: { streamChat: blocked }, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
  const calls: Call[] = [];
  const cards = new Map<string, Card>();
  const intermediateSizes: number[] = [];
  const partialFailure: { afterElement: string | null; code: number; throws: boolean } = { afterElement: null, code: 200860, throws: false };
  let deleteFailure = false;
  let cardCount = 0;
  const measure = (card: Card) => {
    const size = Buffer.byteLength(JSON.stringify({ type: 'card_json', data: JSON.stringify(card) }), 'utf8');
    intermediateSizes.push(size);
    assert.ok(size <= 30_000, `每一步更新后的完整实体也需满足预算，实际${size}`);
  };
  const methods = {
    create: async (request: Request): Promise<Response> => {
      calls.push({ method: 'create', request });
      const id = `card-${++cardCount}`;
      const card = JSON.parse(String(request.data.data)) as Card;
      measure(card); cards.set(id, card);
      return { code: 0, data: { card_id: id } };
    },
    content: async (request: Request): Promise<Response> => {
      calls.push({ method: 'content', request });
      const card = cards.get(request.path!.card_id)!;
      find(card.body.elements, request.path!.element_id)!.content = String(request.data.content);
      measure(card); return { code: 0 };
    },
    batchUpdate: async (request: Request): Promise<Response> => {
      calls.push({ method: 'batchUpdate', request });
      assert.ok(Buffer.byteLength(JSON.stringify(request), 'utf8') <= 30_000, '实际batch请求含字符串再次转义仍在预算内');
      const card = cards.get(request.path!.card_id)!;
      const actions = JSON.parse(String(request.data.actions));
      for (const action of actions) {
        if (action.action === 'delete_elements') {
          assert.deepEqual(action.params, { element_ids: ['progress_history'] });
          if (deleteFailure) return { code: 200860 };
          card.body.elements = card.body.elements.filter(element => !action.params.element_ids.includes(element.element_id));
          measure(card); continue;
        }
        assert.equal(action.action, 'partial_update_element');
        const element = find(card.body.elements, action.params.element_id)!;
        assert.ok(element, '更新已预留的元素');
        assert.equal(element.tag, 'markdown', '不能替换或patch历史父面板');
        assert.deepEqual(Object.keys(action.params.partial_element), ['content']);
        element.content = action.params.partial_element.content;
        measure(card);
        // 严格应用原请求的顺序前缀再失败，模拟batch没有事务保证的边界。
        if (partialFailure.afterElement === action.params.element_id || partialFailure.afterElement === '*' && action === actions.at(-1)) {
          partialFailure.afterElement = null;
          if (partialFailure.throws) throw new Error('受控部分应用后传输异常');
          return { code: partialFailure.code };
        }
      }
      return { code: 0 };
    },
    settings: async (request: Request): Promise<Response> => {
      calls.push({ method: 'settings', request });
      Object.assign(cards.get(request.path!.card_id)!.config, JSON.parse(String(request.data.settings)).config);
      // 2026-10-14原会话网页版实测：修改配置会收起已展开历史。
      const panel = find(cards.get(request.path!.card_id)!.body.elements, 'progress_history');
      if (panel) panel.expanded = false;
      measure(cards.get(request.path!.card_id)!); return { code: 0 };
    },
    update: async (request: Request): Promise<Response> => { calls.push({ method: 'update', request }); throw new Error('过程卡禁止整卡替换'); },
  };
  const adapter = new FeishuAdapter();
  const internal = adapter as unknown as { restClient: unknown; running: boolean; createStreamingCard(chat: string): Promise<boolean> };
  internal.restClient = { cardkit: { v1: { card: methods, cardElement: methods } }, im: { message: { create: async () => ({ code: 0, data: { message_id: 'message-1' } }), reply: async () => ({ code: 0, data: { message_id: 'message-1' } }) } } };
  const f = { adapter, internal, methods, calls, cards, intermediateSizes, partialFailure, rejectEmptyDelete: () => { deleteFailure = true; }, content: (id: string, cardId = 'card-1') => find(cards.get(cardId)!.body.elements, id)?.content ?? '' };
  fixtures.push(f); return f;
}
const pump = () => new Promise<void>(resolve => setImmediate(resolve));
const tick = async () => { await new Promise<void>(resolve => setTimeout(resolve, 270)); await pump(); };
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve: (value: T) => resolve(value) }; }
const advance = async (ms = 270) => { mock.timers.tick(ms); await pump(); };
type Action = { params: { element_id: string; partial_element: { content: string } } };
const actionsOf = (request: Request) => JSON.parse(String(request.data.actions)) as Action[];
const isReset = (request: Request) => actionsOf(request).length === 2
  && actionsOf(request).every(action => action.params.element_id !== 'streaming_content' && action.params.partial_element.content === ' ');

test('完成态只有答复与唯一状态行，无真实历史时正文确认后删除空过程入口', async () => {
  const f = fixture(); await f.internal.createStreamingCard('chat');
  const before = f.calls.length;
  assert.equal(await f.adapter.onStreamEnd('chat', 'completed', '实际最终答复'), true);
  const card = f.cards.get('card-1')!;
  assert.deepEqual(card.body.elements.map(element => element.element_id), ['streaming_content', 'task_status']);
  assert.match(f.content('task_status'), /^✅ 已完成 · [^\n]+$/);
  const batches = f.calls.slice(before).filter(call => call.method === 'batchUpdate');
  assert.equal(batches.length, 2);
  assert.ok(actionsOf(batches[0].request).some(action => action.params.element_id === 'streaming_content'));
  assert.deepEqual(JSON.parse(String(batches[1].request.data.actions)), [{ action: 'delete_elements', params: { element_ids: ['progress_history'] } }]);
});

test('空入口辅助删除失败不否认完整回答已确认，也不重发正文', async () => {
  const f = fixture(); await f.internal.createStreamingCard('chat'); f.rejectEmptyDelete();
  assert.equal(await f.adapter.onStreamEnd('chat', 'completed', '已确认送达的全文'), true);
  assert.equal(f.content('streaming_content'), '已确认送达的全文');
  const batches = f.calls.filter(call => call.method === 'batchUpdate');
  assert.equal(batches.length, 2);
  assert.equal(batches.flatMap(call => JSON.parse(String(call.request.data.actions))).filter(action => action.params.element_id === 'streaming_content').length, 1);
});

test('正文确认晚到且原任务已换代，不继续发旧空入口删除请求', async () => {
  const f = fixture(); await f.internal.createStreamingCard('chat');
  const pending = deferred<void>(); const original = f.methods.batchUpdate; const issued: Request[] = [];
  f.methods.batchUpdate = async request => { issued.push(request); await pending.promise; return original(request); };
  const ending = f.adapter.onStreamEnd('chat', 'completed', '旧任务答复');
  try {
    await pump(); assert.equal(issued.length, 1);
    f.adapter.onMessageEnd('chat'); await f.internal.createStreamingCard('chat');
    pending.resolve(); assert.equal(await ending, false);
    assert.equal(issued.length, 1, '晚到正文成功回执不能让旧任务继续辅助删除');
    assert.equal(f.adapter.hasActiveCard('chat'), true);
    assert.ok(find(f.cards.get('card-2')!.body.elements, 'progress_history'));
    assert.equal(f.content('streaming_content', 'card-2'), ' ');
  } finally { pending.resolve(); await ending; }
});

test('有ctx或追加详情即保留原过程入口，完成后外部不显示诊断或追加', async () => {
  for (const kind of ['ctx', 'append'] as const) {
    const f = fixture(); await f.internal.createStreamingCard('chat');
    const panel = find(f.cards.get('card-1')!.body.elements, 'progress_history')!; panel.expanded = true;
    if (kind === 'append') f.adapter.notifyAppend('chat', 2, '补充核对');
    assert.equal(await f.adapter.onStreamEnd('chat', 'completed', '最终答复', kind === 'ctx' ? { ctx: 'ctx 13% (33k/258.4k)' } : undefined), true);
    assert.match(f.content('task_status'), /^✅ 已完成 · [^\n]+$/);
    assert.match(f.content('history_content'), kind === 'ctx' ? /ctx 13%/ : /\+2 追加/);
    assert.equal(find(f.cards.get('card-1')!.body.elements, 'progress_history'), panel); assert.equal(panel.expanded, true);
    assert.equal(f.calls.some(call => JSON.stringify(call.request).includes('delete_elements')), false);
  }
});

test('长预览提示与追加独立，文本缩短会撤提示，完整终态不误报分段', async () => {
  const f = fixture(); await f.internal.createStreamingCard('chat');
  f.adapter.onStreamText('chat', '长预览😀'.repeat(8_000)); f.adapter.notifyAppend('chat', 1, '补充说明'); await tick();
  assert.match(f.content('task_status'), /正文较长.*分段/); assert.match(f.content('task_status'), /补充说明/);
  f.adapter.onStreamText('chat', '变短后的正文'); await tick();
  assert.doesNotMatch(f.content('task_status'), /分段/);
  assert.equal(await f.adapter.onStreamEnd('chat', 'completed', '完整最终答复'), true);
  assert.match(f.content('task_status'), /^✅ 已完成 · [^\n]+$/);
  assert.match(f.content('history_content'), /补充说明/);
});

/** 三叶子布局下重建可达反例：目标历史与旧缓存相等，失败前缀已扩大平台历史。 */
async function runtimeBudgetFailure(f: ReturnType<typeof fixture>, outcome: 'code' | 'frequency' | 'exception' = 'code') {
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  await f.internal.createStreamingCard('chat');
  const variants = ['中文😀"\\', '\u0000\u0001', '普通命令'];
  const tools: ToolCallInfo[] = Array.from({ length: 9 }, (_, index) => ({ id: `tool${index}`, name: variants[(5 + index) % 3].repeat(140), status: (['running', 'complete', 'error'] as const)[index % 3] }));
  tools[8] = { id: 'tool8', name: tools[0].name, status: tools[0].status };
  f.adapter.onStreamText('chat', 'x'.repeat(19_500));
  const cumulative: ToolCallInfo[] = [];
  for (const tool of tools) { cumulative.push({ ...tool }); f.adapter.onToolEvent('chat', cumulative); }
  f.adapter.onProgress('chat', '中'.repeat(900)); f.adapter.notifyAppend('chat', 1, '追加已接收');
  await pump(); await advance();
  const seededHistory = f.content('history_content');
  f.partialFailure.afterElement = '*';
  f.partialFailure.code = outcome === 'frequency' ? 99991400 : 200860;
  f.partialFailure.throws = outcome === 'exception';
  f.adapter.onStreamText('chat', 'x'.repeat(19_600));
  f.adapter.onProgress('chat', '短进度');
  await advance();
  assert.equal(f.partialFailure.afterElement, null, '故障确已发生，不能只配置一个未触发的fake');
  assert.equal(f.content('streaming_content').length, 19_600);
  assert.ok(f.content('history_content').length > seededHistory.length, '平台历史已增长而未获完整回执');
  f.partialFailure.throws = false;
  return { seededHistory, finalText: '最终完整回答'.repeat(1_400) };
}

test('初建普通动态卡与中性摘要，固定历史默认关闭，实时进展在面板外', async () => {
  const f = fixture(); assert.equal(await f.internal.createStreamingCard('chat'), true);
  const card = f.cards.get('card-1')!;
  assert.equal(card.config.streaming_mode, false);
  assert.deepEqual(card.config.summary, { content: '任务回复' });
  assert.equal(card.config.streaming_config, undefined, '不保留打字机专用配置');
  const panel = card.body.elements.find(element => element.tag === 'collapsible_panel');
  assert.ok(panel, '存在原生折叠面板'); assert.equal(panel.expanded, false);
  assert.equal(find(panel.elements ?? [], 'history_content')?.tag, 'markdown');
  assert.deepEqual(card.body.elements.map(element => element.element_id), ['streaming_content', 'task_status', 'progress_history']);
  assert.equal(card.body.elements[0].element_id, 'streaming_content');
  const ids: string[] = [];
  const collect = (elements: Element[]) => { for (const e of elements) { if (e.element_id) ids.push(e.element_id); collect(e.elements ?? []); } };
  collect(card.body.elements); assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => /^[a-zA-Z][a-zA-Z0-9_]{0,19}$/.test(id)));
});

test('最近3条按真实变更排序，原地修改会识别，重复快照不增加请求', async () => {
  const f = fixture(); await f.internal.createStreamingCard('chat');
  const tools: ToolCallInfo[] = ['A', 'B', 'C', 'D', 'E', 'F'].map(name => ({ id: name, name: `步骤${name}`, status: 'complete' }));
  f.adapter.onToolEvent('chat', tools); await tick();
  for (const name of ['D', 'E', 'F']) assert.ok(f.content('task_status').includes(`步骤${name}`));
  assert.doesNotMatch(f.content('task_status'), /步骤A|步骤B|步骤C/);
  tools[0].status = 'error'; f.adapter.onToolEvent('chat', tools); await tick();
  assert.match(f.content('task_status'), /❌.*步骤A/);
  assert.doesNotMatch(f.content('task_status'), /步骤D/);
  assert.match(f.content('task_status'), /失败\s*1/);
  assert.match(f.content('history_content'), /步骤B/);
  const count = f.calls.length; f.adapter.onToolEvent('chat', tools); await tick();
  assert.equal(f.calls.length, count, '未变化的快照不虚构新进展或网络请求');
});

test('最近3条之外的运行和错误仍醒目，其余完成步骤只在历史', async () => {
  const f = fixture(); await f.internal.createStreamingCard('chat');
  const tools: ToolCallInfo[] = [{ id: 'run', name: '仍在运行', status: 'running' }, { id: 'err', name: '需要检查的失败', status: 'error' }, ...Array.from({ length: 6 }, (_, i) => ({ id: `done${i}`, name: `已完成${i}`, status: 'complete' as const }))];
  f.adapter.onToolEvent('chat', tools); f.adapter.onProgress('chat', '正在核对最新结果'); await tick();
  assert.match(f.content('task_status'), /仍在运行/); assert.match(f.content('task_status'), /需要检查的失败/);
  assert.match(f.content('task_status'), /正在核对最新结果/);
  assert.doesNotMatch(f.content('task_status'), /已完成0/);
  assert.match(f.content('task_status'), /执行中\s*1/); assert.match(f.content('task_status'), /失败\s*1/);
});

test('巨大历史与转义不阻断新进度，正文增长前先缩减旧详情，每步实体和请求均合预算', async () => {
  const f = fixture(); await f.internal.createStreamingCard('chat');
  const longName = '命令😀"\\\n'.repeat(2_000);
  const tools: ToolCallInfo[] = Array.from({ length: 50 }, (_, i) => ({ id: `${i}`, name: `工具${i} ${longName}`, status: 'complete' }));
  f.adapter.onToolEvent('chat', tools); f.adapter.onProgress('chat', '最新：核对预算'); f.adapter.notifyAppend('chat', 1, '继续当前任务'); await tick();
  assert.match(f.content('task_status'), /最新：核对预算/);
  assert.match(f.content('history_content'), /精简|省略|摘要/);
  assert.match(f.content('task_status'), /继续当前任务/);
  const text = '新增正文😀"\\'.repeat(1_400);
  f.adapter.onStreamText('chat', text); f.adapter.onProgress('chat', '最新：正文已更新'); await tick();
  assert.match(f.content('task_status'), /最新：正文已更新/);
  assert.ok(f.content('streaming_content').startsWith('新增正文'));
  assert.ok(f.calls.some(call => call.method === 'batchUpdate' && JSON.parse(String(call.request.data.actions)).some((action: { params: { element_id: string } }) => action.params.element_id === 'streaming_content')));
  assert.equal(f.calls.some(call => call.method === 'content'), false);
  assert.ok(f.intermediateSizes.every(size => size <= 30_000));
  assert.ok(f.calls.every(call => Buffer.byteLength(JSON.stringify(call.request), 'utf8') <= 30_000));
});

test('建卡期间保留不可变工具快照，换代清理后不向新卡重放', async () => {
  const f = fixture(); const pending = deferred<Response>(); let first = true;
  const create = f.methods.create;
  f.methods.create = async request => { if (first) { first = false; await pending.promise; } return create(request); };
  const creating = f.internal.createStreamingCard('chat');
  const tool: ToolCallInfo = { id: 'tool', name: '建卡时动作', status: 'running' };
  f.adapter.onToolEvent('chat', [tool]); tool.status = 'error';
  pending.resolve({ code: 0 }); await creating; await tick();
  assert.match(f.content('task_status'), /🔄.*建卡时动作/);
  f.adapter.onMessageEnd('chat'); await f.internal.createStreamingCard('chat'); await tick();
  assert.doesNotMatch(f.content('task_status', 'card-2'), /建卡时动作/);
});

test('等待期间每5秒更新真实耗时，心跳不改变完成步骤数', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const f = fixture(); await f.internal.createStreamingCard('chat');
  f.adapter.onToolEvent('chat', [{ id: 'done', name: '已完成的读取', status: 'complete' }]); await pump();
  assert.match(f.content('task_status'), /已用时 0/);
  mock.timers.tick(5_000); await pump();
  assert.match(f.content('task_status'), /已用时 5/);
  assert.match(f.content('task_status'), /已完成 1/);
  const history = f.content('history_content');
  mock.timers.tick(5_000); await pump();
  assert.match(f.content('task_status'), /已用时 10/);
  assert.equal(f.content('history_content'), history, '时间流逝不是新的执行事件');
});

test('耗时更新复用在途正文batch，finalize在等待网络前停止心跳', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const f = fixture(); await f.internal.createStreamingCard('chat');
  const pending = deferred<Response>(); const original = f.methods.batchUpdate;
  let attempts = 0;
  f.methods.batchUpdate = async request => { attempts++; await pending.promise; return original(request); };
  f.adapter.onStreamText('chat', '在途正文'); await pump();
  assert.equal(attempts, 1, '正文也用同一局部batch');
  mock.timers.tick(5_000); await pump();
  assert.equal(attempts, 1, '在途正文期间不旁路写耗时');
  const ending = f.adapter.onStreamEnd('chat', 'completed', '最后正文');
  mock.timers.tick(20_000); await pump();
  pending.resolve({ code: 0 }); await ending; await pump();
  const before = f.calls.length;
  mock.timers.tick(20_000); await pump();
  assert.equal(f.calls.length, before, '终态不复活耗时或重试');
});

test('cleanup、换代和stop清理旧耗时，只允许当前卡更新', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const f = fixture(); await f.internal.createStreamingCard('chat');
  f.adapter.onMessageEnd('chat'); const afterCleanup = f.calls.length;
  mock.timers.tick(10_000); await pump(); assert.equal(f.calls.length, afterCleanup);
  await f.internal.createStreamingCard('chat');
  mock.timers.tick(5_000); await pump();
  const elapsed = f.calls.filter(c => c.method === 'batchUpdate');
  assert.equal(elapsed.length, 1, '新卡仍有耗时刷新'); assert.equal(elapsed[0].request.path?.card_id, 'card-2');
  f.internal.running = true; await f.adapter.stop(); const afterStop = f.calls.length;
  mock.timers.tick(10_000); await pump(); assert.equal(f.calls.length, afterStop);
});

test('心跳遵守频控退避，恢复时发送最新事件而非旧快照', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const f = fixture(); await f.internal.createStreamingCard('chat');
  let attempts = 0; const original = f.methods.batchUpdate;
  f.methods.batchUpdate = async request => { attempts++; return attempts === 1 ? { code: 99991400 } : original(request); };
  f.adapter.onProgress('chat', '旧事件'); await pump();
  mock.timers.tick(1_000); f.adapter.onProgress('chat', '最新事件'); await pump();
  assert.equal(attempts, 1, '退避期间事件与心跳都不绕过调度');
  mock.timers.tick(4_000); await pump();
  assert.equal(attempts, 2); assert.match(f.content('task_status'), /最新事件/);
  assert.match(f.content('task_status'), /已用时 5/);
});

test('收尾局部更新原正文/页脚并保留历史，不重发expanded，完成步骤不再外显', async () => {
  const f = fixture(); await f.internal.createStreamingCard('chat');
  const names = ['完成过的命令1', '完成过的命令2', '完成过的命令3'];
  f.adapter.onToolEvent('chat', names.map(name => ({ id: name, name, status: 'complete' }))); await tick();
  for (const name of names) assert.ok(f.content('task_status').includes(name));
  const panel = find(f.cards.get('card-1')!.body.elements, 'progress_history')!;
  panel.expanded = true; // 仅模拟客户端阅读状态；不冒称真实飞书已验收。
  f.calls.length = 0;
  assert.equal(await f.adapter.onStreamEnd('chat', 'completed', '完整最终回答', { ctx: 'ctx 42% (84k/200k)' }), true);
  assert.equal(f.content('streaming_content'), '完整最终回答');
  assert.match(f.content('task_status'), /^✅ 已完成 · [^\n]+$/); assert.match(f.content('history_content'), /ctx 42%/);
  assert.match(f.content('task_status'), /^✅ 已完成 · [^\n]+(?:\n完整回答将在下方分段发送。)?$/);
  for (const name of names) assert.ok(f.content('history_content').includes(name));
  assert.equal(panel.expanded, true);
  assert.deepEqual(f.calls.map(call => call.method), ['batchUpdate']);
  assert.equal(f.cards.get('card-1')!.config.streaming_mode, false);
  assert.deepEqual(f.cards.get('card-1')!.config.summary, { content: '任务回复' });
  assert.equal(f.adapter.hasActiveCard('chat'), false);
});

test('终态错误醒目保留，取消明确中断，最终正文不混入工具历史', async () => {
  for (const status of ['error', 'interrupted'] as const) {
    const f = fixture(); await f.internal.createStreamingCard('chat');
    f.adapter.onToolEvent('chat', [{ id: 'err', name: '失败的检查', status: 'error' },
      ...[1, 2, 3].map(index => ({ id: `done${index}`, name: `最近完成${index}`, status: 'complete' as const }))]); await tick();
    assert.equal(await f.adapter.onStreamEnd('chat', status, status === 'error' ? '失败说明' : ''), true);
    assert.match(f.content('task_status'), status === 'error' ? /出错/ : /中断/);
    assert.match(f.content('task_status'), /❌.*失败的检查/);
    assert.doesNotMatch(f.content('task_status'), /最近完成/);
    assert.match(f.content('history_content'), /最近完成1/);
    assert.doesNotMatch(f.content('streaming_content'), /失败的检查/);
    assert.equal(f.calls.some(call => call.method === 'content' || call.method === 'settings'), false);
  }
});

for (const code of [200860, 99991400]) {
  test(`运行batch写入三条后返回${code}，成功终态仍明确清空外部进度并保留历史`, async () => {
    const f = fixture(); await f.internal.createStreamingCard('chat');
    const card = f.cards.get('card-1')!;
    const config = structuredClone(card.config);
    const panel = find(card.body.elements, 'progress_history')!;
    panel.expanded = true;
    f.partialFailure.afterElement = 'task_status'; f.partialFailure.code = code;
    f.adapter.onToolEvent('chat', [1, 2, 3].map(index => ({ id: `done${index}`, name: `步骤${index}`, status: 'complete' })));
    await tick();
    assert.equal(f.partialFailure.afterElement, null, '故障确实发生在顺序前缀已包含常显进度之后');
    for (const name of ['步骤1', '步骤2', '步骤3']) assert.ok(f.content('task_status').includes(name));
    assert.equal(await f.adapter.onStreamEnd('chat', 'completed', '恢复后的完整正文'), true);
    assert.match(f.content('task_status'), /^✅ 已完成 · [^\n]+$/, '不能依据落后的sentView保留运行进度');
    assert.equal(f.content('streaming_content'), '恢复后的完整正文');
    for (const name of ['步骤1', '步骤2', '步骤3']) assert.ok(f.content('history_content').includes(name));
    const batches = f.calls.filter(call => call.method === 'batchUpdate');
    const reset = actionsOf(batches.at(-2)!.request);
    assert.equal(reset[0].params.element_id, 'task_status', '先清空并让出旧摘要空间');
    assert.equal(new Set(reset.map(action => action.params.element_id)).size, 2);
    assert.ok(isReset(batches.at(-2)!.request));
    assert.equal(actionsOf(batches.at(-1)!.request)[0].params.element_id, 'streaming_content');
    assert.deepEqual(card.config, config); assert.equal(panel.expanded, true);
    assert.equal(find(card.body.elements, 'progress_history'), panel);
    assert.equal(f.calls.some(call => call.method === 'content' || call.method === 'settings' || call.method === 'update'), false);
    assert.equal(f.adapter.hasActiveCard('chat'), false);
    assert.ok(f.intermediateSizes.every(size => size <= 30_000));
    const sequences = f.calls.filter(call => call.method === 'batchUpdate').map(call => Number(call.request.data.sequence));
    assert.deepEqual(sequences, [1, 2, 3]);
  });
}

test('整体成功后此前工具失败明细仅留历史，不能继续作为当前错误外显', async () => {
  const f = fixture(); await f.internal.createStreamingCard('chat');
  f.adapter.onToolEvent('chat', [{ id: 'old-error', name: '已处理的早期失败', status: 'error' },
    ...[1, 2, 3].map(index => ({ id: `done${index}`, name: `恢复步骤${index}`, status: 'complete' as const }))]); await tick();
  assert.match(f.content('task_status'), /❌.*已处理的早期失败/);
  assert.equal(await f.adapter.onStreamEnd('chat', 'completed', '问题已处理，任务成功完成'), true);
  assert.match(f.content('task_status'), /^✅ 已完成 · [^\n]+(?:\n完整回答将在下方分段发送。)?$/);
  assert.match(f.content('history_content'), /❌.*已处理的早期失败/);
  assert.match(f.content('history_content'), /恢复步骤3/);
  assert.match(f.content('task_status'), /已完成/);
  assert.equal(f.content('streaming_content'), '问题已处理，任务成功完成');
});

test('部分运行更新失败后，超限正文的终态预览也清空进度，仍false交回完整投递', async () => {
  const f = fixture(); await f.internal.createStreamingCard('chat');
  f.partialFailure.afterElement = 'task_status';
  f.adapter.onToolEvent('chat', [1, 2, 3].map(index => ({ id: `done${index}`, name: `预览步骤${index}`, status: 'complete' })));
  await tick(); assert.match(f.content('task_status'), /预览步骤3/);
  assert.equal(await f.adapter.onStreamEnd('chat', 'completed', '超长完整正文😀'.repeat(8_000)), false);
  assert.match(f.content('task_status'), /^✅ 已完成 · [^\n]+(?:\n完整回答将在下方分段发送。)?$/);
  assert.match(f.content('history_content'), /预览步骤1/);
  assert.match(f.content('task_status'), /完整回答.*分段发送/);
  assert.doesNotMatch(f.content('streaming_content'), /超长完整正文/);
  assert.equal(f.calls.some(call => call.method === 'settings' || call.method === 'content' || call.method === 'update'), false);
});

test('历史优先让出预算，能容纳的最终正文完整写入；过长正文false且无需配置收尾', async () => {
  const f = fixture(); await f.internal.createStreamingCard('chat');
  f.adapter.onToolEvent('chat', Array.from({ length: 40 }, (_, i) => ({ id: `${i}`, name: `历史${i} ` + '很长的命令😀"\\'.repeat(600), status: 'complete' })));
  await tick();
  const text = '完整正文😀"\\'.repeat(1_100);
  assert.equal(await f.adapter.onStreamEnd('chat', 'completed', text), true);
  assert.equal(f.content('streaming_content'), text, '不能把预览或摘要误认为最终全文');
  assert.ok(f.intermediateSizes.every(size => size <= 30_000));
  const g = fixture(); await g.internal.createStreamingCard('chat');
  const long = '中文😀'.repeat(8_000);
  assert.equal(await g.adapter.onStreamEnd('chat', 'completed', long), false);
  assert.equal(g.cards.get('card-1')!.config.streaming_mode, false);
  assert.equal(g.calls.some(call => call.method === 'content' || call.method === 'settings'), false);
  assert.doesNotMatch(g.content('streaming_content'), /中文/);
});

test('正文batch拒绝返回false，完整正文成功后无需任何配置操作即可确认', async () => {
  const f = fixture(); await f.internal.createStreamingCard('chat');
  let updates = 0;
  f.methods.batchUpdate = async () => { updates++; return { code: 200860 }; };
  assert.equal(await f.adapter.onStreamEnd('chat', 'completed', '未送达的回答'), false);
  assert.equal(updates, 1); assert.equal(f.cards.get('card-1')!.config.streaming_mode, false);
  assert.equal(f.calls.some(call => call.method === 'settings'), false);
  const g = fixture(); await g.internal.createStreamingCard('chat');
  let settingAttempts = 0;
  g.methods.settings = async () => { settingAttempts++; return { code: 99991400 }; };
  assert.equal(await g.adapter.onStreamEnd('chat', 'completed', '已经确认送达'), true);
  assert.equal(settingAttempts, 0, '不能在正文成功之后用配置请求重置阅读状态');
  assert.equal(g.content('streaming_content'), '已经确认送达');
  assert.equal(g.adapter.hasActiveCard('chat'), false);
});

for (const outcome of ['code', 'frequency', 'exception'] as const) {
  test(`可达预算反例：运行${outcome}使历史不确定，较长最终正文经两批校准完整送达`, async () => {
    const f = fixture(); const { seededHistory, finalText } = await runtimeBudgetFailure(f, outcome);
    const card = f.cards.get('card-1')!; const config = structuredClone(card.config);
    const panel = find(card.body.elements, 'progress_history')!; panel.expanded = true;
    const before = f.calls.length;
    assert.equal(await f.adapter.onStreamEnd('chat', 'completed', finalText), true);
    assert.equal(f.content('streaming_content'), finalText);
    assert.equal(f.content('history_content'), seededHistory, '目标历史与旧缓存同文时也必须校准平台增长');
    assert.match(f.content('task_status'), /^✅ 已完成 · [^\n]+(?:\n完整回答将在下方分段发送。)?$/);
    const batches = f.calls.slice(before).filter(call => call.method === 'batchUpdate');
    assert.equal(batches.length, 2); assert.ok(isReset(batches[0].request));
    assert.equal(actionsOf(batches[0].request)[0].params.element_id, 'task_status');
    assert.equal(actionsOf(batches[1].request)[0].params.element_id, 'streaming_content');
    assert.deepEqual(card.config, config); assert.equal(panel.expanded, true);
    assert.equal(f.calls.some(call => call.method === 'settings' || call.method === 'content' || call.method === 'update'), false);
    assert.ok(f.intermediateSizes.every(size => size <= 30_000));
  });
}

test('不确定状态后一次普通diff成功仍保留收尾校准，不能凭差异成功假定全部叶子同步', async () => {
  const f = fixture(); const { finalText } = await runtimeBudgetFailure(f);
  f.adapter.onProgress('chat', '后续普通刷新已确认'); await advance();
  assert.match(f.content('task_status'), /后续普通刷新已确认/);
  const before = f.calls.length;
  assert.equal(await f.adapter.onStreamEnd('chat', 'completed', finalText), true);
  const batches = f.calls.slice(before).filter(call => call.method === 'batchUpdate');
  assert.equal(batches.length, 2); assert.ok(isReset(batches[0].request));
  assert.equal(f.content('streaming_content'), finalText);
});

test('校准先保留正文清详情，再写较短最终正文，最后恢复更大的完整历史', async () => {
  const f = fixture(); await runtimeBudgetFailure(f);
  const previousBody = f.content('streaming_content'); const previousHistory = f.content('history_content');
  const original = f.methods.batchUpdate; let observedReset = false;
  f.methods.batchUpdate = async request => {
    const result = await original(request);
    if (isReset(request)) { observedReset = true; assert.equal(f.content('streaming_content'), previousBody); assert.equal(f.content('history_content'), ' '); }
    return result;
  };
  assert.equal(await f.adapter.onStreamEnd('chat', 'completed', '较短的完整答复'), true);
  assert.equal(observedReset, true); assert.equal(f.content('streaming_content'), '较短的完整答复');
  assert.ok(f.content('history_content').length > previousHistory.length);
  assert.ok(f.intermediateSizes.every(size => size <= 30_000));
});

for (const phase of ['reset', 'restore'] as const) {
  test(`校准${phase}批部分失败返回false，不把未确认目标冒称完整送达`, async () => {
    const f = fixture(); const { finalText } = await runtimeBudgetFailure(f);
    const before = f.calls.length;
    f.partialFailure.afterElement = phase === 'reset' ? 'history_content' : 'streaming_content';
    assert.equal(await f.adapter.onStreamEnd('chat', 'completed', finalText), false);
    assert.equal(f.partialFailure.afterElement, null);
    assert.equal(f.calls.slice(before).filter(call => call.method === 'batchUpdate').length, phase === 'reset' ? 1 : 2);
    if (phase === 'reset') assert.equal(f.content('streaming_content').length, 19_600, '清理失败后不能继续写最终正文');
    assert.equal(f.adapter.hasActiveCard('chat'), false);
    const after = f.calls.length; await advance(10_000); assert.equal(f.calls.length, after, '收尾失败也不复活后台写入');
    assert.ok(f.intermediateSizes.every(size => size <= 30_000));
  });
}

for (const replacement of [false, true]) {
  test(`两批校准之间${replacement ? '取消并换代' : '取消清理'}，旧恢复不得继续写入`, async () => {
    const f = fixture(); const { finalText } = await runtimeBudgetFailure(f);
    const pending = deferred<void>(); const issued: Request[] = []; const original = f.methods.batchUpdate;
    f.methods.batchUpdate = async request => { issued.push(request); if (isReset(request)) await pending.promise; return original(request); };
    const ending = f.adapter.onStreamEnd('chat', 'completed', finalText);
    try {
      await pump(); assert.equal(issued.length, 1); assert.ok(isReset(issued[0]));
      f.adapter.onMessageEnd('chat');
      if (replacement) await f.internal.createStreamingCard('chat');
      pending.resolve(); assert.equal(await ending, false);
      assert.equal(issued.length, 1, '第一批晚到后必须重新验证原卡与generation');
      if (replacement) { assert.equal(f.adapter.hasActiveCard('chat'), true); assert.equal(f.content('streaming_content', 'card-2'), ' '); }
      assert.equal(f.content('streaming_content').length, 19_600);
    } finally { pending.resolve(); await ending; }
  });
}

for (const status of ['error', 'interrupted'] as const) {
  test(`不确定状态下${status}两批恢复历史与必要错误提示，不误报成功`, async () => {
    const f = fixture(); await runtimeBudgetFailure(f);
    assert.equal(await f.adapter.onStreamEnd('chat', status, status === 'error' ? '任务失败说明' : ''), true);
    assert.match(f.content('task_status'), status === 'error' ? /出错/ : /中断/);
    assert.match(f.content('task_status'), /❌/); assert.match(f.content('history_content'), /❌/);
    assert.equal(f.calls.some(call => call.method === 'settings' || call.method === 'content' || call.method === 'update'), false);
    assert.ok(f.intermediateSizes.every(size => size <= 30_000));
  });
}

test('不确定状态下超限终态只恢复已确认正文预览，返回false并明确全文分段', async () => {
  const f = fixture(); await runtimeBudgetFailure(f);
  const before = f.calls.length;
  assert.equal(await f.adapter.onStreamEnd('chat', 'completed', '完整回答😀'.repeat(8_000)), false);
  const batches = f.calls.slice(before).filter(call => call.method === 'batchUpdate');
  assert.equal(batches.length, 2); assert.ok(isReset(batches[0].request));
  assert.equal(f.content('streaming_content'), 'x'.repeat(19_500));
  assert.match(f.content('task_status'), /完整回答.*分段/); assert.notEqual(f.content('history_content'), ' ');
  assert.match(f.content('task_status'), /^✅ 已完成 · [^\n]+\n完整回答将在下方分段发送。$/); assert.ok(f.intermediateSizes.every(size => size <= 30_000));
});
