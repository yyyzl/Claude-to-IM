# Research: 当前 Codex IM 接入升级审计

- Query: 当前 Codex App Server 接入具备哪些能力，哪些升级缺口已确认，最小升级切片和验证是什么？
- Scope: internal（官方现行协议差异由主线程独立调研并汇总）
- Date: 2026-10-04
- 任务：`.trellis/tasks/10-04-agent-runtime-upgrade`；仅写本研究文件，未改业务代码。

## Findings

### 结论

项目已经使用 `codex app-server --listen stdio://` 接入，无需重新做 CLI→App Server 迁移。需要先升级双向 RPC、线程恢复、取消/错误、模型与权限契约；然后补用户输入和进度事件。更新 Codex 二进制本身不能自动获得这些能力。

当前最明确的问题是：服务端请求被误当作响应；旧线程无法恢复时新建线程且不重放历史；`/stop` 只停止本地收流；`/mode` 与 `/model` 传入参数被 Codex 忽略；失败 turn 与现代工具完成状态漏处理。不要把 Codex 桌面版的完整 UI 能力等同于本 IM 桥已经接入的能力。

### 文件清单

| 文件 | 用途 |
|---|---|
| `scripts/claude-to-im-bridge/codex-llm.ts` | Codex Provider、initialize/model/list、thread/turn 与事件收集 |
| `scripts/claude-to-im-bridge/codex-jsonrpc.ts` | 子进程与 JSON-RPC transport、请求 pending、通知 backlog |
| `scripts/claude-to-im-bridge/codex-utils.ts` | 二进制查找、sandboxPolicy、模型评分 |
| `scripts/claude-to-im-bridge/llm.ts` | 脚本局部 LLM 契约及 Claude Provider；Codex 实现依赖这里的类型 |
| `scripts/claude-to-im-bridge/permissions.ts` | 既有审批网关；Codex 只保存其引用，未调用 |
| `scripts/feishu-claude-bridge.ts` | Provider 配置装配，Codex 默认 hint 与权限策略 |
| `src/lib/bridge/host.ts` | 公共 LLM/SSE/PermissionGateway 边界 |
| `src/lib/bridge/types.ts` | ChannelBinding、消息与审批记录共享类型 |
| `src/lib/bridge/conversation-engine.ts` | 传模型/权限/附件、消费 SSE、持久化 SDK session 与模型 |
| `src/lib/bridge/bridge-manager.ts` | IM 命令、append 队列、stop、审批与 token 日报 |
| `src/lib/bridge/internal/codex-passthrough.ts` | `/codex:*` 的角色提示词包装；不切换后端、不创建原生子代理 |
| `src/lib/bridge/internal/usage-summary.ts` | 按结果用量累加日报 |
| `src/__tests__/unit/bridge-codex-llm.test.ts` | 4 个现有 Codex mock 用例 |
| `src/__tests__/unit/bridge-conversation-engine.test.ts` | 模型权限边界与会话引擎最小测试 |
| `tests/codexUtils.test.ts` | 模型评分、sandbox、二进制查找；标准单元测试入口未包含此目录 |

### 已接入能力与代码模式

