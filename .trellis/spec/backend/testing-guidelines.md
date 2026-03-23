# 后端测试规范

> 当前仓库以单元测试为主，重点验证桥接行为、契约边界和并发/命令语义，而不是依赖真实外部平台。

---

## 当前测试栈

- 测试框架：`node:test`
- 断言库：`node:assert/strict`
- 运行命令：`npm run test:unit`
- 全量校验：`npm test`

---

## 测试文件命名

- 使用 `src/__tests__/unit/bridge-*.test.ts`
- 文件名应指向被测模块或行为

例如：

- `bridge-manager.test.ts`
- `bridge-conversation-engine.test.ts`
- `bridge-channel-router.test.ts`

---

## 推荐测试模式

- 使用最小 mock `BridgeStore`、LLM、权限网关
- `beforeEach` 清理 `globalThis` 上的桥接状态
- 每个测试聚焦一个行为断言
- 优先验证外部可观察行为，而不是内部实现细节

对于单例或全局状态相关模块，必须显式清理：

- `__bridge_manager__`
- `__bridge_context__`

---

## 应该优先覆盖的行为

- 同一会话串行、不同会话并行
- 命令解析与命令分支
- 配置项解析与默认值行为
- 消息路由与绑定
- 校验失败时的错误分支

---

## 反模式

- 直接依赖真实平台网络请求
- 为了测试方便复制生产逻辑
- 只测 happy path，不测失败分支
- 忘记清理全局状态，导致测试互相污染

---

## 真实示例

- `src/__tests__/unit/bridge-manager.test.ts`：并发与生命周期行为测试
- `src/__tests__/unit/bridge-conversation-engine.test.ts`：会话引擎相关行为测试
- `src/__tests__/unit/bridge-usage-command.test.ts`：命令与报表行为测试

---

## 本仓库的验证命令

优先顺序：

1. `npm run typecheck`
2. `npm run test:unit`
3. `npm test`

说明：

- 如果 `npm test` 在 `HEAD` 就已失败，需要先明确这是既有问题还是本次引入的问题
- 文档类改动通常不需要重新跑所有测试，但应至少说明是否存在既有基线失败

---

## Mock 工厂模式补充

当前仓库的单元测试不是“把真实对象搬进测试”，而是用最小工厂构造一个可观测、可覆盖失败分支的测试边界。

推荐模式：

- 为适配器、Store、权限网关等依赖分别提供 `createMockXxx()` 工厂
- 工厂返回“完整接口 + 少量可观测字段”，而不是只返回当前测试正好用到的两三个方法
- 用可注入函数覆盖关键行为，例如 `sendFn`
- 测试断言优先落在 `auditLogs`、`outboundRefs`、`dedupKeys` 这类外部可观察结果上

反模式：

- 在每个测试里现写一份匿名 mock，对象结构反复复制
- mock 只实现 happy path，用例一多就开始互相补洞
- 为了断言方便直接读被测模块内部状态，而不是观察输出行为

真实示例：

```typescript
function createMockAdapter(opts?: {
  sendFn?: (msg: OutboundMessage) => Promise<SendResult>;
}): BaseChannelAdapter {
  const sendFn = opts?.sendFn ?? (async () => ({ ok: true, messageId: 'msg-1' }));
  return {
    channelType: 'telegram',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: sendFn,
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;
}
```

```typescript
function createMockStore() {
  const auditLogs: Array<{ chatId: string; direction: string; summary: string }> = [];
  const outboundRefs: Array<{ platformMessageId: string; purpose: string }> = [];
  const dedupKeys = new Set<string>();

  return {
    auditLogs,
    outboundRefs,
    dedupKeys,
    getSetting: () => null,
    getChannelBinding: () => null,
    insertAuditLog: (entry: any) => { auditLogs.push(entry); },
    checkDedup: (key: string) => dedupKeys.has(key),
    insertDedup: (key: string) => { dedupKeys.add(key); },
    insertOutboundRef: (ref: any) => { outboundRefs.push(ref); },
  };
}
```

来源：

- `src/__tests__/unit/bridge-delivery-layer.test.ts`

## `beforeEach` 上下文初始化补充

桥接测试依赖 `globalThis` 上的单例和上下文。只要测试目标碰到 `context.ts` 或 `bridge-manager.ts`，每个用例前都必须显式清理并重建上下文。

推荐模式：

- `beforeEach` 中重建 mock store 和 mock context
- 初始化前先删除 `globalThis['__bridge_context__']`
- 测 `bridge-manager` 或单例模块时，再额外清理 `globalThis['__bridge_manager__']`
- 把上下文初始化抽成 `setupContext()`，避免每个用例复制一段 DI 装配

反模式：

- 依赖上一个用例留下的全局状态
- 在单个 `it` 里偷偷初始化上下文，导致其他用例读到脏数据
- `beforeEach` 只清理不重建，导致被测模块拿到空上下文

真实示例：

```typescript
function setupContext(store: MockStore) {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

beforeEach(() => {
  store = createMockStore();
  setupContext(store as MockStore);
});
```

额外示例：

- `src/__tests__/unit/bridge-manager.test.ts` 在 `beforeEach` 中同时清理 `__bridge_manager__` 与 `__bridge_context__`

## 可观测字段断言补充

测试要验证桥接行为时，不要去探测内部私有状态，优先把 mock 设计成“可观测记录器”。

推荐模式：

- 把 `auditLogs`、`outboundRefs`、`dedupKeys` 直接暴露在 mock 返回值上
- 通过数组长度、字段值和集合变化断言行为是否发生
- 一个可观测字段对应一类外部效果，避免一个数组混记所有事件

反模式：

- 断言私有成员、局部变量或函数调用次数，导致测试与实现过耦合
- 把所有副作用混成一份字符串日志，再靠模糊匹配断言

真实示例：

```typescript
assert.equal(store.auditLogs.length, 1);
assert.equal(store.auditLogs[0].direction, 'outbound');
assert.equal(store.outboundRefs[0].platformMessageId, 'msg-1');
assert.equal(store.outboundRefs[0].purpose, 'response');
```

```typescript
store.dedupKeys.add('dedup-1');
const result = await deliver(adapter, message, { dedupKey: 'dedup-1' });
assert.ok(result.ok);
assert.equal(store.auditLogs.length, 0);
```

来源：

- `src/__tests__/unit/bridge-delivery-layer.test.ts`
