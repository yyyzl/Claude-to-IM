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

### 错误 5：不同基数的数据做比较

坏例子：

- 函数接收 `bySeverity`（已排除 rejected）和 `rejected`（来自全集），然后用 `rejected === totalFindings` 判断"全部 rejected"，但 `totalFindings` 是从 active-only 的 `bySeverity` 求和得来的。混合状态（1 rejected + 1 open）会误判。

好例子：

- 参数命名体现数据集来源（`activeCount` vs `totalCount`）
- 比较前先确认两个值的基数一致，或显式还原到同一基数
- 在函数签名的 JSDoc 里标注每个参数的数据来源

**教训**：当多个参数来自不同的过滤/聚合管道时，比较操作极易产生语义错误。TS 的类型系统只校验结构，不校验语义——必须靠命名约定和代码注释补偿。

### 错误 6：状态机多路径未覆盖

坏例子：

- `terminateWorkflow()` 硬编码 `current_step = 'post_decision'`，但实际上状态机有 7 个调用点，包括从 `pre_termination`、`codex_review`（超时）、`claude_decision`（失败）等步骤触发终止
- 新增 `hasReport: true` 时只考虑了 code-review 完成路径，忘记 spec-review 也会走到同一 `finalizeCard()`

好例子：

- 读取 meta 中已持久化的 `current_step` 作为真实终止点
- 对每个消费状态机步骤的函数，列出它可能遇到的所有 step 值并逐一处理
- 新增工作流类型特有功能时，搜索所有消费该功能标志的路径，确认每个都有类型守卫

**教训**：状态机的每个"分支汇合点"（如 terminateWorkflow、finalizeCard）都必须考虑所有到达路径，而不仅仅是 happy path。这类 bug 在增量开发中特别常见——新功能加入时只测试了新路径，忘记检查旧的汇合点是否仍然正确。

### 错误 7：Error Recovery Path 遗弃工作项

坏例子：

- Claude parse 失败 → 跳到下一轮 → 但上一轮的 open issues 不在下一轮 Claude 的待评审列表中 → 这些 issues 永久 "Unreviewed"
- 重试耗尽 → 降级到备选路径 → 但降级路径没有携带原路径已产生的中间产物

好例子：

- Error recovery 后，扫描当前状态中所有"未完成的工作项"，自动补入下一阶段的输入
- 每条 recovery path 都有"遗留清理"步骤：要么完成、要么显式标记为放弃并通知用户

**教训**：Error recovery 不只是"跳过出错的步骤"，还必须回答"出错步骤产生的半成品去哪了"。如果不显式处理，半成品就会变成永久遗留。

### 错误 8：LLM 输出未 Sanitize

坏例子：

- 直接对 LLM API 返回的字符串做 `JSON.parse`，忽略 BOM (U+FEFF)、零宽字符 (U+200B-U+200D)
- 保存到文件时内容看起来正常，但内存中的字符串包含不可见前缀导致解析失败

好例子：

- 在 JSON parser 入口统一 sanitize：去除 BOM、零宽字符、控制字符
- Parse 失败时记录诊断信息：字符串长度、首尾字符的 charCode

**教训**：LLM API（包括 Claude Agent SDK、Codex CLI）的输出不保证是"干净文本"。流式拼接、编码转换、SDK 内部处理都可能引入不可见字符。必须在消费侧统一 sanitize，而不是假设上游输出干净。

### 错误 9：操作顺序导致原子性缺失

坏例子：

- 先 `updateMeta({status: 'completed'})` → 再 `persistReport()` → 报告写入失败 → 状态已标完成但通知事件没发出
- 先标记最终状态 → 再执行可能失败的副作用 → 状态与现实永久不一致

好例子：

- 先完成所有可能失败的操作 → 再原子更新状态
- 或用 try/catch 包裹可失败操作，失败时继续执行后续通知（降级但不卡住）

**教训**："先 A 再 B"的操作序列中，如果 B 可能失败，那么 A 必须是可回滚的或者 B 必须被 try/catch 兜底。否则就是在制造"半完成态"。

### 错误 10：忘记平台扇出

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
- [ ] 多个参数来自不同数据集时，比较操作的基数是否一致
- [ ] 状态机的所有到达路径是否都被汇合点函数正确处理
- [ ] 新增的 workflow 类型特有功能是否有类型守卫（搜索所有消费点）
- [ ] error recovery 路径是否处理了"半成品工作项"的归属（遗留的 open issues、未决的中间态）
- [ ] LLM 输出是否经过 sanitize 后再消费（BOM、零宽字符、控制字符）
- [ ] "先 A 再 B" 的操作序列中，B 失败时 A 是否可回滚或已被 try/catch 兜底
- [ ] 用户直接输入的标识符（如 runId）是否做了格式校验（白名单正则）防止注入/穿越

---

## 何时值得单独写流程文档

以下情况建议单独补一份流程说明：

- 改动横跨 3 层以上
- 共享契约复杂
- 同一个问题以前已经踩过坑
- 平台差异开始显著影响实现
