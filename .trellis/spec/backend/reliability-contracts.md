# 会话、投递与恢复合同

## 1. 范围与触发条件

修改消息队列、会话绑定、停止、回答投递、权限/问答交互、JSON Store 或工作流恢复/自动修复时，必须使用本合同。平台表现不能代替核心状态：卡片收到点击不代表权限已批准，模型结束不代表回答已送达。

## 2. 接口

- `processWithSessionLock(..., signal?: AbortSignal)`：信号取消尚未开始的排队任务；已运行任务由自己的取消上下文结束。
- `deliverResponse(adapter, address, responseText, sessionId, replyToMessageId?, options?)`：统一生成响应分块、保存待发记录和投递；`options` 可携带 `turnId / isCurrent / finalize / images / workingDirectory`。`finalize(preparedText)` 仅确认实际转换后的完整正文；飞书正文媒体见 [正文图片交付合同](./inline-image-delivery.md)。
- `retryResponseDelivery(adapter, address, id?, { isCurrent }?)`：只重投已有记录的未送达块，不调用模型；有效性谓词在每个后续分块与发送重试前检查。
- `deliver(adapter, message, { isCurrent }?)`：普通文本投递可选归属检查，覆盖开始、后续分块与重试；已进入平台的发送不能撤回。账号额度查询的异步调度及 epoch 合同见 [账号额度合同](./codex-account-quota.md)。
- `BridgeStore.saveResponseDelivery/getResponseDelivery/listResponseDeliveries/flush`：四项共同形成可选的持久待发能力；`close()` 用于停机。
- `BridgeStore.listChannelSessionHistory?(channelType, chatId): ChannelSessionHistoryEntry[]`：只读当前聊天历史；条目为 `sessionId/title/workingDirectory/updatedAt`，按最近关联排序。`/sessions [页码]` 每页 5 条，完整 ID 可用于 `/bind`。
- `PermissionGateway.onResolution?(requestId, listener)`：订阅真实解决结果，返回取消订阅函数；reason 为 expired/cancelled/delivery_failed/request_closed/turn_completed，问答闭合两项详见下方合同。
- `UserInputRequest.isBlocking?: boolean`：明确 false 表示非阻塞，缺省维持通用阻塞语义；`answerChannel?: 'rpc' | 'message'` 缺省 rpc，不能据阻塞状态推断答案通道。`UserInputSupplementResponse` 与原答案结构相同，以 `InboundMessage.userInputSupplementResponse` 表示明确的补充动作。
- `BaseChannelAdapter.updateUserInputRequest?(address, messageId, request, phase)`：问答专属阶段回写，phase 为 pending/closed/answered/supplemented/expired/cancelled/failed；不改变审批卡更新能力。
- `prepareUserInputSupplement(address, response, callbackMessageId, action)`：action 必填 answer/supplement，分别要求 pending/closed；返回 invalid/unavailable、原请求答案的 rpc 或 ready `{text, sessionId, isCurrent, claim(admit: () => void): boolean}`。调用方在准入锁内校验、claim 并转入既有调度；rpc 才走原网关。缺少有效 admit 返回 false 且保留未消费资格。
- `clearUserInputRequests(sessionId, { preserveClosed?, owner? }?)`：回合收尾可保留 closed，通过原归属回调身份限定本回合；`invalidateUserInputRequests(address?)` 主动取消原 channel/chat，缺省全量清理用于停机。
- `WorkflowStore.acquireExecution(runId)`：取得唯一执行权并返回释放函数；活跃或归属不明的执行者不能自动抢占。
- `WorkflowStore.loadDocumentVersion(runId, target)`：只读返回 `{version, content}`，其中 `target` 为 `spec | plan`，缺失内容为 `null`；版本文件仍由原 `saveSpec/savePlan` 显式版本参数保存。
- `AutoFixOptions.validate?(cwd, issueIds)`：返回 `{passed, summary}`；缺少验证时只产生修复候选，不计入 `fixedCount`。

## 3. 数据与行为合同

### 任务归属

