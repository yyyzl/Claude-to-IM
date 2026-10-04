# Claude Code / Codex 升级路线评估

评估日期：2026-10-04（Asia/Shanghai）。本轮保存评估资料，未修改业务代码、依赖、全局配置或运行中的桥接。

## 建议

保留现有 IM 适配器、投递层和依赖注入结构。项目已使用 Codex app-server，接入方向合适；当前主要问题是运行时版本分离、双向协议不完整，以及桥接和工作流拥有不同的执行实现。

建议顺序：**修复 Codex 协议与权限 → 对齐运行时与模型 → 补齐远程交互 → 收敛工作流执行层**。每个切片独立验收，避免把新版全部特性混入一次架构改造。

## 版本基线

| 对象 | 本地证据 | 本次查询到的发布版本 | 建议 |
| --- | --- | --- | --- |
| PATH 中的 Codex CLI | 0.156.1 | 0.160.0 | 修复协议基础后验证 0.160.0，记录实际启动二进制版本 |
| PATH 中的 Claude Code CLI | 2.1.198 | 2.1.289 | 单独管理，与项目 SDK 版本区分 |
| 项目 Claude Agent SDK | package.json 声明 ^0.2.62；实际安装 0.2.69 | 0.3.289 | 做明确的跨 minor 迁移，更新 lockfile |
| SDK 内置 Claude Code | package.json 的 claudeCodeVersion=2.1.69 | 目标 SDK 对应 2.1.289 | 项目 query 未覆盖 executable，升级 SDK 才能对齐 |
| 项目 Anthropic Client SDK | 实际安装 0.39.0 | 0.131.0 | 随 Agent SDK 的 peer 要求一起对齐，避免孤立升级 |

