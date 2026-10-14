import assert from 'node:assert/strict';
import { test } from 'node:test';
import { read, setup } from './codex-test-transport.js';
import childProcess from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

// 协议测试无论注入是否失效，都禁止真实模型和平台入口。
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  Object.defineProperty(childProcess, key, { value: () => { throw new Error('真实子进程被测试阻断'); } });
}
net.Socket.prototype.connect = (() => { throw new Error('真实网络被测试阻断'); }) as typeof net.Socket.prototype.connect;
globalThis.fetch = async () => { throw new Error('真实网络被测试阻断'); };
syncBuiltinESMExports();

function question(client: ReturnType<typeof setup>['client'], id: string, isBlocking: boolean) {
  client.emitter.emit('request', { id, method: 'item/tool/requestUserInput', params: {
    threadId: 'thread', turnId: 'turn', itemId: id, isBlocking,
    questions: [{ id: 'q', header: '问题', question: '原问题', options: null }],
  } });
}

// 官方 schema 合法、从真实内部持久事件字段映射的合成 wire fixture，非抓包。
const nativeItem = { type: 'agentMessage', id: 'native-item', phase: 'final_answer', delivery: 'async', text: '本轮测试题', questions: [
  { title: '报告格式', options: ['简短报告', '详细报告'] }, { title: '填写 QA_FEISHU_20261014', options: null },
] };

