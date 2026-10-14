# Research: 飞书过程卡执行流与最小变更边界

- Query: 当前过程卡的工具/模型进度来源、生命周期、更新串行与最终分段边界；最近3条常显、历史折叠及低频耗时显示能否仅落在飞书内部。
- Scope: internal（源码、项目规范、现有测试、GitNexus 图上下文；不调查官方折叠展开状态合同）。
- Date: 2026-10-14
- Task: `.trellis/tasks/10-14-feishu-progress-collapse`

## Findings

### 1. 结论与文件边界

当前共享事件已经提供本需求需要的工具 ID、名称与 running/complete/error 状态，模型进度也已经独立于正文送达飞书。优先只调整两处业务文件：

| 文件 | 现有职责与建议边界 |
| --- | --- |
| `src/lib/bridge/adapters/feishu-adapter.ts` | 建卡、本卡状态、节流/退避、单个在途请求、进度/历史组件更新、计时器与终态清理。 |
| `src/lib/bridge/markdown/feishu.ts` | 工具名称展示、进度/历史区域渲染、预算内展示模型、最终回答优先与折叠历史。 |
| `src/__tests__/unit/bridge-feishu-streaming.test.ts` | 复用 fake SDK、deferred、请求捕获，添加实时进度、预算与单请求并发验证。 |
| `src/__tests__/unit/bridge-feishu-final-card.test.ts` | 复用纯 JSON 渲染检查，添加正文优先、历史折叠且 footer 不变的断言。 |
| `src/__tests__/unit/bridge-feishu-reliability.test.ts` | 已覆盖建卡/收尾跨回合隔离及真实封装字节预算，按新增状态/计时生命周期补最小断言。 |

以下仅为调用链取证或回归锚点，原则上不改：`bridge-manager.ts`、`conversation-engine.ts`、`channel-adapter.ts`、`types.ts`、`host.ts`、Codex/Claude provider、`response-delivery.ts`、`delivery-layer.ts`。若展示模型需要额外的顺序、不可变工具快照、最近更新时间、历史省略数量或耗时计时器，可留在 FeishuCardState 或飞书渲染器局部类型，不必扩大共享 ToolCallInfo 契约。

源码中实际收尾函数名是 `finalizeCard`，不是 `finalizeStreamingCard`；另有独立 `finalizeWorkflowCard`，本任务不要把工作流卡混入普通会话过程卡改动。

### 2. 工具字段、进度来源与不能推断的语义

`ToolCallInfo` 只有三个字段：`id: string`、`name: string`、`status: 'running' | 'complete' | 'error'`（`types.ts:240-244`）。没有工具开始/结束时间、日志正文、错误说明、具体等待原因，也没有更新时间顺序。

实际来源如下：

1. Codex collector 对 commandExecution/fileChange/mcpToolCall/dynamicToolCall/webSearch/imageView/collabAgentToolCall 产生工具事件；名称取 `item.tool`，否则 `item.command`，否则 `item.type`。因此名称可能就是完整且很长的命令。首次见到 ID 发 running，completed 根据 failed/declined/非零 exitCode/error 映射 error，否则 complete（`scripts/claude-to-im-bridge/codex-llm.ts:607-610`）。provider 将 running 转成 tool_use，将终态转成 tool_result（同文件 `261-263`）。
2. Claude provider 的 tool_use 使用 SDK block 的 name/input，tool_result 使用 is_error；task_progress/task_started/task_notification/tool_progress 产生独立 progress 字符串（`scripts/claude-to-im-bridge/llm.ts:160-175`）。
3. engine 消费 tool_use 时调用 `(id,name,'running')`；tool_result 时调用 `(tool_use_id,'',is_error?'error':'complete')`，完整工具返回仍在 contentBlocks 中（`conversation-engine.ts:436-483`）。卡片 hook 没有收到这些返回日志，不能凭现有 ToolCallInfo 展示不存在的“完整日志”。
4. manager 在本回合 Map 中按 ID 跟踪工具。带名称时 set 新值；只有结果时原地修改已有对象的 status，然后将 `Array.from(values())` 整个快照交给 adapter（`bridge-manager.ts:1542-1557`）。Map 的顺序是原插入顺序，完成一个旧工具不会自动排到末尾。
5. progress 是独立 SSE，engine 直接转 `interactions.onProgress(event.data)`（`conversation-engine.ts:415-417`）；manager 经 isCurrent 检查调用 adapter（`bridge-manager.ts:1610`）。Codex commentary 与 MCP progress 会走这里，不计入最终正文（`codex-llm.ts:542,581,612-613`）。

