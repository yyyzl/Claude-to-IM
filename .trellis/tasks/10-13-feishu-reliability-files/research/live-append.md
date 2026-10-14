# Research: 飞书 Codex 当前回合即时补充

- Query: 同一任务所有者的无附件文本补充进入正在执行的 Codex 回合，复用原卡；明确接收、历史、取消和后轮边界。
- Scope: mixed；当前源码、本地锁定协议及必要官方说明。
- Date: 2026-10-13
- 状态: Trellis Phase 1.2；父/子任务仍 planning，本研究不授权实施。
- 写入: 仅本文件；未修改业务源码、测试、spec、配置，未调用真实模型或生产飞书。

## Findings

### 1. 最小方案（建议，尚未实现）

采用每次 stream 的输入句柄回调：Codex provider 发布绑定本次调用的 closure；engine 包装它，同步登记补充、串行提交、保存成功 user，并在 assistant 写入前封口结算；manager 管来源、原任务归属、结果提示、统一 ack 和确认未提交后的正常调度。复用现有 activeTasksByChat、session lock、generation/runEpoch、taskPromises，不增加全局 append 注册表、持久队列或自动重试。

首版无需改 codex-jsonrpc：调用 RPC 前能证明未提交的情况返回 not-submitted；已调用后的异常保守归 unknown；匹配原 turnId 的成功收据归 accepted。不能解析错误文案猜“回合结束”，不能将 unknown 再送后轮。manager finally 晚于 assistant 保存，无法单独承担历史顺序栅栏。

### 2. 文件与事实锚点

| 文件/行 | 当前事实 |
| --- | --- |
| `src/lib/bridge/host.ts:254`、`:294` | StreamChatParams / LLMProvider 只有启动能力及 runtime 回调，无活跃输入契约。 |
| `src/lib/bridge/bridge-manager.ts:160`、`:185` | TurnContext 保存本地 UUID/binding/chat/generation/epoch/abort；ActiveChatTask 只有 abort/sessionId/startedAt，缺 context/原发送者/句柄。 |
| `bridge-manager.ts:346`、`:359`、`:411` | 登记与清理按 abort owner；ownsTurn 复验取消、epoch、generation、binding ID 和 session ID。 |
| `bridge-manager.ts:421`、`:455` | cancelChat 递增 generation、清 append/debounce/队列、abort 原任务；旧卡清理检查原 UI owner。 |
| `bridge-manager.ts:498`、`:719` | scheduleMessages 固定 context/来源 ack 并走 session lock；merged ack 保留全部 updateId、去重升序。 |
| `bridge-manager.ts:625`、`:633`、`:666` | pendingAppends 是裸 InboundMessage[]；drain 删除整个 buffer，flush 重新调度模型回合。 |
| `bridge-manager.ts:757`、`:772` | 忙时追加先于 handleMessage；仅比较 buffer 内发送者，未比较原任务 owner。 |
| `bridge-manager.ts:1016`、`:1037`、`:1055` | 控制/问答/审批原路消费；普通输入通过短 admissionGate 同步准入。 |
| `bridge-manager.ts:1337`、`:1345`、`:1456`、`:1645` | active 登记早于 engine；正常回合 onMessageStart 一次；模型返回后还有卡片收尾，finally 才清 active/ack/flush。 |
| `bridge-manager.ts:915`、`:943` | bridge stop 禁止准入、递增 epoch，taskPromises 排空有 5 秒本地上界。 |
| `src/lib/bridge/conversation-engine.ts:69`、`:114`、`:183` | InteractionCallbacks 是扩展入口；processMessage 固定 sessionId、先保存首条 user。 |
| `conversation-engine.ts:214`、`:237`、`:260` | engine 新建自己的 abortController；唯一核心 llm.streamChat 动态调用点，随后 consumeStream。 |
| `conversation-engine.ts:277`、`:524`、`:565` | consumeStream 正常和错误/取消两条路径都会保存 assistant，都要先结算补充。 |
| `scripts/claude-to-im-bridge/codex-llm.ts:17`、`:85` | ActiveTurn / activeTurns 按 threadId 登记，无明确 closed 阶段。 |
| `codex-llm.ts:161`、`:165`、`:191`、`:202`、`:205`、`:206` | 每次 stream 又建内部 abort；resume/start thread 后登记 active，startTurn 返回后才有 remote turnId。 |
| `codex-llm.ts:224`、`:450`、`:527`、`:535`、`:542` | 正常 finally 也 abort；collector 精确匹配 thread/turn、处理 completed、订阅并 drain early backlog。 |
| `scripts/claude-to-im-bridge/codex-jsonrpc.ts:239`、`:253`、`:259`、`:304`、`:318` | request 包含启动/写入/等待；超时、RPC error、断连均泛 Error，不能结构化证明某次没有接收。 |
| `src/lib/bridge/adapters/feishu-adapter.ts:998`、`:1004`、`:1519`、`:1578` | notifyAppend 拒绝 closing 卡，但文案不分 queued/accepted；text/post 归一化，InboundMessage 不保留 message_type。 |
| `src/__tests__/unit/codex-test-transport.ts:9`、`bridge-codex-jsonrpc.test.ts:9` | 内存 transport/backlog 和 processMock 可挂起、注入协议结果，不启动真实模型。 |
| `src/__tests__/unit/bridge-lifecycle-regression.test.ts:154`、`.ccg/append-debug/append-diagnostic.test.ts:108` | 可复用真实 manager 消费循环、取消/重启及旧回合隔离 fake；既有诊断已证明当前追加开独立后轮。 |