test('原生 async questions 经消息通道单次发出，题目文字不混最终响应且输出继续', async () => {
  const { client, provider } = setup(); const statuses: string[] = [];
  client.onTurn = () => {
    client.publish('item/agentMessage/delta', { itemId: 'native-item', delta: '测试题缓存' });
    client.publish('item/started', { item: { ...nativeItem, questions: undefined } });
    client.publish('item/completed', { item: nativeItem });
    client.publish('item/completed', { item: nativeItem });
    client.publish('item/agentMessage/delta', { itemId: 'native-item', delta: '迟到题目delta' });
    client.publish('item/completed', { item: { type: 'agentMessage', id: 'progress-native', phase: 'commentary', text: '继续独立工作' } });
    client.publish('item/completed', { item: { type: 'agentMessage', id: 'final-native', phase: 'final_answer', text: '实际最终回答' } });
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  const events = await read(provider.streamChat({ prompt: 'hi', sessionId: 's', onRuntimeStatusChange: s => statuses.push(s) }));
  const requests = events.filter(event => event.type === 'user_input_request');
  assert.equal(requests.length, 1);
  const request = JSON.parse(requests[0].data);
  assert.equal(request.answerChannel, 'message'); assert.equal(request.isBlocking, false);
  assert.deepEqual(request.questions, [{ id: 'q0', question: '报告格式', options: [{ label: '简短报告' }, { label: '详细报告' }], allowOther: true }, { id: 'q1', question: '填写 QA_FEISHU_20261014', allowOther: true }]);
  assert.equal(events.filter(event => event.type === 'text').map(e => e.data).join(''), '实际最终回答');
  assert.ok(events.some(e => e.type === 'progress' && e.data === '继续独立工作'));
  assert.equal(statuses.includes('waiting_for_input'), false); assert.deepEqual(client.replies, []);
});

test('原生题支持仅completed与started题元数据；错回合和普通畸形async保留普通文字', async () => {
  for (const started of [false, true]) {
    const { client, provider } = setup();
    client.onTurn = () => {
      client.publish('item/completed', { threadId: 'other', item: { ...nativeItem, id: 'wrong-thread' } });
      client.publish('item/completed', { turnId: 'other', item: { ...nativeItem, id: 'wrong-turn' } });
      if (started) client.publish('item/started', { item: nativeItem });
      client.publish('item/completed', { item: nativeItem });
      client.publish('item/completed', { item: { ...nativeItem, id: 'empty', questions: [], text: '普通async文字' } });
      client.publish('item/completed', { item: { ...nativeItem, id: 'invalid', questions: [{ title: '坏题', options: [7] }], text: '无效题原文' } });
      client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
      client.publish('item/completed', { item: { ...nativeItem, id: 'late' } });
    };
    const events = await read(provider.streamChat({ prompt: 'hi', sessionId: 's' }));
    assert.equal(events.filter(e => e.type === 'user_input_request').length, 1);
    assert.equal(events.filter(e => e.type === 'text').map(e => e.data).join(''), '普通async文字无效题原文');
  }
});

test('取消和回合结束后的原生通知不能在旧回合创建表单', async () => {
  const { client, provider } = setup(); const controller = new AbortController();
  client.onTurn = () => {
    controller.abort(); client.publish('item/completed', { item: nativeItem });
  };
  const events = await read(provider.streamChat({ prompt: 'hi', sessionId: 's', abortController: controller }));
  client.publish('item/completed', { item: { ...nativeItem, id: 'after-close' } });
  assert.equal(events.some(e => e.type === 'user_input_request'), false);
});

test('普通async未收到item completed时，回合终态仍保留其缓存文字', async () => {
  const { client, provider } = setup();
  client.onTurn = () => {
    client.publish('item/started', { item: { type: 'agentMessage', id: 'ordinary-async', phase: 'final_answer', delivery: 'async', questions: null, text: '' } });
    client.publish('item/agentMessage/delta', { itemId: 'ordinary-async', delta: '普通async正文' });
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  const events = await read(provider.streamChat({ prompt: 'hi', sessionId: 's' }));
  assert.equal(events.filter(e => e.type === 'text').map(e => e.data).join(''), '普通async正文');
  assert.equal(events.some(e => e.type === 'user_input_request'), false);
});

test('普通async缺省或空phase且缺少item completed时仍不丢缓存正文', async () => {
  for (const phase of [undefined, null]) {
    const { client, provider } = setup();
    client.onTurn = () => {
      client.publish('item/started', { item: { type: 'agentMessage', id: 'optional-phase-async', phase, delivery: 'async', questions: null, text: '' } });
      client.publish('item/agentMessage/delta', { itemId: 'optional-phase-async', delta: '没有phase的普通正文' });
      client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    };
    const events = await read(provider.streamChat({ prompt: 'hi', sessionId: 's' }));
    assert.equal(events.filter(e => e.type === 'text').map(e => e.data).join(''), '没有phase的普通正文');
    assert.equal(events.some(e => e.type === 'user_input_request'), false);
  }
});

test('普通async的commentary终态缓存仍是进度，明确普通started继续流式', async () => {
  const { client, provider } = setup();
  client.onTurn = () => {
    client.publish('item/started', { item: { type: 'agentMessage', id: 'async-commentary', phase: 'commentary', delivery: 'async', questions: null, text: '' } });
    client.publish('item/agentMessage/delta', { itemId: 'async-commentary', delta: '旁白进度' });
    client.publish('item/started', { item: { type: 'agentMessage', id: 'ordinary-streaming', phase: 'final_answer', text: '' } });
    client.publish('item/agentMessage/delta', { itemId: 'ordinary-streaming', delta: '已经显示的普通片段' });
    client.publish('item/completed', { item: { ...nativeItem, id: 'ordinary-streaming' } });
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  const events = await read(provider.streamChat({ prompt: 'hi', sessionId: 's' }));
  assert.equal(events.filter(e => e.type === 'progress').map(e => e.data).join(''), '旁白进度');
  // 已明确是普通流式消息的文字无法在 later completed 改为 async 后撤回。
  assert.equal(events.filter(e => e.type === 'text').map(e => e.data).join(''), '已经显示的普通片段');
  assert.equal(events.filter(e => e.type === 'user_input_request').length, 1);
});

test('初始化期错 turn 问答和审批不能借用新回合转发或返回用户答案', async () => {
  const { client, provider, permissions } = setup();
  const statuses: string[] = [];
  client.onTurn = () => {
    for (const method of ['item/tool/requestUserInput', 'item/commandExecution/requestApproval']) {
      client.emitter.emit('request', { id: method, method, params: { threadId: 'thread', turnId: 'old-turn', itemId: 'old', isBlocking: false,
        questions: [{ id: 'q', header: '旧问题', question: '旧回合问题', options: null }] } });
    }
    setImmediate(() => client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } }));
  };
  const events = await read(provider.streamChat({ prompt: '新任务', sessionId: 's', onRuntimeStatusChange: s => statuses.push(s) }), event => {
    if (event.type === 'user_input_request') permissions.resolvePendingPermission(JSON.parse(event.data).requestId, { behavior: 'allow', updatedInput: { answers: { q: ['不该返回'] } } });
    if (event.type === 'permission_request') permissions.resolvePendingPermission(JSON.parse(event.data).permissionRequestId, { behavior: 'allow' });
  });
  assert.equal(events.some(e => e.type === 'user_input_request' || e.type === 'permission_request'), false);
  assert.equal(statuses.includes('waiting_for_input'), false);
  assert.deepEqual(client.replies, [
    { id: 'item/tool/requestUserInput', result: { answers: {} } },
    { id: 'item/commandExecution/requestApproval', result: { decision: 'cancel' } },
  ]);
});

