# Research: Claude Agent SDK 与双模型工作流升级范围

- Query: 当前 Claude 接入、双模型评审与自动修复有哪些可复用能力、版本耦合和升级缺口？
- Scope: mixed，以本地源码、已安装 SDK 类型和现有测试为主；最新版本与模型退役信息使用主线程已核验资料。
- Date: 2026-10-04
- 任务路径: `.trellis/tasks/10-04-agent-runtime-upgrade`，`python ./.trellis/scripts/task.py current --source` 确认当前会话指向此任务。
- 研究限制: 只写本文件；没有更改业务代码、依赖、配置或 Git 状态；没有读取 `.env` / auth 文件，没有真实模型调用。

## Findings

### 1. 结论

升级可沿现有边界推进，无需重写 IM 投递、会话路由或 workflow 状态机。但必须分别升级聊天 bridge 与双模型 workflow 的运行时：二者目前不共用模型调用实现。

优先顺序建议：先修正默认模型、CLI 配置丢失和 auto-fix 工作目录；再升级项目 Agent SDK 并补类型检查、消息契约回归；最后根据实际需要接任务进度、结构化输出等能力。全局 Claude CLI 更新不能替代项目 Agent SDK 更新。

### 2. 文件发现

| 文件 | 用途 |
|---|---|
| `scripts/claude-to-im-bridge/llm.ts` | Claude SDK query 到统一 SSE 的聊天宿主适配器，含 IM 工具授权、resume、流式文本。 |
| `scripts/claude-to-im-bridge/settings.ts` | 设置解析与默认值；支持环境传入模型，没有固定 Claude 默认模型。 |
| `scripts/feishu-claude-bridge.ts` | 按后端装配 Claude SDK 或 Codex app-server，并导入编译后的 bridge 核心。 |
| `src/lib/bridge/host.ts` | `LLMProvider`、`StreamChatParams`、SSE、权限、用量等共享契约。 |
| `src/lib/bridge/types.ts` | 渠道绑定、后端、工作目录与会话 ID 等共享类型。 |
| `src/lib/bridge/conversation-engine.ts` | 将统一 SSE 转成消息、工具状态、用量和持久化会话。 |
| `src/lib/bridge/permission-broker.ts` | IM 权限交互；仍直接依赖 Agent SDK 的 `PermissionUpdate` 类型。 |
| `src/lib/workflow/model-invoker.ts` | 独立的 Codex wrapper 子进程与 Claude 单轮 SDK 调用，统一返回 `Promise<string>`。 |
| `src/lib/workflow/workflow-engine.ts` | 多轮评审、检查点、问题账本、决策与补丁编排。 |
| `src/lib/workflow/types.ts` | 模型参数默认值、profile 与工作流公共类型。 |
| `src/lib/workflow/index.ts` | 评审引擎工厂，内部构造 `ModelInvoker`。 |
| `src/lib/workflow/auto-fixer.ts` | 创建修复 worktree，并再次独立构造 `ModelInvoker`。 |
| `src/lib/workflow/cli.ts` | 纯命令行评审入口和模型覆盖参数。 |
| `src/lib/bridge/internal/workflow-command.ts` | IM `/workflow` 入口，传入工作流 profile、快照和模型覆盖。 |
| `src/__tests__/unit/bridge-claude-sdk-settings.test.ts` | 用假 query 验证设置来源、流式文本去重与 assistant 正文兜底。 |
| `src/__tests__/unit/workflow-model-invoker.test.ts` | 用假子进程验证 wrapper stdin 参数和 EOF 处理。 |
| `src/__tests__/unit/workflow-engine.test.ts`、`workflow-code-review.test.ts` | 真实引擎依赖 + 假模型，验证工作流而非 SDK 兼容性。 |
| `src/__tests__/unit/workflow-cli-and-fix.test.ts` | 主要测试 IM 参数解析、卡片与类型；没有实际调用 CLI `handleSpecReview` 或 `AutoFixer.applyFixes`。 |
| `package.json`、`tsconfig.json`、`tsconfig.build.json` | 依赖、单测匹配、类型检查与构建范围。 |
| `node_modules/@anthropic-ai/claude-agent-sdk/{package.json,sdk.d.ts,sdk.mjs}` | 已安装 0.2.69 的版本、SDK 契约及内置运行时默认路径。 |

