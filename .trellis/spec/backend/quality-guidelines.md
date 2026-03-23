# 后端质量规范

> 当前仓库的质量重点不是花哨架构，而是边界清晰、契约稳定、复用到位、文档和实现一致。

---

## 代码风格基线

- 使用 ESM 导入
- 保持导入路径中的 `.js` 后缀一致
- 注释只解释非显然约束，例如并发、锁、平台差异、兼容分支
- 名称优先表达职责，不追求缩写

---

## 当前仓库的稳定工程约束

- 不直接依赖宿主应用，统一通过 `getBridgeContext()` 获取依赖
- 不把同一条配置解析逻辑复制到多个模块
- 不把平台适配逻辑、投递策略、命令解析全部糊到一个文件
- 先搜索已有 helper，再决定是否新增 helper

---

## 修改前必须先搜索的内容

这些内容改动前必须全文搜索：

- 配置 key：搜索 `getSetting(`
- slash 命令：搜索 `case '/`、`/help` 与对应测试
- 平台限制：搜索 `PLATFORM_LIMITS`
- 宿主契约：搜索 `BridgeStore`、`LLMProvider`、`PermissionGateway`

---

## 推荐模式

- 改动先收敛到当前目标，不顺手扩散修改面
- 优先在现有模块里做局部补强，而不是扩散新层次
- 当一个大文件继续膨胀时，优先抽出职责明确的小模块
- 功能调整后及时删除无用兼容代码、过时代码和临时兜底逻辑
- 补文档时引用真实文件，不写空泛“最佳实践”
- 修改完成后做全文搜索，确认没有残留旧 key、旧路径或模板措辞

---

## 反模式

- 为了省事用 `any`、硬编码字符串或复制粘贴逻辑
- 在 `scripts/` 里实现桥接核心行为，而不是回到 `src/lib/bridge/`
- 修改一个点，却顺手把不相关模块一起改乱
- 新逻辑上线后继续保留已经无用的兼容分支或临时代码
- 只改 README，不改规范或测试
- 只改规范，不检查现有流程文档是否仍然冲突

---

## 真实示例

- `src/lib/bridge/bridge-manager.ts`：大文件中依然通过子模块拆分职责
- `src/lib/bridge/CONTRIBUTING.md`：明确了 `node:test`、宿主隔离与代码风格要求
- `README.zh-CN.md`：对项目结构和模块职责有稳定描述

---

## 本任务类型的收尾检查

如果这次是规范或流程文档改动，完成前至少做：

- [ ] 搜索并清理模板占位文案残留
- [ ] 搜索规范路径是否与 `workflow.md`、`start` 技能一致
- [ ] 明确说明是否存在既有基线失败
- [ ] 不执行 `git commit`，由人类在验证后提交

---

## 命名约定补充

这些规则解决“知道文件该放哪里，但不知道具体该怎么命名”的问题。命名应直接表达职责和边界语义，而不是表达实现细节。

推荐模式：

- 源文件统一使用 `kebab-case.ts`，例如 `delivery-layer.ts`、`channel-adapter.ts`、`rate-limiter.ts`
- 类、接口、类型别名使用 `PascalCase`，例如 `ChatRateLimiter`、`BridgeStore`、`SSEEventType`
- 函数、方法、局部变量使用 `camelCase`，例如 `deliver`、`classifyError`、`validateWorkingDirectory`
- 导出常量使用 `UPPER_SNAKE_CASE`，例如 `MAX_RETRIES`、`BASE_DELAY_MS`、`DEFAULT_WINDOW_MS`
- 未使用参数统一加 `_` 前缀，避免误导调用者，例如 `_chatId`、`_draftId`
- 布尔状态和能力判断使用 `is` / `has` / `can` / `should` 前缀，事件钩子使用 `on` 前缀
- 不给接口加 `I` 前缀；可判别状态、字面量集合优先使用 union type，而不是 `enum`

反模式：

- 文件名写成 `DeliveryLayer.ts`、`RateLimiter.ts` 或 `utils.ts`
- 接口写成 `IBridgeStore`
- 布尔字段命名成 `runningFlag`、`authOk`
- 用 `enum` 表达一组固定字符串，而不是直接使用字面量联合

真实示例：

```typescript
export class ChatRateLimiter {
  async acquire(chatId: string): Promise<void> { ... }
}

export interface ChannelAddress {
  channelType: ChannelType;
  chatId: string;
  userId?: string;
}

export type SSEEventType =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'done';

onStreamEnd?(
  _chatId: string,
  _status: 'completed' | 'interrupted' | 'error',
  _responseText: string,
): Promise<boolean>;
```