- stdio App Server、CLI `-c key=value` 覆盖、Windows 后台子进程：`codex-llm.ts:548`、`codex-llm.ts:551`、`codex-llm.ts:554`、`codex-jsonrpc.ts:107`、`codex-jsonrpc.ts:118`。
- 一次性 initialize 与 model/list 动态发现：`codex-llm.ts:719`、`codex-llm.ts:739`；请求 `limit:200, includeHidden:true`，按 hint/显式 id 评分选择。
- 原生 thread/start、turn/start、工作目录与 baseInstructions：`codex-llm.ts:790`、`codex-llm.ts:807`、`codex-llm.ts:817`。turn 输入目前只有 text。
- final_answer 流式文本、completed-only 文本补发、delta 先于 started 的缓冲：`codex-llm.ts:876`、`codex-llm.ts:913`、`codex-llm.ts:985`、`codex-llm.ts:676`。
- early-notification backlog、按 threadId/turnId 分流：`codex-jsonrpc.ts:177`、`codex-llm.ts:891`、`codex-llm.ts:1029`。
- SSE keep_alive、总超时与静默超时、本地 AbortSignal：`codex-llm.ts:577`、`codex-llm.ts:1052`、`codex-llm.ts:1096`、`codex-llm.ts:1105`。
- 有限工具进度：命令 outputDelta 首次显示 shell running，MCP progress 首次显示 mcp_tool running；旧 function_call/tool_call 可以映射完成：`codex-llm.ts:944`、`codex-llm.ts:965`、`codex-llm.ts:975`、`codex-llm.ts:1001`。
- 用量保留 last/total/contextWindow，缺失时扫描本地 rollout 尾部：`codex-llm.ts:175`、`codex-llm.ts:228`、`codex-llm.ts:277`、`codex-llm.ts:1065`。
- 桥核心已有审批 SSE、PermissionGateway 和即时回调：`host.ts:38`、`host.ts:238`、`conversation-engine.ts:350`，可复用审批投递链路；Codex 尚未接这条链路。

### 已确认问题

以下“确认”指由源码或纯内存 mock 证明，不代表已在生产桥接或真实模型上观测。