test('初始化期正确问题等待 turnId 与 collector ready 后转发原 RPC', async () => {
  const { client, provider, permissions } = setup();
  let release!: () => void;
  const starting = new Promise<void>(resolve => { release = resolve; });
  const request = client.request.bind(client);
  let sawQuestion = false;
  let started = false;
  client.request = async (method, params = {}) => {
    if (method !== 'turn/start') return request(method, params);
    client.calls.push({ method, params });
    started = true; question(client, 'early-valid', false);
    await starting;
    return { turn: { id: 'turn' } };
  };
  const reading = read(provider.streamChat({ prompt: '任务', sessionId: 's' }), event => {
    if (event.type !== 'user_input_request') return;
    sawQuestion = true;
    permissions.resolvePendingPermission(JSON.parse(event.data).requestId, { behavior: 'allow', updatedInput: { answers: { q: ['有效答案'] } } });
    setImmediate(() => client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } }));
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, true);
    assert.equal(sawQuestion, false);
    release();
    await reading;
    assert.equal(sawQuestion, true);
    assert.deepEqual(client.replies, [{ id: 'early-valid', result: { answers: { q: { answers: ['有效答案'] } } } }]);
  } finally {
    release(); provider.stop(); await reading;
  }
});

test('初始化等待期间服务端 resolved，问题不能在 ready 后复活', async () => {
  const { client, provider } = setup();
  client.onTurn = () => {
    question(client, 'early-resolved', false);
    client.publish('serverRequest/resolved', { requestId: 'early-resolved' });
    setImmediate(() => client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } }));
  };
  const events = await read(provider.streamChat({ prompt: '任务', sessionId: 's' }));
  assert.equal(events.some(e => e.type === 'user_input_request'), false);
  assert.deepEqual(client.replies, []);
});

