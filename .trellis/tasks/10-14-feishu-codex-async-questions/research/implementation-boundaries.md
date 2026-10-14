# Research: 飞书 Codex 非阻塞问答与闭合问题补充边界

- Query: 用最少改动正确展示 Codex 非阻塞问题，并在原请求闭合后保留原问答卡的选择/输入，允许用户明确点击“作为任务补充发送”；复用既有即时追加/后轮且不污染其他任务。
- Scope: internal；引用已经完成并落盘的官方协议研究，不重复外部检索。
- Date: 2026-10-14

## Findings

### 1. 已有证据与文件位置

| 文件 | 本次相关职责与代码锚点 |
| --- | --- |
| `.ccg/codex-user-input/research-summary.json` | 0.160.0 与官方最新观测版本 0.162.1 的三份问答/解决通知 schema 相同；两项内存诊断、40 项相关测试通过。该目录被忽略，不能作为唯一长期任务依据。 |
| `scripts/claude-to-im-bridge/codex-llm.ts:115` | 已接收 `serverRequest/resolved`，按 raw RPC ID 找到本地 permission ID、标记 resolved 并 deny；目前丢失闭合原因及通知 thread 的核对。 |
| `scripts/claude-to-im-bridge/codex-llm.ts:409` | 解析问答、等待真实 gateway，并把答案回传原 RPC；所有请求都写 waiting_for_input，未投影 isBlocking。 |
| `scripts/claude-to-im-bridge/codex-llm.ts:257` | 正常流收尾也会 abort 内部信号，因此未答问题目前被 gateway 当作 cancelled。 |
| `scripts/claude-to-im-bridge/permissions.ts:19` | onResolution 支持先解决后订阅；completed 最多 100 条且只复制 behavior/reason，不保存答案体。 |
| `src/lib/bridge/host.ts:322` | PermissionResolution、UserInputRequest/Response 公共契约。 |
| `src/lib/bridge/user-input-broker.ts:12` | 原问答转发、发送边界、来源校验；目前一旦解决就删除原题，缺少闭合未答记录。 |
| `src/lib/bridge/user-input-broker.ts:49` | 可复用的答案合法性规则：原 chat/channel/user/card、已知问题 ID、非空字符串、单/多选、选项限制。 |
| `src/lib/bridge/interaction-lifecycle.ts:6` | 通用审批观察与终态回写，deny 被压成 denied，终态卡删除表单；不宜为问答补充而扩散审批行为。 |
| `src/lib/bridge/markdown/feishu.ts:413` | 单份问答表单渲染；稳定字段 q0/q1、select_static/input 和提交按钮，可直接按问答阶段变更按钮。 |
| `src/lib/bridge/adapters/feishu-adapter.ts:585` | 回调真实 chat/card/user 来自飞书 context/operator；表单解码只入队，不调用模型。 |
| `src/lib/bridge/adapters/feishu-adapter.ts:1049` | 发送原问答卡，含 30KB 卡片预算及 secret 拒绝；replyTo 实际使用 im.message.reply。 |
| `src/lib/bridge/adapters/feishu-adapter.ts:1097` | 通用 updateInteractionMessage 用普通终态替换原卡，当前不会保留选择/输入。 |
| `src/lib/bridge/bridge-manager.ts:432` | ownsTurn 核对原 abort、run epoch、chat generation、binding ID、session ID；正常收尾不取消该 context。 |
| `src/lib/bridge/bridge-manager.ts:442` | cancelChat 为 stop/new/bind 共用取消点，即使没有 active task 也推进 generation；目前只清理 active session 的 pending 问答。 |
| `src/lib/bridge/bridge-manager.ts:692` | tryLiveAppend 对同原 sender、飞书 Codex、文本、原 active task 才提交原 closure；unknown 不自动重播。 |
| `src/lib/bridge/bridge-manager.ts:850` | enqueueRegularMessage 已处理 live/后轮/debounce 和来源顺序；可作为补充唯一正常输入入口。 |
| `src/lib/bridge/bridge-manager.ts:1110` | consume loop 控制分支；model/quota 已采用 taskPromises 追踪且不等网络，可按相同模式接专用补充 DTO。 |
| `src/lib/bridge/bridge-manager.ts:1561` | 已在本回合 onUserInputRequest 捕获 context，可传问答归属闭包；1570/1732 正常 result/finally 当前无差别 clear。 |
| `src/lib/bridge/internal/model-selection.ts:9` | ChatAdmissionGate 串行同 chat 的准入/切换，不能持有它等待模型或平台。 |
| `src/__tests__/unit/bridge-feishu-live-append.test.ts:1` | 真实 manager/provider/FeishuAdapter + FakeClient + 内存 SDK 传输；硬阻断子进程、Socket、fetch；已有 accepted/unknown、结束早于收据、cancel/new/bind 等边界。 |