上述短文件名继承表内完整目录。既有调查 `.ccg/append-debug/investigation.md` 可只读复用，无需再搜索真实聊天或认证资料。

### 3. host 契约与身份（建议）

在 StreamChatParams 增加可选 onActiveTurnInput，在 InteractionCallbacks 增加对应回调；无需 LLMProvider.append(sessionId, ...) 或第二套 active registry。类型示意：

```ts
type TurnInputResult =
  | { status: 'accepted' }
  | { status: 'not-submitted'; reason: 'turn-ended' | 'cancelled' | 'unavailable' }
  | { status: 'unknown' };
interface ActiveTurnInput {
  submitText(text: string): Promise<TurnInputResult>;
}
// onActiveTurnInput?: (input: ActiveTurnInput) => void
```

remote thread/turn 留在 provider closure，manager 保存原 ActiveChatTask/context/ownerUserId/来源组。manager、engine、provider 各自持不同取消控制器（manager:1348、engine:214、provider:165），不能用 signal/controller 相同查找活跃 turn。本地 TurnContext.turnId 是 UUID，不能作为 expectedTurnId。

### 4. 同步准入、串行提交与收尾（建议）

1. admissionGate 内检查即时范围和原任务归属，同步建立来源序号/状态，并将来源交原 ActiveChatTask。即时来源不在 legacy pendingAppends 重复保留，防 finally 二次排出。
2. 句柄已存在时同步调用 engine.submitText，方法在返回 Promise 前登记 pending；控制循环不 await RPC、flush 或平台反馈。不能仅放进 manager 的 Promise.then 微任务，因为 EOF 可能先于登记。
3. active 已登记、句柄尚未发布的极短窗口，来源暂存于该 task 的 initializing 列表；回调到达时同步按序登记。发布前失败则结算未提交，取消则取消，不迁往新 binding。
4. engine tail 串行执行每条 submit/记录；下一条等上一条结果后再发。每来源一次，不按内容相似度去重，不按远端回执顺序或 timestamp 重排。
5. 来源结果与反馈任务纳入 taskPromises，持原 context；输入分类/历史结算不等待通知网络，不持 admissionGate。不得在原任务里 await 整个 taskPromises（包含自身）。
6. 状态至少区分 waiting/submitting/accepted/not-submitted/unknown/cancelled；submitting、accepted、unknown 永不由普通 finally flush 送后轮。