test('early completed 解锁 ready 后不能把刚结束的问题再显示出来', async () => {
  const { client, provider } = setup();
  client.onTurn = () => {
    question(client, 'early-completed', false);
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  const events = await read(provider.streamChat({ prompt: '任务', sessionId: 's' }));
  assert.equal(events.some(e => e.type === 'user_input_request'), false);
  assert.equal(events.some(e => e.type === 'error'), false);
});

for (const failure of ['cancel-before-ready', 'start-failed']) {
  test(`${failure} 释放初始化期问题且不转发，终态后不回 running`, async () => {
    const { client, provider } = setup();
    const controller = new AbortController();
    const statuses: string[] = [];
    const request = client.request.bind(client);
    client.request = async (method, params = {}) => {
      if (method !== 'turn/start') return request(method, params);
      client.calls.push({ method, params }); question(client, 'early-failed', true);
      if (failure === 'start-failed') throw new Error('fake start failure');
      controller.abort();
      return { turn: { id: 'turn' } };
    };
    const events = await read(provider.streamChat({ prompt: '任务', sessionId: 's', abortController: controller, onRuntimeStatusChange: s => statuses.push(s) }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.some(e => e.type === 'user_input_request'), false);
    assert.equal(statuses.at(-1), 'idle');
    assert.equal(statuses.includes('waiting_for_input'), false);
    assert.equal(JSON.parse(events.find(e => e.type === 'result')!.data).is_error, true);
  });
}

test('非阻塞提问透传标志，继续进度并回原 RPC，不误报等待', async () => {
  const { client, provider, permissions } = setup(); const statuses: string[] = [];
  client.onTurn = () => { question(client, 'async-q', false); client.publish('item/completed', { item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '继续工作' } }); };
  const events = await read(provider.streamChat({ prompt: 'hi', sessionId: 's', onRuntimeStatusChange: s => statuses.push(s) }), event => {
    if (event.type !== 'user_input_request') return;
    const data = JSON.parse(event.data);
    assert.equal(data.isBlocking, false);
    permissions.resolvePendingPermission(data.requestId, { behavior: 'allow', updatedInput: { answers: { q: ['答案'] } } });
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  });
  assert.equal(statuses.includes('waiting_for_input'), false);
  assert.ok(events.some(e => e.type === 'progress' && e.data === '继续工作'));
  assert.deepEqual(client.replies, [{ id: 'async-q', result: { answers: { q: { answers: ['答案'] } } } }]);
});

test('两个阻塞问题与非阻塞问题交错，最后一个阻塞解决前始终等待', async () => {
  const { client, provider, permissions } = setup(); const statuses: string[] = []; const ids: string[] = [];
  client.onTurn = () => { question(client, 'b1', true); question(client, 'b2', true); question(client, 'n', false); };
  await read(provider.streamChat({ prompt: 'hi', sessionId: 's', onRuntimeStatusChange: s => statuses.push(s) }), event => {
    if (event.type !== 'user_input_request') return;
    ids.push(JSON.parse(event.data).requestId);
    if (ids.length !== 3) return;
    permissions.resolvePendingPermission(ids[0], { behavior: 'allow' });
    permissions.resolvePendingPermission(ids[2], { behavior: 'allow' });
    setImmediate(() => {
      assert.equal(statuses.at(-1), 'waiting_for_input');
      permissions.resolvePendingPermission(ids[1], { behavior: 'allow' });
      setImmediate(() => client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } }));
    });
  });
  assert.equal(statuses.at(-1), 'idle');
});

test('正常完成关闭未答问题，错 thread resolved 不生效，idle 后不回 running', async () => {
  const { client, provider, permissions } = setup(); const reasons: unknown[] = []; const statuses: string[] = [];
  client.onTurn = () => question(client, 'closed', false);
  await read(provider.streamChat({ prompt: 'hi', sessionId: 's', onRuntimeStatusChange: s => statuses.push(s) }), event => {
    if (event.type !== 'user_input_request') return;
    permissions.onResolution(JSON.parse(event.data).requestId, value => reasons.push(value.reason));
    client.publish('serverRequest/resolved', { requestId: 'closed', threadId: 'other' });
    assert.deepEqual(reasons, []);
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reasons, ['turn_completed']);
  assert.equal(statuses.at(-1), 'idle');
  assert.deepEqual(client.replies, []);
});

test('服务端关闭原问题使用精确闭合原因，工具审批仍阻塞', async () => {
  const { client, provider, permissions } = setup(); const reasons: unknown[] = []; const statuses: string[] = [];
  client.onTurn = () => {
    client.emitter.emit('request', { id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'tool' } });
    question(client, 'closed-q', false);
  };
  let approval = '';
  await read(provider.streamChat({ prompt: 'hi', sessionId: 's', onRuntimeStatusChange: s => statuses.push(s) }), event => {
    if (event.type === 'permission_request') approval = JSON.parse(event.data).permissionRequestId;
    if (event.type !== 'user_input_request') return;
    permissions.onResolution(JSON.parse(event.data).requestId, value => reasons.push(value.reason));
    client.publish('serverRequest/resolved', { requestId: 'closed-q' });
    setImmediate(() => {
      assert.equal(statuses.at(-1), 'waiting_for_input');
      permissions.resolvePendingPermission(approval, { behavior: 'deny' });
      setImmediate(() => client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } }));
    });
  });
  assert.deepEqual(reasons, ['request_closed']);
  assert.equal(client.replies.some(r => (r as { id: string }).id === 'closed-q'), false);
});

