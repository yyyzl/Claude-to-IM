# 飞书跨重启去重设计草案

## 边界与最小结构

新增专用入站处理 ledger，复用现有 JSON 保存/flush，不复用只表示出站发送的 checkDedup。ledger 只存身份、状态、回合/待发关联和安全错误类别；不保存另一份待执行正文，不建立第二套队列。内存 inFlight 继续负责并发事件的短期互斥。

记录建议包含 key、平台/聊天/用户/消息身份、state、turnId/sessionId、responseDeliveryId、执行结果类别与创建/更新时间。状态分为 pending、running、completed、unknown、discarded。completed 表示已有可核验处理结果，不等于模型或平台业务成功。

## 持久化时机

1. 授权、解析和下载成功后登记 pending，flush 成功才交给现有队列。入口失败不得提前标记 completed；保存失败不得无记录启动模型。
2. 合并/追加保留所有来源消息 ID；真正开始模型或控制副作用前，整组记录转 running 并 flush。不得只保留 mergeInboundMessages 的最后一条 messageId。
3. 模型回合产生结果后，outbox 初始记录及全部来源 ID 的 completed/result 关联必须在同一宿主 JSON 快照中落盘，随后才进行外部投递。已有回答仅投递失败时，重复事件不再触发模型；/retry 只补已有响应。
4. 模型结果未形成可核验持久记录、首次 outbox flush 失败或进程在 running 时退出，保留 unknown，不自动重跑可能已发生副作用的模型任务。
5. 控制命令按实际处理结果记录：/retry、/workflow 返回只表示任务已登记，不代表后台投递/工作流成功。审批与卡片回调仍由原 broker 校验，不扩成另一套审批系统。

## 恢复与停止

拟定恢复行为供本轮最终审阅：completed/discarded 重投被抑制；未开始的 pending 若再次由平台投递，可在原来源和当前绑定校验后进入现有队列；running/unknown 不盲目重跑，在 /status 或重投反馈中说明中断与结果未知，用户通过新消息明确要求重试。没有可用平台重投的 pending 只显示未完成状态，不假装已经恢复执行。

stop/new/bind 清理未开始的消息时同步保存 discarded；已开始执行按原中断机制处理，不将旧消息迁入新会话。正常停机完成既有有界排空与 flush；未知状态不会因 finally/ack 被伪装为成功。

## 宿主契约与升级

host.ts 提供可选但成组的入站记录能力与 flush；内置 JSON 宿主实现完整能力。能力不完整的外部宿主仍使用现有内存行为并明确不能保证跨重启，禁止伪造持久化保证。旧文件缺少新字段按无历史记录加载，无法补证旧消息已经执行。保留有界过期策略，不清除仍可能恢复或待发的活动记录。

JSON 更新遵守原原子写、备份与 unknown 运行时校验；不给真实存储做离线手工迁移或删除。实现前核对反向兼容：旧版本保存新文件可能丢弃新增字段，回退前须停止写入并保留完整存储备份。

## 受影响入口和风险

FeishuAdapter.handleIncomingEvent → processIncomingEvent/enqueue → scheduleMessages（含 debounce/append）→ handleMessage → processMessage → deliverResponse/outbox → JSON Store。

基线 main c651157；已知共享调度和投递的上游图风险为 CRITICAL。实施前按最终符号继续逐项分析，直接调用方与动态注册边界以源码补证。修改保持在飞书入站、已有调度和宿主契约，不扩到其它渠道。

## 研究与审阅

父任务 research/inbound-dedup.md 已收敛原始消息组透传、模型结果未落盘的未知窗口及控制命令处理含义。实施时按其中列出的真实边界确定具体接口名和切片，不另建执行队列；最终计划未获确认前不实施。
