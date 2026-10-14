# 飞书跨重启入站去重研究

基线：main c651157。2026-10-13 只读调研；去重研究代理两次遇到模型容量限制，主会话结合其已返回的源码结论补齐本记录。没有修改业务代码或访问真实模型/平台。

## 确认事实

- 飞书 SDK 事件注册在 `src/lib/bridge/adapters/feishu-adapter.ts:364`，调用 handleIncomingEvent（`:1435`）。incomingInFlight 防并发，seenMessageIds 仅内存；stop 会清除。
- processIncomingEvent 解析、授权、下载并 enqueue（`:1573`、`:1600`）后返回。handleIncomingEvent 随后 addToDedup；这一时刻尚未执行模型。
- JsonFileBridgeStore 的 checkDedup/insertDedup 位于 `scripts/claude-to-im-bridge/store.ts:334`，只是内存 Map；PersistedData（`:73`）及 save（`:490`）没有序列化它。只读合成验证中，同实例检查为 true，关闭再构造为 false，未创建文件。
- 现有失败重投回归在 `src/__tests__/unit/bridge-feishu-reliability.test.ts:88`；不能把旧的处理前标记恢复回来。
- 合并/追加最终调用 scheduleMessages；mergeInboundMessages 保留最后一条 messageId，单独新增处理记录必须透传全部来源 ID（`bridge-manager.ts:632`、`:665`、`:498`）。
- handleMessage（`bridge-manager.ts:1333`）登记活跃任务并调用 conversation-engine.processMessage；deliverResponse（`response-delivery.ts:124`）建立稳定 outbox，attempt 首次 save/flush 在平台发送之前。

## 最小可行合同

使用独立的入站 metadata ledger，保留 source identity、state、turn/session、关联 outbox 和安全原因类别。不复制原始执行正文，不新建持久消息队列或自动恢复执行服务。

1. 完成授权/下载后登记 pending 并 flush，再进入现有队列；保存失败不得绕过记录去执行。
2. scheduleMessages 合并/追加保留整组 source IDs；模型或控制副作用前将整组标为 running 并 flush。
3. 模型结果的初始 outbox 和来源完成关联在同一 JSON 快照/flush 保存。完成记录可区分正常、错误、取消的已核验处理结果，不把业务失败写成业务成功。
4. 已有结果但发送失败保持同一 outbox；重复事件不再次调用模型，用户沿 /retry 补投。
5. running 中断或结果/首次 outbox 保存失败保留 unknown。不能用 finally/ack 自动 completed，也不能删除标记后盲目重跑。

若 outbox 已落盘而后续 ledger 保存失败，优先利用同一原始 ID/turn/result 关联证明已有结果；不能仅根据正文相同猜测已执行。应把原始消息组身份纳入初始 outbox 关联，避免非原子两阶段保存窗口。

## 恢复取舍（供最终计划审批）

推荐结果未知不自动执行：/status 或重复事件给出上次处理中断/结果未知说明，用户以新消息明确要求重试。未开始的 pending 可在平台合法重投、来源与当前会话校验通过后重新进入现有队列；没有重投时只报告未完成，不声称恢复了执行。

stop/new/bind 明确丢弃的未开始消息保存 discarded，避免重投把旧消息带入新会话。已启动任务保留原中断/回合归属语义。正常停机执行既有有界排空与 flush；进程崩溃不假称确认过外部执行结果。

桥接控制命令也需要准确的处理含义：/retry 或 /workflow 的命令返回表示任务已登记，其后台结果仍由原投递/工作流状态管理。审批/问答/模型配置卡回调继续使用各自来源校验和 broker，不新增另一套交互去重。普通模型透传命令与普通输入共享回合执行记录。

现有 SDK handler 捕获异常并记录后返回，不能据此承诺平台一定再次推送；下载/保存失败测试只验证下一次合法重投不会被提前标记抑制，不宣称提供完整入站可靠送达服务。

## 影响与文件

- host.ts、types.ts：成组的可选 ledger 能力和内部 source IDs；缺少完整能力的宿主不能显示跨重启保证。
- scripts/claude-to-im-bridge/store.ts：运行时校验、序列化、原子快照和有界保留；旧文件缺字段只表示无旧记录，不补造历史执行结论。
- feishu-adapter.ts：授权/接收边界与并发抑制；bridge-manager.ts：合并、追加、排队、实际执行前状态及 stop/new/bind；response-delivery.ts：初始 outbox 与来源记录的同快照关联。
- 建议只有一个 internal/inbound-delivery.ts 一类私有协调 helper，具体命名由实施时按现有复用决定，不能把整个 manager 控制流复制进去。

GitNexus 1.6.12 索引对应基线，FTS 关键词检索不可用但图可查询。scheduleMessages upstream 风险 CRITICAL，d=1 包含 enqueueRegularMessage、flushDebouncedMessages、flushPendingAppends；processMessage upstream 风险 CRITICAL，d=1 包含 handleMessage、mock-host.main；deliverResponse upstream 风险 CRITICAL，d=1 为 handleMessage。影响执行流包括准入、合并/追加、会话队列、模型调用、投递及启停，实施前需向用户说明并逐项补查新修改的符号。

## 最小验收矩阵

| 场景 | 结果 |
| --- | --- |
| 同 ID 并发与串行重投 | 实际模型调用只有一次 |
| 相同正文、不同 ID | 两条独立输入均处理，不按文本去重 |
| 真 JSON 保存/重建再重投 | 已完成记录不启动模型 |
| 下载/保存失败后合法重投 | 未被提前记完成，能进入处理 |
| debounce/append 合并 2 条以上 | 全部来源 ID 均被同一回合结果覆盖 |
| 模型完成、平台失败 | outbox pending/failed，可 /retry，无新模型调用 |
| 模型完成、首次 outbox flush 失败 | unknown，有明确原因，不盲目重跑 |
| running 崩溃/重启 | unknown，不默默重复副作用 |
| stop/new/bind 清排队 | discarded，旧消息不迁移 |
| /retry、/workflow 后台仍运行 | 命令接收与后台成功分别断言 |

规范：backend/reliability-contracts.md、module-boundaries.md、type-safety.md、integration-guidelines.md、testing-guidelines.md。测试全部 fake，必须真正经过 manager 与 JSON 保存边界；每批外层硬超时 60 秒。

## 上游参考

[PR #19](https://github.com/op7418/Claude-to-IM/pull/19)，固定头 77ba46e1738af203c7704bef2b273ddbd6ce538e。只参考跨重启目标；其处理前 insertDedup 和对宿主已持久化的假设不适用于当前项目，Discord/QQ 的扩展不进入首版。
