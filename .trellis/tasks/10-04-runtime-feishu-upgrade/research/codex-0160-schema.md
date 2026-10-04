# Codex 0.160.0 本地协议核验

日期：2026-10-04。执行项目依赖的 `node node_modules/@openai/codex/bin/codex.js --version`，返回 `codex-cli 0.160.0`；执行 `app-server generate-json-schema --out <临时目录>` 成功。没有启动会话、登录或请求模型。

完整生成物保存在系统临时目录 `claude-to-im-codex-0.160-schema`，不纳入仓库。以下字段来自该版本生成的 JSON Schema，而非推测旧协议。

## 握手、模型与会话

- `initialize` 接受 `capabilities.experimentalApi`，默认 false；用户输入协议仍标记 experimental。初始化响应后发送 `initialized` notification。
- `Model` 同时包含目录 `id`、实际模型 `model`、展示 `displayName`。不得将展示名当持久化模型 ID；`turn/start.model` 使用实际模型字符串。
- `defaultReasoningEffort`、`supportedReasoningEfforts[].reasoningEffort` 是非空字符串，不能限定在旧枚举。`inputModalities` 默认 text/image，显式能力以目录为准。
- `thread/resume` 必需 `threadId`，可加 `excludeTurns:true`、`cwd`、`model`、`approvalPolicy` 和 `sandbox`。恢复响应包含 `thread`、实际 `model` 和 `reasoningEffort`。
- `turn/start` 使用 `threadId`、`input`；支持 `model`、`effort`、`cwd`、`approvalPolicy`、`sandboxPolicy`。`readOnly` 和 `workspaceWrite` 是 sandboxPolicy 对象的 type，thread 的 sandbox 则采用 SandboxMode 字符串。
- `UserInput` 文本为 `{type:'text',text}`；图片为 `{type:'image',url}` 或 `{type:'localImage',path}`。

## 服务端主动请求

| 方法 | 响应要点 |
| --- | --- |
| `item/commandExecution/requestApproval` | `{decision:'accept'|'acceptForSession'|'decline'|'cancel'}`；另有 execpolicy/network amendment 对象，本轮无需隐式授权持久策略 |
| `item/fileChange/requestApproval` | 相同四种字符串 decision |
| `item/permissions/requestApproval` | `{permissions:GrantedPermissionProfile,scope:'turn'|'session'}`，scope 默认 turn；拒绝返回空 permissions |
| `item/tool/requestUserInput` | `{answers:{[questionId]:{answers:string[]}}}` |
| `mcpServer/elicitation/request` | `{action:'accept'|'decline'|'cancel',content?:...}`；未支持的表单/URL 模式须明确拒绝或取消 |

`PermissionsRequestApprovalParams` 包含 threadId/turnId/itemId/cwd/startedAtMs/permissions。permissions 的 fileSystem 支持 entries、旧 read/write，network 支持 enabled；只授予用户批准的请求范围。

`ToolRequestUserInputParams` 必需 `isBlocking:boolean`、threadId/turnId/itemId/questions。问题含 id/header/question，以及可选 isOther/isSecret/options。不能把选项选择当执行工具的 allow/deny。

MCP elicitation 的 mode 支持 form、openai/form、openaiForm、url；turnId 可 null，不能假定每个请求都有活动回合。未知服务端 RPC 须返回协议错误，不应无响应悬挂。

`serverRequest/resolved` 通知包含 requestId 和 threadId，可清理已在其它客户端处理的交互。

## 终态与事件

- `turn/completed.turn.status` 为 completed/interrupted/failed/inProgress；error 包含 message 和可选 additionalDetails/codexErrorInfo，不能一律视为成功。
- agentMessage 的 phase 区分正文与 commentary；commandExecution 的最终字段是 status、exitCode、aggregatedOutput；fileChange/mcpToolCall 同样有明确最终状态。
- `thread/tokenUsage/updated` 必需 threadId、turnId、tokenUsage。tokenUsage 的 last/total 含 inputTokens、cachedInputTokens、cacheWriteInputTokens、outputTokens、reasoningOutputTokens、totalTokens，以及 modelContextWindow。输入总量与缓存子项不能机械重复相加。

此核验仅确认协议结构；账号可用模型、真实飞书投递与运行中服务切换仍需相应环境联调。
