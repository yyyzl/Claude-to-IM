# 设计模式指南

> **目的**：帮助你在扩展 `bridge` 与 `workflow` 时沿用现有架构骨架，而不是只复用若干函数名。

---

## 这份指南解决什么问题

现有两份指南已经覆盖：

- “跨层怎么想”
- “复用前先搜什么”

但它们没有回答另一个高频问题：

- 这个仓库已经稳定采用了哪些结构模式
- 新能力应该挂到哪个扩展点
- 哪些实现细节看起来像普通代码，实际上是关键架构约束

这份文档只聚焦 **结构模式**。
它不重复讲数据流梳理，也不重复讲 DRY 搜索流程。

下面提到的调用关系，均结合 GitNexus 对 `src/lib/bridge/` 与
`src/lib/workflow/` 的符号追踪整理而成。

---

## 先看模式地图

- `bridge/context.ts`：依赖注入容器
- `bridge/channel-adapter.ts` + `bridge/adapters/`：抽象工厂 + 注册表
- `bridge/adapters/*` + `bridge-manager.ts`：生产者-消费者队列
- `bridge-manager.ts`：HMR 安全单例
- `delivery-layer.ts`：错误分类 + 重试决策
- `security/rate-limiter.ts`：滑动窗口限流
- `delivery-layer.ts`、`bridge-manager.ts`：最佳努力副作用
- `workflow/index.ts`：组合根 / 手工装配
- `workflow/types.ts` + `workflow-engine.ts`：策略模式（Profile）
- `workflow/types.ts` + `workflow-engine.ts`：崩溃可恢复状态机

---

## 1. 依赖注入容器

**What**：宿主能力统一放入 `BridgeContext`，桥接层只能通过上下文取依赖，不能直接依赖宿主实现。

**Where**：`src/lib/bridge/context.ts`

**Why**：把 bridge 做成纯库层，避免适配器、路由、投递层直接耦合到宿主工程。

### Implementation

```ts
// src/lib/bridge/context.ts
export interface BridgeContext {
  store: BridgeStore;
  llm: LLMProvider;
  permissions: PermissionGateway;
  lifecycle: LifecycleHooks;
}

const CONTEXT_KEY = '__bridge_context__';

export function initBridgeContext(ctx: BridgeContext): void {
  (globalThis as Record<string, unknown>)[CONTEXT_KEY] = ctx;
}

export function getBridgeContext(): BridgeContext {
  const ctx = (globalThis as Record<string, unknown>)[CONTEXT_KEY] as BridgeContext | undefined;
  if (!ctx) {
    throw new Error(
      '[bridge] Context not initialized. Call initBridgeContext() before using bridge modules.',
    );
  }
  return ctx;
}
```

GitNexus 追踪到 `getBridgeContext()` 被这些核心模块直接消费：

- `src/lib/bridge/channel-router.ts`
- `src/lib/bridge/conversation-engine.ts`
- `src/lib/bridge/delivery-layer.ts`
- `src/lib/bridge/permission-broker.ts`
- `src/lib/bridge/bridge-manager.ts`

### When to Use

- 新增宿主能力时，优先扩展 `BridgeContext`，不要在 bridge 内部偷偷 `import` 宿主模块。
- 需要在多个 bridge 子模块共享 `store`、`llm`、权限网关、生命周期钩子时，统一走上下文。
- 需要让测试替换宿主实现时，直接注入 mock context。

### Anti-patterns

- 在适配器里直接依赖宿主应用文件路径。
- 在任意模块内懒初始化全局依赖，导致初始化顺序不可控。
- 把 `store`、`llm` 层层手传几十层，而不是回到统一上下文入口。

---

## 2. 抽象工厂 + 注册表

**What**：平台适配器都实现同一抽象基类，通过注册表自注册，再由工厂函数统一实例化。

**Where**：`src/lib/bridge/channel-adapter.ts`、`src/lib/bridge/adapters/index.ts`、`src/lib/bridge/adapters/*.ts`

**Why**：`bridge-manager` 不需要知道每个平台的具体类名，只关心“给我一个该类型的 adapter”。

### Implementation