每个入队回合固定 session/binding 快照、chat generation、bridge run epoch 和取消信号。旧回合的 status/result/finally、延时刷新和异步卡片创建都必须验证归属；绑定 ID 相等不足以证明还是同一个会话。`stop/new/bind` 统一清理合并、追加与串行队列，不将旧消息迁入新会话。

本地取消等待与外部实际中断分别对待。流读取、交互发送必须能响应取消，清理有界；超时不能伪称外部服务已经确认停止。核心 stop 禁止新准入，再取消和排空，最后关适配器。

补发属于独立、受跟踪的投递任务，不得在渠道控制消息循环或聊天准入锁内等待网络。任务仍绑定 chat generation 与 bridge epoch；`stop/new/bind` 及 bridge stop 必须取消后续未发送分块并保留已确认进度。不能用无归属的 fire-and-forget 避开阻塞，也不能复用模型任务收尾去关闭新的卡片。

`/sessions` 表示当前 channel/chat 关联过的会话，不是同渠道所有聊天的当前 bindings。完整会话 ID 必须可直接用于 `/bind`；历史关联在绑定变更时与 bindings 一起持久化。旧数据只迁移能证明归属的当前绑定，不根据标题或全部 sessions 猜测归属；宿主缺历史能力时只列当前聊天当前会话并说明限制。

### 当前回合的即时补充

`StreamChatParams.onActiveTurnInput?` 发布本次 stream 的 `ActiveTurnInput`，由 engine 包装后交给 manager；其 `submitText(text)` 返回 `TurnInputResult`，`seal()` 封闭新输入准入。句柄通过单次调用的 closure 绑定原回合，不按“最新 session/thread”查找另一个任务，也不比较 manager、engine、provider 各自不同的取消控制器来猜归属。

| 结果 | 必须语义 |
| --- | --- |
| `accepted` | 收据的 remote turnId 与原 expectedTurnId 精确一致。`historyError` 只表示本地记录失败，不撤销远端接收事实，不重送。 |
| `not-submitted` | 调用 RPC 前已确认未提交；区分 turn-ended、cancelled、unavailable，只有仍属于原会话、未取消且适合继续处理的来源可移交既有后轮。 |
| `unknown` | RPC 已调用后的异常、超时、断连或坏/错 ID 收据。明确提示，不自动重送或启动第二轮；后来看到回合完成不能证明这条补充未被接收。 |

Codex 在初始化前提供句柄；等待 remote turnId、collector 订阅并处理 early backlog 后才能提交 `turn/steer`。精确匹配完成、失败、中断以及取消/断连/epoch 变化当场关闭新准入。卡片存在或 manager busy 包含投递收尾，不能据此判定模型仍活跃。可选 clientUserMessageId 没有声明幂等保证，不作为自动重放依据。

engine 的 submit 必须同步登记 pending，再按顺序异步提交，控制消费循环不等待网络。正常初始化等待本轮 ready，不用 engine 的提前逐条超时制造“已经报未知、稍后才发送”的行为。provider 约束已发 RPC；engine 在正常/错误/取消收尾统一封口并有界结算，再保存 assistant。成功记录顺序为原 user、补充 user、assistant；结算结束后的迟到收据不能在 assistant 后再补 user，也不能由 catch 重跑记录/提交。

manager 持有原来源组，提交中及已接收来源不能同时留在可 flush 的后轮缓冲。成功/未知/终结取消的即时来源跟随原任务确认；确认未提交并移交后轮的来源归后轮确认。范围限定飞书 Codex、开启追加、同原发送者的无附件普通文字，复用 sanitizeInput、大小与截断审计；命令、控制、其他来源/provider/channel/附件保留原路径。确认接收后更新原卡，不再调用 onMessageStart 或为该来源开新过程卡。

原卡 notifyAppend 必须检查原 UI owner。携带原补充 messageId 作为 replyToMessageId 的独立事实通知按 ownsTurn 检查原取消信号、chat generation、bridge epoch、binding ID 和 session ID，仍纳入 taskPromises；正常 finally 清理原 UI 或同会话开启新卡不能吞掉限流/重试中的提示，stop/new/bind/停机则取消旧通知。是否渲染为平台回复沿用适配器能力。