### 2. 协议事实及外部参考

- 官方最新观测版本为 0.162.1；当前固定 0.160.0。相关 `ToolRequestUserInputParams`、`ToolRequestUserInputResponse`、`ServerRequestResolvedNotification` 的生成 JSON schema 经解析比较相同，因此本任务不用升级 Codex 或修改依赖文件。
- `isBlocking` 是 Codex 问答参数中的必填布尔值；`autoResolutionMs` 在两版 schema 中均标记 deprecated，不能按该字段另加猜测的短答题截止时间。
- options 可为 null，代表自由输入；厂商 schema 没有 multiSelect，现有通用桥接 UI 的多选能力不能被当成 Codex 原生多选保证。
- 服务解决通知含 `threadId` 和 `requestId`，既可能是用户回答，也可能是生命周期清理；通知本身没有“模型已看到此用户答案”的成功收据。
- 有效请求的答案必须回原 JSON-RPC ID，闭合补充是新的普通任务文字，不能回复旧 RPC，也不能把按钮展示当作收到答案。
- 已有异步 request handler 并不会强制模型停止；本次是状态投影与闭合问答体验补齐。

官方来源（本次复用前一轮已验证内容）：

- https://learn.chatgpt.com/docs/app-server — 原请求回答与 serverRequest/resolved 生命周期。
- https://learn.chatgpt.com/docs/changelog — 2026-09-08 iOS 更新中支持 Codex 工作时回答实时问题；不推断所有平台/模型账号都可用。
- https://developers.openai.com/api/docs/guides/async-tool-calling — 异步答案返回原调用的原则；Responses API call_id/response 生命周期不能代替本项目 app-server requestId/turn 生命周期。
- 本地版本证据：`.ccg/codex-user-input/schema-comparison.json`、`.ccg/codex-user-input/0.162.1/release-receipt.json`、该版本 `schema/ToolRequestUserInputParams.json`。

### 3. 推荐终态与可补充资格

建议 `PermissionResolution.reason` 仅新增 `request_closed | turn_completed`，保留现有 expired/cancelled/delivery_failed。不用 message 字符串判断语义；现有 gateway 已复制 reason，无需改它的存储实现。

| 事件 | 原 RPC | 原卡后续 | 可作为补充 |
| --- | --- | --- | --- |
| 原问答仍有效，用户提交 | 回原请求结构化答案一次 | answered，去表单 | 否 |
| serverRequest/resolved 与原 thread/raw ID 精确匹配，且本地尚未提交 | resolved=true，禁止迟到回复 | request_closed，保留表单、按钮改为明确补充 | 是，仍须完整归属 guard |
| 原 turn 正常 completed，问答未提交 | 在内部 abort 前 resolved=true + turn_completed | turn_completed，保留表单、明确后轮语义 | 是 |
| 用户 stop/new/bind、bridge stop | cancelled，禁止旧任务重开 | 取消/失效，无可操作入口 | 否 |
| failed/interrupted、超时、断连、secret、发送失败、格式无效 | 原错误/拒绝流程 | 不可补充终态 | 否 |
| gateway 本地答题期限 expired | 原请求已自动 deny，保留现有过期语义 | expired，去入口 | 本次不自动提升为可补充 |
| 已 submitted/supplemented、结果 unknown、TTL/容量淘汰 | 不再访问旧 RPC | 最终事实/失效 | 否 |

