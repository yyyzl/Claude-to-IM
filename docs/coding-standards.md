# Claude-to-IM 编码规范

English version below | 中文版在前

---

## 目录

- [1. 概述](#1-概述)
- [2. 项目技术栈](#2-项目技术栈)
- [3. 目录结构](#3-目录结构)
- [4. 命名规范](#4-命名规范)
- [5. TypeScript 风格](#5-typescript-风格)
- [6. 模块与导入](#6-模块与导入)
- [7. 注释与文档](#7-注释与文档)
- [8. 错误处理](#8-错误处理)
- [9. 异步编程](#9-异步编程)
- [10. 安全规范](#10-安全规范)
- [11. 测试规范](#11-测试规范)
- [12. 设计模式](#12-设计模式)
- [13. Git 工作流](#13-git-工作流)
- [14. 性能与资源管理](#14-性能与资源管理)

---

## 1. 概述

本文档是 **Claude-to-IM** 项目的编码规范，基于现有代码库的实际模式提炼而成。所有贡献者必须遵循这些规范以保持代码库的一致性和可维护性。

**核心原则**：
- **类型安全优先**：`strict: true`，零容忍 `any` 泄漏到公共 API
- **接口驱动设计**：通过依赖注入解耦模块，宿主接口 → BridgeContext
- **防御式编程**：所有外部输入必须验证，best-effort 策略用于非关键路径
- **可恢复性**：crash-safe resume、偏移量持久化、幂等操作

---

## 2. 项目技术栈

| 项 | 值 |
|---|---|
| 语言 | TypeScript 5.x, `strict: true` |
| 目标 | ES2022 |
| 模块系统 | ESNext (ESM), `"type": "module"` |
| 运行时 | Node.js >= 20 |
| 构建 | `tsc` (无 bundler) |
| 测试 | Node.js 内建 test runner (`node:test` + `node:assert/strict`) |
| 包管理 | npm (lockfile v3) |

---

## 3. 目录结构

```
src/
├── lib/
│   ├── bridge/              # 核心桥接系统
│   │   ├── adapters/        # 平台适配器 (Telegram, Discord, Feishu, QQ)
│   │   ├── internal/        # 内部实现 (不公开导出)
│   │   ├── markdown/        # Markdown → 平台格式渲染
│   │   ├── security/        # 安全: 速率限制、输入验证
│   │   ├── context.ts       # 依赖注入容器
│   │   ├── host.ts          # 宿主接口定义
│   │   ├── types.ts         # 公共类型定义
│   │   ├── channel-adapter.ts   # 适配器基类 + 注册表
│   │   ├── bridge-manager.ts    # 单例编排器
│   │   ├── channel-router.ts    # 会话路由
│   │   ├── conversation-engine.ts  # 对话引擎
│   │   ├── delivery-layer.ts   # 消息投递 (分块、重试、去重)
│   │   └── permission-broker.ts # 权限代理
│   └── workflow/            # 双模型协作工作流引擎
│       ├── types.ts         # 工作流类型定义
│       ├── index.ts         # 公共 API 入口 + 工厂函数
│       └── ...              # 各功能模块
├── __tests__/
│   └── unit/                # 单元测试
└── (no other top-level source files)
```

### 规则

- `lib/` 下按功能域组织，每个域一个目录
- `internal/` 目录存放不对外暴露的实现细节
- `adapters/` 中每个平台一个文件，通过 `index.ts` 统一注册
- 公共 API 通过 `index.ts` 统一导出
- 测试文件位于 `src/__tests__/unit/`，不与源码混放

---

## 4. 命名规范

### 4.1 文件命名

| 分类 | 规则 | 示例 |
|------|------|------|
| 源文件 | `kebab-case.ts` | `delivery-layer.ts`, `channel-adapter.ts` |
| 测试文件 | `{domain}-{module}.test.ts` | `bridge-delivery-layer.test.ts` |
| 类型定义 | `types.ts` | 每个功能域一个 `types.ts` |
| 入口文件 | `index.ts` | 公共 API 重导出 |

### 4.2 标识符命名

| 分类 | 规则 | 示例 |
|------|------|------|
| 类 | `PascalCase` | `ChatRateLimiter`, `TelegramAdapter` |
| 接口 | `PascalCase`（**无 `I` 前缀**） | `BridgeContext`, `SendResult` |
| 类型别名 | `PascalCase` | `ErrorCategory`, `ChannelType` |
| 函数 | `camelCase` | `chunkText`, `backoffDelay` |
| 导出常量 | `UPPER_SNAKE_CASE` | `MAX_RETRIES`, `PLATFORM_LIMITS` |
| 局部常量 | `camelCase` | `const rateLimiter = ...` |
| 私有成员 | `camelCase`（使用 `private` 关键字） | `private running = false` |
| 未使用参数 | `_` 前缀 | `_chatId`, `_draftId` |
| 布尔变量 | `is/has/can/should` 前缀 | `isRunning`, `hasError` |
| 事件回调 | `on` 前缀 | `onPermissionRequest`, `onStreamEnd` |

### 4.3 特殊约定

```typescript
// ✅ Union type 替代 enum
export type Severity = 'critical' | 'high' | 'medium' | 'low';

// ❌ 禁止使用 TypeScript enum
export enum Severity { Critical, High, Medium, Low }
```

---

## 5. TypeScript 风格

### 5.1 严格模式

`tsconfig.json` 中 `"strict": true`，不得降级。核心规则：
- `noImplicitAny`: 所有参数和变量必须有显式类型或可推断类型
- `strictNullChecks`: 必须处理 `null` / `undefined`
- `forceConsistentCasingInFileNames`: 文件名大小写敏感

### 5.2 类型 vs 接口

```typescript
// ✅ 对象形状 → 用 interface
export interface ChannelAddress {
  channelType: ChannelType;
  chatId: string;
  userId?: string;
}

// ✅ 联合类型 / 字面量类型 → 用 type
export type ErrorCategory = 'rate_limit' | 'server_error' | 'client_error';

// ✅ 函数签名类型 → 用 type
export type OnPartialText = (fullText: string) => void;
```

### 5.3 Type-Only Imports

```typescript
// ✅ 类型导入使用 `import type`
import type { ChannelAddress, OutboundMessage, SendResult } from './types.js';

// ✅ 混合导入时分开写
import { getBridgeContext } from './context.js';
import type { BridgeContext } from './context.js';
```

### 5.4 可选属性与泛型

```typescript
// ✅ 可选参数用 `?` 标记
export interface StreamChatParams {
  prompt: string;
  sessionId: string;
  sdkSessionId?: string;  // 可选
  model?: string;
}

// ✅ 函数可选参数放最后
export async function deliver(
  adapter: BaseChannelAdapter,
  message: OutboundMessage,
  opts?: { sessionId?: string; dedupKey?: string },
): Promise<SendResult> { ... }
```

### 5.5 禁止项

```typescript
// ❌ 禁止 `any` 出现在公共 API（private 实现中仅在必须时使用，需注释理由）
export function process(data: any): any  // 禁止

// ❌ 禁止 non-null assertion (!) 除非有充分理由并注释
this.data!.value  // 禁止

// ❌ 禁止 `as` 类型断言，除非处理外部不可控类型
const x = value as string;  // 仅在解析外部 JSON 等场景可用

// ❌ 禁止 TypeScript enum
export enum Status { ... }  // 使用 union type 替代
```

---

## 6. 模块与导入

### 6.1 导入后缀

ESM 模式下，导入路径必须包含 `.js` 后缀：

```typescript
// ✅ 正确
import { getBridgeContext } from './context.js';
import type { ChannelAddress } from './types.js';

// ❌ 错误
import { getBridgeContext } from './context';
```

### 6.2 导入排序

按以下分组排序，组间空行分隔：

```typescript
// 1. Node.js 内建模块
import crypto from 'crypto';
import { execFile } from 'node:child_process';

// 2. 第三方模块
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import MarkdownIt from 'markdown-it';

// 3. 项目内部模块（类型导入在前）
import type { ChannelAddress, OutboundMessage, SendResult } from './types.js';
import { getBridgeContext } from './context.js';
import { ChatRateLimiter } from './security/rate-limiter.js';
```

### 6.3 导出规范

```typescript
// ✅ 公共 API：通过 index.ts 统一 re-export
export * from './types.js';
export { WorkflowEngine } from './workflow-engine.js';

// ✅ 函数和类使用命名导出
export function deliver(...) { ... }
export class ChatRateLimiter { ... }

// ❌ 禁止 default export
export default class MyClass { ... }  // 禁止
```

### 6.4 自注册模式

适配器使用自注册模式，避免修改核心代码：

```typescript
// adapter 文件末尾
registerAdapterFactory('telegram', () => new TelegramAdapter());

// adapters/index.ts 只需 side-effect import
import './telegram-adapter.js';
import './discord-adapter.js';
```

---

## 7. 注释与文档

### 7.1 文件头注释

每个源文件必须以模块级 JSDoc 注释开头：

```typescript
/**
 * Delivery Layer — reliable outbound message delivery with chunking,
 * dedup, retry, error classification, and reference tracking.
 */
```

### 7.2 区域分隔注释

使用一致的分隔线格式组织代码区域：

```typescript
// ── Channel Types ──────────────────────────────────────────────
// ── Error classification ──────────────────────────────────────
// ── Public API ────────────────────────────────────────────────
// ── Private ──────────────────────────────────────────────────
```

**格式**：`// ── {区域名称} ──` + 填充 `─` 至约 65 字符。

### 7.3 公共 API 文档

所有公共函数、类、接口必须有 JSDoc 注释：

```typescript
/**
 * Send a message through an adapter with chunking, dedup, retry, and auditing.
 */
export async function deliver(
  adapter: BaseChannelAdapter,
  message: OutboundMessage,
  opts?: { sessionId?: string; dedupKey?: string },
): Promise<SendResult> { ... }
```

接口属性使用行内或单行 JSDoc：

```typescript
export interface Issue {
  /** Unique issue identifier (e.g. `"ISS-001"`). */
  id: string;
  /** The round in which this issue was first raised. */
  round: number;
  /** Who raised this issue. */
  raised_by: RaisedBy;
}
```

### 7.4 语言约定

- **公共 API 注释**：英文（因为是 npm 包，面向国际社区）
- **业务逻辑解释**：中文允许，特别是涉及复杂业务决策时
- **代码标识符**：始终使用英文

```typescript
// ✅ 中文业务注释
// 关键：新会话必须清空 sdkSessionId，避免 SDK 恢复到旧上下文。

// ✅ 英文公共 API 注释
/** Start the adapter (connect, begin polling/websocket, etc.). */
abstract start(): Promise<void>;
```

---

## 8. 错误处理

### 8.1 自定义错误类

当错误需要被调用方区分处理时，创建自定义错误类：

```typescript
export class SessionQueueTimeoutError extends Error {
  timeoutMs: number;

  constructor(sessionId: string, timeoutMs: number) {
    super(`Session ${sessionId} is busy, queue timeout`);
    this.name = 'SessionQueueTimeoutError';  // 必须设置 name
    this.timeoutMs = timeoutMs;
  }
}
```

**必要条件**：
- 继承 `Error`
- 设置 `this.name` 为类名（确保 `instanceof` 和序列化正确）
- 附加结构化数据字段（如 `timeoutMs`, `statusCode`）

### 8.2 Best-Effort 模式

非关键路径（审计日志、去重清理等）使用 best-effort 模式：

```typescript
// ✅ 正确：catch 空块 + 注释
try {
  store.insertAuditLog({ ... });
} catch { /* best effort */ }

// ✅ 正确：概率触发清理
if (Math.random() < 0.01) {
  try { store.cleanupExpiredDedup(); } catch { /* best effort */ }
}
```

### 8.3 错误分类

```typescript
// ✅ 定义错误分类枚举
type ErrorCategory = 'rate_limit' | 'server_error' | 'client_error' | 'parse_error' | 'network';

// ✅ 分类函数
function classifyError(result: SendResult): ErrorCategory { ... }

// ✅ 基于分类决定重试策略
function shouldRetry(category: ErrorCategory): boolean { ... }
```

### 8.4 重试策略

```typescript
// ✅ 指数退避 + 抖动
function backoffDelay(attempt: number): number {
  const base = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * JITTER_MAX_MS;
  return base + jitter;
}
```

重试规则：
- `MAX_RETRIES` 上限（通常 2-3 次）
- 仅重试可恢复错误（rate_limit, server_error, network）
- 客户端错误（4xx 非 429）不重试
- 尊重 `Retry-After` 头

---

## 9. 异步编程

### 9.1 async/await

优先使用 `async/await`，避免直接操作 Promise 链：

```typescript
// ✅ 正确
async function send(message: OutboundMessage): Promise<SendResult> {
  const result = await adapter.send(message);
  return result;
}

// ❌ 避免
function send(message: OutboundMessage): Promise<SendResult> {
  return adapter.send(message).then(result => result);
}
```

### 9.2 AbortController / AbortSignal

长时间运行的操作必须支持取消：

```typescript
// ✅ 创建 abort controller
const abortController = new AbortController();

// ✅ 传递 signal
const stream = llm.streamChat({
  prompt: text,
  abortController,
});

// ✅ 超时取消
const timeoutTimer = setTimeout(() => {
  abortController.abort(new BridgeTurnTimeoutError(timeoutMs));
}, timeoutMs);
```

### 9.3 异步队列 (Producer-Consumer)

适配器使用异步队列模式处理消息：

```typescript
// ✅ 消费者阻塞等待，生产者推送
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
  if (waiter) { waiter(msg); } else { this.queue.push(msg); }
}
```

### 9.4 定时器管理

```typescript
// ✅ 使用 .unref() 防止定时器阻止进程退出
setInterval(() => { rateLimiter.cleanup(); }, 5 * 60_000).unref();

// ✅ 清理所有定时器（在 stop 方法中）
async stop(): Promise<void> {
  for (const [, interval] of this.typingIntervals) {
    clearInterval(interval);
  }
  this.typingIntervals.clear();
}
```

---

## 10. 安全规范

### 10.1 输入验证

所有外部输入（IM 消息、用户命令参数）必须经过验证：

```typescript
// ✅ 验证路径：防止路径穿越
export function validateWorkingDirectory(rawPath: string): string | null { ... }

// ✅ 验证 ID 格式
export function validateSessionId(id: string): boolean { ... }

// ✅ 检测危险输入
export function isDangerousInput(input: string): { dangerous: boolean; reason?: string } { ... }

// ✅ 净化输入：去除控制字符、截断长度
export function sanitizeInput(text: string, maxLength?: number): { text: string; truncated: boolean } { ... }
```

### 10.2 授权检查

每个适配器必须实现 `isAuthorized(userId, chatId)` 方法：

```typescript
// ✅ 默认拒绝策略
isAuthorized(userId: string, chatId: string): boolean {
  const allowed = ...;
  if (allowed.length > 0) {
    return allowed.includes(userId) || allowed.includes(chatId);
  }
  return false;  // 无配置 → 拒绝
}
```

### 10.3 速率限制

出站消息必须经过速率限制器：

```typescript
// ✅ 滑动窗口限速
await rateLimiter.acquire(message.address.chatId);
```

### 10.4 敏感数据

- Token/密钥通过 `store.getSetting()` 读取，不硬编码
- `.env` 文件已在 `.gitignore` 中排除
- 日志中截断敏感信息（`summary: text.slice(0, 200)`）

---

## 11. 测试规范

### 11.1 测试框架

使用 Node.js 内建 test runner：

```typescript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
```

### 11.2 文件命名

```
src/__tests__/unit/{domain}-{module}.test.ts
```

| 域 | 前缀 | 示例 |
|---|---|---|
| Bridge | `bridge-` | `bridge-delivery-layer.test.ts` |
| Workflow | `workflow-` | `workflow-engine.test.ts` |

### 11.3 Mock 工厂

使用工厂函数创建 mock 对象，实现所有接口方法：

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

function createMockStore(): BridgeStore { ... }
```

**要求**：
- Mock 必须实现接口的全部方法（可空实现）
- 可观测字段（如 `auditLogs[]`）用于断言
- 使用 `beforeEach` 重置上下文

### 11.4 测试运行

```bash
# 类型检查 + 单元测试
npm test

# 仅单元测试
npm run test:unit

# 仅类型检查
npm run typecheck
```

---

## 12. 设计模式

### 12.1 依赖注入 (DI Container)

全局 context 通过 `globalThis` 存储，避免 Next.js HMR 问题：

```typescript
// 初始化
initBridgeContext({ store, llm, permissions, lifecycle });

// 使用
const { store } = getBridgeContext();
```

**规则**：bridge 模块内部不得直接依赖宿主实现，一律通过 `getBridgeContext()` 获取。

### 12.2 适配器模式 (Adapter + Registry)

```typescript
// 基类定义通用接口
export abstract class BaseChannelAdapter {
  abstract readonly channelType: ChannelType;
  abstract start(): Promise<void>;
  abstract send(message: OutboundMessage): Promise<SendResult>;
  // ... 可选钩子方法
}

// 注册表
const adapterFactories = new Map<string, () => BaseChannelAdapter>();
export function registerAdapterFactory(channelType: string, factory: () => BaseChannelAdapter): void;
export function createAdapter(channelType: string): BaseChannelAdapter | null;

// 自注册
registerAdapterFactory('telegram', () => new TelegramAdapter());
```

**添加新适配器步骤**：
1. 创建 `adapters/{platform}-adapter.ts`，继承 `BaseChannelAdapter`
2. 文件末尾调用 `registerAdapterFactory()`
3. 在 `adapters/index.ts` 添加 `import './{platform}-adapter.js';`

### 12.3 工厂函数

复杂对象的创建使用工厂函数封装依赖装配：

```typescript
export function createSpecReviewEngine(basePath?: string): WorkflowEngine {
  const store = new WorkflowStore(basePath);
  const compressor = new ContextCompressor();
  const packBuilder = new PackBuilder(store, compressor);
  // ... 组装所有依赖
  return new WorkflowEngine(store, packBuilder, ...);
}
```

### 12.4 单例 (globalThis Guard)

长生命周期管理器使用 globalThis 实现 HMR-safe 单例：

```typescript
const GLOBAL_KEY = '__bridge_manager__';
// 通过 globalThis[GLOBAL_KEY] 存储实例
```

### 12.5 Profile 模式 (Strategy)

使用 Profile 对象参数化行为差异，避免条件分支：

```typescript
export interface WorkflowProfile {
  type: WorkflowType;
  steps: WorkflowStep[];
  configOverrides: Partial<WorkflowConfig>;
  behavior: {
    claudeIncludesPreviousDecisions: boolean;
    applyPatches: boolean;
    // ...
  };
}

export const SPEC_REVIEW_PROFILE: WorkflowProfile = { ... };
export const CODE_REVIEW_PROFILE: WorkflowProfile = { ... };
```

---

## 13. Git 工作流

### 13.1 提交消息

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <description>

[optional body]
```

常用 type：
- `feat`: 新功能
- `fix`: 错误修复
- `refactor`: 重构（不改变行为）
- `docs`: 文档变更
- `test`: 测试变更
- `chore`: 构建/工具变更

### 13.2 分支策略

- `main`: 稳定分支
- `feat/*`: 功能分支
- `fix/*`: 修复分支

---

## 14. 性能与资源管理

### 14.1 常量提取

所有魔术数字提取为命名常量：

```typescript
// ✅ 正确
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const INTER_CHUNK_DELAY_MS = 300;
const DEDUP_SET_MAX = 1000;

// ❌ 错误
if (attempt < 3) { ... }
await new Promise(r => setTimeout(r, 300));
```

### 14.2 资源清理

- 定时器必须在 `stop()` 中清理
- Map/Set 必须有定期清理机制防止内存泄漏
- 使用 `.unref()` 防止 Node.js 进程无法退出

```typescript
// ✅ 清理模式
cleanup(): void {
  const now = Date.now();
  const expiry = this.windowMs * 2;
  for (const [chatId, bucket] of this.buckets) {
    const latest = bucket.timestamps[bucket.timestamps.length - 1];
    if (!latest || now - latest > expiry) {
      this.buckets.delete(chatId);
    }
  }
}
```

### 14.3 数值分隔符

大数字使用下划线分隔增强可读性：

```typescript
// ✅ 正确
const DEFAULT_WINDOW_MS = 60_000;
const timeout = 5_400_000;

// ❌ 错误
const DEFAULT_WINDOW_MS = 60000;
```

### 14.4 平台限制

每个平台的消息长度限制集中管理：

```typescript
export const PLATFORM_LIMITS: Record<string, number> = {
  telegram: 4096,
  discord: 2000,
  slack: 40000,
  feishu: 30000,
  qq: 2000,
};
```

---

## 附录 A: 快速检查清单

在提交 PR 前，确认以下项目：

- [ ] `npm run typecheck` 通过（零错误）
- [ ] `npm run test:unit` 通过
- [ ] 所有新增公共 API 有 JSDoc 注释
- [ ] 所有新文件有模块级注释
- [ ] 导入路径使用 `.js` 后缀
- [ ] 无 `any` 类型泄漏到公共 API
- [ ] 外部输入经过验证/净化
- [ ] 定时器在 stop/cleanup 中清理
- [ ] 非关键操作使用 best-effort catch
- [ ] 新适配器已在 `adapters/index.ts` 注册

## 附录 B: 常用代码片段

### B.1 新建适配器骨架

```typescript
/**
 * {Platform} Adapter — implements BaseChannelAdapter for {Platform}.
 */

import type { ChannelType, InboundMessage, OutboundMessage, SendResult } from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';

export class PlatformAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'platform';

  private running = false;

  async start(): Promise<void> {
    if (this.running) return;
    const configError = this.validateConfig();
    if (configError) {
      console.warn('[platform-adapter] Cannot start:', configError);
      return;
    }
    this.running = true;
    // Start polling/websocket...
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    // Cleanup resources...
  }

  isRunning(): boolean { return this.running; }

  async consumeOne(): Promise<InboundMessage | null> { ... }

  async send(message: OutboundMessage): Promise<SendResult> { ... }

  validateConfig(): string | null { ... }

  isAuthorized(userId: string, chatId: string): boolean { ... }
}

registerAdapterFactory('platform', () => new PlatformAdapter());
```

### B.2 安全的外部 JSON 解析

```typescript
let event: SSEEvent;
try {
  event = JSON.parse(line.slice(6));
} catch {
  continue;  // 跳过格式错误的行
}
```