```ts
// src/lib/bridge/channel-adapter.ts
export abstract class BaseChannelAdapter {
  abstract readonly channelType: ChannelType;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract isRunning(): boolean;
  abstract consumeOne(): Promise<InboundMessage | null>;
  abstract send(message: OutboundMessage): Promise<SendResult>;
  abstract validateConfig(): string | null;
  abstract isAuthorized(userId: string, chatId: string): boolean;
}

const adapterFactories = new Map<string, () => BaseChannelAdapter>();

export function registerAdapterFactory(channelType: string, factory: () => BaseChannelAdapter): void {
  adapterFactories.set(channelType, factory);
}

export function createAdapter(channelType: string): BaseChannelAdapter | null {
  const factory = adapterFactories.get(channelType);
  return factory ? factory() : null;
}
```

```ts
// src/lib/bridge/adapters/index.ts
import './telegram-adapter.js';
import './feishu-adapter.js';
import './discord-adapter.js';
import './qq-adapter.js';
```

```ts
// src/lib/bridge/adapters/qq-adapter.ts
registerAdapterFactory('qq', () => new QQAdapter());
```

GitNexus 追踪到：

- `registerAdapterFactory()` 由 `telegram`、`feishu`、`discord`、`qq` 四个适配器文件调用
- `createAdapter()` 由 `src/lib/bridge/bridge-manager.ts` 的启动流程调用

### When to Use

- 增加新 IM 平台时，新增一个 adapter 文件并自注册。
- 扩充 `BaseChannelAdapter` 协议时，让所有平台按统一契约补齐能力。
- 需要列举当前支持的平台类型时，读取注册表而不是写死数组。

### Anti-patterns

- 在 `bridge-manager.ts` 里写 `switch(channelType)` 手动 new 各种适配器。
- 新增平台时忘记在 `adapters/index.ts` 加 side-effect import，导致注册表为空。
- 平台只实现局部接口，不遵守 `BaseChannelAdapter` 统一契约。

---

## 3. 生产者-消费者异步队列

**What**：每个 adapter 负责把入站消息放入内部队列；`bridge-manager` 负责持续消费并分发处理。

**Where**：`src/lib/bridge/adapters/telegram-adapter.ts`、`src/lib/bridge/adapters/qq-adapter.ts`、`src/lib/bridge/adapters/feishu-adapter.ts`、`src/lib/bridge/adapters/discord-adapter.ts`、`src/lib/bridge/bridge-manager.ts`

**Why**：把“接收消息”与“处理消息”解耦，避免平台事件回调直接承载完整业务流程。

### Implementation

```ts
// src/lib/bridge/adapters/telegram-adapter.ts
consumeOne(): Promise<InboundMessage | null> {
  const queued = this.queue.shift();
  if (queued) return Promise.resolve(queued);
  if (!this.running) return Promise.resolve(null);
  return new Promise<InboundMessage | null>((resolve) => {
    this.waiters.push(resolve);
  });
}

private enqueue(msg: InboundMessage): void {
  const waiter = this.waiters.shift();
  if (waiter) {
    waiter(msg);
  } else {
    this.queue.push(msg);
  }
}
```

```ts
// src/lib/bridge/bridge-manager.ts
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();

  (async () => {
    while (state.running && adapter.isRunning()) {
      const msg = await adapter.consumeOne();
      if (!msg) continue;

      if (msg.callbackData || msg.text.trim().startsWith('/')) {
        await handleMessage(adapter, msg);
      } else {
        enqueueRegularMessage(adapter, msg);
      }
    }
  })();
}
```

GitNexus 与源码搜索都显示，这个队列模式并不是 Telegram 专属，而是四个 adapter 的共同骨架。

### When to Use

- 平台接入层通过轮询、Webhook、WebSocket 持续收到消息时。
- 接收节奏和处理节奏差异很大，必须有缓冲边界时。
- 需要把“平台协议解析”与“会话处理 / 命令处理”拆开时。

### Anti-patterns

- 在平台回调里直接跑完整会话逻辑，导致传输层和业务层绑死。
- 所有平台共用一个全局消息数组，失去隔离和归责能力。
- 在 adapter 的 `enqueue()` 内直接做重试、渲染、会话状态更新。