实现应在 provider 的正常 collect 结果返回后、emit result 或 finally 内部 abort 前显式关闭本 active turn 的未答问答。raw 请求记录至少保存所属 active/thread/turn 及方法，不能清空其他聊天的问答或审批。失败结果不可走此正常关闭路径。

`serverRequest/resolved` 先核对通知 threadId 与记录 threadId；原 raw ID 已在本地成功解决的 allow 路径绝不再进入闭合保留。通知到达时 active 已外部取消/连接已换 epoch，要收敛为不可补充，而非把先前 cancelled 复活为 request_closed。

### 4. broker 记录与生命周期

建议 pending 和 closed 未答记录均由 user-input-broker 拥有，问答专属观察代替此处的 generic observeInteraction；通用审批 helper 保持原行为。保留内容只有原 request、原 address、sessionId、原 card messageId、归属检查闭包、闭合时间/状态及必要的 UI 更新序号；不保存已经提交的答案正文。

- closed 仅限具备飞书专用更新能力、Codex 原任务提供归属选项、非 secret 且发送成功的原问答；不让其他 provider/channel 的普通 deny 获得补充入口。
- 关闭后保留 10 分钟、进程合计最多 100 条；TTL 从关闭时计时，容量按最早关闭淘汰。清理计时器须 unref/可取消；验证入口先 prune，可结合一只最近截止时间 timer 做及时卡片失效，不建立每答案计时器。
- TTL/淘汰/主动 invalidate 清除题目及闭包、取消该记录计时，不保存答案体；可更新原卡为失效，但平台失败不能延长服务端资格。
- 原消息发送 promise 挂起期间也可能已关闭。记录必须先建再订阅（onResolution 可能同步回放终态），messageId 到达后只回写当前阶段；不能重建成 pending、延长 TTL 或恢复已取消入口。
- 发送已过期/取消后迟到成功只更新终态；无可信 messageId 时闭合卡不可被 callback claim。
- 正常 manager result/finally 清理 pending 不得删除已经由 request_closed/turn_completed 保留的 closed 记录。取消清理另走 chat/address 范围的 invalidate，避免仅按 sessionId 清理误伤其他聊天同 session。
- 没有 active task 的 `/stop`、`/new`、`/bind` 同样需要 invalidate closed 卡；bridge stop 要全量清理，而不是只遍历 active 聊天。generation/epoch 仍作为迟到回调拒绝的最后防线。
- 协议请求原题体积、问题数量应有界；卡片仍沿用最终 UTF-8 30KB 预算。答案复用现有 32K 字符单值规则，补充整段继续经过 sanitizeMessageInput 的控制字符处理、32K 限额和截断审计。若最终原题+答案被截断，不能声称传了完整答案。

### 5. 原 task 与新回合隔离：最小 guard

转发时 manager 捕获原 TurnContext 的 turnId；给 broker 传 `isCurrent: () => ownsTurn(context)` 和补充资格检查闭包，而不向 broker 暴露 manager 私有状态。

claim 在 ChatAdmissionGate 内同步要求：

1. state.running、adapter running、原 run epoch 有效。
2. 原 channel/chat/user 与真实 callback 原 card messageId 一致。
3. ownsTurn(context) 为真：原 abort 未取消，generation/epoch/binding/session 仍匹配。
4. 当前 active task 为空，或其 context.turnId 等于该原 turnId。
5. closed 阶段仍为可补充，未过 TTL、未 claim，答案合法。