重要状态注意点：

- **不要保存 manager 传入数组中的旧对象引用再比较状态**：Claude 的结果路径会修改对象本身；需要在飞书内部复制 `{id,name,status}`，再与前一份不可变快照比较。
- 若“最近3条”指最近变更的步骤，可以在本卡内记录单调递增序号；若指最近启动的工具，使用原数组顺序即可。方案必须写清，不能声称共享事件自带时间排序。
- onProgress 当前只有字符串，无 item ID/phase/结构化等待类型。它可能是同一 commentary 的连续增长内容；把每次字符串变化都计为一个新完成步骤会虚增数量。最小方案可保留最新 progress 常显，并以工具步骤定义最近3条历史，不必为折叠展示反向改 provider 协议。
- 运行与失败可以准确由 status 区分；“等待审批”“等待用户”等具体原因没有统一结构化字段。只显示真实已有进度/独立交互卡与实际经过时间，不能通过字符串猜测阻塞语义或伪报完成。

### 3. 当前过程卡链路

#### 建卡与归属

- `onMessageStart` 先 cleanupCard，建立新的 generation，随后发起 CardKit create 与 IM reply；`onStreamText`/`onProgress` 可懒建卡（`feishu-adapter.ts:483-528,1020-1050`）。
- `createStreamingCard` 使用 cardCreatePromises 复用同聊天建卡请求（`651-663`）。`_doCreateStreamingCard` 在 create 后、IM 发送后均核对 generation，成功后设置 activeCards（`691-753`）。
- 初始卡是三个独立 markdown 元素：`streaming_content`、`tool_progress`、`append_notice`（`679-687`）。可为历史区增加独立稳定元素，实际组件合同交由官方研究结果决定。
- 当前 `updateToolProgress` 在尚无 active state 时直接返回，不像 onProgress/onStreamText 会等待建卡（`902-906`）。因此若需要保证建卡期间最新工具快照不丢失，应在适配器内部按原 generation 保存/重放最新工具快照；不能使用另一个回合的“最新聊天”状态。新的测试须覆盖这条边界。

#### 正文、模型进度、工具与追加

- `updateCardContent` 首个非空正文清除 thinking，使用 `splitFeishuMarkdown(text,20_000)` 只展示第一个预览分片，多片时写“完整回答将在结束后分段发送”提示；完整正文仍由核心持有（`815-826`）。
- onProgress 只覆盖 `state.progress` 最新字符串，updateToolProgress 只覆盖工具全量数组，两者都调 scheduleCardUpdate（`902-906,1038-1050`）。
- notifyAppend 只写本卡 appendNotice 并调同一刷新队列（`1002-1012`）。其来源确认属于已交付追加合同，不能因为历史布局重建卡或变更确认语义。
- `buildToolProgressMarkdown` 当前为每个工具输出一行图标与完整 name，全部历史无界累加，不对名称长度做展示限制（`markdown/feishu.ts:146-153`）。

#### 单请求串行与预算停更原因

- scheduleCardUpdate 若 state.inFlight 则只置 needsFlush；否则按最小250ms、默认2秒节流与 cooldownUntil 调度（`774-812`）。
- flushCardUpdate 把最新 progress 与全部工具 markdown 合并。若 `{text,progress,notice}` JSON 的 UTF-8 大于28,000字节，直接 return，**本次最新进度和追加提示均不会发送**（`839-844`）。仅折叠旧内容不会减少它的消息体体积，必须同时做预算内展示。
- 一次 operation 内先等待 cardElement.content 正文请求完成，再用 batchUpdate 更新 tool_progress/append_notice；两个请求也串行，不是同时发送（`846-869`）。后续布局更新必须共用此 operation，不能给折叠/耗时另开并行请求队列。
- 频控业务码99991400触发指数退避；finally 仅在仍为本 active state、未 closing、needsFlush 时补发最新状态（`872-895`）。重试应合并最新视图，不逐条重放旧历史。

最小预算策略建议（实现决策，非当前行为）：优先保留真实当前状态/经过时间、运行/失败摘要、最近3条与追加提示，压缩较早历史的展示细节并明确“历史细节已精简”。对单条超长名称/progress 做可见摘要与省略标记，原工具记录/最终正文不改；只给所有历史套容器仍会超限。应验证真正发送的 request.data JSON，包括 actions/card.data 字符串再次转义、中文和 emoji，而不能只按字符数或内层 markdown 长度计数。

### 4. 最终卡与完整分段不能退化