案例：正常接收“排除隐藏目录”后继续更新原卡，历史为原 user → 补充 user → assistant；基础边界是模型已结束、卡仍在收尾，此时确认未提交的补充进入下一轮一次；坏回执（错 turnId、超时或断连）只报告 unknown，不以回合完成推断可安全重送。

测试锚点：`src/__tests__/unit/bridge-codex-llm.test.ts` 断言精确 threadId/expectedTurnId、ready/backlog 和旧 closure 隔离；`bridge-conversation-engine.test.ts` 断言同步登记、连续 user 在 assistant 前、记录失败保留 accepted 和收尾后迟到收据不写历史；`bridge-feishu-live-append.test.ts` 用真实 manager/provider 与内存传输断言一回合、一张卡、来源确认、后轮顺序及 stop/new/bind/停机隔离，还须挂起限流验证 unknown/记录失败提示在正常收尾后发送、控制取消后不发送，且始终保留原 address/replyToMessageId、不更新新卡。测试须硬阻断真实模型与平台，单测 15 秒、每批外层 60 秒。

错误：`if (result.status !== 'accepted') scheduleNext(message)` 会把 unknown 重送。正确：仅在 `result.status === 'not-submitted'`、未取消且原会话归属有效时移交后轮；accepted/unknown 来源由原任务收尾确认。

### 投递与权限

#### Codex 非阻塞问答与闭合补充

RPC 题目有效答案回传原 app-server JSON-RPC 请求，结构为 `{answers: {[questionId]: {answers: string[]}}}`，不调用 turn/steer 或另开回合。`isBlocking === false` 的问题允许继续输出，不写 waiting_for_input；同一 ActiveTurn 的其他阻塞问题/审批仍存在时必须继续等待，最后一个解决才运行。迟到 finally 检查原 active/epoch/abort/ended，不能在 idle 后回写 running。弃用 autoResolutionMs 不用于新的答题倒计时；卡片投递超时也不是回答期限。

原生非阻塞题是当前 thread/turn 的 `agentMessage.delivery='async'` 与结构化 questions，属于 notification，不存在对应回答 RPC。collector 按 item.id 去重 started/completed/backlog，从 title/options 映射稳定题目 ID，经原 SSE 显式转发 message 答案通道；不扫描历史、不从文字猜题，不把题目文字计入最终回答。phase=final_answer 不等于 turn 完成，普通 async 消息不得丢失。原生选择支持建议答案和其他文字，不能推断多选或秘密字段。非飞书渠道保持文字显示。

metadata 未知的 delta 缓存，已知 async 等 completed 后判别题目；普通 started 已明确 phase 且无 async 则维持流式。上述题目文本隔离仅针对尚未投递的片段：如果已显示普通文字后同 item 的 completed 才改变为 async，已投递片段无法撤回，不缓存所有普通消息来防御未经证实的字段变更。普通 async 缺 completed 时在 turn 完成刷出缓存，phase 缺省按 final_answer，已有 commentary 保持。两种边界需保留回归。

message 题目不创建 PermissionGateway pending/observer/response。pending 原答案动作携带 broker 原题，经 manager 原归属校验、admissionGate、sanitize、一次 claim 准入既有追加/后轮；RPC 默认合同不变。正常 clear(preserveClosed:true,owner) 明确将原生 pending 转 closed，闭合后只接显式补充，旧原提交竞态不得自动转换；错误或主动取消不保留。

`serverRequest/resolved` 精确匹配原 threadId/requestId，未答问题以 request_closed 关闭；正常回合完成在内部 abort 之前以 turn_completed 关闭该回合未答问题。这两个 PermissionResolution.reason 只证明原请求已结束，不能当作本桥接答案已被模型接收的收据。初始化期先登记原请求再等待 ready，确认远端 turnId 后精确校验，避免旧问题借新 active 归属转发；等待期间关闭、取消或失败不得复活。错误、主动停止、断连、过期或失败不可转为可补充。

