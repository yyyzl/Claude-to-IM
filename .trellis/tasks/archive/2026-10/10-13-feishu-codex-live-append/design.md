# 即时追加技术设计

## 状态与边界

用户已认可目标体验，并于 2026-10-14 审阅最终范围后明确批准实施。首版针对飞书 Codex、追加开启、同一原任务发送者的无附件普通文本（含现有归一化的纯文字 post）。命令、透传、按钮、其他发送者、其他平台/provider 与附件沿用原路径。研究依据为父任务 `research/live-append.md`。

核心变更集中在 `host.ts`、`conversation-engine.ts`、`bridge-manager.ts`、`codex-llm.ts`。优先复用现有飞书 notifyAppend 与卡片生命周期，不改 JSON-RPC 协议客户端、SDK 版本或待发架构；不新增全局输入注册表、持久执行队列或相似文本去重。

## 契约：每次模型调用提供当前输入句柄

在 `StreamChatParams` 增加可选回调，由支持即时输入的 provider 提供本次 stream 专属的提交函数；engine 包装后通过交互回调交给 manager 的原 ActiveChatTask。具体类型名在实施中遵循现有命名，语义必须固定：

- 输入为归一化补充文字及内部来源标识，不注入历史提示词。
- 结果仅区分 accepted、not-submitted、unknown。
- accepted 只在 RPC 响应合法且 turnId 与原 expectedTurnId 完全一致时成立。
- not-submitted 只在本地验证能证明未调用 RPC 时成立，例如句柄已封闭、初始化已结束但原回合未建立或归属失效；允许在仍属原会话且未取消时进入既有后轮。正常初始化中的请求等待本轮 ready，不提前降级后轮。
- request 已调用后的异常、超时、断连、坏或不匹配的响应归 unknown。后续 turn/completed 不能证明先前未接收。unknown 明确提示用户，不自动重复提交或启动后轮。

句柄是单次 stream 的闭包，绑定 provider epoch、thread、turn、取消信号及存活状态，不能按缓存 sdkSessionId 重新查找别的活跃任务。engine 的内部取消控制器与 manager 的控制器不同，不假定它们是同一对象。

## manager：源消息与调度归属

原 ActiveChatTask 关联原 TurnContext、发送者及当前输入能力。新增输入仍按 chat generation、run epoch、binding、session、原任务对象及 abort 验证归属；发送者必须与原任务一致。即时入口先复用现有 sanitizeInput、大小限制及截断审计，再按清理后的文本判定普通输入；原命令/透传处理不被绕过。

消息消费循环在既有准入边界内同步登记来源并调用 engine 提供的 submit 句柄，不等待其网络 Promise。同步调用确保补充立即进入 engine 的 pending 集合，不先放进一个尚未登记的 manager 微任务。连续补充由 engine 按原入站次序串行提交；对应 Promise 纳入现有任务追踪、取消与有界排空。跨聊天及 stop/审批继续消费。

生命周期必须明确区分待尝试、提交中、已接收、确认未提交与未知结果。同一来源只能由一个路径拥有：提交中或已接收的消息不能同时存在于可 flush 的 pendingAppends 组。原回合 finally 不能把尚在等待回执的同一来源再次发成后轮。

provider 初始化前发布本次句柄；提交操作等待原回合 ready，不另建全局 registry。若 manager 尚未收到句柄，保留确认未提交来源，并在句柄发布时接入符合条件的待补充。模型已封闭时，仍然存在的卡片不代表模型可 steer：仅确认未提交的来源进入原有后轮。保留来源顺序，不跨越其他发送者、命令或附件的既有排队边界。无法证明与原发送者相同时不进行即时提交。

成功来源与原任务统一确认，必要消息确认不得在 RPC 入站成功时提前冒充整个任务处理完成。取消时对每个来源给出符合现有 offset 契约的终态；未知来源不会悄悄迁入下一任务。