test('任意问题 ID 经结构化答案序列化保留，不依赖对象原型', async () => {
  const { client, provider, permissions } = setup();
  client.onTurn = () => client.emitter.emit('request', { id: 'prototype', method: 'item/tool/requestUserInput', params: {
    threadId: 'thread', turnId: 'turn', itemId: 'prototype', isBlocking: false,
    questions: [{ id: '__proto__', header: '信息', question: '输入', options: null }],
  } });
  await read(provider.streamChat({ prompt: 'hi', sessionId: 's' }), event => {
    if (event.type !== 'user_input_request') return;
    permissions.resolvePendingPermission(JSON.parse(event.data).requestId, { behavior: 'allow', updatedInput: { answers: Object.fromEntries([['__proto__', ['safe']]]) } });
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  });
  const serialized = JSON.parse(JSON.stringify(client.replies[0]));
  assert.deepEqual(Object.keys(serialized.result.answers), ['__proto__']);
  assert.deepEqual(serialized.result.answers.__proto__, { answers: ['safe'] });
});

for (const failure of ['cancel', 'failed', 'disconnect']) {
  test(`${failure} 不形成正常完成可补充原因`, async () => {
    const { client, provider, permissions } = setup(); const controller = new AbortController(); const reasons: unknown[] = [];
    client.onTurn = () => question(client, 'failure-q', false);
    await read(provider.streamChat({ prompt: 'hi', sessionId: 's', abortController: controller }), event => {
      if (event.type !== 'user_input_request') return;
      permissions.onResolution(JSON.parse(event.data).requestId, value => reasons.push(value.reason));
      if (failure === 'cancel') controller.abort();
      else if (failure === 'disconnect') client.emitter.emit('disconnect', new Error('fake disconnect'));
      else client.publish('turn/completed', { turn: { id: 'turn', status: 'failed' } });
    });
    assert.ok(reasons.length > 0); assert.equal(reasons.includes('turn_completed'), false); assert.equal(reasons.includes('request_closed'), false);
  });
}

test('目录读取失败保留握手连接，下一次仅重试目录', async () => {
  const { client, provider } = setup();
  const request = client.request.bind(client); let failed = false;
  client.request = async (method, params) => {
    if (method === 'model/list' && !failed) { failed = true; throw new Error('temporary catalog error'); }
    return request(method, params);
  };
  const first = await read(provider.streamChat({ prompt: 'hello', sessionId: 's' }));
  assert.match(first.find(e => e.type === 'error')?.data ?? '', /temporary catalog error/);
  assert.equal(client.isRunning(), true);
  const second = await read(provider.streamChat({ prompt: 'hello', sessionId: 's' }));
  assert.equal(second.some(e => e.type === 'error'), false);
  assert.equal(client.calls.filter(c => c.method === 'initialize').length, 1);
});

