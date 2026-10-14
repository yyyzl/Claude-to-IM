# 技术设计

## 数据流与职责

`app-server 原问题 → Codex provider → user_input_request → broker → 飞书表单 → 专用答案/补充回调 → broker 校验 → manager 准入 → 原 RPC 或既有追加/后轮`。

provider 只负责协议与阻塞状态；broker 负责题目、答案、来源和问答生命周期；飞书渲染器只负责卡片；manager 负责原任务归属及消息调度。保留通用审批 `observeInteraction` 的行为，不给审批卡增加问答缓存。

## 协议与运行状态

- 明确区分两个生产者。原 item/tool/requestUserInput 有 JSON-RPC ID，答案回原 RPC；原生 agentMessage.delivery=async/questions 是通知，没有对应回答 RPC。UserInputRequest.answerChannel?: 'rpc' | 'message' 缺省 rpc，不能用 isBlocking 推断回答通道。
- 当前 collector 精确核对 thread/turn 后识别有效原生 questions，稳定映射 q0/q1 等题目 ID，并按 item.id 去重 started/completed/backlog。经现有 user_input_request SSE 透传 message 通道和 isBlocking=false；不扫描历史、不从文字猜题。
- 原生题的文字不计入模型最终响应。缓冲时以 item metadata 判别后再发文字，保留普通消息及无效题的既有展示。原生题 notification 的 phase=final_answer 不等于 turn 完成。
- 流式取舍：metadata 未知的 delta 先缓存，明确 async 但题目未定则等 completed；普通 started 已给出 phase 且无 async 时维持现有流式。如果同 item 已显示普通文字，后续 completed 才改变为 async 题，已投递文字无法撤回，仍保留该片段；不为未证实的字段变更暂停所有普通输出。这个例外已有回归，真实持久事件不能证明 wire 的完整顺序。普通 async 未收到 completed 的缓存在 turn 完成时刷出，phase 缺省按 final_answer，既有 commentary 不变。
- 原生消息题只对当前飞书 Codex 创建表单，不创建 PermissionGateway pending/observer/response；其他渠道保留文字显示。原生 pending 答案与 closed 显式补充共用安全消息准备和一次 claim，action 必须区分。
- manager 的正常 clear(...preserveClosed:true,owner) 将原生 pending 明确转 closed；异常/停止/换绑仍取消。没有新的 engine 闭合事件。回答是带原题的普通输入，经现有 admissionGate/追加/后轮路径；该映射基于当前 schema 和普通 turn/steer 合同的实现推论，不能声称存在原生专用 answer RPC。
- `UserInputRequest.isBlocking?: boolean` 透传，Codex 明确布尔值；非 Codex 旧调用缺省维持阻塞语义。
- 明确 `false` 的问题不写 waiting_for_input，不用弃用的 autoResolutionMs 新建短超时。
- 在每个 ActiveTurn 记录未解决的阻塞交互。并发问题/审批之一结束时，另一个仍阻塞则继续等待；已结束/被替代回合的迟到 finally 不写 running。
- serverRequests 保存原 thread/turn 与交互类别；`serverRequest/resolved` 必须匹配原 threadId，使用 `request_closed` 原因关闭，原 RPC 不再响应。
- 初始化期的请求先登记原请求及关闭通知观察，再等待本轮输入 ready；必须拿到远端 turnId 后精确核对，旧 turn 的问题不能在新 turn 初始化时转发。等待期间关闭、取消或 start 失败不得复活请求。
- 正常回合完成时，内部 abort 之前关闭本回合未答问题，原因 `turn_completed`。取消、错误、断连沿用不可补充终态；不能凭一个通用 deny 或 error 文案猜测正常完成。
- `PermissionResolution.reason` 只增加上述两个精确原因，既有过期/取消/失败语义不改。

## 问答状态与保留

问答专属状态为 pending、closed、answered、supplemented、expired、cancelled、failed。仅飞书 Codex、非秘密、成功取得原卡 messageId、原任务归属仍有效的未答 request_closed/turn_completed 可保留为 closed。其他渠道保留既有回答路径，不提供迟到补充。

closed 记录保留原问题、原地址、sessionId、卡片 ID、原任务有效性/准入回调；关闭后最多 10 分钟，全进程最多 100 条。时间/数量失效及 stop/new/bind/停机应清理记录并关闭入口，定时器须 unref；不持久化题目/答案，不在日志记录用户答案。已回答或已经移交补充的记录当场不可重用。