原卡追加提示检查原 UI owner；独立接收事实通知只检查原 context 的取消、generation、run epoch、binding ID 与 session ID，纳入 taskPromises。正常 finally 清理原 UI 或同会话开启新卡不能吞掉限流中的 unknown/记录失败提示；stop/new/bind/停机仍抑制旧通知。通知携带原地址与 replyToMessageId，现有飞书适配器按聊天普通消息投递，不声称已实现线程回复。

## engine：消息历史与收尾栅栏

engine 持有本次模型调用的输入包装器、串行 tail 与待确认请求集合。submit 同步登记 Promise 后才启动异步 provider 操作，后续消息即使尚在等待前一个 RPC，也已经被收尾栅栏覆盖。

成功接收的补充作为 user 消息写入原会话，使用原任务捕获的会话归属；不在 accepted 后重新调用 processMessage。正常或错误的 assistant 消息写入前，关闭新输入准入并结算已登记的确认，再保存 assistant 消息。最终记录顺序必须为原 user、补充 user、原回合 assistant。

取消、超时及连接故障的结算有界，不无限等待网络。RPC 已接收但本地历史保存失败时，不得降级成 not-submitted 或自动再送模型；应保留接收事实并报告记录失败。

## Codex provider：精确回合与终态

使用固定协议 `turn/steer`，参数 threadId、expectedTurnId、input；不引入额外 turn/start、thread/start/resume 或重新选模型。

本次 closure 输入句柄在初始化前发布；其 ready 仅在 turnId 已建立、本次 collector 安装通知处理并处理现有 backlog 后解锁，避免已经收到 turn/completed 仍把句柄标成可用。精确匹配当前 thread/turn 的完成、失败、中断以及本地取消、断连、epoch 变化均当场封闭准入，并唤醒尚未发 RPC 的等待操作。已提交请求仍须结算其接收结果，不能因后来闭合就假定未提交。

使用现有文本输入格式 `{type:'text', text, text_elements:[]}`。响应只读取 turnId 白名单并校验类型和值，不将原始错误、账号数据或 RPC payload 送入普通日志/卡片。现有 client 抛泛 Error 即可；不解析错误文案猜远端状态。保守限制：部分真实远端拒绝也只能归 unknown，需明确说明而非自动再执行。

## 飞书可见行为

接受补充后调用原卡 notifyAppend，表示确实已追加；既有正文、进度及工具列表继续在原卡更新。没有第二次 onMessageStart 或第二张过程卡。最后仍由现有最终卡片/待发链路完成答复，不绕过补发与图文结果投递。

模型是否需要再次调用工具取决于补充内容；当前设计不按文本相似度硬去重，也不承诺工具永远只运行一次。

## 影响与回滚

GitNexus 索引与 main/c651157 一致。registerActiveTask/clearActiveTask 上游直接调用为 handleMessage，风险 CRITICAL；processMessage 的直接调用为 handleMessage 与 mock-host.main，风险 CRITICAL。共用 scheduleMessages 也是 CRITICAL，优先避免修改。enqueueRegularMessage 为 LOW。

consumeStream 为 CRITICAL，直接调用为 processMessage；真实上游为 handleMessage 与 mock-host.main。provider.streamChat 图中为 UNKNOWN/lower-bound，实际源码由 engine 的 llm.streamChat 动态调用并由宿主装配 provider；零图调用不能视为安全。图中的同名动态误关联不作为真实调用链；每个最终修改符号仍须重新 impact 并结合当前源码补证。HIGH/CRITICAL 已在规划告知，实施前仍确认实际范围。

本任务先交付，去重子任务继承 accepted 补充与原回合的来源关系，不能把即时输入当成可重放后轮。回滚为回退本任务代码并重启桥接进程，恢复既有后轮追加；无新持久格式或全局配置迁移。

## 设计就绪条件

研究已确认句柄的初始化、ready、封闭、待确认结算与来源统一确认边界。采用保守 unknown 语义，不依赖额外厂商查询或提交幂等承诺。无待用户选择的产品分支；一致性、上下文及最终规划审阅已完成，实施仍需逐符号核对实际影响。