test('断开时收到迟到服务端请求的回复错误会被捕获', async () => {
  const { client } = setup();
  const errors: unknown[] = [];
  const oldWarn = console.warn;
  console.warn = (...args) => { errors.push(args); };
  try {
    client.respondError = () => { throw new Error('connection already closed'); };
    client.emitter.emit('request', { id: 'late', method: 'future/request', params: {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.length, 1);
  } finally { console.warn = oldWarn; }
});

test('握手、恢复、会话模型、目录effort、权限与图片真实传递', async () => {
  const { client, provider } = setup();
  const events = await read(provider.streamChat({ prompt: 'hi', sessionId: 's', sdkSessionId: 'thread', model: 'catalog-id ultra', permissionMode: 'default', files: [{ id: 'i', name: 'image.png', type: 'image/png', size: 1, data: 'YQ==' }] }));
  assert.deepEqual(client.calls.slice(0, 4).map(c => c.method), ['initialize', 'initialized', 'model/list', 'thread/resume']);
  assert.equal((client.calls[0].params.capabilities as Record<string, unknown>).experimentalApi, true);
  const turn = client.calls.find(c => c.method === 'turn/start')!.params;
  assert.equal(turn.model, 'model-next'); assert.equal(turn.effort, 'ultra');
  assert.equal(turn.approvalPolicy, 'on-request'); assert.deepEqual(turn.sandboxPolicy, { type: 'workspaceWrite' });
  assert.deepEqual((turn.input as unknown[])[1], { type: 'image', url: 'data:image/png;base64,YQ==' });
  assert.equal(JSON.parse(events.find(e => e.type === 'status' && JSON.parse(e.data).model)!.data).model, 'model-next');
});

test('failed终态不会被报告成功，未知模型不会静默替换', async () => {
  const { client, provider } = setup();
  client.onTurn = () => client.publish('turn/completed', { turn: { id: 'turn', status: 'failed', error: { message: 'upstream failed' } } });
  const events = await read(provider.streamChat({ prompt: 'hi', sessionId: 's' }));
  assert.match(events.find(e => e.type === 'error')!.data, /Codex 回合执行失败/);
  assert.equal(JSON.parse(events.find(e => e.type === 'result')!.data).is_error, true);
  const invalid = await read(provider.streamChat({ prompt: 'hi', sessionId: 's', model: 'unavailable' }));
  assert.match(invalid.find(e => e.type === 'error')!.data, /unavailable/);
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('取消等待会发送turn/interrupt', async () => {
  const { client, provider } = setup(); const abortController = new AbortController();
  client.onTurn = () => { setTimeout(() => abortController.abort(), 10); };
  await read(provider.streamChat({ prompt: 'hi', sessionId: 's', abortController }));
  assert.deepEqual(client.calls.find(c => c.method === 'turn/interrupt')?.params, { threadId: 'thread', turnId: 'turn' });
});

test('审批、问答回传真实答案，未知服务端请求明确失败', async () => {
  const { client, provider, permissions } = setup();
  client.onTurn = () => {
    client.emitter.emit('request', { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'cmd', command: 'test' } });
    client.emitter.emit('request', { id: 'q', method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'input', isBlocking: true, questions: [{ id: 'choice', question: 'Choose', header: 'Choice', isOther: true, isSecret: false, options: [{ label: 'A', description: '' }] }] } });
    client.emitter.emit('request', { id: 'unknown', method: 'future/request', params: {} });
  };
  const originalRespond = client.respond.bind(client);
  client.respond = (id, result) => { originalRespond(id, result); if (id === 'q') client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } }); };
  await read(provider.streamChat({ prompt: 'hi', sessionId: 's' }), event => {
    const data = event.type.endsWith('request') ? JSON.parse(event.data) : null;
    if (event.type === 'permission_request') permissions.resolvePendingPermission(data.permissionRequestId, { behavior: 'allow', scope: 'session' });
    if (event.type === 'user_input_request') permissions.resolvePendingPermission(data.requestId, { behavior: 'allow', updatedInput: { answers: { choice: ['Custom'] } } });
  });
  assert.ok(client.replies.some(r => JSON.stringify(r) === JSON.stringify({ id: 7, result: { decision: 'acceptForSession' } })));
  assert.ok(client.replies.some(r => JSON.stringify(r) === JSON.stringify({ id: 'q', result: { answers: { choice: { answers: ['Custom'] } } } })));
  assert.ok(client.replies.some(r => (r as { error?: { code: number } }).error?.code === -32601));
});

test('现代工具收尾、commentary进度与turn用量，不扫描rollout文件', async () => {
  const { client, provider } = setup();
  client.onTurn = () => {
    client.publish('item/started', { item: { id: 'cmd', type: 'commandExecution', command: 'build' } });
    client.publish('item/completed', { item: { id: 'cmd', type: 'commandExecution', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 } });
    client.publish('item/completed', { item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'Working' } });
    client.publish('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 }, total: { inputTokens: 1100, cachedInputTokens: 400, outputTokens: 110 }, modelContextWindow: 200000 } });
    client.publish('item/completed', { item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Done' } });
    client.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  };
  const events = await read(provider.streamChat({ prompt: 'hi', sessionId: 's' }));
  assert.equal(events.find(e => e.type === 'progress')?.data, 'Working');
  assert.equal(events.filter(e => e.type === 'text').map(e => e.data).join(''), 'Done');
  assert.equal(JSON.parse(events.find(e => e.type === 'tool_result')!.data).is_error, false);
  const result = JSON.parse(events.find(e => e.type === 'result')!.data);
  assert.deepEqual(result.usage, { input_tokens: 60, output_tokens: 10, cache_read_input_tokens: 40 });
  assert.equal(result.context_window, 200000);
});
