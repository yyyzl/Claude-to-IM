# 后端模块边界规范

> 先判断职责归属，再动手改代码。大多数桥接库问题都来自边界滑坡，而不是单点实现。

---

## 核心模块边界

### `bridge-manager.ts`

职责：

- 管理桥接启停与适配器生命周期
- 协调消息入口、会话锁、命令处理和出站响应
- 调用路由、会话引擎、权限与投递模块

不应负责：

- 直接承接所有平台细节
- 重复实现渲染、校验、存储或命令解析

### `channel-router.ts`

职责：

- 从 `ChannelAddress` 找到或创建对应 `ChannelBinding`
- 处理聊天与会话之间的绑定关系

不应负责：

- LLM 流处理
- 出站发送
- 平台 UI 细节

### `conversation-engine.ts`

职责：

- 调用 LLM 流
- 消费 SSE 事件
- 生成会话内的文本、工具、状态变化

不应负责：

- 直接做平台投递策略
- 管理平台适配器生命周期

### `delivery-layer.ts`

职责：

- 统一发送
- 分块、重试、去重
- 做平台发送失败的兜底处理

不应负责：

- 生成业务语义
- 管理会话状态

### `host.ts`

职责：

- 定义 `BridgeStore`、`LLMProvider`、`PermissionGateway`、`LifecycleHooks`
- 作为桥接核心与宿主应用之间的契约边界

不应负责：

- 放具体宿主实现
- 引入宿主应用模块

### `internal/`

职责：

- 承载桥接内部复用的小模块与帮助函数

不应负责：

- 形成第二套公共 API
- 被外部脚本任意跨层依赖

---

## 设计判断顺序

新增逻辑前，先问自己：

1. 这是编排问题、契约问题、投递问题，还是平台问题
2. 现有模块中是否已有明确归属
3. 是否只是缺一个小 helper，而不是该往大文件继续堆逻辑

如果一个改动横跨多个模块，优先拆成：

- 契约变更
- 模块内部实现
- 调用方接线
- 测试补齐

---

## 推荐模式

- 通过 `getBridgeContext()` 访问宿主依赖
- 通过共享类型和小函数传递上下文，而不是跨模块偷读内部状态
- 让 `bridge-manager` 继续做 orchestration，而不是成为万能文件
- 新平台支持优先复用现有渲染、投递、安全能力

---

## 反模式

- 绕过 `getBridgeContext()` 直接耦合宿主实现
- 从 `internal/` 跨层引用细节，替代正式边界
- 在脚本层直接复制 `bridge-manager` 中已有的桥接逻辑
- 为了赶进度把命令解析、发送和存储操作全部塞进一个函数

---

## 真实示例

- `src/lib/bridge/bridge-manager.ts`：主编排，但仍委托给多个模块
- `src/lib/bridge/channel-router.ts`：绑定解析独立成模块
- `src/lib/bridge/conversation-engine.ts`：LLM 流处理独立成模块
- `src/lib/bridge/delivery-layer.ts`：投递策略独立成模块
- `src/lib/bridge/host.ts`：契约层与实现层分离

---

## 适配器注册边界补充

新增平台时，核心边界不应该被“平台分支”反向侵蚀。桥接核心只依赖抽象适配器注册表，不直接依赖某个平台类。

推荐模式：

- `channel-adapter.ts` 维护唯一的注册表边界：`registerAdapterFactory()`、`createAdapter()`、`getRegisteredTypes()`
- 每个适配器文件在模块末尾自注册
- `adapters/index.ts` 只保留 side-effect import，作为“适配器目录清单”
- `bridge-manager.ts` 只导入 `./adapters/index.js` 触发注册，不为新平台添加 `switch` 或 `new XxxAdapter()`

反模式：

- 在 `bridge-manager.ts` 里手动 `if (type === 'telegram') new TelegramAdapter()`
- 新增平台时顺手改多个核心模块，而不是只补注册入口
- 适配器实现已经存在，但忘了在 `adapters/index.ts` side-effect import

真实示例：

```typescript
const adapterFactories = new Map<string, () => BaseChannelAdapter>();

export function registerAdapterFactory(
  channelType: string,
  factory: () => BaseChannelAdapter,
): void {
  adapterFactories.set(channelType, factory);
}

export function createAdapter(channelType: string): BaseChannelAdapter | null {
  const factory = adapterFactories.get(channelType);
  return factory ? factory() : null;
}
```

```typescript
import './telegram-adapter.js';
import './feishu-adapter.js';
import './discord-adapter.js';
import './qq-adapter.js';
```

```typescript
// Self-register so bridge-manager can create TelegramAdapter via the registry.
registerAdapterFactory('telegram', () => new TelegramAdapter());
```

来源：

- `src/lib/bridge/channel-adapter.ts`
- `src/lib/bridge/adapters/index.ts`
- `src/lib/bridge/adapters/telegram-adapter.ts`

## 新增适配器的落地步骤补充

新增平台适配器时，推荐按下面顺序落地，避免职责泄漏和漏注册：

1. 在 `src/lib/bridge/adapters/` 下创建平台文件；现有真实命名模式是 `telegram-adapter.ts`、`discord-adapter.ts`、`qq-adapter.ts`
2. 在该文件实现 `start()`、`stop()`、`isRunning()`、`consumeOne()`、`send()`、`validateConfig()`、`isAuthorized()`
3. 文件末尾按现有模式自注册，例如 `registerAdapterFactory('discord', () => new DiscordAdapter())`
4. 在 `src/lib/bridge/adapters/index.ts` 追加对应的 side-effect import，例如 `import './discord-adapter.js';`
5. 如果需要新的配置 key、类型或校验器，再分别落到 `host.ts`、`types.ts`、`security/validators.ts` 对应边界，不要直接塞进 `bridge-manager.ts`

反模式：

- 先在 `bridge-manager.ts` 写平台逻辑，再回头补适配器
- 让适配器自己读取并解析所有宿主配置，但不通过 `getBridgeContext()`
- 新增平台时复制已有平台的大段实现，却不复用 `delivery-layer.ts`、`markdown/`、`security/` 能力

## 授权边界补充

适配器注册完成后，平台特有的授权判断仍然留在适配器内部，桥接核心只依赖抽象方法。

推荐模式：

- `BaseChannelAdapter` 把 `isAuthorized(userId, chatId)` 定义为必实现契约
- 平台实现可以读取自己的 allowlist、chatId 或群权限配置
- 无授权配置时默认拒绝，而不是交给上层猜测

真实示例：

```typescript
abstract isAuthorized(userId: string, chatId: string): boolean;
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

来源：

- `src/lib/bridge/channel-adapter.ts`
- `src/lib/bridge/adapters/telegram-adapter.ts`