RPC 问答 broker 独立观察真实网关，两种入口均保留飞书 Codex 的原题、地址、session、原卡和原 task guard；closed 未答记录关闭后最多 10 分钟、全进程最多 100 条，定时器 unref，按时间/数量淘汰。先登记再订阅，处理 onResolution 同步回放及卡创建晚到；发送失败、秘密问题、已回答、已补充和取消不能复活。只保留未答原题，不持久化或日志输出答案正文。正常 finally 不取消 closed；stop/new/bind 按聊天清理，停机也清理闲置卡。

答案与补充共用原题校验：真实 channel/chat/user/card、已知问题 ID、完整非空 own-property 答案、选项与单/多选限制及大小。动态问题 ID 映射不得用普通对象的原型属性代替答案；不得信任按钮携带的原题、绑定或来源。closed 的原答案动作只拒绝并提示显式补充，不自动重放。明确补充从 broker 原题生成文本，在 manager admissionGate 内检查原取消信号、binding/session、generation、epoch，并要求当前 active 为空或仍为原 turnId；其他 active 回合不能被旧卡 steer。sanitize 与总大小检查在 claim 前完成，同步 claim(admit) 一次再沿用既有 enqueue/live-append 来源与 ack 合同；没有有效 admit 不消耗资格。

问答控制动作及反馈为 tracked task，消费循环和准入锁不能等待模型/平台网络。每卡最多一个实际在途 patch，真正结束后合并最新终态；本地超时不能并行新 patch 让旧 closed 覆盖终态。外部永久挂起时核心资格立即撤销，UI 及时刷新不保证；飞书 patch 也不保证未提交草稿保留。展示与准入结果分开，更新失败不撤销已成立的答案或补充事实。

飞书 JSON2 input 的 `max_length` 平台范围为1…1000，other/free 与 pending/closed 均须遵守；不能把本地答案校验上限或历史渲染值当作平台组件属性范围。SDK content:string 不校验内层schema，fake SDK成功不证明平台接受卡片。平台格式、IM投递可见控件、真实答案回到原任务分别取证；CardKit仅实体校验成功不能宣称真实问答链路已通过。[官方输入组件合同](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/input)。

#### 飞书动态过程卡