来源：

- `src/lib/bridge/security/rate-limiter.ts`
- `src/lib/bridge/types.ts`
- `src/lib/bridge/host.ts`
- `src/lib/bridge/channel-adapter.ts`

## 导入与导出规则补充

当前仓库是 ESM 项目，导入写法不是风格问题，而是运行时契约的一部分。

推荐模式：

- 所有相对导入路径都带 `.js` 后缀
- 导入顺序保持为：Node.js 内建模块 → 第三方模块 → 项目内部模块
- 仅用于类型的导入必须写成 `import type`
- 同时需要类型和值时，拆成两条导入，不混用
- 默认使用命名导出；只有适配器目录这种“注册目录”才允许 side-effect import

反模式：

- `import { getBridgeContext } from './context'`
- 把 `import type` 和值导入混成一行
- 默认导出 `export default class ...`
- 在普通业务模块里使用 side-effect import

真实示例：

```typescript
import type {
  ChannelAddress,
  OutboundMessage,
  SendResult,
} from './types.js';
import type { TelegramChunk } from './markdown/telegram.js';
import { PLATFORM_LIMITS as limits } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import { getBridgeContext } from './context.js';
import { ChatRateLimiter } from './security/rate-limiter.js';
```

```typescript
import './telegram-adapter.js';
import './feishu-adapter.js';
import './discord-adapter.js';
import './qq-adapter.js';
```

```typescript
export abstract class BaseChannelAdapter { ... }
export function registerAdapterFactory(...) { ... }
export function createAdapter(...) { ... }
```

来源：

- `src/lib/bridge/delivery-layer.ts`
- `src/lib/bridge/adapters/index.ts`
- `src/lib/bridge/channel-adapter.ts`

## 注释与文档风格补充

文档注释的目标不是“翻译代码”，而是把边界、约束、并发和平台差异写出来。

推荐模式：

- 每个源文件以模块级 JSDoc 开头，说明职责和边界
- 文件较长时用 `// ── 区域名 ─────────` 分区，而不是靠空行堆结构
- 公共 API、接口和关键类型保持 JSDoc
- 面向外部调用者的 API 注释优先英文；复杂业务约束、平台差异和非显然原因允许中文补充
- 中文注释只解释规则、风险和设计意图，不描述显而易见的赋值行为

反模式：

- 文件没有头注释，只靠文件名猜职责
- 区域全靠“很多空行”分隔
- 公共接口没有任何约束说明
- 中文注释只是逐行复述代码动作

真实示例：

```typescript
/**
 * Delivery Layer — reliable outbound message delivery with chunking,
 * dedup, retry, error classification, and reference tracking.
 */

// ── Error classification ──────────────────────────────────────
// ── Public API ────────────────────────────────────────────────
```

```typescript
// 说明：这里不走 shell（只是目录路径），因此允许括号等常见文件夹名字符，
// 只拒绝高风险的 shell 元字符与控制字符。
if (/[$`;|&><\x00-\x1f]/.test(trimmed)) return null;
```

```typescript
/** Result of sending a message via an adapter */
export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}
```

来源：

- `src/lib/bridge/delivery-layer.ts`
- `src/lib/bridge/security/validators.ts`
- `src/lib/bridge/types.ts`

## 数值字面量与魔法数补充

时间值、长度阈值和大数字要优先可读，而不是追求“短”。

推荐模式：

- 五位数以上的数字、时间毫秒值、上下文阈值统一使用下划线分隔
- 魔法数提取成命名常量，再在逻辑里引用
- 对含义明显的倍率表达式保留乘法形式，例如 `90 * 60_000`

反模式：

- 在逻辑里直接散落 `60000`、`32000`、`5400000`
- 写成 `if (attempt < 3)` 而不抽 `MAX_RETRIES`
- 平台限制写死在多个函数中

真实示例：

```typescript
const MAX_INPUT_LENGTH = 32_000;
const DEFAULT_WINDOW_MS = 60_000;
const timeoutMs =
  parsePositiveInt(store.getSetting('bridge_codex_turn_timeout_ms'))
  ?? 90 * 60_000;
