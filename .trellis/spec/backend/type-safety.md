# 后端类型安全规范

> 当前仓库依赖 TypeScript 严格类型，但真正的风险来自外部输入边界。类型声明不能替代运行时校验。

---

## 共享类型放置规则

- 跨模块共享的消息、绑定、状态类型放在 `src/lib/bridge/types.ts`
- 宿主接口契约放在 `src/lib/bridge/host.ts`
- 某个文件私有的小类型，优先留在本文件附近

不要把明显只在单文件使用的类型过度上提到全局。

---

## 当前仓库的稳定模式

- 接口优先：如 `BridgeStore`、`LLMProvider`
- 联合类型优先：如 `SSEEventType`、`MessageContentBlock`
- 共享结构集中在 `types.ts` 与 `host.ts`
- 运行时入口配合 `security/validators.ts` 做收窄与校验

---

## 边界输入一律视为不可信

以下输入必须做运行时校验，而不能只靠类型声明：

- IM 文本消息
- 工作目录
- 会话模式
- 命令参数
- 配置项值
- 外部回调数据

推荐做法：

- 先用 `unknown` 或原始字符串接收
- 再用显式校验函数收窄
- 校验失败时返回明确错误，而不是沉默兜底

---

## 推荐模式

- 优先复用已有校验函数，例如 `validateWorkingDirectory`、`validateMode`
- 修改共享类型时，同时检查测试、帮助文案和上下游调用
- 让类型名称表达边界语义，而不是仅表达数据形状
- 对可选字段保持诚实，不要为了省事强行声明为必填

---

## 禁止事项

- 滥用 `any`
- 用无依据的 `as` 断言掩盖真实不确定性
- 让字符串魔法值在多个文件里散落
- 只改类型定义，不检查对应的运行时验证和测试

---

## 真实示例

- `src/lib/bridge/types.ts`：集中定义消息、绑定、状态与平台限制
- `src/lib/bridge/host.ts`：集中定义宿主契约与 SSE 事件结构
- `src/lib/bridge/security/validators.ts`：对工作目录、会话 ID、模式和输入危险性做显式校验
- `src/lib/bridge/bridge-manager.ts`：从配置中读取字符串后再解析为布尔值或数字

---

## 修改共享类型前的检查清单

- [ ] 是否真的属于共享类型，而不是局部类型
- [ ] `host.ts` / `types.ts` / 校验函数是否需要同步修改
- [ ] 单元测试中的 mock 或 fixture 是否需要同步更新
- [ ] 帮助文案、README 或脚本装配是否依赖这个字段

---

## 联合类型 vs 接口决策树补充

当前仓库不是“接口越多越好”，而是按语义选对建模工具。

决策顺序：

1. 如果表达的是一组固定字符串、判别分支、函数签名或变体组合，优先用 `type`
2. 如果表达的是稳定对象形状、宿主契约、持久化记录或需要被多个方法共享的结构，优先用 `interface`
3. 如果只是单文件私有且不需要复用，优先保留在本文件附近，不要急着上提到 `types.ts`

推荐模式：

- 宿主能力、持久化接口、参数对象使用 `interface`
- SSE 事件类型、消息内容分支、权限行为、状态字面量使用 union type
- 可扩展的对象边界保持字段名清晰，不用“万能 Record”替代正式接口

反模式：

- 用 `interface Status { value: 'running' | 'stopped' }` 包住原本只需要一个 union 的场景
- 用 `type BridgeStore = { ... }` 写超大宿主契约，失去接口语义
- 只是为了“统一”把每个局部对象都提到全局 `types.ts`

真实示例：

```typescript
export interface BridgeStore {
  getSetting(key: string): string | null;
  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null;
  insertAuditLog(entry: AuditLogInput): void;
}

export interface StreamChatParams {
  prompt: string;
  sessionId: string;
  sdkSessionId?: string;
  model?: string;
  abortController?: AbortController;
}
```

```typescript
export type SSEEventType =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'done';

export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };
```

来源：

- `src/lib/bridge/host.ts`

## `import type` 与类型边界补充

在 ESM + TypeScript 项目里，类型导入不是纯风格，而是避免运行时错误和循环依赖的重要约束。

推荐模式：

- 只在类型位置使用的符号必须通过 `import type` 导入
- 同一个模块同时导入类型和值时，拆分成独立语句
- 公共类型从 `host.ts`、`types.ts` 这类边界文件导入，不从实现细节文件偷拿类型

反模式：

- `import { BaseChannelAdapter, SendResult } from './channel-adapter.js'`
- 为了少写一行，把值和类型混在一条导入中
- 从 `internal/` 导入临时类型到公共模块

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
```

来源：

- `src/lib/bridge/delivery-layer.ts`

## 公共 API 禁止模式补充

这些模式会把外部不确定性直接泄漏到调用边界，必须明确禁止。

禁止事项：

- `any` 出现在公共函数签名、接口字段或共享类型里
- 没有局部证据时直接使用 `!` 非空断言
- 用 `as` 把不确定输入强行压成目标类型，而不经过校验
- 把外部输入直接声明成精确类型，而不是先接成 `unknown`、`string` 或原始对象后再收窄

推荐模式：

- 对外部回调数据、消息原文、工具输入保留 `unknown`，再用校验函数逐步收窄
- 只有在 mock 或桥接测试构造阶段才允许受控 `as unknown as ...`，且范围尽量小
- 非空断言只在局部已经证明安全、且写明原因时使用

反模式：

- `function process(data: any): any`
- `const session = maybeSession!`
- `const mode = raw as 'plan' | 'code' | 'ask'`

真实示例：

```typescript
export interface InboundMessage {
  raw?: unknown;
}

export type MessageContentBlock =
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
```

```typescript
return {
  ...mockStore,
} as unknown as BridgeStore;
```

来源：

- `src/lib/bridge/types.ts`
- `src/lib/bridge/host.ts`
- `src/__tests__/unit/bridge-delivery-layer.test.ts`

## 可选字段与参数顺序补充

可选不是“偷懒不确定”，而是对边界状态的诚实表达。

推荐模式：

- 单个可选输入使用 `?`，多个可选输入收敛进 `opts` 对象
- 函数形参中，可选参数放在最后
- 接口中只有真正可能缺失的字段才标为可选
- 对于“创建时可空、运行后必有值”的字段，优先通过阶段化对象或局部收窄处理，不要一开始就乱用可选

反模式：

- 把必填字段写成可选，只为减少调用方报错
- 把可选参数塞在必填参数中间
- 一个函数堆很多并列可选参数，而不是改成 `opts`

真实示例：

```typescript
export async function deliver(
  adapter: BaseChannelAdapter,
  message: OutboundMessage,
  opts?: {
    sessionId?: string;
    dedupKey?: string;
  },
): Promise<SendResult> { ... }
```

```typescript
export interface StreamChatParams {
  prompt: string;
  sessionId: string;
  sdkSessionId?: string;
  model?: string;
  workingDirectory?: string;
  abortController?: AbortController;
}
```

来源：

- `src/lib/bridge/delivery-layer.ts`
- `src/lib/bridge/host.ts`