---

## 4. HMR 安全单例

**What**：运行时状态挂在 `globalThis[GLOBAL_KEY]`，而不是依赖模块级静态变量。

**Where**：`src/lib/bridge/bridge-manager.ts`

**Why**：在热重载或重复加载模块时，保留已存在的 adapter 状态、锁、缓冲区，避免重复启动与状态丢失。

### Implementation

```ts
// src/lib/bridge/bridge-manager.ts
const GLOBAL_KEY = '__bridge_manager__';

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      activeTasksByChat: new Map(),
      activeTaskStartedAt: new Map(),
      sessionLocks: new Map(),
      inputDebounceBuffers: new Map(),
      gitDrafts: new Map(),
      autoStartChecked: false,
      recentToolCalls: new Map(),
    };
  }
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  return g[GLOBAL_KEY];
}
```

这个实现不只是“单例”。
它还显式做了旧状态回填，说明作者预期这个对象会跨版本、跨模块重载长期存活。

### When to Use

- 运行态状态需要被多个函数共享，且不能因模块重载而重置时。
- 有长生命周期 Map / 锁 / AbortController，需要进程级单例时。
- 桥接器处于长期运行模式，开发环境可能频繁热更新时。

### Anti-patterns

- 直接写 `const state = {}` 放在模块顶层，热重载后重复初始化。
- 每次 `start()` 时重建所有锁和缓冲，破坏进行中的会话。
- 把进程级状态混进 request-local 数据里，导致作用域混乱。

---

## 5. 分层错误分类 + 重试决策

**What**：先把发送失败归类，再由独立策略决定是否重试，最后把 fallback 与 backoff 组合起来。

**Where**：`src/lib/bridge/delivery-layer.ts`

**Why**：平台 API 失败原因很多，但“识别失败类型”和“如何处理失败”是两个不同职责。

### Implementation

```ts
// src/lib/bridge/delivery-layer.ts
type ErrorCategory =
  | 'rate_limit'
  | 'server_error'
  | 'client_error'
  | 'parse_error'
  | 'network';

function classifyError(result: SendResult): ErrorCategory {
  const status = (result as { httpStatus?: number }).httpStatus;
  const error = result.error ?? '';

  if (status === 429) return 'rate_limit';
  if (status && status >= 500) return 'server_error';
  if (status && status >= 400 && status < 500) {
    if (/can't parse entities|parse entities|find end of the entity/i.test(error)) {
      return 'parse_error';
    }
    return 'client_error';
  }
  if (/too many requests|rate limit|retry.after/i.test(error)) {
    return 'rate_limit';
  }
  return 'network';
}

function shouldRetry(category: ErrorCategory): boolean {
  switch (category) {
    case 'rate_limit':
    case 'server_error':
    case 'network':
      return true;
    case 'client_error':
    case 'parse_error':
      return false;
  }
}
```

```ts
// src/lib/bridge/delivery-layer.ts
const category = classifyError(result);

if (category === 'parse_error' && message.parseMode === 'HTML') {
  const plainResult = await adapter.send({ ...message, parseMode: 'plain' });
  if (!shouldRetry(classifyError(plainResult))) {
    return plainResult;
  }
}

if (!shouldRetry(category)) {
  return result;
}
```

GitNexus 追踪到 `classifyError()` 与 `shouldRetry()` 都只被
`sendWithRetry()` 消费，职责边界非常清楚。

### When to Use

- 平台 API 有多种失败形态，但处理策略并不相同时。
- 需要兼顾 HTTP 状态码、错误字符串和平台特定字段时。
- 需要在“纯重试”“纯回退”“立即失败”之间做清晰分流时。

### Anti-patterns

- 把所有判断直接塞进发送循环，后续无法扩展。
- 对 `parse_error` 盲目指数重试，而不是降级成纯文本。
- 把“如何判断错误”和“如何重试”耦合成不可复用的大 `if/else`。

---

## 6. 滑动窗口限流器

**What**：按 chat 维护时间戳桶，窗口内超额就等待最老记录过期。