| 优先级 | 问题与证据 | 用户影响 |
|---|---|---|
| P0 | `codex-jsonrpc.ts:237` 先看 numeric id，完全不区分 request 的 method 与 response 的 result/error；未知 id 直接丢弃，同 id 会 resolve 本地主动请求。JsonRpcMessage id 只声明 number（`:7`），类也没有 response/notify API。纯内存复现均为 true。 | 审批、用户输入和动态工具等服务端请求不能完成；请求 id 冲突还可能破坏本地请求。 |
| P0 | `permissions` 只在 `codex-llm.ts:518` 保存、`:536` 赋值；未使用。`params.permissionMode` 无读取；构造默认 `danger-full-access` + `never`（`:539`、`:540`），宿主默认相同（`feishu-claude-bridge.ts:376`、`:377`）。CE 明确按 plan/ask/code 传权限模式（`conversation-engine.ts:181`、`:223`）。 | 用户切 `/mode ask` 或 `/mode plan` 后 Codex 权限策略仍按全局配置执行；这是现有 UI 与运行行为不一致。 |
| P0 | transport 脱敏正则 `codex-jsonrpc.ts:32`、`:33`、`:37` 使用双反斜杠，匹配字面转义而非空白/词边界；用 fabricated Bearer/token 值证明日志未遮盖（仅输出 boolean）。错误响应 `:245` 直接 JSON.stringify；`codex-llm.ts:427`、`:429` 也没有逐字段脱敏。 | 在日志确实包含敏感值的条件下，recent logs/debug/IM 错误消息可能透传；未读取或发现任何真实凭据。 |
| P1 | `sdkSessionId` 直接当已加载 threadId（`codex-llm.ts:587`、`:591`）；没有 thread/resume。thread not found 时新建并重试（`:623`–`:642`），且从不读取 `params.conversationHistory`。 | 重启后进入兜底路径会丢失旧线程上下文；IM 中保存的旧消息不能自动补回。 |
| P1 | Abort/idle timeout/总 timeout 只退出本地 collect（`codex-llm.ts:1052`、`:1097`、`:1105`），cancel 只 abort（`:704`）；没有 turn/interrupt。`bridge-manager.ts:1738` 同样只 abort。 | `/stop` 提示停止后，桥接没有发送后端中断；原生 turn/工具可能继续执行（后端持续执行的实际程度尚未 live 验证）。 |
| P1 | turn/completed 只设置 boolean（`codex-llm.ts:1024`），不检查 turn.status/turn.error；streamChat 正常返回一律 `is_error:false`（`:681`）。mock failed turn 无独立 error 通知时返回正常。 | 某些失败/中断完成通知可能被当成功，产生空白或旧文本兜底。 |
| P1 | modern commandExecution/mcpToolCall 的 item/started 与 item/completed 没有匹配分支；只处理旧 function_call/tool_call。模拟 command started→outputDelta→completed 只收到 running。证据 `codex-llm.ts:944`、`:965`、`:1001`。 | 有输出命令一直显示运行中；无 outputDelta 的命令甚至不显示开始，文件变更、MCP/协作工具完成状态也缺失。 |
| P1 | `params.model` 无读取；model/list 只初始化一次（`codex-llm.ts:720`），选中 id 固定用于 thread/start（`:794`）。CE 会传当前模型（`conversation-engine.ts:178`、`:219`）。模型显式 id 无匹配时静默走评分（`codex-utils.ts:155`–`:173`），已 mock 证明。 | `/model` 对 Codex 本轮不生效；失效模型配置会静默替换，难以发现实际运行模型改变。 |
| P1 | `modelHint` 只参与模型字符串评分，未转成 turn 的 effort；没有读取 defaultReasoningEffort/supportedReasoningEfforts。`codex-utils.ts:111`、`:149` 与 `codex-llm.ts:818`；mock 请求无 effort。 | 默认 hint `gpt-5.5 xhigh`（`feishu-claude-bridge.ts:375`）不能保证 xhigh 生效；真正 effort 只可能来自另配 CLI config 或服务端默认。 |
| P1 | `params.files` 无读取，turn input 恒定 text（`codex-llm.ts:822`）；公共契约提供 files（`host.ts:217`），CE 传递（`conversation-engine.ts:226`）。 | IM 已收附件不等于 Codex 看到附件；需按 model inputModalities 接入图片/本地路径，或明确拒绝而非沉默忽略。 |
| P2 | `thread/tokenUsage/updated` 当前 camelCase 的 tokenUsage.total/last/modelContextWindow 并未显式解析；extractCodexUsagePair 只识别 snake_case（`codex-llm.ts:195`–`:203`），BFS 只能偶然命中 total/last 之一（`:338`）。纯内存现代 payload + legacy completion 哨兵证明 last/window 没有从现代事件提取。 | 仍依赖本地 rollout 来补 last/window，无法成为可靠的协议用量接入。 |
| P2 | CE 持久化 `status.model`（`conversation-engine.ts:378`），Codex 发的是 displayName 优先的 selectedModelLabel（`codex-llm.ts:598`、`:778`）。 | 展示名与调用 model id 混为同一字段；补 `/model` 时必须先拆标识与展示名，避免把 displayName 发回服务端。 |
| P2 | 不传 `params.onRuntimeStatusChange`，子进程 exit 只 reject pending request（`codex-jsonrpc.ts:153`、`:259`），不通知已开始的 collector。Provider initialized 不会因意外 exit 清零，client.request 又自动 start（`:188`）。 | 转执行中→空闲无法细分状态；app-server 意外退出可能等到长超时，下次自动重启可能缺 handshake。运行时复原路径未 live 验证。 |

### 明确缺失能力，但不能一概当作 bug

- 没有 turn/steer。现有 append 语义明确为“等当前任务完成后合并为下一轮”（`bridge-manager.ts:460`、`:665`），这是既有设计，不是丢消息 bug。升级可把 Codex 支持的主动 steering 做成独立可选能力，并保持普通 append 的 ack、群聊用户隔离与会话切换保护。
- commentary 不实时显示是现有明确测试要求（`bridge-codex-llm.test.ts:60`）。应新增独立 progress/commentary 事件，让其更新卡片而不污染最终答案和持久化回复，不能简单把所有 delta 都作为 text。
- 缺 reasoning、plan/diff、fileChange、collabToolCall/子代理状态与 richer MCP/tool 事件映射（`codex-llm.ts:933` 后的有限分支）。host SSE 有 task_update，但缺用户输入请求、commentary 与原生 agent 状态边界（`host.ts:29`）。
- `/codex:review` 等仅包装提示词；即使当前后端是 Claude 仍走同一 LLM。`codex-passthrough.ts:18` 与 `bridge-manager.ts:1166` 不调用独立 Codex review/子代理 API。不要把这些角色名当作真正多代理调度。
- 没有 thread/list/read/resume/archive/fork/rollback/compact/status 等生命周期接口。本次优先 resume/status/interrupt，不建议一次性暴露所有生命周期操作。

