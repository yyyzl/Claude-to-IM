# Codex 与共享交互实现记录

## 文件与行为

- `codex-jsonrpc.ts`：区分服务端请求与客户端响应 ID 空间；新增响应/通知/断开事件；未知请求返回 -32601；脱敏覆盖 Bearer/JSON key-value；重启后的旧进程回调隔离；测试环境默认禁止真实 spawn。
- `codex-utils.ts`：默认解析桥接安装根的固定 npm runtime；显式 bin 优先；目录 isDefault 选择、精确模型校验、动态 supportedReasoningEfforts；移除旧字符串评分/PATH 回退。
- `codex-llm.ts`：完整握手、模型分页、按会话模型/effort/权限、thread/resume、turn/interrupt、失败终态、早到审批与问答、现代工具生命周期、独立进度、图片输入、公开 usage/contextTokens。移除私有 rollout 扫描和旧事件兼容逻辑。
- `host/types/channel-adapter`：新增 user_input_request/progress、通用问题/答案、问答卡片与进度钩子、scope/updatedInput、reasoningEffort。
- `user-input-broker.ts`：聊天/平台/原卡/发起用户校验，答案合法性校验、TTL、防重复，`/answer` 后备入口；秘密问题明确拒绝。
- `conversation-engine/bridge-manager/permission-broker`：流中即时交互、进度隔离、审批 scope、/model、明确中断收尾、公开 contextTokens；非法审批 action 不抢占请求。
- `channel-router.ts`：新建/重绑时清理上个模型的 reasoningEffort；`internal/bridge-help.ts`、runner 中文文档同步。

## 影响分析

使用 `gitnexus impact <symbol-or-uid> -r Claude-to-IM --direction upstream --depth 3 --include-tests`。主要结果：

| 范围 | 风险 | 直接调用方 / 执行流 |
| --- | --- | --- |
| RPC request | HIGH | ensureInitialized / startThread / startTurn；4 条 Codex 流程 |
| RPC handleMessage / start / redactSensitive | HIGH | handleLine → start → request；4 条 Codex 流程 |
| Provider ensureInitialized/startThread/startTurn/collectTurnText | LOW（图） | streamChat；宿主依赖由 DI 调用，不能据 LOW 判断隔离 |
| consumeStream | HIGH | processMessage；4 流程、8 符号 |
| processMessage | CRITICAL | bridge-manager.handleMessage、mock-host.main；5 流程、10 符号 |
| handlePermissionCallback | CRITICAL | handleMessage/handleCommand；5 流程、7 符号 |
| manager handleMessage/handleCommand/help | HIGH | 正常消息、命令、debounce/append、adapter loop |
| router startNewSession | CRITICAL | resolve、handleCommand；5 流程 |
| router bindToSession | HIGH | handleCommand；4 流程 |
| router createBinding、waitFor、model utils | LOW（图） | 对应调用方与测试 |

Codex 文件旧 helper 的影响扫描保存在 `codex-impact-details.json`。类级展开出现 `declaredType` binder 错误；以源码和已扫描方法补齐。主要入口在编辑前进行了分析；旧 model utils 被移除的内部评分 helper 另做了补充扫描（LOW，直接依赖 selectCodexModel/baseScore）。没有重建索引，没有提交。新增 broker/transport mock 尚不在旧索引中，以类型检查和跨层测试覆盖。

## 验证

- 协议/JSON-RPC/模型目录：`node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-codex-*.test.ts tests/codexUtils.test.ts`（此前 19 例通过，随后增加了 cwd 回归）。
- 共享流/问答/审批/manager：29 例通过；包含 `/answer` 解锁正在等待的流、progress 不进入正文。
- channel-router + utils：19 例通过（包括会话切换清理 effort 与跨 cwd 本地运行时解析）。
- `npm run typecheck` 通过；最终统一 build/full suite 由质量门执行。
- `git diff --check` 通过，保留仓库原有 Git autocrlf 提示。
- 协议形状使用项目 Codex 0.160.0 离线 schema 核对。早到请求在 turn/start 响应前进入 active thread handler；目录失败后重连、断开后迟到回复、旧进程迟到 exit 有回归。

## 限制与测试事件

- 精细权限 `item/permissions/requestApproval`、MCP elicitation 返回明确拒绝并提示本地处理；未伪装成已支持的完整授权界面。秘密输入不在聊天收集。
- 模型目录不证明实际账号 entitlement。没有飞书生产消息联调。
- 初次 RED 测试曾因未实现的 client 注入启动真实 Codex；不可声称本次完全没有真实后端调用。详见 `testing-isolation-incident.md`。已使用默认 spawn 硬拒及纯内存双向传输防止再次发生。