**Where**：`src/lib/bridge/security/rate-limiter.ts`、`src/lib/bridge/delivery-layer.ts`

**Why**：限流目标是“单个 chat 不要打爆平台”，不是“整个进程统一睡眠”。

### Implementation

```ts
// src/lib/bridge/security/rate-limiter.ts
export class ChatRateLimiter {
  private buckets = new Map<string, BucketEntry>();

  async acquire(chatId: string): Promise<void> {
    const now = Date.now();
    const bucket = this.getOrCreate(chatId);
    this.pruneOld(bucket, now);

    if (bucket.timestamps.length < this.maxMessages) {
      bucket.timestamps.push(now);
      return;
    }

    const oldest = bucket.timestamps[0];
    const waitMs = oldest + this.windowMs - now;
    if (waitMs > 0) {
      await new Promise<void>(r => setTimeout(r, waitMs));
    }

    const afterWait = Date.now();
    this.pruneOld(bucket, afterWait);
    bucket.timestamps.push(afterWait);
  }
}
```

```ts
// src/lib/bridge/delivery-layer.ts
const rateLimiter = new ChatRateLimiter();
setInterval(() => { rateLimiter.cleanup(); }, 5 * 60_000).unref();

await rateLimiter.acquire(message.address.chatId);
```

GitNexus 追踪到 `ChatRateLimiter` 当前由 `delivery-layer.ts` 统一消费，
说明限流策略被集中放在投递边界，而不是散落在各 adapter 里。

### When to Use

- 平台有限流要求，而且是按会话 / 聊天窗口生效时。
- 多段分块消息需要串行发送，必须在发送前统一限流时。
- 需要长期运行但又不能让空闲 chat bucket 无限增长时。

### Anti-patterns

- 用全局 `sleep(1000)` 粗暴限速，拖慢所有 chat。
- 只做固定间隔节流，不考虑窗口内累计请求数。
- 忘记 `cleanup()`，让长运行进程累积无用 bucket。

---

## 7. 最佳努力副作用

**What**：对非关键副作用使用 `try/catch { /* best effort */ }`，主流程成功与否不被辅助操作绑架。

**Where**：`src/lib/bridge/delivery-layer.ts`、`src/lib/bridge/bridge-manager.ts`、`src/lib/bridge/adapters/feishu-adapter.ts`

**Why**：审计、去重清理、出站引用、ack 等逻辑很重要，但它们不该阻断真正的消息处理与投递。

### Implementation

```ts
// src/lib/bridge/delivery-layer.ts
if (Math.random() < 0.01) {
  try { store.cleanupExpiredDedup(); } catch { /* best effort */ }
}

try {
  store.insertAuditLog({
    channelType: adapter.channelType,
    chatId: message.address.chatId,
    direction: 'outbound',
    messageId: lastMessageId || '',
    summary: message.text.slice(0, 200),
  });
} catch { /* best effort */ }
```

```ts
// src/lib/bridge/bridge-manager.ts
try { adapter.acknowledgeUpdate!(id); } catch { /* best effort */ }
try { ack(); } catch { /* best effort */ }
```

这个模式在 bridge 里出现很多次，说明它是明确的稳定约定，而不是零散写法。

### When to Use

- 审计日志、统计埋点、过期清理、消息引用等“辅助但不阻断主链路”的操作。
- 平台 ack 失败不应影响已经完成的业务处理时。
- 降级路径允许略过局部元数据更新时。

### Anti-patterns

- 把核心状态写入也包成 best effort，最后连真实失败都被吞掉。
- 没有任何日志或上下文，排查时完全不知道副作用在哪一步失败。
- 用 best effort 掩盖必需的契约错误，让坏数据悄悄流过系统。

---

## 8. 组合根 / 手工装配

**What**：在公共入口处显式 new 出所有依赖，再把它们装配成 `WorkflowEngine`。

**Where**：`src/lib/workflow/index.ts`

**Why**：`WorkflowEngine` 本身不偷偷创建依赖，测试、CLI、bridge 命令都可以复用同一装配方式。

### Implementation