第 4 条防止旧问题偷偷 steer 同一 session 的后来回合。新回合活跃时明确拒绝，不消费保留记录、不自动排入那一轮；当前回合结束后、仍在 TTL 且其他归属有效时，用户再次明确操作可走正常后轮。无需修改 enqueueRegularMessage/tryLiveAppend 来支持“跨回合即时补充”。

原 task 正常收尾清理 uiOwners 不应导致该问答失效；问答的 ownsTurn guard 不依赖 UI owner。原 task 已 active 但 closing/模型已结束时，既有 enqueue 路径会形成正常后轮；只在原活跃输入 closure 确认 accepted 后称为即时追加。

### 6. 专用 callback 与一次性 claim

推荐新增专用 `UserInputSupplementResponse`（requestId + answers），并接 `InboundMessage.userInputSupplementResponse`；不要用普通 text/callbackData 假装已验证消息，也不要接受 callback value 提供的原题、session、turn、chat 或 user。

- Renderer 仅把补充专用 request ID 和稳定字段映射放进明确“作为任务补充发送”按钮；adapter 复用现有表单解码，把补充 DTO 与原 UserInputResponse 区分。真实 chat/card/user 始终来自飞书上下文。
- broker 用同一答案验证 helper 校验原问题/选项，拒绝未知 question ID、空值、非法多选、限制选项外值、错误 card/user/chat。
- 从 broker 自己缓存的原 request 生成“补充此前任务中已关闭的问题：原题…；我的答案…”普通文字；固定前缀确保答案中的 `/stop` 等字符不会成为桥接控制命令。
- 明确补充按钮在问题尚 pending 时拒绝，普通提交答案按钮在 closed 时拒绝；两种 DTO 不自动互相转换。
- 合法补充在 gate 中一次性 claim，然后同一同步准入回调调用 enqueueRegularMessage；两个同卡 callback 即使 messageId 不同，也只允许一次 claim。一次性资格不能按 callback messageId 去重代替。
- 原请求已经 answered、本地普通答案提交进入不确定窗口、补充 steer 为 unknown，均不可恢复补充资格自动重播。
- claim/队列准入失败不得伪称“已追加到当前任务”；可以显示无法接收/已排队的实际状态。UI 更新失败不回滚已经成立的模型接收或本地准入。
- 给合成正常输入保留该 callback 的真实 address、messageId/updateId，清除控制 DTO 后让既有来源确认处理；不要先 ack 控制事件再让正常输入重复 ack。否决时可立即 ack，合法来源由原任务或后轮按既有规则确认。

### 7. 消费循环与卡片更新

runAdapterLoop 必须把补充 DTO 分类为控制事件；按 model/quota 的跟踪任务模式派发 handleMessage，并立即继续 consume。handleMessage 只在 admissionGate 内等待短暂本地准入；不能在 gate 或控制循环内 await turn/steer、模型、平台 patch、提示发送。

卡片更新用问答专用 `updateUserInputRequest` 抽象方法（原 address/messageId/request + 阶段），不把原题缓存放进 FeishuAdapter。复用 buildUserInputCard 选择/输入生成，在 pending/closed/answered/supplemented/expired/cancelled 阶段改变说明和按钮；其他审批仍用 updateInteractionMessage。

- pending 阻塞问答显示等待回答；非阻塞问答显示“Codex 正在继续，可补充回答”。原选择和输入同时存在，不误称只有选择题。
- closed 保留原题、选项和 input，使用明确补充按钮；answered/supplemented/失效必须移除入口。
- 更新按单条问答串行、阶段序号检查并设置有界等待；迟到 closed patch 不能最终覆盖 supplemented/cancelled 终态。仅开始调用前检查归属不能撤销已进入平台的旧 patch，串行顺序与最终终态回写仍必要。
- 非阻塞模型每次 progress 不重建问答卡，降低打断输入的机会。
- 不添加未经验证的 Feishu 默认值/草稿保留属性；复用稳定字段名不等于平台保证 patch 后保留未提交内容，必须把该表现列入手工联调。