### 尚待官方契约或双轮 fixture 验证的风险

1. **initialize 完成通知**：当前只 request initialize 然后 model/list（`codex-llm.ts:725`、`:739`），没有发送 initialized 通知，capabilities 为 null（`:733`）。主线程需以当前官方文档确认要求；真实 CLI 0.156.1 是否容忍缺失未运行验证。
2. **model.id 与 model.model**：当前只选 id 并把 id 用于 thread/start（`codex-llm.ts:764`、`:794`）。在二者不一致的响应下需按官方语义选择调用字段；不能假设永远相同。分页 nextCursor 未处理，includeHidden:true 的候选未过滤隐藏/弃用/模态/effort，可能选到不适合的模型。
3. **累计用量重复记账**：代码把 total_token_usage 直接当整个本 turn 的 usage（`codex-llm.ts:903`、`:1069`），日报逐轮加和（`bridge-manager.ts:1338`；`usage-summary.ts:210`）。代码没有 thread total 的前后差分。若官方 total 为 thread/session 累计量，连续两轮会重复累计；需用两轮 `{total:100→150}` fixture 验证应记 `100+50`，不能仅测一次 total 值。
4. **rollout 私有存储耦合**：本地 sessions 年/月/日目录、rollout-*threadId.jsonl 命名、2 MiB 尾部上限、20,000 字 JSON 行限制（`codex-llm.ts:146`、`:228`、`:245`、`:288`）不是应依赖的稳定协议。未核查真实私有数据，不能据此断言当前文件布局已改变；迁移到正式 tokenUsage 通知后应移除冗余兼容，避免长期双路径维护。
5. **错误是否可恢复**：只通过 `Reconnecting... n/m` 文本识别（`codex-llm.ts:353`、`:1016`），未处理结构化 willRetry/codexErrorInfo 的完整语义。新版可恢复错误需 fixture 确认；不应过早终止或仅靠英文消息匹配。
6. **phase 缺省兼容**：只有 phase=final_answer 会实时转 text；phase 缺失的旧事件会等完成后合并，且 legacyMerged 可能包含 commentary（`codex-llm.ts:883`、`:1087`）。这是可见行为，是否删除旧路径需先约定支持的最低 Codex 版本。
7. **sandboxPolicy 版本边界**：helper 对三种配置生成有限结构（`codex-utils.ts:64`）。需用现行 schema 校验网络、可写根与额外权限字段；不能单凭类型断言认定完整支持新版权限模型。

### GitNexus 影响范围

本次实际执行了 CLI context 和 upstream impact，未改任何符号、未提交。重名方法用完整 UID 消歧。