```ts
// src/lib/workflow/index.ts
export function createSpecReviewEngine(basePath?: string): _WorkflowEngine {
  const store = new _WorkflowStore(basePath);
  const compressor = new _ContextCompressor();
  const packBuilder = new _PackBuilder(store, compressor);
  const promptAssembler = new _PromptAssembler(store);
  const modelInvoker = new _ModelInvoker();
  const terminationJudge = new _TerminationJudge();
  const jsonParser = new _JsonParser();
  const issueMatcher = new _IssueMatcher();
  const patchApplier = new _PatchApplier();
  const decisionValidator = new _DecisionValidator();

  return new _WorkflowEngine(
    store, packBuilder, promptAssembler, modelInvoker,
    terminationJudge, jsonParser, issueMatcher, patchApplier,
    decisionValidator,
  );
}
```

GitNexus 追踪到：

- `createSpecReviewEngine()` 被 `src/lib/workflow/cli.ts` 与 `src/lib/bridge/internal/workflow-command.ts` 调用
- `createCodeReviewEngine()` 被 `src/lib/bridge/internal/workflow-command.ts` 调用

这说明 `workflow/index.ts` 是明确的公共组合根，不是“顺手导出几个 helper”。

### When to Use

- 对外暴露库级入口，希望调用方一行拿到完整引擎时。
- 测试中需要替换部分依赖，但仍想保留默认装配骨架时。
- 需要把相同的引擎装配方式复用到 CLI、bridge 命令和其他入口时。

### Anti-patterns

- 在 `WorkflowEngine` 内部偷偷 `new WorkflowStore()` 等依赖，导致构造器语义失真。
- CLI、bridge、测试各自写一份不同装配，后续逐渐漂移。
- 用隐藏单例替代显式注入，让测试和替换依赖越来越困难。

---

## 9. 策略模式（Workflow Profile）

**What**：把不同工作流的差异收敛进 `WorkflowProfile` 数据对象，由引擎按 profile 参数化行为。

**Where**：`src/lib/workflow/types.ts`、`src/lib/workflow/workflow-engine.ts`

**Why**：`spec-review` 与 `code-review` 共用同一引擎骨架，但模板、回合数、补丁策略、终止判定不同。

### Implementation

```ts
// src/lib/workflow/types.ts
export interface WorkflowProfile {
  type: WorkflowType;
  steps: WorkflowStep[];
  configOverrides: Partial<WorkflowConfig>;
  templates: {
    review: string;
    decision: string;
    decisionSystem: string;
  };
  behavior: {
    claudeIncludesPreviousDecisions: boolean;
    applyPatches: boolean;
    trackResolvesIssues: boolean;
    requireFixInstruction: boolean;
    acceptedIsTerminal: boolean;
  };
}
```

```ts
// src/lib/workflow/types.ts
export const SPEC_REVIEW_PROFILE: WorkflowProfile = {
  type: 'spec-review',
  behavior: {
    claudeIncludesPreviousDecisions: true,
    applyPatches: true,
    trackResolvesIssues: true,
    requireFixInstruction: false,
    acceptedIsTerminal: false,
  },
};

export const CODE_REVIEW_PROFILE: WorkflowProfile = {
  type: 'code-review',
  behavior: {
    claudeIncludesPreviousDecisions: false,
    applyPatches: false,
    trackResolvesIssues: false,
    requireFixInstruction: true,
    acceptedIsTerminal: true,
  },
};
```

```ts
// src/lib/workflow/workflow-engine.ts
const profile = params.profile ?? SPEC_REVIEW_PROFILE;
```

```ts
// src/lib/workflow/workflow-engine.ts
function resolveProfileFromType(workflowType: WorkflowType): WorkflowProfile {
  switch (workflowType) {
    case 'code-review':
      return CODE_REVIEW_PROFILE;
    case 'spec-review':
    case 'dev':
    default:
      return SPEC_REVIEW_PROFILE;
  }
}
```

GitNexus 追踪到 `resume()` 会通过 `resolveProfileFromType()` 重新恢复策略，
说明 profile 不是“启动时临时参数”，而是运行期语义的一部分。

### When to Use