- `onStreamEnd` 仅转调 finalizeCard（`1114-1120`）。manager 的正常结果按 abort/error/completed 分类；主动 cancelChat 会传 interrupted 和空正文（`bridge-manager.ts:1694-1705,470-481`）。
- finalizeCard 等待建卡、核对 generation，先 closing=true、取消节流 timer，再 await 原 operation，重新核对 active state（`feishu-adapter.ts:916-930`）。最终更新不能越过还在发送的正文/历史请求。
- 当前 finalCard 调用 **`buildFinalCardJson(responseText,[],footer)`**（`934`），工具历史被主动清空。若要求最终“回答优先、执行历史默认收起”，应传本卡工具/预算后的展示模型并渲染成独立历史区，而非原样把工具 markdown 拼入回答正文。
- buildFinalCardJson 当前把 tools 全部拼到正文后，然后输出状态/耗时/ctx 页脚，config.streaming_mode=false（`markdown/feishu.ts:170-218`）。可保持原参数主边界或增加飞书局部可选视图；无须更改共享 adapter.onStreamEnd extras。
- 最终整请求超过30,000字节或 update 失败时，原卡 settings 关闭流式，返回 false，active state 清除，让核心执行完整回答投递（`feishu-adapter.ts:938-958`）。不能为“卡更新成功”截掉正文却返回 true。
- manager 将 responseText 原文与 finalize closure 交 `deliverResponse`（`bridge-manager.ts:1716-1726`）。response-delivery 先持久化完整正文/分片，再调用 finalize；只有 finalize=true 才把所有文字分片标为已送达，false 时继续逐片发送（`response-delivery.ts:35-41,74-85,124-150`）。
- 最终历史的体积不应挤掉可完整显示的正文。可以先减少历史展示再判断正文是否需要既有分段；正文仍超限则保持原 false/fallback 合同，不重复模型，不另造 outbox。

### 5. 耗时与等待 UI：当前没有动态计时

当前初始 tool_progress 是固定“💭 思考中…”（`686`），无实时耗时。startTime 在 CardKit create 和 IM 发送成功后才记录（`734`），不包括此前建卡等待。formatElapsed 仅在 finalizeCard 被用于最终 footer（`932-934`）。

processingNoticeTimers 是2.5秒后没有任何卡/Typing指示时才发送的一次兜底文字，卡或Typing存在就取消；它不是心跳或耗时计时器（`483-545`）。

若实现低频更新“已运行/等待新进展多久”：

- 本卡添加一个 unref timer 字段即可；回调检查 `activeCards.get(chatId)===state && !state.closing`，更新实际经过时间的展示，再走 scheduleCardUpdate，复用节流、退避和 inFlight。
- 时间刷新只证明本桥接任务仍未收尾及实际时间流逝，不证明模型产生新进展，不能伪造新步骤、百分比或任务仍有效的外部服务确认。
- 不改当前正文，不把 timer tick 添加进历史数量，真实进度到来时及时替换“等待新进展”显示。
- 清理三处：stop 的 activeCards 循环（`428-434`）、finalizeCard 在 await operation 前（`924-929`）、cleanupCard（`975-985`）。onMessageStart/onMessageEnd 已通过 cleanupCard 处理换回合与异常清理（`483-484,559-567`）。不能等最终网络请求结束再清理，否则挂起期间还会产生无效更新。
- stop 的 running=false 提前 return（`406-408`）是现有合同，计时回归需要真实 start 的 fake fixture 或显式设置 running，再检验清理。不要为了测试依赖真实登录/WS。

### 6. GitNexus 与动态边界补证

使用当前仓库显式 `--repo .`；已安装 CLI1.6.12。meta 记录 repoPath=`G:/project/Claude-to-IM`、indexedCommit=`41a698387a148d87b8c569708027e39e8a120bac`、indexedAt=`2026-10-14T10:09:27.449Z`（main索引；本任务feature基于同HEAD，业务源码读取在实现之前）。

执行 `query 'Feishu streaming card tool progress final update' --repo .` 返回空，但明确 FTS unavailable/load-only，未尝试安装。该空结果不作安全证明；精确 context 加当前源码补证如下：