```

来源：

- `src/lib/bridge/security/validators.ts`
- `src/lib/bridge/security/rate-limiter.ts`
- `src/lib/bridge/conversation-engine.ts`

## 错误处理与可恢复性补充

桥接链路的错误处理必须区分“需要立即失败”和“允许 best effort”的场景，否则很容易把审计、去重、流式状态更新这些非关键路径写成故障放大器。

推荐模式：

- 调用方需要区分处理分支时，定义自定义错误类并显式设置 `this.name`
- 对审计、去重清理、状态写回等非关键路径使用 `catch { /* best effort */ }`
- 把发送失败先分类，再决定是否重试；不要把全部失败都丢进统一 retry
- 退避策略使用指数退避加抖动，并在平台提供 `retryAfter` 时优先尊重平台返回

反模式：

- 直接抛 `new Error('timeout')`，让上层无法可靠识别
- 为了“看起来稳”把所有异常都吞掉
- `404`、HTML 解析失败、网络抖动全部按同一种方式重试
- 退避时间直接写死，不区分平台返回的限流信息

真实示例：

```typescript
export class SessionQueueTimeoutError extends Error {
  timeoutMs: number;

  constructor(sessionId: string, timeoutMs: number) {
    super(`Session ${sessionId} is busy, queue timeout`);
    this.name = 'SessionQueueTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
```

```typescript
type ErrorCategory =
  | 'rate_limit'
  | 'server_error'
  | 'client_error'
  | 'parse_error'
  | 'network';

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

```typescript
if (Math.random() < 0.01) {
  try { store.cleanupExpiredDedup(); } catch { /* best effort */ }
}
```

来源：

- `src/lib/bridge/internal/session-lock.ts`
- `src/lib/bridge/delivery-layer.ts`

## 异步与资源管理补充

异步代码的重点是“可取消、可清理、可恢复”，而不是单纯把函数写成 `async`。

推荐模式：

- 统一使用 `async/await`，让取消、重试和资源释放路径可读
- 需要超时或外部打断的流程必须接入 `AbortController`
- 内部控制器和外部 `abortSignal` 要建立转发关系，保证 `/stop`、超时和上层取消能传到底层
- 后台定时器默认调用 `.unref()`，避免阻止 Node.js 进程退出
- 适配器收消息统一使用 producer-consumer 队列：有等待者就直接唤醒，没有等待者才入队

反模式：

- 在关键链路里堆叠多层 `.then()` / `.catch()`
- 启动超时定时器却不在 `finally` 里清理
- 后台清理定时器常驻，导致测试进程不退出
- `consumeOne()` 直接轮询睡眠，而不是等待生产者唤醒

真实示例：

```typescript
const abortController = new AbortController();
if (abortSignal) {
  if (abortSignal.aborted) {
    abortController.abort();
  } else {
    abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
  }
}

timeoutTimer = setTimeout(() => {
  try { abortController.abort(timeoutError!); } catch { /* ignore */ }
}, timeoutMs);
```

```typescript
setInterval(() => { rateLimiter.cleanup(); }, 5 * 60_000).unref();
```

```typescript
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

来源：

- `src/lib/bridge/conversation-engine.ts`
- `src/lib/bridge/delivery-layer.ts`
- `src/lib/bridge/adapters/telegram-adapter.ts`

## 安全约束补充

类型声明只能约束“我们希望是什么”，真正面对外部输入时必须先做运行时校验和授权判断。

推荐模式：

- 来自 IM、命令、配置或工作目录的输入先进入 `security/validators.ts`
- 适配器自己的入口必须先做 `isAuthorized(userId, chatId)` 检查，再继续处理消息
- 出站发送在共享投递层先过速率限制器，再调用具体平台 `send`
- 密钥、token 和允许名单统一从 `store.getSetting()` 读取，不硬编码到适配器中

反模式：

- 把工作目录、会话 ID、命令参数直接当可信值使用
- 没有授权配置时默认放行
- 适配器各自实现一套限流逻辑，绕开共享 `delivery-layer`
- 在日志和源码里直接写 token 或原始敏感内容

真实示例：

```typescript
export function validateWorkingDirectory(rawPath: string): string | null {
  if (!path.isAbsolute(trimmed)) return null;
  if (trimmed.includes('\0')) return null;
  if (/[$`;|&><\x00-\x1f]/.test(trimmed)) return null;
  return path.normalize(trimmed);
}
```

```typescript
isAuthorized(userId: string, chatId: string): boolean {
  const allowedUsers = getBridgeContext().store.getSetting('telegram_bridge_allowed_users') || '';
  if (allowedUsers) {
    const allowed = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.length > 0) {
      return allowed.includes(userId) || allowed.includes(chatId);
    }
  }
  return false;
}
```

```typescript
await rateLimiter.acquire(message.address.chatId);
```

来源：

- `src/lib/bridge/security/validators.ts`
- `src/lib/bridge/adapters/telegram-adapter.ts`
- `src/lib/bridge/delivery-layer.ts`