- 新增工作流类型，但主循环骨架不想复制一份时。
- 某些步骤仍相同，只是模板、终止规则、补丁行为不同。
- 需要让 CLI、bridge 命令、恢复逻辑都基于同一行为描述时。

### Anti-patterns

- 在 `workflow-engine.ts` 各处分散 `if (workflowType === 'code-review')`。
- 为了一个新模式直接复制整份 `WorkflowEngine`。
- 用一堆无命名布尔参数替代 profile，最后谁控制什么完全说不清。

---

## 10. 崩溃可恢复状态机

**What**：工作流被拆成 5 个细粒度步骤，并把 `current_step`、`last_completed` 持久化到 meta 中，支持中断后精确恢复。

**Where**：`src/lib/workflow/types.ts`、`src/lib/workflow/workflow-engine.ts`、`src/lib/workflow/workflow-store.ts`

**Why**：这是长运行、多回合、会调用外部模型的流程；如果只存最终结果，一旦超时或中止就只能整轮重跑。

### Implementation

```ts
// src/lib/workflow/types.ts
export type WorkflowStep =
  | 'codex_review'
  | 'issue_matching'
  | 'pre_termination'
  | 'claude_decision'
  | 'post_decision';

export interface WorkflowMeta {
  status: WorkflowStatus;
  current_round: number;
  current_step: WorkflowStep;
  last_completed: {
    round: number;
    step: WorkflowStep;
  } | null;
}
```

```ts
// src/lib/workflow/workflow-engine.ts
const meta: WorkflowMeta = {
  run_id: runId,
  workflow_type: profile.type,
  status: 'running',
  current_round: 1,
  current_step: 'codex_review',
  last_completed: null,
  // ...
};
```

```ts
// src/lib/workflow/workflow-engine.ts
private async saveCheckpoint(runId: string, round: number, step: WorkflowStep): Promise<void> {
  await this.store.updateMeta(runId, {
    status: 'paused',
    current_round: round,
    current_step: step,
  });
}

async resume(runId: string, profile?: WorkflowProfile): Promise<void> {
  const meta = await this.store.getMeta(runId);
  const resolvedProfile = profile ?? resolveProfileFromType(meta.workflow_type);
  await this.emit(runId, meta.current_round, 'workflow_resumed', {
    resumed_from_step: meta.current_step,
    resumed_from_round: meta.current_round,
  });
  await this.runLoop(runId, meta, resolvedProfile);
}
```

```ts
// src/lib/workflow/workflow-engine.ts
await this.store.updateMeta(runId, {
  current_round: round,
  current_step: 'codex_review',
  last_completed: { round: round - 1, step: 'post_decision' },
});
```

GitNexus 追踪到 `resume()` 由 `workflow/cli.ts` 和
`bridge/internal/workflow-command.ts` 调用，说明恢复能力既服务 CLI，
也服务 bridge 内的交互式工作流命令。

### When to Use

- 流程很长，任何一步都可能超时、中止、等待人工。
- 单步结果已经持久化，恢复时不应重复调用外部模型。
- 需要对“上一轮做到哪一步了”给出精确、可观测的回答时。

### Anti-patterns

- 只记录最终完成状态，不记录中间 step。
- 恢复时靠目录里有没有文件去猜当前状态，而不是读 meta。
- 在 step 切换前不持久化元数据，导致崩溃后恢复点漂移。

---

## 使用这份指南的正确方式

- 需要扩平台时，先看“抽象工厂 + 注册表”与“生产者-消费者队列”。
- 需要加宿主能力或桥接能力时，先看“依赖注入容器”。
- 需要改投递可靠性时，先看“错误分类 + 重试”“滑动窗口限流”“最佳努力副作用”。
- 需要扩工作流类型时，先看“组合根 / 手工装配”“策略模式”“崩溃可恢复状态机”。

---

## 一句话总结

这个仓库不是“很多独立文件凑在一起”，而是已经形成了明确的扩展骨架：

- `bridge` 侧强调宿主解耦、平台可插拔、长运行稳定性
- `workflow` 侧强调显式装配、数据驱动行为、可恢复执行

如果你的改动违背了这三组骨架，通常说明你没有在正确的扩展点上工作。