### 3. 已有能力与稳定边界

#### 聊天 bridge

- 已有 SDK 查询、工作目录、model、resume、systemPrompt、AbortController 和工具权限回调：`scripts/claude-to-im-bridge/llm.ts:81`、`:116`、`:133`。
- 已显式启用 `settingSources: ['user', 'project', 'local']` 与 partial messages：`llm.ts:123`。因此不能笼统说项目完全不能使用本机/项目配置中的 skills、hooks、MCP 或插件；能否加载某项能力应按 SDK 版本、配置来源和项目实际配置分别验证。
- 已捕获 SDK session ID，用于后续 resume：`llm.ts:85`、`:174`、`:233`；核心在 `conversation-engine.ts:417` 持久化 ID。
- 已处理 text_delta、最终 assistant 文本、工具使用、累计 usage 和最后一次 assistant usage：`llm.ts:179`、`:190`、`:198`、`:235`。
- 已有流取消、heartbeat 和 query close：`llm.ts:165`、`:279`、`:285`。
- 核心始终调用 `LLMProvider.streamChat()`；共享参数仍是 SDK session / model / cwd / abort / files：`host.ts:206`、`:221`，实际接线在 `conversation-engine.ts:215`。

#### 双模型 workflow

- 工作流已有 spec-review、code-review、review-fix；评审、问题匹配、终止与 Claude 裁决分步持久化，升级运行时应保留这些上层语义。
- 工厂 `_buildEngine()` 统一接线九个依赖：`workflow/index.ts:65`；公开入口是 `createSpecReviewEngine()`、`createCodeReviewEngine()`：`:92`、`:106`。
- 模型调用集中在 `ModelInvoker`，已有超时、错误分类、重试和取消：`model-invoker.ts:66`、`:90`、`:121`。
- Codex 评审实际命令是 `codeagent-wrapper --backend <backend> -`，不是直接 `codex exec`，也不是聊天 bridge 的 app-server：`model-invoker.ts:40`、`:223`、`:231`。wrapper 内部是否调用 `codex exec` 属于外部运行时行为，本轮未读外部 wrapper 实现，不能断言。
- Claude 评审另行动态导入 SDK：`model-invoker.ts:428`，使用 `tools: []`、`persistSession: false`、`maxTurns: 1`、`settingSources: []`：`:471`。这是有意隔离的纯文本裁决路径，不能把聊天的设置加载策略直接复制过来。
- AutoFixer 还会 `new ModelInvoker()`：`auto-fixer.ts:60`，所以重构工厂注入时也必须考虑自动修复，不可只修改 engine 工厂。

### 4. 版本与运行时分离