provider 在 catalog/thread 初始化前发布本次 closure，内部一次 ready promise 支持补充等待。ready 仅在 startTurn 得 remote ID、collector 已订阅且 early backlog 已 drain 后解决；fake 已可能在 turn/start 返回前发 completed，不能先标 active 再 drain。

matching turn/completed 在通知 handler 当场关闭新准入，再 resolve/reject collector；初始化失败、error/timeout、disconnect、cancel 同样关闭并解开 ready。不能等 provider finally 或卡片收尾才关闭；正常 finally 的内部 abort 不代表用户 stop。

提交前复验 closure、连接 epoch、remote IDs、取消及已有 activeTurns 对象身份。RPC 发出后捕获原 threadId/expectedTurnId；正确成功回执即 accepted，即使 completed/cancel 先到，也不得再用 closed 把成功降为未提交。

确认从未调用 steer 且原 turn 已 ended，才正常后轮一次；模型已结束但卡收尾时也如此。转交在短 admissionGate 内复验原 context，固定原来源/会话和新本地回合身份，复用 session lock。旧异步回调不能重新捕获已经切换的 binding。

finally 先分类全部已准入来源，再清 active/UI、统一 ack 当前回合来源，只排出可证明未提交且仍属原代际的后轮。后轮与 legacy 交错时保留来源顺序及 sender 分组，不能按异步完成顺序 merge，也不能跨用户混合。

stop/new/bind 继续通过 cancelChat（manager:1727/:1780/:1979），取消 waiting/未开始来源并停止新 RPC；已发 RPC 不宣称撤销，不重送。迟到 accepted 仅可记入捕获的原 session，不能改新 session/binding/卡片。原卡更新检查 ownsTurn + 原 UI owner；独立事实通知只检查 ownsTurn，否则正常 finally 清理 UI 会吞掉限流中的提示。通知仍受原 abort/generation/runEpoch/binding/session 约束并纳入 taskPromises。2026-10-14 独立检查用 RED/GREEN 证实此边界；通知携带原地址与 replyToMessageId，既有飞书适配器实际按聊天普通消息发送，不声称支持线程回复。

steer/pending 结算必须有限；可用现有 request 的显式 timeout，无新增重试。design 需明确它与 bridge stop 5 秒排空的关系；不能无限等待、伪称远端停止，或在历史已经封闭后补写迟到 user。

### 5. RPC 证据与结果界限

`package.json:59` / `package-lock.json:830` 锁定 @openai/codex 0.160.0。本地官方生成协议目录 P 为 `.trellis/tasks/archive/2026-10/10-05-codex-model-picker/research/codex-0.160.0-schema/v2/`。

P/TurnSteerParams.json:299–326：expectedTurnId 匹配 active turn，必填 expectedTurnId/input/threadId；文本项 :77–110，text_elements 默认为空。P/TurnSteerResponse.json:4/:8 要求字符串 turnId。请求只发 `{threadId, expectedTurnId, input:[{type:'text', text:sanitizedText, text_elements:[]}]}`，无模型/cwd overrides。

| 证据 | 分类及处理 |
| --- | --- |
| 本地 ended，且本条从未调用 request | not-submitted/turn-ended；原归属有效时正常后轮一次。 |
| 本地 cancelled/stale，且未 request | not-submitted/cancelled 或 unavailable；不迁往新任务。 |
| 正确成功响应且 response.turnId === 发出时 expectedTurnId | accepted；保存原 user、原卡确认、最终统一 ack，无新 turn/start。 |
| 已调用 request 后泛 rejection/timeout/disconnect/写失败包装错误 | unknown；不猜文案，不自动重送，明确提示。 |
| 空/错类型/不同 turnId 响应 | unknown；协议异常不当成功或安全后轮。 |
| RPC 中 completed 先到，随后成功 | accepted；completed 禁止后续提交，不否定原成功收据。 |
| RPC 中 completed 先到，随后异常 | unknown；completed 不能证明补充未接收。 |

