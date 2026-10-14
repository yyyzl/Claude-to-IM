# 会话、投递与恢复合同

## 1. 范围与触发条件

修改消息队列、会话绑定、停止、回答投递、权限交互、JSON Store 或工作流恢复/自动修复时，必须使用本合同。平台表现不能代替核心状态：卡片收到点击不代表权限已批准，模型结束不代表回答已送达。

## 2. 接口

- `processWithSessionLock(..., signal?: AbortSignal)`：信号取消尚未开始的排队任务；已运行任务由自己的取消上下文结束。
- `deliverResponse(adapter, address, responseText, sessionId, replyToMessageId?, options?)`：统一生成响应分块、保存待发记录和投递；`options` 可携带 `turnId / isCurrent / finalize / images`。
- `retryResponseDelivery(adapter, address, id?, { isCurrent }?)`：只重投已有记录的未送达块，不调用模型；有效性谓词在每个后续分块与发送重试前检查。
- `deliver(adapter, message, { isCurrent }?)`：普通文本投递可选归属检查，覆盖开始、后续分块与重试；已进入平台的发送不能撤回。账号额度查询的异步调度及 epoch 合同见 [账号额度合同](./codex-account-quota.md)。
- `BridgeStore.saveResponseDelivery/getResponseDelivery/listResponseDeliveries/flush`：四项共同形成可选的持久待发能力；`close()` 用于停机。
- `BridgeStore.listChannelSessionHistory?(channelType, chatId): ChannelSessionHistoryEntry[]`：只读当前聊天历史；条目为 `sessionId/title/workingDirectory/updatedAt`，按最近关联排序。`/sessions [页码]` 每页 5 条，完整 ID 可用于 `/bind`。
- `PermissionGateway.onResolution?(requestId, listener)`：订阅真实解决结果，返回取消订阅函数；`reason` 可区分 `expired / cancelled / delivery_failed`。
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

`ResponseDeliveryRecord` 保留 ID、所属地址/会话、待发正文、分块及 sent/messageId、状态、尝试次数和时间。必须先 save + await flush，再进行平台发送；每块成功后更新进度。保存失败不可降级成无记录发送。只有宿主确实实现完整能力才称持久化；内存降级须明确重启可能丢失。

重试必须验证 chat/channel/user 来源并互斥。不能把失败记成成功去重，也不能按旧格式错误判断降级后的重试。成功记录清除重复正文并限制元数据保留。平台送达与本地保存之间有不确定窗口，不声称 exactly-once。

### 生成图片

Codex 生成图仅来自精确匹配当前 thread/turn 的 `item/completed.imageGeneration`，要求 completed 状态与有效 PNG Base64，以 thread/turn/item 标识去重。忽略历史、imageView、输入附件和文字路径，不读取 savedPath 或扫描目录。桥接仅为自身 app-server 子进程设置不省略通知媒体；不得改全局配置或将静态 capability 当作账号可用性证明。

生成图片通过独立事件进入会话结果，禁止 Base64 进入普通正文、工具日志或原始 SDK 错误日志。共享校验先限制编码长度，再检查标准 Base64、PNG 最小结构及 IHDR 尺寸；每图最多 10_000_000 字节、宽高 1…12000，每回合最多 8 张、合计 30_000_000 字节。无效或超限须给用户可见说明，保留已接受内容。

回合结束且归属有效后建立单条图文 outbox，文字在前、图片按生成顺序。记录先 save + flush，再上传；图片上传得到 imageKey 后先保存并 flush，再检查归属，使用持久 sendUuid 发送图片消息；成功进度必须在后续取消检查前落盘。重试复用 imageKey/sendUuid，不重新生成图片。建立 outbox 前不承诺内存产物的崩溃恢复。

流卡 finalize 只确认文字块送达，随后继续图片；纯图片也必须收尾原卡。图片不得进入文字/卡片降级路径，其他渠道默认明确不支持。上传与发送分离，上传迟到不得自动触发发送；超时保持结果未知语义，不能虚报成功。旧无 kind 的文本块继续按文本加载，混合记录须严格校验，成功后清除图片数据。

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

## 6. 必需测试断言

使用纯内存模型、平台传输和故障注入；普通测试禁止真实模型/IM。覆盖控制命令 × collecting/queued/running/waiting-input、stop/start 交错、旧卡创建晚到、并发 flush、发送后进度保存失败、权限到期回写、崩溃锁恢复、非 HEAD 快照、部分修复失败和准确补丁范围。相关单测通过后运行 typecheck/build 与整合单测；后台单测总时长不超过 60 秒。

补发回归应真正运行 manager 消费循环并挂起 fake 平台发送；会话历史回归应关闭后重建 JSON store，验证 channel/chat 隔离。补丁恢复回归应使用真实 WorkflowStore、fake ModelInvoker，并在 application/spec/plan/ledger/checkpoint 保存前后注入故障，再创建新 Store/Engine 恢复；与无故障执行比较文档、问题状态、版本数量及模型调用次数。

图片回归使用锁定 Codex 协议结构、合成 PNG 与 fake 传输。覆盖 early 通知、重复/错回合、失败/空/坏/超限、纯图和图文、流卡收尾、上传检查点、重启补发、取消后迟到及 SDK 日志脱敏。禁止真实生图与生产飞书调用，测试不得扫描用户图片目录。

## 7. 错误与正确做法

- 错：`await deliverResponse(...)` 后忽略结果并认为用户已收到。正确：送达状态独立记录，失败保留补发入口。
- 错：`abort()` 后立即让旧回调继续按 chatId 更新卡。正确：检查 generation/epoch 与具体卡片创建归属。
- 错：JSON.parse 失败后用空集合继续启动。正确：校验备份或拒绝覆盖原数据。
- 错：存在任何 diff 就增加 fixedCount。正确：范围/补丁检查产生候选，问题验证通过后才增加 fixedCount。
- 错：保存过文档就从 latest 重放补丁。正确：先保存原始基线与应用结果，恢复固定判定及目标版本。
- 错：把渠道当前绑定列表当作聊天历史并截断 ID。正确：按 channel/chat 的历史关联读取，提供完整可用绑定命令。

来源：`10-04-optimization-audit` 的隔离研究，`10-04-reliability-fixes`、`10-05-audit-priority-fixes` 与 `10-05-feishu-image-output` 的实现/回归。