| 符号 | Direct callers | 已返回相关 processes | 工具风险 |
|---|---|---|---|
| `CodexAppServerLLMProvider` | `scripts/feishu-claude-bridge.ts:main` + 文件 import | main | LOW，class 扩展部分失败 |
| `JsonRpcAppServerClient` | Codex Provider constructor + 文件 import | constructor | LOW，class 扩展部分失败 |
| `JsonRpcAppServerClient.handleMessage` | `handleLine`，继而 start→request | StartTurn→HandleMessage、StartThread→HandleMessage、EnsureInitialized→HandleMessage；impact 还返回 streamChat | **HIGH**；3 impacted symbols、4 processes、1 direct |
| `collectTurnText` | `CodexAppServerLLMProvider.streamChat` | CollectTurnText→TryParseJsonLikeString / ToSafeNonNegativeNumber / PickString | LOW；1 impacted symbol、1 process entry（内部 9 hits） |
| `startTurn` | `streamChat` | streamChat | LOW；1 impacted symbol |
| `selectCodexModel` | 图返回 tests 文件，遗漏实际 ensureInitialized 的调用；源码 `codex-llm.ts:763` | StreamChat→ScoreWithHint / ExtractBestGptVersionRank / NormalizeModelHaystack | LOW 输出不完整，源码补足 |
| `buildCodexPassthroughPrompt` | `bridge-manager.ts:handleMessage` | enqueueRegularMessage、tryAutoStart、runAdapterLoop、handleMessage | **HIGH**；6 impacted symbols、4 processes |
| `consumeStream` | `conversation-engine.ts:processMessage` | mock-host main、enqueueRegularMessage、runAdapterLoop、handleMessage | **HIGH**；8 impacted symbols、4 processes、3 modules |

升级前应先向用户说明：transport 改动影响 initialize/thread/start/turn/start/streamChat 全链路；共享 consumeStream 或 passthrough 改动影响 IM 主入口、消息排队和多渠道行为。随后实施代理还须对每个实际修改符号重新 impact；本研究的风险表不替代实施时检查。

### 推荐最小切片与有意义的验证

| 顺序 | 切片 | 最小有意义验证 |
|---|---|---|
| 1 | RPC 形状分流与类型：response、notification、server request，支持 number/string id；notify/respond、脱敏、unknown 验证；按官方补 handshake | 同 number id 的双向请求不会互相 resolve；unknown 请求返回明确 JSON-RPC error；分片行/非法 JSON/字符串 id/子进程退出 pending 清理；fabricated 敏感字段只输出遮盖值 |
| 2 | session 生命周期：新建/恢复分开，持久化 threadId；重启 resume，不静默丢历史；backend interrupt 与完成/失败/重试状态 | mock app-server 重启后先 initialize，再 thread/resume，再 turn/start；stop/timeout 发送匹配 threadId+turnId 的 interrupt；终态 failed/interrupted/completed 明确区分；异常退出及时结束 collector |
| 3 | 模型与权限契约：id/model/label 分开；动态列表、显式配置失效报错；effort 校验；plan/ask/code 对应 Codex 模式与 sandbox/approval | 不支持 effort 时明确错误或按已约定策略降级；/model 真正改变请求模型；plan/ask 不继续使用全局 danger-full-access+never；角色/附件能力不得静默忽略 |
| 4 | 审批与用户输入：复用 permission_request，新增多问题/选择/自由文本的用户输入事件、IM 关联与应答 | command/fileChange 审批 allow/deny/本次会话映射；同 chat 多请求避免错配；取消/超时/重复回复只完成一次；requestUserInput 多题、多选与自由文本完整往返 |
| 5 | 现代事件与用量：commandExecution/mcpToolCall/fileChange/collabToolCall 生命周期；独立 commentary/progress；正式 tokenUsage 通知；按 thread 差分统计 | 无输出命令仍 running→complete；failed 命令→error；MCP 与子代理终态更新；commentary 不进入 final 持久化；total/last 键顺序变化不影响解析；双轮累计差分；没有 rollout 文件也正确统计 |
| 6 | 可选 turn/steer：以活跃 turn 的 id、expectedTurnId 处理即时补充；共享 append 仍保留既有语义 | active turn 接受 steering；stale expectedTurnId 明确失败且不误发新任务；群聊 userId/会话切换/stop ack 与队列语义不回归；Claude 后端继续原 append |

优先把 Codex 专属协议保持在 provider/transport；跨后端的 SSE/IM 交互再通过 `host.ts` 契约扩展。无需为了研究结果先改 bridge-manager 巨型控制流或把所有新能力一次性接入。