### 8. isBlocking 与并行等待

UserInputRequest 可选 isBlocking 是跨 provider 的诚实契约：Claude AskUserQuestion 当前没有该字段（`scripts/claude-to-im-bridge/llm.ts:56`），默认按阻塞展示；Codex 发出问答时显式传原布尔值。

Codex ActiveTurn 应记录本 turn 尚未结束的 blocking 请求集合（工具审批也计入）。状态根据集合派生；新增/解决一个 nonblocking 问题都不能把已有 blocking 请求的 waiting_for_input 清成 running。两个 blocking 请求解决其一仍等待，最后一个结束才 running。

正常 turn 已关闭、abort、连接 epoch 已改变、activeTurns 已换 owner时，迟到的 handleServerRequest finally 不再写 running。否则可能在 idle 后重新变成 running 或污染后来回合。不要维护跨 thread 的全局等待计数。

### 9. 最小必要业务文件与验证

预计必要业务文件 8 个：

1. `host.ts`：isBlocking、新终态原因、专用问答补充/阶段契约。
2. `types.ts`：补充控制 DTO 的 InboundMessage 字段。
3. `channel-adapter.ts`：问答阶段更新能力。
4. `codex-llm.ts`：真实闭合原因、原 turn 隔离、isBlocking/并行等待。
5. `user-input-broker.ts`：问答观察、closed bounded retention、复用校验、一次 claim。
6. `markdown/feishu.ts`：同一表单按阶段渲染。
7. `adapters/feishu-adapter.ts`：专用回调解析与问答原卡更新。
8. `bridge-manager.ts`：原任务归属、控制事件追踪、一次性准入与正常/取消清理接线。

不应修改 conversation-engine（已转发完整 request）、permissions（已复制 reason）、generic interaction-lifecycle、store/schema/配置依赖、去重/文件任务；如最终确需增加文件，需写清新职责而非顺手扩散。

有意义的测试分层：

- 现有 `bridge-codex-protocol.test.ts`：非阻塞通知继续+原 RPC 答案；两个阻塞/混合审批并行；server resolved 错 thread 无效；正常 completed 原未答 reason 与 cancelled/error/disconnect 区分；idle 后不回 running。
- 现有 `bridge-user-input-broker.test.ts`：真实 gateway 的同步已终态订阅、关闭先于 send 返回、card/owner/chat/题目/选项校验、双点击一次、answered 不转补充、TTL/100 条淘汰、清理不存答案体。TTL 用 mock clock，不能真实等待 10 分钟。
- 现有 `bridge-feishu-streaming.test.ts`：choice + input 同卡；pending/closed 仅按钮语义不同；真实回调专用 DTO，伪造 session/chat/原题不进入核心；terminal 删除入口；secret 不发。
- 新增聚焦 manager 集成测试或扩展 live-append 文件：真实 loop + provider + adapter 内存链路，断言 active 原回合只有一次 turn/start/一次 steer/原过程卡；正常完成后的补充仅一个后轮；新活跃 turn 的旧补充被拒，绝不 steer 新 turn；stop/new/bind/停机（包括已无 active）隔离旧卡；unknown 不开后轮，二次 callback 不重送；卡 patch/steer/提示发送永久挂起时其他 chat stop/审批仍可消费；closed patch 与 supplemented/cancelled patch 乱序不恢复按钮。
- 回归 `bridge-delivery-reliability.test.ts` 的通用审批、过期、先解决后消费和有界发送语义，避免为问答破坏授权路径；保留既有 live-append 26 项。
- 所有集成使用 FakeClient + fake SDK，硬阻断真实进程/网络；单项 15 秒、每批外层进程树硬截止 60 秒。研究本身未运行额外测试，不声称新功能验证通过。