| 精确符号 | 图确认的直接调用方 | 当前源码额外确认 |
| --- | --- | --- |
| FeishuAdapter.createStreamingCard | onMessageStart、onProgress、onStreamText | 三处均在 adapter 内；调用后用 generation 隔离晚到创建。 |
| FeishuAdapter.flushCardUpdate | scheduleCardUpdate（即时分支、timer分支） | flush又会按退避/needsFlush调回 schedule，保留真实在途 operation。 |
| buildToolProgressMarkdown | buildFinalCardJson、FeishuAdapter.flushCardUpdate | 工具全部渲染的直接共同出口。 |
| buildFinalCardJson | FeishuAdapter.finalizeCard | 此调用实际 tools=[]，需要显式更改才会保留最终工具历史。 |
| FeishuAdapter.finalizeCard | FeishuAdapter.onStreamEnd | 正常结果与取消均由 manager 经 adapter 多态接口调用。 |
| FeishuAdapter.onToolEvent | 图无静态业务 calls | BaseChannelAdapter声明 `channel-adapter.ts:158-162`；manager动态调用 `bridge-manager.ts:1554-1557`；streaming/live-append/async-questions 测试直接/集成覆盖。 |
| FeishuAdapter.onProgress | 图无静态业务 calls | Base声明 `channel-adapter.ts:121-122`；engine→manager 的 `bridge-manager.ts:1610`；streaming/reliability 回归覆盖。 |
| FeishuAdapter.onStreamEnd | 图无静态业务 calls | Base声明 `channel-adapter.ts:164-179`；正常 finalize `bridge-manager.ts:1694-1705` 与 cancelChat `474`；finally onMessageEnd `1790`；生命周期测试覆盖。 |
| FeishuAdapter.stop | 图无静态业务 calls | Base抽象契约 `channel-adapter.ts:35-39`；stopBridge排空后 `bridge-manager.ts:1040-1045`；reliability、live-append/async-questions cleanup及lifecycle停机回归。 |

context 的同名 flushCardUpdate 有 workflow-command 的另一候选，已用 UID `Method:src/lib/bridge/adapters/feishu-adapter.ts:FeishuAdapter.flushCardUpdate#1` 消歧；其他方法按 `--file src/lib/bridge/adapters/feishu-adapter.ts` 查询。

执行流资源由 context 返回：OnToolEvent → BuildToolProgressMarkdown、OnProgress → BuildToolProgressMarkdown、OnStreamText → BuildToolProgressMarkdown、OnStreamEnd → BuildToolProgressMarkdown，以及正常建卡/收尾 AssertFeishuSuccess 流。部分无关 resolve/updateInteractionMessage 图边是泛名称消歧噪声，不能据此扩大影响范围。

主会话已独立保存 `research/impact-before.json` 的完整 upstream 结果：buildToolProgressMarkdown=CRITICAL；createStreamingCard/flushCardUpdate=HIGH；buildFinalCardJson/updateCardContent/updateToolProgress/finalizeCard=LOW；公开 hooks/stop=UNKNOWN（动态0调用方）。主会话已向用户提示 HIGH/CRITICAL。本研究的当前源码与下方测试用于补充 UNKNOWN/动态边界，**不将其改写为图已证明安全**。实际实现改变新增函数或 timer清理函数前仍需主会话完成对应影响检查。

### 7. 可复用测试与新增断言点

