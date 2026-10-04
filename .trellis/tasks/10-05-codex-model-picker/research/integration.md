# Codex 模型选择集成研究

日期：2026-10-05。研究基线 HEAD：a12b8fc；GitNexus 1.6.12 索引 lastCommit 与 HEAD 一致。只读代码和离线协议，未启动真实模型或飞书请求。

## 现有能力与缺口

- `scripts/claude-to-im-bridge/codex-llm.ts:218` 初始化读取 model/list，支持隐藏过滤、分页、重复游标防护；需要正式宿主接口暴露目录和刷新。
- `scripts/claude-to-im-bridge/codex-utils.ts:7` 已定义模型目录类型；模型校验在 `:44` 起，可复用扩展速度元数据。
- `src/lib/bridge/bridge-manager.ts:1701` 无参只显示文本，文本设置先保存后到下一轮才验证目录。卡片与文本需共享提交前验证逻辑。
- `src/lib/bridge/conversation-engine.ts:230` 传 model/reasoningEffort；`scripts/claude-to-im-bridge/codex-llm.ts:257` 进入 turn/start。速度需沿同链路贯通。
- `src/lib/bridge/conversation-engine.ts:417` 把实际型号和强度写回 binding，混淆偏好与实际值；需要分离展示状态与显式选择。
- `src/lib/bridge/channel-router.ts:43` 新建会话会清空强度并恢复后端默认；`:185` bind 也切换绑定。用户已确认新配置由当前聊天保存并在 `/new` 后继承，设计需分离聊天偏好与会话实际值。
- `scripts/claude-to-im-bridge/store.ts:12` 存在重复 ChannelBinding 类型且缺少 reasoningEffort；本任务涉及字段时需同步或复用正式类型，JSON 存储不需要数据库迁移。

## 飞书卡片

- `src/lib/bridge/markdown/feishu.ts:412` 已使用 schema 2.0 原生 form、select_static、form_action_type:submit、behaviors.callback。
- `src/lib/bridge/adapters/feishu-adapter.ts:524` 解析 action.form_value，并检查真实 context chat/message、operator、allowlist。保留快速排队返回，网络目录查询不能阻塞回调响应。
- `:984` 提供交互卡发送样板；`:1002` 有 im.message.patch，可用来更新同一张卡。
- `src/lib/bridge/channel-adapter.ts:115` 可增加可选的模型选择卡发送／更新接口；`types.ts:38` 使用独立 modelSelectionResponse。
- `bridge-manager.ts:965` 的轻量回调分支必须并列识别模型选择，不进入模型对话队列；`:1035` 接入专用协调模块。
- 不复用运行中 user-input-broker 的请求生命周期；仅复用其归属校验思路。

建议两步表单：第一步选模型并下一步，第二步选择该模型支持的强度和速度并应用。第一步只保存草稿，最终验证后一次提交。模型变化影响强度／速度，不能允许模型A的档位未经验证用于模型B。

临时记录绑定 requestId/channel/chat/user/session/messageId、代次和到期时间。异步目录读取或卡片创建结束后再次检查归属；new/bind/stop/restart、重复回调和旧卡晚到不能覆盖新设置。提交前检查忙碌状态，保存失败不得显示成功。

## 影响分析（预查，不替代实现前逐符号检查）

- handleCommand：CRITICAL，直接调用方 handleMessage，共10项、6个执行流程组。
- bridge-manager.handleMessage：CRITICAL，11项、4个直接图引用，涉及 adapter loop / scheduleMessages。
- handleCardAction：LOW，直接调用方 FeishuAdapter.start，4个流。
- Codex.selectModel：LOW，直接上游 streamChat.start。
- 图存在跨模块同名误连迹象，必须用当前源码补证；不可把图噪声作为忽略高风险的理由。已在用户 commentary 告知 CRITICAL 风险。

## 验证重点

- 目录分页、刷新失败、隐藏项、模型能力校验、无效配置不写入。
- 原生两步卡片、回调来源、过期、重复、切会话／停止竞态。
- model/effort/速度的保存恢复、实际请求参数、Fast→正常的显式覆盖。
- 默认偏好不被实际 status 固定，文字入口与现有 Claude 行为不回归。
- 当前相关测试：bridge-manager-ctx.test.ts:190，bridge-feishu-streaming.test.ts:108。
- 只运行离线测试；每次后台单元测试总时长不超过60秒。最终运行 typecheck/build 和相应单测。

## 外部依据

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：model/list 提供账户／客户端实际目录与支持的推理强度，不能硬编码示例。
- [Codex 速度说明](https://learn.chatgpt.com/docs/agent-configuration/speed)：Fast 独立于推理强度，使用量更高；可用性依赖模型、账号和工作区。
- 飞书官方 [表单](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/form-container)、[单选菜单](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/single-select-dropdown-menu) 页面正文未能被工具解析，未确认表单内即时联动。两步方案依据现有原生表单实现，真实飞书渲染需后续验证。