本地命令：codex --version、claude --version、npm ls --depth=0。发布版本来自 npm view；Codex 0.160.0 同时由 [2026-10-01 官方发布记录](https://learn.chatgpt.com/docs/changelog) 核实。Agent SDK 0.3.289 与 Claude Code 2.1.289 对齐见 [SDK 官方变更日志](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)。

目标 Agent SDK 的 npm manifest 要求 @anthropic-ai/sdk >=0.93.0、@modelcontextprotocol/sdk ^1.29.0、zod ^4.0.0。现有 0.39.0 需在同一迁移切片处理。

以上是本地 PATH 和 node_modules 的基线，不代表已核实运行中桥接的二进制、账号可用模型或桌面 App 版本。未读取 .env、auth.json 或令牌配置。

## 已有基础值得保留

- Codex：stdio app-server、动态 model/list、thread/start、turn/start、最终回答流、用量展示。
- Claude：Agent SDK query、会话恢复、权限网关、文件系统 settingSources、文本流归一化。
- 桥接：平台适配、会话绑定、投递重试、权限卡片、会话锁。
- 工作流：跨模型审查、问题追踪、修复和重审等现有策略。

官方建议富交互客户端采用 app-server，自动化任务可采用 Codex SDK；现有 IM 接入无需为了“更新”改回字符串解析 CLI。[Codex SDK 文档](https://learn.chatgpt.com/docs/codex-sdk)

## 当前确认的问题

代码证据与精确行号见 [Codex 审计](./codex-current-audit.md) 和 [Claude / 工作流审计](./claude-workflow-current-audit.md)。

| 优先级 | 现状 | 实际影响 | 升级目标 |
| --- | --- | --- | --- |
| P0 | JsonRpcAppServerClient 将 number id 消息统一当响应 | 服务端主动审批/提问被丢弃；id 冲突可能误完成本地主动请求 | 明确区分 response、server request、notification；支持回应 server request |
| P0 | Codex Provider 不使用传入 permissionMode | /mode ask、/mode plan 没有改变 Codex 权限，构造默认为 danger-full-access + never | 每种会话模式映射明确权限策略，并接入已有权限网关 |
| P0 | transport 的日志脱敏正则使用了错误的双反斜杠 | 若日志包含令牌等内容，可能未遮盖；模拟值已复现，未发现或读取真实凭据 | 修正脱敏并覆盖错误响应、recent logs 和 IM 错误出口 |
| P0 | turn/completed 未区分 failed/interrupted | 回合失败可能显示为正常结束 | 传播失败、取消和结构化错误，避免成功状态误报 |
| P0 | workflow 默认 claude-sonnet-4-20250514 | 标准 Claude API 上已退役，默认配置有失败风险 | 使用明确支持的模型配置；启动时校验，避免静默替换 |
| P1 | Codex 没有 thread/resume，thread 缺失时创建新 thread | 进程重启或回收后可能丢失远端会话历史 | 恢复持久化 thread；恢复失败应明确展示并让用户选择新会话 |
| P1 | 停止只结束本地收流，没有 turn/interrupt | 远端工作可能继续执行 | 发送协议中断，等待 interrupted 状态并清理待审批项 |
| P1 | 会话 model、files 等输入没有进入 Codex 调用 | 模型切换、图片附件等能力不能按上层契约使用 | 从模型目录确认能力，按实际会话参数构造 turn |
| P1 | workflow 使用独立 codeagent-wrapper，修复调用未显式传 worktree cwd | 升级两条执行路径，修复目标目录需核实 | 明确 cwd、模型、工具、审批和超时配置，收敛重复执行机制 |
| P1 | 集成脚本未纳入 tsc；tests/ 不在默认单测命令内 | 核心库检查通过不代表宿主运行时代码被完整检查 | 为 scripts 和 tests 增加独立类型检查/测试入口 |

Sonnet 4 于 2026-06-15 在 Claude API 退役，见 [Claude 平台发布记录](https://platform.claude.com/docs/en/release-notes/overview)。这说明默认配置需要迁移，未调用实际账号验证其失败。

脚本的 Codex fallback hint 仍为 gpt-5.5 xhigh。官方公告 ChatGPT 登录面的 gpt-5.5 将于 2026-10-14 退役，API 不在此退役范围；应按账号实际目录选择模型，不把旧示例当配置事实。[官方更新记录](https://learn.chatgpt.com/docs/changelog)

## 第一阶段：兼容性与运行时基础

1. **协议分流和权限闭环**：先修 transport，再接 command/file approval 和用户输入；沿用 IM 权限网关，但提问需保存选项答案，不能只提供允许/拒绝。补齐 initialize → initialized 握手，并针对日志脱敏建立模拟值回归。
2. **状态正确性**：失败、取消、服务端断连必须有不同终态；请求 id、threadId、turnId 共同限定待处理交互；不能盲目重发不确定是否已成功的 turn/start。
3. **版本和模型对齐**：固定一组已验证版本，按该 Codex CLI 生成协议类型；把 SDK、其内置 runtime 和 peer 依赖作为一个迁移单元。模型以 model/list 的返回值为准，显式无效选择给出错误。
4. **验证入口**：scripts 纳入单独的类型检查；tests/ 纳入相关单测入口。生成协议和能力检测保持在运行时适配层，避免扩散到各 IM adapter。

## 第二阶段：让飞书能完整参与任务

- 恢复持久化 thread，停止发送实际中断。
- 增加运行中补充输入，处理“正在执行”“等待审批”“等待回答”“完成/失败”四类状态。
- 把 commentary、执行工具、任务/子代理进度与 final_answer 分开渲染；不把进度文本混入最终答案。
- 使用公开用量事件作为主要来源，逐步移除对私有 rollout 格式的依赖。
- 提供模型与 reasoning effort 的目录选择；对图片/附件按模型能力做输入适配。
- 显式 Skills/MCP 能力发现放在基础协议完善后，先实现确实用到的操作。

这些目标分别对应 app-server 的 thread/resume、turn/interrupt、turn/steer、server request、item/事件、thread/tokenUsage/updated 等公开协议。实验接口应按生成 schema 与实际能力验证后启用。[App Server 官方协议](https://learn.chatgpt.com/docs/app-server)

## 第三阶段：共享执行机制，保留工作流策略

将 Codex 执行 transport 和 Claude SDK 接入从宿主脚本收敛到可复用模块。桥接与 workflow 复用版本诊断、取消、事件归一化和模型校验；保留不同调用策略：

- IM：持久化会话、用户交互、项目上下文、按模式授权工具。
- 审查：隔离会话、受控上下文、结构化输出、明确限制工具和本地设置。
- 修复：显式 worktree cwd、受控写权限、测试结果回流。

不要直接把现有 chat provider 原样塞入审查流程，否则可能改变已有隔离语义。先修复 wrapper 的 cwd 等明确缺口，再替换执行实现。原生子代理能力可用于并行子任务；跨 Claude/Codex 的审查仲裁继续属于项目自己的工作流。

## Claude SDK 迁移检查

当前已经使用 Agent SDK 包，无需再次做旧包更名迁移。重点核对原生 binary 分发、env 替换语义、MCP 异步初始化、TaskCreate/TaskUpdate 等任务事件、显式 permissionMode、后台消息与多轮控制。现有 query 路线继续保留。

runner 当前直接导入包内部的 sdk.mjs 文件，迁移时应改为受支持的包入口，同时保留指定项目安装目录的解析需求；不要把包内部布局当作长期契约。

交互式澄清需要对 AskUserQuestion 单独采集回答；SDK 已提供此回调机制。[Claude SDK 用户输入文档](https://code.claude.com/docs/en/agent-sdk/user-input)

## 项目定位与官方远程能力

如果目标是用手机操作官方本地会话，可先评估现成 Remote：Codex Remote 已正式提供手机到 Mac/Windows 主机的任务与审批入口；Claude Remote Control 也支持继续本地会话。[Codex 发布记录](https://learn.chatgpt.com/docs/changelog)、[Claude Remote Control](https://code.claude.com/docs/en/remote-control)

本项目后续投入可集中在飞书统一入口、跨模型协作、定制工作流与审计。Claude Channels 已提供 IM 事件推送机制，但仍为预览，适合单独验证其适用性，不宜本轮替换整个桥接。[Channels 官方文档](https://code.claude.com/docs/en/channels)

桌面 App 的浏览器、语音、可视化等体验与当前 Node.js bridge 不在同一接入层；是否能复用具体能力必须逐项确认公开入口和运行环境，不能以 CLI 版本升级推断功能已继承。

## 影响范围与验收

GitNexus handleMessage 上游分析为 HIGH（3 个符号、4 条执行流）；workflow invokeCodex 为 HIGH（5 个节点、4 个入口）。后续实现应先告知高风险范围，再按切片修改。图索引还出现缺失 FTS 和 declaredType 字段错误，不能用部分查询返回 LOW/空结果证明没有调用方。

第一批验收应覆盖：服务端请求和响应 id 冲突；允许/拒绝审批及用户答案回传；ask/plan/code 的权限；failed/interrupted；重启恢复原 thread；模型无效时的明确错误；新 SDK 的项目设置与启动；修复只写入指定 worktree。

本轮验证：

- npm run typecheck 通过。
- Codex provider、Claude SDK settings、Codex utils、宿主 settings 四个测试文件共 18 个测试通过（每测超时 15 秒，总耗时小于 60 秒）。
- Codex 审计另用纯内存模拟确认若干协议和状态缺口，未启动模型或生产桥接。
- gitnexus detect-changes --scope all 返回 No changes detected；git status 补充确认新增评估任务文档，业务代码没有改动。

以上不能替代真实账号的协议联调。正式实施完成后，应在隔离测试目录对目标版本做恢复、审批、停止和图片输入的小规模联调，再切换运行中的桥接。