| 行为 | 现有锚点 | 最小新增断言 |
| --- | --- | --- |
| 当前进度/最近3条/历史折叠 | `bridge-feishu-streaming.test.ts:170-191`：正文A→AB、tool/progress/append独立batch、重复快照零请求、递增sequence。 | 5个以上工具；最近3条与所有running/error可见、旧complete仅入历史；progress新文字常显；错误不被收起；重复数组快照不追加历史/发请求；状态从原对象原地修改仍能识别。 |
| 长命令/历史预算后仍更新 | 同文件 fixture `29-49` 捕获所有request；reliability `70-75` 检查实际send封装。 | 构造超长中文/emoji/引号反斜线工具name、大量历史和长progress，再送最新事件/追加；应有预算内请求且含最新状态、省略说明与追加；正文与最终回答原文不改。 |
| 单个实际在途更新 | streaming `137-155` 挂起content、收尾等待、最终sequence[1,2]；workflow串行 `273-292` 提供类似deferred模式。 | 挂起历史/进度batch，继续送正文/tool/progress/计时；同时在途计数max=1；释放后只合并最新视图；onStreamEnd最后写终态，关闭后不复活计时更新。不能仅断言本地inFlight布尔。 |
| 频控/重试 | streaming `193-203` 非零频控、退避与收尾清理。 | 最新进度在退避期间更新，重试发最新视图而非旧历史；计时不绕过cooldown创建并行请求。 |
| 建卡/换回合/计时隔离 | reliability `29-52` 原建卡/operation挂起、取消、新卡不被旧创建/finalize污染。 | 建卡期间onToolEvent与progress保存最新快照；新generation不接旧快照；旧elapsed callback和旧请求finally不写新卡；finalize/cleanup/stop都清理elapsed timer。 |
| 最终卡正文优先/历史折叠 | `bridge-feishu-final-card.test.ts:12-108` 六组ctx/footer/null/empty场景。 | JSON顶层正文完整且在历史区前；历史不再混入正文；默认折叠与稳定组件ID按官方合同；完成/中断/错误footer、ctx、streaming_mode=false保持原结果。 |
| 最终正文超限与失败回落 | streaming `157-168` update业务拒绝返回false并关闭流；`264-271` 超长正文不发超限update，只settings关闭。 | 添加历史后，仍优先保留全部正文；正文仍大则false；不能把预览第一片当完整成功；update或组件结构拒绝不假报完成。 |
| 完整UTF8分段与补发 | reliability `70-75` 实际SDK构造<=30KB；delivery-reliability `107-114` 非代码parts.join=原文/代理对/代码围栏；`63-76` durable逐块确认、retry只补失败块；`164-172` 超时未知不自动fallback。 | 复用以上回归；必要时加真实FeishuAdapter fake平台+deliverResponse(finalize=false)集成，断言全文各片连续且模型fake调用数不增加。 |
| 追加/问答/取消生命周期 | `bridge-feishu-live-append.test.ts:105-134,180-214`；`bridge-feishu-async-questions.test.ts:217-246,321-342`；`bridge-lifecycle-regression.test.ts:124-182,291-310`。 | 运行现有集成回归即可；若新增timer/状态泄漏，应定向补原卡create数量=1、旧回合不写新卡、闭合问答与追加确认仍保留的断言，无须改manager/provider业务。 |
| 完成通知 | `bridge-feishu-card-notify.test.ts:52-135`。 | 最终历史布局不改变默认完成通知、禁用配置与空错误无重复通知。 |

测试继续使用 fake SDK/deferred，不运行真实平台/模型。streaming fixture当前只注入SDK；需要新增涉及start/timer测试时，应复用 reliability/live-append 中 net/socket/fetch/child_process 的硬阻断方法。每条测试15秒，外层60秒硬终止进程树。项目已有 `npm run typecheck`、`npm run build`、`npm run test:unit`，无lint脚本。本研究未运行测试，避免与主会话/实现阶段无必要重复。

### 8. 相关规范与引用

- `.trellis/spec/backend/index.md`：包入口、开发前影响确认、可靠性补充阅读。
- `.trellis/spec/backend/module-boundaries.md`：飞书展示在适配器/markdown，manager保持编排。
- `.trellis/spec/backend/type-safety.md`：局部状态不要上提共享类型；外部card数据与fake成功不能替代平台合同。
- `.trellis/spec/backend/testing-guidelines.md`：最小mock、行为断言、全局状态清理、真实模型/网络阻断。
- `.trellis/spec/backend/reliability-contracts.md:28-32,38-56,66-80,166`：原回合generation/epoch/取消归属、追加仍用原卡、问答独立、单实际在途patch、平台格式/可见控件/回传证据分别验证。
- `.trellis/spec/guides/index.md`：外部系统payload大小、参数基数与状态汇合点需显式检查。
- 当前依赖版本来自 `package.json`：`@larksuiteoapi/node-sdk`1.74.0、`@openai/codex`0.160.0、Node要求>=20；研究命令GitNexus1.6.12。
- External references：本文件未检索外部资料；飞书折叠组件schema、展开状态保留与动态更新合同由并行官方研究负责，不能用现有fake SDK的任意成功回复证明组件真实有效。

## Caveats / Not Found

- 未调用真实飞书/模型、未重启进程、未修改业务/测试/规范/依赖/环境、未执行git操作；仅本研究文件写入。
- 图FTS不可用，concept query空；精确context可用，动态hooks没有静态入边；所有边界已由当前源码与代表测试补证，不是零风险结论。
- 本调查不能证明用户展开状态在动态更新后保留；该项必须依官方合同和后续真实可见验收，不能承诺仅稳定element_id就一定成立。
- 原事件只提供工具摘要，不提供完整工具日志；当前任务若希望完整日志可展开，需要重新审定数据来源，不能把命令名称冒称日志。最小范围可收起旧工具名称和已有progress细节。
- 无结构化等待原因、tool时间或progress item ID；可显示真实经过时间和最新原生进度，不能虚构任务百分比、剩余时长或特定阻塞原因。
- 原startTime包含的是建卡完成后的本地时间，若产品需要从接收消息算总耗时，需在飞书本generation建卡前固定开始时间，并测试晚到建卡/取消隔离；仍无需改manager/provider。