- 清单 Agent SDK 范围是 `^0.2.62`：`package.json:55`；当前安装为 `0.2.69`：`node_modules/@anthropic-ai/claude-agent-sdk/package.json:3`。此范围不会自动跨到 `0.3.x`，仅执行常规范围内更新不能到最新主线程已核验的版本。
- 已安装包 metadata 声明 `claudeCodeVersion: "2.1.69"`。本机全局 CLI `2.1.198` 与项目内置版本是两层依赖，数字不同不能据此认定桥接已使用全局 CLI。
- 本地 `sdk.d.ts:937` 明确规定未指定 `pathToClaudeCodeExecutable` 时使用内置 executable；`sdk.mjs` 默认在自身包旁定位 `cli.js`。聊天和 workflow 两处 options 都未设置该字段，因此当前 query 使用 SDK 包内运行时。
- 主线程 2026-10-04 核验的 npm latest 是 Agent SDK `0.3.289`、Claude CLI `2.1.289`、HTTP Client SDK `0.131.0`。这些是不同包；本报告未重复查询 npm 或执行安装。
- runner 用绝对路径导入 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`：`scripts/feishu-claude-bridge.ts:400`；这绕过 package exports 并耦合包内部文件布局。升级应检查新包布局并优先通过受支持的 package entry 解析，保留现有“使用指定项目安装目录”的宿主需求。
- `@anthropic-ai/sdk` 清单 `^0.39.0`：`package.json:56`。在 `src/`、`scripts/` 的 `.ts` 源码没有查到直接使用 HTTP SDK；旧 `ModelInvokerOptions` 注释还残留 `messages.create` 描述：`model-invoker.ts:29`。但主线程补充核验 **Agent SDK 0.3.289 要求 peer `@anthropic-ai/sdk >=0.93.0`、`@modelcontextprotocol/sdk ^1.29.0`、`zod ^4.0.0`**，因此目前 0.39.0 不能直接满足目标版本。HTTP SDK 是否由项目直接调用，与它是否为新 Agent SDK 必需 peer 是两件事；应在同一依赖升级切片对齐 peer，不按“业务未直接调用”删除必要 peer。

### 5. 已确认的缺口与风险

| 优先级 | 结论与证据 | 升级影响 |
|---|---|---|
| P0 | workflow 两处默认均为 `claude-sonnet-4-20250514`：`types.ts:503`、`model-invoker.ts:432`。主线程通过官方 release notes 核验该模型于 2026-06-15 API 退役。 | 必须迁移默认值及示例，具体替代模型以官方当前支持、账号可用性与任务成本决定。没有真实请求验证，不能声称本机当前报错已复现。 |
| P0 | spec-review CLI 在未提供 `--config` 时，`readConfig()` 返回 undefined：`cli.ts:231`；`:302` 和 `:303` 给临时 `{}` 赋值，而 `engine.start()` 仍收到原 undefined：`:305`。 | `--model`、`--codex-backend` 在这一场景实际丢失；只推荐用户通过 `--model` 避开退役默认值是不完整方案。code-review 使用 `mergedConfig`：`:347`，不受同一问题影响。 |
| P0（修复链路） | AutoFixer 创建 worktree：`auto-fixer.ts:100`，但调用 `invokeCodex` 没有 worktree cwd：`:119`；`ModelInvokerOptions` 没有 cwd：`model-invoker.ts:20`，spawn options 也没有 cwd：`:231`。修复 prompt 只有相对文件路径：`auto-fixer.ts:242`。 | 本地接线未保证模型在隔离 worktree 执行；后续 git diff/commit 却查看 worktree：`auto-fixer.ts:127`。这是确定的目录传递缺口；外部 wrapper 实际选目录、是否发生错误写入尚未验证。恢复 auto-fix 使用前应传入显式 cwd，并用假 runtime 验证。 |
| P1 | engine 传 `maxOutputTokens: config.claude_max_output_tokens`：`workflow-engine.ts:662`，默认 `64_000`：`types.ts:504`；`executeClaudeRequest` 从未读取 opts.maxOutputTokens。 | 输出 token 配置当前无效果。不要把它当作 SDK 有效 options 照搬；需按目标 SDK 的支持方式实现或移除无效配置。规范目前还有 SDK 输出 200,000 的旧陈述：`.trellis/spec/backend/workflow-engine.md:514`，需随实施纠正。 |
| P1 | Claude adapter 只处理 assistant tool_use 与直接 `msg.type === 'tool_result'`：`llm.ts:200`、`:219`，未处理 SDKUserMessage 中的 tool_result 内容块；本地 SDK 主消息 union 包含 `SDKUserMessage` 而不包含独立 tool_result 消息：`sdk.d.ts:1867`、`:2192`。 | 工具完成信息可能不能正确汇入 IM status。缺少 SDK 标准事件到 bridge 事件的完整转换，单纯升版本不会补齐。 |
| P1 | 0.2.69 已有 `tool_progress`、`system/task_started`、`task_progress`、`task_notification`：`sdk.d.ts:2129`、`:2146`、`:2162`、`:2173`；adapter 没有相应处理分支。 | SDK 能执行后台/子代理任务，但 IM 端缺少生命周期和进度呈现。应把新版事件映射到共享契约；现有 `task_update` 只认 `todos`：`conversation-engine.ts:389`，不能直接塞入异构后台任务对象。 |
| P1 | Claude result 的 `modelUsage` 已包含 `contextWindow`：`sdk.d.ts:624`，adapter result 只转发 usage/last_usage/is_error/session_id：`llm.ts:254`。 | Claude 端仍依赖静态上下文窗口；核心已支持 `result.context_window`：`conversation-engine.ts:413`，优先复用该字段。多模型调用时应制定“实际主模型”的选择规则，不能任取第一个条目。 |
| P1 | 共享契约带附件/历史/provider，但 adapter 的 query prompt 只有 `params.prompt`：`llm.ts:117`；文件内未消费 `files`、`conversationHistory` 或 provider。 | 当前 Claude 附件传入与无 SDK resume 时的历史恢复并不完整。应与版本升级分开明确验收，不能声称升级 SDK 后就自动支持图片/文档。 |
| P1 | 脚本独立复制 `StreamChatParams`、`LLMProvider`：`llm.ts:5`、`:19`，query 定义用 `Record<string, unknown>` / `AsyncGenerator<any>`：`:23`；结果和权限回调也依赖 any。 | SDK breaking changes 很容易绕过编译检查。优先接 SDK 的 `Options` / `SDKMessage` / `CanUseTool` 类型并复用 host 契约。 |
| P2 | workflow 只取 success `m.result` 文本：`model-invoker.ts:496`；0.2.69 已支持 `outputFormat`、`structured_output`：`sdk.d.ts:935`、`:1968`。 | 可用结构化输出降低决策 JSON 解析失败，但需保持 schema 验证、业务 DecisionValidator 和重试语义。属于增强项，不是所有升级的前置条件。 |

补充运行风险：wrapper 路径未显式指定 review 只读权限，也未将 target repo cwd 传给 Codex 评审。代码评审的快照和 prompt 本身可跨仓库，但 wrapper 本地配置、工具权限、全局模型与当前目录会影响实际调用；这些行为需在升级实现中核验，不能据现有 prompt 认为已强制只读。

### 6. SDK breaking change 关注点

本轮没有直接比较 0.2.69 与 0.3.289 的完整发布差异；主线程已核验官方 changelog 的下列变化，先作为确定迁移项记录：

- **0.2.113 起切换 native binary，env 替换父环境**：项目两处 query 均显式复制 `process.env` 后移除 `CLAUDECODE`，当前写法有利于保留 PATH 等变量。仍需核对 native binary 下载/解析与 Windows 运行，不把仅更新全局 CLI 当作修复。
- **0.3.142 异步 MCP 初始化，TaskCreate/TaskUpdate 替换 TodoWrite**：SDK settings 加载与 MCP 准备状态应验证；核心现有 `task_update` 的 `todos` 形状不能代表新版任务生命周期，应制定明确映射，避免旧待办同步失效。
- **0.3.286 omitted permissionMode 会遵循配置**：聊天 adapter 当前显式 `normalizePermissionMode()` 并传 permissionMode：`llm.ts:35`、`:127`，升级时应保留显式策略，不能因为新 SDK 能读取配置而省略它。
- **0.3.289 peer 依赖变化**：版本与 peers 按上一节同步对齐，不单独改 Agent SDK 的版本号后期待安装自动可靠完成。

以下兼容清单来自当前接入边界；未明确列入上述已核验变化的条目，不表示官方已经确认发生 breaking change。

1. **加载与执行路径**：package exports、SDK 内置 runtime、Node engines、Windows Bash 查找和 `pathToClaudeCodeExecutable`。现有两处会删除 `CLAUDECODE` 避免 nested session：`llm.ts:101`、`model-invoker.ts:467`，应保留正确的子进程隔离，但不靠旧行为推断新版实现。
2. **Query 生命周期**：异步消息流、cancel/abort、close、result 后续消息、无 result 时错误语义。聊天流还会消费 result 后续消息：`llm.ts:229`，不能提前断流丢进度。
3. **消息 union**：assistant/user content、partial message、task/progress、rate limit、status/model、compact、result subtype。用真实版本的事件 fixture 做映射回归，而非凭 any 静默跳过新格式。
4. **权限与 hooks/settings**：`CanUseTool` 的 toolUseID、agentID、blockedPath、decisionReason 和 allow/deny 返回类型。当前回调只保留 toolUseID/suggestions：`llm.ts:136`；本地类型还有其他解释信息：`sdk.d.ts:122`，可逐步呈现。不要擅自扩大既有 permissionMode。
5. **用量、输出与预算**：累计 result usage、单次 assistant usage、modelUsage/cost、结构化输出和输出限制。当前 result 不转发 `total_cost_usd`；如要显示费用，可转换成 `host.ts:52` 已有的 cost 字段，但需保持语义和单位。
6. **持久化会话与恢复**：sdkSessionId、模型切换、跨版本 resume、用户/项目 settings 加载。不得假设不同版本的历史 session 永久兼容，应安排隔离的可回退验证。

### 7. 编译、测试与构建的真实范围

- `npm run typecheck` 是 `tsc --noEmit`：`package.json:45`，`tsconfig.json:19` 只 include `src/**/*.ts`，rootDir 为 src：`:11`。`scripts/` 不在直接检查范围。
- `npm run build` 只编译 `src/lib/**/*.ts`：`tsconfig.build.json:13`，排除测试与 examples：`:14`；不会编译 Claude adapter 或 runner。runner 从 dist 读取 bridge 核心，但直接以 TypeScript 执行 scripts：`scripts/feishu-claude-bridge.ts:336`、`:340`。
- scripts 测试使用 `import(new URL(...).href)`：`bridge-claude-sdk-settings.test.ts:37`，运行时由 tsx 导入；静态 tsc 不会沿这个动态 URL 发现 scripts 的类型错误。
- `test:unit` 同时匹配 `bridge-*.test.ts` 与 `workflow-*.test.ts`：`package.json:50`，每个测试文件上限 15 秒，低于用户要求的 60 秒。不能误称 workflow 单测没有进入默认命令。
- Claude settings 单测目前 3 个行为：加载文件 settings、text delta 不重复、assistant 正文兜底：`bridge-claude-sdk-settings.test.ts:36`、`:74`、`:132`。没有工具结果、后台任务、权限中断、错误子类型、resume/无 result、附件等适配回归。
- workflow invoker 单测只有 wrapper 参数与 stdin EOF：`workflow-model-invoker.test.ts:60`、`:84`。Claude invoker 动态 import 不可注入 query，当前没有针对真实 `executeClaudeRequest` 映射的假 SDK 测试；引擎单测 mock 掉整个 invokeClaude/invokeCodex 不能验证 SDK 兼容性。
- `workflow-cli-and-fix.test.ts:229` 的“CLI compatibility”实际经 `parseWorkflowArgs` 测 IM 命令，并不运行 `src/lib/workflow/cli.ts`。这解释了 spec-review CLI 参数丢失未被覆盖。
- `bridge-runner-scripts.test.ts:13` 是脚本文本断言，不验证 SDK 的导入路径和装配可运行。
- 建议新增独立 scripts tsconfig/typecheck 命令，合理配置 rootDir 和 `.ts` import，并接入常规验证；当前无需为了检查 scripts 去扩大 dist 产物范围。
- 本轮没有执行测试，主线程负责 typecheck 和选定 mock 回归；没有把静态审计说成测试通过。

### 8. 影响范围与 GitNexus 局限

执行了只读 GitNexus CLI context / upstream impact，没有重建索引。

- `impact invokeCodex --direction upstream --include-tests` 返回 **HIGH**，5 个受影响节点、4 个入口/流程汇总，d=1 为 `AutoFixer.applyFixes`，d=2 为 workflow CLI `handleCodeReview` 与 IM `handleStartReviewFix`，d=3 为 CLI `main` 与 IM `handleWorkflowCommand`。这是升级 Codex workflow runtime 必须先告知的高风险范围。
- 图漏掉 engine 调用，但源码明确存在：`workflow-engine.ts:367`。真实直接调用方至少包含 `WorkflowEngine.runLoop` 和 `AutoFixer.applyFixes`；评审/恢复/修复入口都应覆盖。
- `impact invokeClaude` 返回 LOW / 0，不能视作没有调用方：源码 `workflow-engine.ts:656` 明确调用。此图在当前仓库不足以单独证明安全。
- `impact ClaudeCodeLLMProvider` 返回 LOW，直接关联 runner main、runner import 与 codex-llm import；class expansion 同时报告 `Binder exception: Cannot find property declaredType for p.`，结果不完整。
- `context ModelInvoker` 也有 Binder schema 错误；先前主线程 query 还发现 FTS indexes missing。后续实施不得把空 query / 零影响当作无调用方，应结合源码补齐并在工具可用后再跑修改前 impact / 修改后 detect_changes。

### 9. 推荐最小实施路径

1. **先修确定问题**：替换退役默认模型，修 CLI 的 config 合并；为 ModelInvoker 增加显式工作目录并把 AutoFixer 的 worktreePath 传入。修复目录用假运行时验证 spawn options 和后续 diff 一致，避免真实模型写文件。
2. **升级 SDK 与可靠检查**：更新 Agent SDK 与其必要 peers/lock 作为同一切片；确认其内置 native Claude runtime 与目标 Node/Windows；修 runner 导入；给 scripts 加类型检查，去掉 SDK 边界的 any，使不兼容消息/Options 编译失败。
3. **补最少必要回归**：Claude 标准 user/tool_result、权限 allow/deny 与 abort、success/error result、resume、no result、已知 task progress 的事件映射；workflow 用可注入 query 验证 SDK options 与错误分类；CLI 模型覆盖和 auto-fix cwd 用假依赖测试。
4. **复用聊天契约**：尽量保留 `LLMProvider.streamChat`，在 SDK 适配层规范化消息。`result.context_window` 已存在可直接利用；后台任务若与 todos 含义不同则新增明确结构，联动 host/conversation/UI，而非滥用旧字段。
5. **收敛运行时重复**：保留 ModelInvoker 的上层 `Promise<string>` 契约和 workflow 独立状态机；把 Codex app-server/进程封装中可复用的启动、取消、错误及配置解析提到清晰共享边界，或引入可注入的批处理 runtime 接口。无需强迫 SSE 聊天与一次性裁决共用同一个高层接口。若替换 wrapper，应一次切换并移除旧 runner 分支，不长留双实现兜底。
6. **增强按需进入后续任务**：结构化输出、完整 task/progress 呈现、模型目录与上下文窗口动态选择、附件能力。先定义独立验收，避免依赖升级夹带大规模产品功能。

### 10. 相关规范

- `.trellis/workflow.md`：任务优先、研究落盘；本轮处于 planning/research。
- `.trellis/spec/backend/index.md`、`directory-structure.md`：bridge 核心、脚本装配与测试的职责。
- `.trellis/spec/backend/module-boundaries.md`：host 契约与核心模块分层；避免 scripts 复制领域逻辑。
- `.trellis/spec/backend/integration-guidelines.md`：配置 key、启动命令、文档与测试同步。
- `.trellis/spec/backend/type-safety.md`：共享类型从 host/types 获取；外部输入 unknown + 收窄；公共边界禁止 any。
- `.trellis/spec/backend/testing-guidelines.md`：node:test、最小 mock、隔离真实平台与全局状态。
- `.trellis/spec/backend/workflow-engine.md:627`：所有 workflow 模型调用经 ModelInvoker；tools/settings 隔离；`:905` 使用真实工作流依赖与假模型。
- `.trellis/spec/backend/quality-guidelines.md`：错误分类、取消、资源清理与权限边界。

### 11. 外部引用与版本

- [Claude 平台 release notes](https://platform.claude.com/docs/en/release-notes/overview)：主线程已核验旧 Sonnet 模型 API 退役日期；本报告依据该证据标记迁移，CLI 订阅账号的实际调用结果未测试。
- [Claude Agent SDK TypeScript 官方仓库](https://github.com/anthropics/claude-agent-sdk-typescript)：本地安装 package.json 的 homepage；本轮直接查 0.2.69 已安装类型与源码，不假设官方最新类型和旧版完全一致。
- npm latest / 全局 CLI 版本由主线程于 2026-10-04 核验，本文件没有执行远端安装、全局升级或生产接口调用。

## Caveats / Not Found

- `python3` 在 Windows 当前环境 exit 1 且无输出，改用 `python` 成功确认任务；没有改变系统配置。
- GitNexus FTS/schema 不完整，impact 的 LOW/0 不是无风险证据；代码影响分析按图与直接源码综合判断。
- 没有读取外部 codeagent-wrapper 实现，不能给出它内部究竟用 exec、app-server 或其他传输的确定结论；仓库只明确调用 wrapper 进程。
- SDK 0.3.289 完整破坏性变更仍需实施时验证；本文已分别记录主线程核验的官方 changelog 变化与当前边界暴露的兼容核对点，未把推断当成 release note。
- 未对真实模型、账号、跨版本历史会话、子进程树终止和 wrapper 实际工作目录做集成测试；所有真实运行结论保留待验证状态。
- `src/` 与 `scripts/` 内未找到 HTTP Client SDK 直接用途，尚未审计非 TS 的外部消费者；目标 Agent SDK 已要求较新的 HTTP SDK peer，不能据此删除必要 peer。
- 本轮只新增研究文档，不进行业务代码修复，不对现有 tests/build 的通过状态作新承诺。