过程卡从创建起使用 `streaming_mode:false` 和中性固定摘要；正文、合并状态区和历史子文本通过 `batchUpdate` 的 `partial_update_element` 更新。`actions` 为JSON字符串，内部 `partial_element` 为对象。原生 `collapsible_panel` 只初建时写 `expanded:false`，运行和错误/中断诊断时有内容的父面板及标题固定，不整卡替换、不重写 `expanded`、不改配置；成功收尾移除过程面板，见下方终态合同。真实网页版验收已观察到 settings 改摘要以及 settings/batch 切换流式会重置展开；固定ID不能抵消配置更新。为保留运行时阅读状态，取消逐字动画，仍持续局部刷新正文。原生面板没有展开回调，不能编造回调或据此承诺所有客户端/滚动位置都保留。[官方折叠组件](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/collapsible-panel)、[局部更新合同](https://open.feishu.cn/document/cardkit-v1/card/batch_update)。

工具事件的 id/name/status 必须立即复制，manager会原地修改对象；最近3条按真实字段变化排序，重复快照不伪造进展。当前动作、运行/失败数量与必要错误外显，历史命令有界显示并明确摘要/省略；没有工具stdout或结构化阻塞原因时不能假称完整日志、虚构等待原因/百分比。独立问答/审批卡不放进折叠历史。5秒真实耗时复用单实际在途、节流和退避，不计入工具完成数；定时器unref、绑定具体卡片及generation，finalize在等待旧请求前清理，cleanup/换代/stop同样清理。

折叠不减少JSON字节。维持30,000字节保守预算，校验含字符串再次转义的完整实体、实际请求及每个中间更新状态；先缩减再增长，不假设batch具有事务原子性。旧历史优先让出空间，不能因工具历史过大直接跳过实时刷新。最终正文始终完整，容纳不了就返回false交回既有分段/outbox/retry，不把预览确认成全文、不重跑模型。完整正文成功回执与辅助展示状态分开，不因辅助失败重复已确认正文。

成功完成后，卡片只保留完整答复与一处完成状态/耗时，常显最近进展及整个执行过程面板移除；错误或中断仍外显必要失败提示并保留可读诊断。batch非零回执不能证明全部动作均未应用，`sentView`只是最后整批成功的快照。终态合并状态区必须覆盖运行内容；存在不确定更新时不能以旧缓存相等省略恢复。仍按实际请求及逐步实体校验预算，不强制重写整卡或配置。

运行batch异常或非零后，视图仍不确定；后续一次普通diff成功不能证明被省略的历史已恢复。不确定时收尾先串行清空由当前视图推导的非正文叶子（合并状态区优先，正文保留），确认成功及原generation有效后，以空白基线先写完整目标正文，再恢复状态/历史等内容。清理每步只缩减，目标批后续只增长到已预算实体；两批各自计请求预算。失败不确认全文，取消或换代不得继续第二批；正常路径不增加恢复请求。只更新Markdown叶子，不能借恢复重建面板或重写配置。

**终态信息层级合同**：`ProgressView`仅含正文`streaming_content`、可复用状态区`task_status`与面板内部`history_content`三叶子。运行态在状态区展示真实耗时、近期变化、必要错误与追加；成功态以完整回答为主体，状态区只留一次完成与耗时，同时移除过程面板。工具统计、ctx、追加等辅助信息不构成保留成功过程入口的理由；不在完成卡默认区展示零统计、重复完成、额外历史说明或独立追加标签。分段投递去向、未解决错误/中断与独立问答仍保持可见。预览超限与真实追加分开建模，完整正文已入卡就撤销过时的预览分段提示。

结构性留白从布局消除：空格Markdown仍可占行，不能用多处空文本模拟隐藏。初建明确body间距及Markdown margin，移除不再使用的叶子，不能保留旧ID只为旧fixture兼容。成功终态无论有无工具/ctx/追加，在正文与状态成功确认后，单独用`delete_elements`移除`progress_history`；错误/中断只移除真正空的面板，有可读诊断则保留原实例。辅助删除失败不能撤销已确认全文、触发重复补发或模型重跑，仍检查generation并保持实际请求串行。不得用预算精简后为空冒充“没有过程”，或猜测未得到官方合同支持的隐藏属性。

测试锚点为 `bridge-feishu-progress.test.ts`、`bridge-feishu-streaming.test.ts` 及追加/问答/投递回归；fake平台须逐action检查完整实体大小并禁止配置/整卡/打字机请求。部分失败必须真实应用有序前缀后再返回非零或抛错，覆盖终态目标历史恰等于旧缓存、平台实际仍须缩减的情形，不能只测整批未应用。还须覆盖：成功即使有工具/ctx/追加或曾展开也移除过程、错误/中断保留原诊断面板、删除失败不撤销全文确认、追加与预览超限独立。真实JSON本地版式预览不能等同真实客户端效果；平台接受与客户端运行时“展开→正文更新→历史更新”、成功收尾移除面板分别取证，fake SDK成功不能替代真实阅读状态验收。

#### 完整回答投递

`ResponseDeliveryRecord` 保留 ID、所属地址/会话、待发正文、分块及 sent/messageId、状态、尝试次数和时间。必须先 save + await flush，再进行平台发送；每块成功后更新进度。保存失败不可降级成无记录发送。只有宿主确实实现完整能力才称持久化；内存降级须明确重启可能丢失。

重试必须验证 chat/channel/user 来源并互斥。不能把失败记成成功去重，也不能按旧格式错误判断降级后的重试。成功记录清除重复正文并限制元数据保留。平台送达与本地保存之间有不确定窗口，不声称 exactly-once。

### 生成图片

Codex 生成图仅来自精确匹配当前 thread/turn 的 `item/completed.imageGeneration`，要求 completed 状态与有效 PNG Base64，以 thread/turn/item 标识去重。忽略历史、imageView、输入附件和文字路径，不读取 savedPath 或扫描目录。桥接仅为自身 app-server 子进程设置不省略通知媒体；不得改全局配置或将静态 capability 当作账号可用性证明。

生成图片通过独立事件进入会话结果，禁止 Base64 进入普通正文、工具日志或原始 SDK 错误日志。共享校验先限制编码长度，再检查标准 Base64、PNG 最小结构及 IHDR 尺寸；每图最多 10_000_000 字节、宽高 1…12000，每回合最多 8 张、合计 30_000_000 字节。无效或超限须给用户可见说明，保留已接受内容。

回合结束且归属有效后建立单条图文 outbox，原生独立图片仍按文字在前、图片按生成顺序；正文明确引用的本地 PNG 在对应位置交付，详见 [正文图片交付合同](./inline-image-delivery.md)。记录先 save + flush，再上传；图片上传得到 imageKey 后先保存并 flush，再检查归属，使用持久 sendUuid 发送图片消息；成功进度必须在后续取消检查前落盘。重试复用 imageKey/sendUuid，不重新生成图片。建立 outbox 前不承诺内存产物的崩溃恢复。

原生独立图片场景中，流卡 finalize 只确认文字块送达，随后继续图片；纯图片也必须收尾原卡。正文内嵌图文块则按 [正文图片交付合同](./inline-image-delivery.md) 整体确认。图片不得进入文字/卡片降级路径，其他渠道默认明确不支持。上传与发送分离，上传迟到不得自动触发发送；超时保持结果未知语义，不能虚报成功。旧无 kind 的文本块继续按文本加载，混合记录须严格校验，成功后清除图片数据。

飞书 SDK 的 image.create 返回扁平 image_key；message.create 须同时检查平台成功与 message_id。SDK logger 仅输出固定类别与安全数值状态码，不传递原始错误、请求配置、Buffer 或 Base64。Codex 服务端失败和 JSON 语法错误同样不得透传原始异常文本或 cause 链；保留固定错误类别和主存储/备份角色，避免错误信息回显媒体内容。

审批发送、登记、超时失败必须解开模型等待。原卡状态在网关确认解决后更新，超时使用真实 resolution，不再维护猜测时长的第二套计时器。卡片更新失败不能撤销已经成立的权限解决。

### 持久化与审查

JSON 写入采用同目录临时文件、同步内容后原子替换，并保留有效备份；仅 ENOENT 可代表首次运行。损坏且无有效备份应停止空载启动，不能覆盖原文件。并发 flush 必须等到调用前已有变更真正落盘。

工作流执行锁识别主机、PID 和随机 owner token；不因耗时长抢占活跃 PID。可确认退出的锁可恢复，损坏/异地主机/无法确定归属应返回可操作的错误。暂停返回前保证旧执行者停止写入。

补丁步骤必须在写 spec/plan/ledger 之前持久化稳定基线与完整应用结果；恢复使用固定原始输入或已保存结果，不能对 latest 文档重复 apply 后重新判断成败。目标文档使用固定版本，存在但内容不符应暂停而非覆盖。round pack 可能已压缩，不能充当准确补丁原文。未知标题首次追加且失败，恢复后仍须失败，不能因新增标题已经存在就升级为 resolved。缺乏可证基线的旧半完成步骤必须说明限制，不能猜测成功。

每轮 `claude-baseline.json` 保存 `schema/runId/round`、spec/plan 的 `version/hash` 及决策前 ledger；`patch-application.json` 保存 `baselineHash/rawHash`、各目标文档的固定版本与完整 `PatchResult`、`hasPatchFailure`、最终 ledger 和完成事件摘要。两者使用带 `checksum` 的原子 round artifact。恢复先校验归属、摘要、实际版本与 ledger（须等于原基线或已提交结果），然后补齐固定文档、ledger，最后推进步骤；发生冲突不得覆盖人工或其他步骤变更。

首次提交也必须复用同样的预检，检测模型调用期间发生的人工变更。补丁提交各写入及完成事件/checkpoint 边界都检查暂停信号；已进入的原子写先排空，再保存 `claude_decision` 暂停检查点，后续提交留待恢复。暂停期间执行锁保持归属，不能提前释放给第二执行者。

审查 snapshot 的 diff、blob 和修复基线必须一致。`head_tree` 表示可重建的冻结 tree；缺失时拒绝猜测修复。每次修复用独立 attempt、worktree 和准确 base/head；失败组保留现场并停止后续组，不能无条件 add -A 或强删旧 worktree/branch。

## 4. 校验与错误矩阵

| 输入或故障 | 必须行为 |
| --- | --- |
| 合并/排队期间 stop | 不启动被取消的模型请求，消息得到明确处理 |
| 旧回合晚到或绑定切走再切回 | 不更新新 binding、状态或卡片 |
| 非阻塞问答与其他阻塞交互并存 | 输出可继续，等待状态由尚未解决的阻塞集合决定 |
| 关闭通知 thread 错误或原答案按钮在闭合后晚到 | 忽略错误通知；旧答案不能自动转换为补充 |
| 闭合问题补充双击、超时结果未知或另一回合活跃 | 一次性准入；unknown 不重放；新活跃回合拒绝旧补充 |
| 原回合正常完成与主动 stop/new/bind/停机 | 正常未答可保留显式入口，主动取消清理包括闲置卡 |
| 补充成功回执晚于模型完成 | 接收事实仍成立，补充 user 在原 assistant 前结算；不自动后轮 |
| 即时补充请求结果未知、收尾后回执迟到 | 不重送、不迁入新任务、不在最终记录之后再追加 user |
| 待发记录 flush 失败 | 不发送，返回可定位的持久化错误 |
| 第 N 块失败 | 保留前 N-1 块进度；补发不重调模型 |
| 流卡收尾成功且仍有图片 | 只确认文字，继续上传并发送图片 |
| 图片上传后发送失败或进程重启 | 复用保存的 imageKey/sendUuid，补发未确认块 |
| 取消后图片上传迟到 | 不继续发送；不影响新回合 |
| 纯图、空/坏/超限结果或不支持图片的平台 | 纯图正常出站；失败有明确说明，不发送 Base64 或空文本假成功 |
| 聊天 A 补发等待，聊天 B stop/审批 | 控制事件继续消费，不等 A 的网络结果 |
| 补发中 stop/new/bind 或停机 | 停止后续块；成功块仍写回原投递记录；旧回执不更新新聊天状态 |
| 当前聊天 new 后查询 sessions | 可找到旧关联并获取完整可用 ID，不暴露其他聊天记录 |
| 审批卡发送或 link 登记失败 | deny 当前请求，清理转发状态 |
| 卡片/富文本超字节预算 | 按最终序列化预算分块，不按 JS 字符数猜测 |
| 工具历史过大、正文增长或JSON转义放大 | 历史显式缩略、先缩减再增长，实时状态仍刷新，全文仍完整投递 |
| 手动展开历史后继续输出及结束 | 仅局部更新子文本，不切配置；真实客户端验收，不能用固定ID或fake成功代替 |
| 运行batch部分应用后报错或频控，随后成功收尾 | 明确清空常显最近进展、保留历史；超限终态预览也清空，完整正文仍交原分段链路 |
| JSON 损坏 | 验证备份或失败退出，保留恢复材料 |
| 活跃执行锁 | 拒绝并发 resume，不按超时抢占 |
| 补丁文档/ledger 已保存但步骤未推进 | 从稳定结果补齐固定版本并推进，不重新解释失败，不重复版本 |
| 补丁恢复基线缺失或目标冲突 | 明确暂停并保留原始产物，不覆盖或猜 latest |
| 审查基线不可重建 | 不启动模型修复，提示重新审查 |
| 无关 diff、验证不通过、模型改提交历史 | 不计 fixed，不夹带到下一组提交 |

## 5. 正常、边界与失败示例

- 正常：完整回答保存后发送，原卡完成或所有块成功，记录变为 delivered。
- 边界：第 2 块失败后 `/retry <id>` 仅补第 2 块及后续，模型调用次数不变。
- 边界：补发被停止时，已进入平台且最终成功的分块仍保留 sent；没有发送的分块下次可补发。
- 正常：`/new` 后 `/sessions` 列出当前聊天旧会话的完整 ID，`/bind` 可切回；其他聊天的会话不出现。
- 失败：磁盘拒绝写入时保留未送状态并明确错误，不能回复“已持久保存”。
- 边界：进程退出后遗留 running，在确认 owner 已退出并取得锁后恢复；另一个活跃 runner 恢复同一 run 时拒绝。
- 失败：修复模型改了不在本组范围的文件，即使 git diff 非空也不能称为已修复。
- 边界：未知标题补丁保存后进程中断，恢复保留首次 failedSections，问题仍未解决；正常匹配的补丁恢复后仍能解决问题。
- 正常：非阻塞问题“输出格式？”期间 Codex 继续分析，回答“CSV”只返回原问题，没有新的过程卡或回合。
- 边界：原问题已关闭，用户点击“作为任务补充发送”后，原题与“CSV”沿即时追加/后轮一次处理；点击原“提交答案”则提示关闭。
- 失败：旧问题卡在另一 active 回合或换绑后点击，不能向该新回合发送答案。

## 6. 必需测试断言

使用纯内存模型、平台传输和故障注入；普通测试禁止真实模型/IM。覆盖控制命令 × collecting/queued/running/waiting-input、stop/start 交错、旧卡创建晚到、并发 flush、发送后进度保存失败、权限到期回写、崩溃锁恢复、非 HEAD 快照、部分修复失败和准确补丁范围。相关单测通过后运行 typecheck/build 与整合单测；后台单测总时长不超过 60 秒。

补发回归应真正运行 manager 消费循环并挂起 fake 平台发送；会话历史回归应关闭后重建 JSON store，验证 channel/chat 隔离。补丁恢复回归应使用真实 WorkflowStore、fake ModelInvoker，并在 application/spec/plan/ledger/checkpoint 保存前后注入故障，再创建新 Store/Engine 恢复；与无故障执行比较文档、问题状态、版本数量及模型调用次数。

图片回归使用锁定 Codex 协议结构、合成 PNG 与 fake 传输。覆盖 early 通知、重复/错回合、失败/空/坏/超限、纯图和图文、流卡收尾、上传检查点、重启补发、取消后迟到及 SDK 日志脱敏。禁止真实生图与生产飞书调用，测试不得扫描用户图片目录。

问答回归锚点：bridge-codex-protocol.test.ts 验证标志、并发等待、原 RPC、正常闭合/取消和错 thread；bridge-user-input-broker.test.ts 验证同步已终态、晚到卡、答案来源、连续到期/容量淘汰及慢 patch 最终终态；bridge-feishu-streaming.test.ts 验证同卡选择/输入、专用补充 DTO与终态去入口；bridge-feishu-async-questions.test.ts 用真实 manager/provider/broker 和 fake 平台验证即时/后轮、双击、旧回合隔离、闲置卡 stop/new/bind/停机、挂起反馈仍消费控制及 unknown 不重播。硬阻断真实模型/网络，每批 60 秒。

## 7. 错误与正确做法

- 错：`await deliverResponse(...)` 后忽略结果并认为用户已收到。正确：送达状态独立记录，失败保留补发入口。
- 错：`abort()` 后立即让旧回调继续按 chatId 更新卡。正确：检查 generation/epoch 与具体卡片创建归属。
- 错：JSON.parse 失败后用空集合继续启动。正确：校验备份或拒绝覆盖原数据。
- 错：存在任何 diff 就增加 fixedCount。正确：范围/补丁检查产生候选，问题验证通过后才增加 fixedCount。
- 错：保存过文档就从 latest 重放补丁。正确：先保存原始基线与应用结果，恢复固定判定及目标版本。
- 错：把渠道当前绑定列表当作聊天历史并截断 ID。正确：按 channel/chat 的历史关联读取，提供完整可用绑定命令。
- 错：`if (!handleUserInputResponse(...)) enqueueRegularMessage(answer)` 自动重放闭合答案。正确：原答案失败仅提示关闭；专用补充动作经原题/来源/原任务校验和一次性 claim 后才准入。

来源：`10-04-optimization-audit` 的隔离研究，`10-04-reliability-fixes`、`10-05-audit-priority-fixes` 与 `10-05-feishu-image-output` 的实现/回归。
