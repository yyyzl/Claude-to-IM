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