### 本次验证证据

- 主线程汇报：`npm run typecheck` 通过；4 个指定 mock 测试文件共 **18/18** 通过。本代理未重复运行，未启动 App Server 或模型。
- 本代理直接执行两段内存 mock，只有 imports、对象替换与 stdout；没有创建文件、修改环境变量、读取私有 rollout、调用外部 API。
- 第一段：serverRequestDiscarded=true；serverRequestCanResolveClientRequest=true；fabricatedBearerOrTokenRedactionFailed=true；failedTurnReturnedNormally=true；commandLifecycleStatuses=[running]；invalidExplicitModelSilentlyReplaced=true。
- 第二段：现代 tokenUsage.total 能被 BFS 碰到，但 last/window 未提取（用 completion 注入 legacy 哨兵避免触发任何文件读取）；initialize 请求序列为 initialize→model/list，thread 使用 selected id，turn 无 effort。
- `bridge-codex-llm.test.ts` 仅 4 个用例：final_answer-only delta、completed final fallback、streamChat fallback、rollout backfill。未覆盖 transport、审批/问答、恢复、中断、turn failed、现代工具、模型失效、两轮累计用量。
- `tests/codexUtils.test.ts` 虽有评分与 sandbox 用例，`package.json` 的 test:unit 只 glob `src/__tests__/unit/bridge-*.test.ts` 和 workflow 测试；这些 utils 测试没有进入标准质量门。

### 相关规范

- `.trellis/workflow.md`：研究产物持久化与阶段边界。
- `.trellis/spec/backend/index.md`：后端入口与规范清单。
- `.trellis/spec/backend/directory-structure.md`：桥核心/宿主脚本/单元测试分层。
- `.trellis/spec/backend/module-boundaries.md`：host/types 与核心边界。
- `.trellis/spec/backend/integration-guidelines.md`：脚本装配、配置与文档同步。
- `.trellis/spec/backend/type-safety.md`：外部输入 unknown、运行时校验、共享类型联动。
- `.trellis/spec/backend/testing-guidelines.md`：node:test、纯 mock、并发与失败路径。

### 外部参考与版本

- 官方现行 App Server：<https://learn.chatgpt.com/docs/app-server>。本代理没有重复主线程的大范围浏览；新字段与方法名称以主线程官方差异研究为最终来源，本文列出的待验证项不得当作已确认官方兼容结论。
- 主线程提供的版本证据：本机 Codex CLI **0.156.1**，npm latest/官方 2026-10-01 changelog 为 **0.160.0**；未安装更新。本机 Claude Code **2.1.198** 与本审计边界外。
- 主线程提供模型列表现行能力字段：id/model/defaultReasoningEffort/supportedReasoningEfforts/inputModalities。仓库 mock 的 gpt-5.5-codex-xhigh 等是测试数据，不是本机可用模型事实。

## Caveats / Not Found

- 未读取 `.env`、凭据、真实配置私密字段或用户私有 rollout；未启动模型、桥接或生产 API。
- `python3 task.py current --source` 在本机无输出退出 1，替代 `python task.py current --source` 成功定位当前任务。
- GitNexus 概念 query 的 FTS index 不可用由主线程先行确认；本代理使用 context/impact 与最小 rg 源码补足。
- `.gitnexus/meta.json` indexedAt 为 2026-04-27；工具未直接提示 stale，因此未运行会写索引的 analyze。class context/impact 报 `declaredType` schema 属性缺失；函数 context 行号比当前源文件少 1；以当前源码行号为准。
- GitNexus `selectCodexModel` incoming 漏掉实际调用、某些 process 聚合不能代表全部运行时调用。LOW 不能作为完整安全证明；已知 HIGH 已报告主线程，未实施任何业务修改。
- 现有测试通过只能证明其覆盖范围；不能证明新版真实 App Server、重启恢复、审批请求或平台交互已兼容。
