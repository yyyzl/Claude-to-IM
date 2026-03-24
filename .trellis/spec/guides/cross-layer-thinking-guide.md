# 跨层思考指南

> **目的**：在实现前先把跨层数据流和契约变化想清楚。当前仓库的大多数高成本问题，几乎都发生在边界处。

---

## 核心问题

多数跨层问题不是“不会写逻辑”，而是“误以为这只是本地改动”。

常见症状：

- 上游消息格式变了，下游仍按旧结构处理
- 共享类型改了，但测试、脚本、帮助文案没同步
- 某个脚本里偷偷复制了核心逻辑，后续越改越分叉

---

## 实现前先画链路

先把数据流写出来，再决定在哪一层改：

```text
来源 → 转换 → 存储/绑定 → 再转换 → 展示/投递
```

对每一跳都问自己：

- 输入格式是什么
- 输出格式是什么
- 校验在哪一层做
- 出错时谁负责兜底

---

## 先识别边界

通用边界示例：

| 边界 | 常见问题 |
|------|----------|
| API ↔ Service | 字段缺失、格式不一致 |
| Service ↔ Database | 空值、转换、持久化差异 |
| Backend ↔ Frontend | 序列化与展示不一致 |
| Component ↔ Component | props 形状变化 |

当前仓库里更关键的边界通常是：

| 边界 | 仓库示例 | 常见问题 |
|------|----------|----------|
| Adapter ↔ Bridge Manager | `adapters/*.ts` ↔ `bridge-manager.ts` | 平台特有 payload 向上泄漏 |
| Router ↔ Session Binding | `channel-router.ts` ↔ `host.ts` | 绑定字段漏改、会话状态陈旧 |
| Conversation Engine ↔ Host LLM | `conversation-engine.ts` ↔ `LLMProvider` | 流事件格式不一致、运行态漂移 |
| Delivery Layer ↔ Adapter | `delivery-layer.ts` ↔ `send()` | 分块、重试、去重策略不一致 |
| Bridge Core ↔ Scripts | `src/lib/bridge/` ↔ `scripts/` | glue code 逐步长成核心逻辑 |

---

## 先定义契约，再写代码

对每个边界都写清：

- 精确输入格式
- 精确输出格式
- 允许的错误类型
- 失败后的回退方式

如果你说不清这四件事，说明你还不该开写。

---

## 当前仓库的专用链路清单

在这个桥接项目里，跨层链路通常更具体：

```text
InboundMessage
→ adapter consume loop
→ channel binding resolution
→ session lock / runtime status
→ LLM stream events
→ markdown/render transformation
→ delivery / retry / dedup
→ outbound platform message
```

逐跳检查：

- 这一步由哪个文件拥有
- 这一步依赖哪个共享类型或宿主接口
- 这一步变更后，哪些测试、文档、脚本也要动

---

## 何时必须触发跨层检查

只要出现以下任一情况，就不要把它当成”局部小改”：

- 你改了 `host.ts`
- 你给 `ChannelBinding`、`InboundMessage` 或其他共享类型增删字段
- 你改了 `BridgeStore.getSetting()` 相关配置 key
- 你新增平台适配器或新的命令回调格式
- 你改了权限回调 payload、Markdown 渲染或 delivery 重试策略
- **你把用户生成的内容（diff、源码、配置文本）注入到模板、命令或查询中** — 必须确认不会触发字符串特殊语义（`$` 反向引用、占位符级联、shell 注入等）
- **你的组件输出会作为下游外部系统的输入** — 必须确认下游的大小/格式限制（如 Codex CLI 的 1M 字符限制）

---

## 常见跨层错误

### 错误 1：只在一层改契约

坏例子：

- 改了 `types.ts`，没改测试、脚本或帮助文案

好例子：

- 共享类型、宿主契约、测试和文档一起改

### 错误 2：校验分散

坏例子：

- 同一个约束在多个模块各写一遍

好例子：

- 在入口层集中校验，其他层只消费已验证结果

### 错误 3：脚本层长出核心逻辑

坏例子：

- 在某个启动脚本里塞入可复用桥接行为

好例子：

- 把可复用逻辑抽回 `src/lib/bridge/`

### 错误 4：内容注入导致跨层膨胀

坏例子：

- 模板引擎用 `String.replace` 做占位符替换，替换值（用户内容）包含 `$'` 或其他占位符字符串
- PackBuilder 不知道下游 Codex CLI 的 1M 字符限制，给 PromptAssembler 传了 2.4MB 的 pack
- ModelInvoker 的 `withRetry` 把进程崩溃（输入超限 exit 1）误报为 "超时"

好例子：

- 单次扫描替换（`replaceAllPlaceholders`），已插入的 value 不会被再次处理
- 渲染后检查字符数，自动降级（full content → diff hunks → truncate diff）
- `NON_RETRYABLE_PATTERNS` 识别 "exceeds maximum length"，不浪费重试

**教训**：当用户生成的内容（diff、源码、配置）被注入到模板/命令/查询中时，必须把它当作"不可信输入"处理。这不只是安全问题，也是正确性问题。

### 错误 5：忘记平台扇出

坏例子：

- 改消息渲染时只看一个平台

好例子：

- 同步检查 Telegram、Discord、Feishu 的渲染、限制和投递逻辑

---

## 跨层实现前检查清单

- [ ] 已画出完整数据流
- [ ] 已识别所有受影响边界
- [ ] 已写清每个边界的输入、输出和错误
- [ ] 已确认校验发生在哪一层
- [ ] 已确认会变动哪些共享类型、宿主接口、配置 key

实现后再检查：

- [ ] 空值、无效值、极端输入是否覆盖
- [ ] 每一层的错误处理是否一致
- [ ] 测试、脚本、文档是否跟着契约一起更新
- [ ] 用户内容注入是否安全（`String.replace` 的 `$` 反向引用、模板占位符级联、SQL/shell 注入）
- [ ] 输出是否在下游系统的大小/格式限制内（Codex 1M chars、HTTP body limit 等）

---

## 何时值得单独写流程文档

以下情况建议单独补一份流程说明：

- 改动横跨 3 层以上
- 共享契约复杂
- 同一个问题以前已经踩过坑
- 平台差异开始显著影响实现