卡片更新通过问答专属可选 adapter 能力，closed 卡保留选择与输入组件，说明“原问答已关闭，提交后将作为任务补充”，按钮改为“作为任务补充发送”。终态移除表单。平台 patch 不承诺保留未提交草稿；复用已验证的表单属性，不添加未经确认的默认值字段。更新顺序必须防止慢到的 closed patch 覆盖 answered/supplemented/取消终态；更新失败不能撤销原 RPC 接收事实。

每卡保持一个实际在途 patch，其结束后合并回写最新阶段。本地观察超时不能让下一条 patch 并发超车；控制消费与 claim 不等待更新。如果外部 promise 永久挂起，核心资格仍即时撤销，但卡片及时更新无法保证；实际 SDK 的 HTTP 超时继续承担外部边界。

正常收尾不能无差别取消 closed 记录。主动取消按 channel/chat 清理，包括已经没有 activeTask 的 closed 卡；同会话其他聊天不能被清理。回合清理使用原回合的有效性快照，避免旧 finally 干扰新回合。

## 答案与显式补充

- 新增 `InboundMessage.userInputSupplementResponse` 专用 DTO，内容与 UserInputResponse 相同，仅表示用户主动选择补充。adapter 从真实 callback context/operator 提取 chat/message/user，不信任按钮中原题或来源。
- broker 共用答案校验：问题 ID 完整、非空字符串、单选与允许选项/自由输入约束、大小限制；拼接文本时从 broker 原缓存读取原题，禁止从 callback 注入伪造原题。
- pending 只接受原答案动作：rpc 回原 RPC，message 经消息准入；closed 只接受显式补充。旧卡“提交答案”在闭合竞态中不能自动补充，返回清楚提示用户选择补充入口。
- 补充包含原题与答案，先同步校验归属、sanitize 与总大小，再在 manager admissionGate 内同步 claim 一次并准入。原有效性检查覆盖原取消信号、binding ID/session ID、chat generation、run epoch。
- 原回合仍 active 时复用即时追加；当前无其他 active 回合时可复用后轮。若同会话已开始另一 active 回合，旧卡不可 steer 新回合，明确提示通过普通消息继续。既有追加开关、来源分组和 unknown 不重放规则继续生效。
- 合成普通消息必须清除卡片动作 DTO，保留原用户/聊天及该次回调的唯一来源 ID。成功移交后由既有任务路径负责 ack，失败控制动作及时 ack；不得再次普通处理同一回调。
- 回调准入及反馈纳入 taskPromises；消费循环不等待模型 RPC、平台通知或卡片更新，所有异步边界重新检查原归属。

## 影响与取舍

CRITICAL：manager handleMessage、cancelChat 及 broker clearUserInputRequests；HIGH：答案校验入口。已向用户报告。直接调用方是消费循环、排队调度、会话控制及答案文本/卡片入口。GitNexus 中同名属性与 JSON-RPC 名称误边已用精确 UID、源码和测试补证。

不升级固定依赖、不改全局配置、不新增第二套消息调度、权限计时或持久存储。必要变更预计集中在 Codex provider、host/types、broker、adapter 契约、飞书 adapter/渲染和 manager。若实现需要扩展此边界，先反馈主会话更新设计。

## 验证与回退

纯内存真实 provider/manager/broker/卡片链路；硬阻断默认真实模型和平台入口。覆盖正常/竞态/并发阻塞、闭合、重复补充、陌生来源、停止换绑、挂起网络与 unknown。运行 typecheck/build、相关测试和全量单测；每批外层进程树硬截止 60 秒。

独立检查用 fake 复现旧 turn 在新初始化窗口被错误转发，纳入本批原任务隔离修复；另收敛 claim(admit) 必填，缺少有效准入回调不消耗资格，答案必填字段必须为 own property。

真实验收发现入口遗漏后增加 S5，基准及 RED 证据见 research/live-native-async.md。更新后的运行进程需加载新代码后再验收；主会话当前由该 bridge 自托管，不在实施/检查中自行重启。回退为撤销本批独立提交，沿用已经交付的即时追加版本，不撤销旧功能。