request 包含 start/write，caller 调用之前是最小可证明未提交边界；调用之后即使异常实际发生在发送前，也保守 unknown。因此无需改 JSON-RPC；真实远端拒绝也可能被显示 unknown，这是明确取舍。本地 schema/滚动 docs 不提供稳定“未接收”错误类别，不能从通用 code/message 猜状态。

### 6. engine 历史封口及来源 ack（必要建议）

包装句柄的 submit 同步登记 pending，accepted 后用 processMessage 固定 sessionId 保存 sanitizedText 为 user，再返回 manager。backend 接收与本地保存分开；addMessage 失败不是 not-submitted，不得自动重送。

EOF、错误、取消共用一次幂等 sealAndSettleInputs：同步封口；有界结算已登记输入，按顺序保存 accepted user；之后才允许 consumeStream:524/:565 两处 assistant 写入。保存失败不能由 catch 重跑提交/记录，也不能无条件写 assistant 掩盖缺失。成功历史为 原 user → 补充 user1 → 补充 user2 → 原 assistant。

manager 保留完整来源组，不只留文本/最后 messageId。原输入与 accepted/unknown/取消且已处理的即时补充在原 finally 统一 ack；确认未提交转后轮的来源移交后轮 ack，不提前确认。复用 merged ack 去重/升序规则，避免重复 finally。

飞书当前没有 updateId/acknowledgeUpdate，该步骤是无操作；来源组仍保留供后续去重子任务继承。当前不实现 ledger、不加持久字段、不承诺跨崩溃恢复。

### 7. 范围保持

- 即时仅飞书、原回合实际 backend 为 Codex、追加开关开启、无附件非空普通文字、非空相同 ownerUserId；复验 chat/session/binding/generation/epoch。不要随异步配置漂移改归属。
- 普通文字指已归一化无附件 text/post，不新增 message_type；复用 sanitizeInput（validators.ts:106）和截断审计，避免绕过 handleMessage 后失去输入约束。
- callback/问答/模型按钮/审批数字、所有单斜杠/双斜杠和 /codex:* 沿原路，不绕过 manager:1253–1308 的 help/透传/命令语义。
- 其他 sender/chat/session/channel/backend、附件、追加关闭沿现有 debounce/排队/后轮路径和 sender 分组，不混入原 Codex 回合。
- accepted 前不显示“已追加当前回合”；legacy 明确待后轮。必要时 notifyAppend 可加可选 queued/accepted 显示态，原默认 queued；不改卡片创建/工具 tracker 代际。
- accepted 不再 onMessageStart；新增工具/正文继续原卡。卡已 closing 时只发有归属的普通结果提示，不创建第二张过程卡。
- 额度、审批、outbox/补发无需改；网络后台任务可跟踪，控制循环不等网络。

### 8. 最小 meaningful fake 矩阵

主回归用真实 manager + engine + Codex provider + 内存 JSON-RPC/飞书 transport，记录 RPC、历史、卡片与来源 ack；不能只 mock engine 证明顺序。

| 场景 | 核心断言 |
| --- | --- |
| 正常 active 补充 | 一个 turn/start/卡；精确 steer 输入；仅收据后已追加；新增工具原卡。 |
| 连续两条、首回执挂起 | 第二条不先发，各一次；user/user/user/assistant；所有来源最终 ack。 |
| thread/turn 尚未建立 | 不发空/猜测 ID；ready 后原 turn；初始化失败/取消解开等待。 |
| start 返回前 completed backlog | 订阅/drain 后 closed；从未 steer 的补充后轮一次。 |
| completed + finalize 挂起 | 不 steer 已结束 turn；原卡收尾后正常新轮。 |
| completed 先于成功收据 | accepted user 先于原 assistant；无后轮。 |
| 超时/断连/泛 error/坏或错 turnId | unknown；无自动 steer/turn/start；finally 不重排来源。 |
| stop/new/bind × initializing/queued/submitting | 未提交不发、已提交不重送；旧/新卡与 session 隔离，切回相同 ID 仍受 generation 隔离。 |
| stop/restart + 挂起 RPC | 有界排空/隔离；新 epoch 不执行旧来源；ack 无遗漏。 |
| chat A steer 挂起 | chat B 控制/审批和 A stop 仍消费，不持 admissionGate 等网络。 |
| 来源/开关/slash/附件矩阵 | 无错误即时 steer，原路径与 sender 分组不退化。 |
| accepted user 保存失败及错误/取消收尾 | 不重送、不假报未提交；共同封口不倒序/重复，迟到回执不补写到 assistant 后。 |