### 10. GitNexus 影响证据

本次只做读查询，未刷新索引或修改图文件。使用 GitNexus 1.6.12、`--repo .`；symbol 同名时使用 `--file`/`--kind` 精确消歧。

| 符号 | risk | d=1 / 受影响数 | 对应当前源码与执行流 |
| --- | --- | --- | --- |
| handleServerRequest | LOW | 1 / 1 | constructor onServerRequest → 原请求 gateway → 问答/审批 |
| forwardUserInputRequest | LOW | 1 / 1 | manager.onUserInputRequest → 渲染/发送/观察 |
| buildUserInputCard | LOW | 1 / 1 | FeishuAdapter.sendUserInputRequest |
| handleCardAction | LOW | 1 / 1 | FeishuAdapter.start 的卡回调注册 |
| enqueueRegularMessage | LOW | 1 / 3 | runAdapterLoop → append/debounce/会话任务 |
| runAdapterLoop | LOW | 1 / 2 | start → consume/control/normal admission |
| handleMessage | CRITICAL | 4 / 13 | 实际生产调用为 runAdapterLoop 与 scheduleMessages；图另报 file USES 及 codex-jsonrpc.handleLine，后者由同名方法误解析，须用文本补证，不照抄为真实核心调用方。 |
| clearUserInputRequests | CRITICAL | 2 / 14 | 源码实际 manager.handleMessage 正常 result/finally 与 cancelChat；图中 stop/cancel 路径需结合本文件内调用核对。 |

main 应在编辑 handleMessage/清理关键流程前向用户说明 CRITICAL 风险；riskSharedAxes=LOW 不抵消该提示。上述低计数不能证明整个功能低风险；公共抽象回调边界与消息表单来源仍需集成测试。

### 11. 相关规范

- `.trellis/spec/backend/reliability-contracts.md`：原 abort/generation/epoch/binding/session 归属；控制循环禁止等待网络；accepted/not-submitted/unknown；来源确认与卡片事实分离。
- `.trellis/spec/backend/module-boundaries.md`：manager 只编排；broker 验证/生命周期，adapter 平台解析，markdown 渲染，provider 厂商协议。
- `.trellis/spec/backend/type-safety.md`：外部表单不可信，共享 DTO 放 host/types，原题/绑定不得信任 callback，类型进口用 import type。
- `.trellis/spec/backend/integration-guidelines.md`：模型问答和工具许可独立，答案验证来源后回厂商协议。
- `.trellis/spec/backend/testing-guidelines.md`：node:test、最小 fake/可观测记录器、全局单例隔离。
- `.trellis/spec/guides/cross-layer-thinking-guide.md`、`code-reuse-thinking-guide.md`：先明确每跳契约，复用现有表单解码、答案校验、准入与追加路径。

## Caveats / Not Found

- FTS 不可用，CLI 输出 load-only 警告且没有尝试安装；不把概念搜索空结果当作不存在。context/impact 返回精确结果，但存在同名符号错误调用边，已按当前源码纠偏。
- `serverRequest/resolved` 不含精确“外部回答还是清理”原因，因此能保证的是本桥接没有提交该答案；补充必须是用户新的明确动作，不是自动重放旧答案。
- 同 session 已开始其他 active turn 时本方案拒绝旧卡补充，不迁移旧任务；是否以后支持关联跨回合输入应是独立需求。
- 飞书 patch 未提交表单草稿、平台延迟 callback、真实账号是否触发 async 问题，需要手工联调。保留字段和输入能力不能承诺草稿字符无损。
- 闭合未答记录仅进程内存保留 10 分钟；重启后旧入口会失效，不引入持久化或全球请求幂等保证。
- 研究仅写当前任务 research；没有模型/平台调用、全局依赖安装、源代码/任务元数据/其他任务修改或 git 操作。