实施后运行相关 Codex/engine/manager lifecycle/Feishu/quota/permission/image/delivery 回归；每批外层硬超时 60 秒，再 typecheck/build 和实际 diff/GitNexus 范围核对。本研究未运行新实现，不以旧测试通过证明新功能。

### 9. 候选符号、影响与相关规范

候选：StreamChatParams、新结果/句柄类型、InteractionCallbacks；ActiveChatTask、registerActiveTask/clearActiveTask、enqueueRegularMessage、handleMessage 的输入/来源/finally；processMessage/consumeStream；Codex streamChat/ActiveTurn/collectTurnText；必要时 BaseChannelAdapter/Feishu notifyAppend。尽量不改 scheduleMessages、通用 legacy 队列和 JsonRpcAppServerClient。

GitNexus 1.6.12 status：仓库 G:\project\Claude-to-IM/main，索引/current c651157，105 covered files 匹配。FTS 无法加载，query 空结果不代表安全；用准确符号和当前源码补证，无系统安装/索引刷新。
主会话 impact：register/clear CRITICAL（d1 handleMessage，6 flows）；processMessage CRITICAL（14 impacted，d1 handleMessage/mock-host.main，7 flows）；streamChat UNKNOWN/lower-bound，源码 engine:237 的动态调用补证。
本研究 context/impact consumeStream：CRITICAL（8 impacted，d1 processMessage，d2 handleMessage/mock-host.main，5 flows）。图的 JSONRPC.handleLine d3 是动态/同名推断，真实链以 processMessage:260 → consumeStream:277 为准。
既有调查 enqueueRegularMessage LOW（d1 runAdapterLoop，2 flows）；scheduleMessages CRITICAL（d1 enqueue/flushDebounced/flushPending，5 flows）。HIGH/CRITICAL 实施前须告知；最终逐符号 impact 和 detect_changes 不由本研究替代。

相关 specs：workflow.md 的 planning/批准分离；backend/module-boundaries、integration-guidelines 的 host 边界；type-safety 的 runtime 判别；reliability-contracts 的固定归属、可跟踪网络及有界取消；testing-guidelines 的 fake 注入与真实入口硬阻断。
外部参考：[OpenAI Docs：Codex App Server](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)（2026-10-13 读取）补证 steer 使用活跃原 turn、返回 accepted turnId、不发新 turn/started。滚动网页不替代固定 0.160.0 schema，也不证明本版本错误分类/自动重试。

## Caveats / Not Found

- schema 存在可选 clientUserMessageId，但未声明去重/幂等保证，也未提供接收状态查询合同；首版不依赖它证明未提交或 exactly-once。unknown 不自动重送，不提供跨崩溃恢复。
- 接收不保证补充改变已发送 token，不撤销已开始工具；fake 证明协议/生命周期/历史，不能证明真实模型最终答复质量。
- 正常结束与取消不能只看内部 abort；accepted 后存储失败单独报告，不是安全重送理由。有限等待与迟到收据的最终封口需在 design 明确。
- 补充后轮与 legacy 交错的来源顺序/用户分组要回归；不得按完成顺序重新 merge。若引入持久状态、自动重试或通用 RPC 错误系统，应重新审阅范围。
- 工具调用简报：PowerShell/rg 读取最小源码/spec/诊断/固定 schema；GitNexus status/query/context/impact（FTS 退化，以源码补证）；Web 仅读 OpenAI Docs；唯一写入本文件，无真实模型/飞书及业务测试。
