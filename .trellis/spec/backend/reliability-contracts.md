# 会话、投递与恢复合同

## 1. 范围与触发条件

修改消息队列、会话绑定、停止、回答投递、权限交互、JSON Store 或工作流恢复/自动修复时，必须使用本合同。平台表现不能代替核心状态：卡片收到点击不代表权限已批准，模型结束不代表回答已送达。

## 2. 接口

- `processWithSessionLock(..., signal?: AbortSignal)`：信号取消尚未开始的排队任务；已运行任务由自己的取消上下文结束。
- `deliverResponse(adapter, address, responseText, sessionId, replyToMessageId?, options?)`：统一生成响应分块、保存待发记录和投递；`options` 可携带 `turnId / isCurrent / finalize`。
- `retryResponseDelivery(adapter, address, id?)`：只重投已有记录的未送达块，不调用模型。
- `BridgeStore.saveResponseDelivery/getResponseDelivery/listResponseDeliveries/flush`：四项共同形成可选的持久待发能力；`close()` 用于停机。
- `PermissionGateway.onResolution?(requestId, listener)`：订阅真实解决结果，返回取消订阅函数；`reason` 可区分 `expired / cancelled / delivery_failed`。
- `WorkflowStore.acquireExecution(runId)`：取得唯一执行权并返回释放函数；活跃或归属不明的执行者不能自动抢占。
- `AutoFixOptions.validate?(cwd, issueIds)`：返回 `{passed, summary}`；缺少验证时只产生修复候选，不计入 `fixedCount`。

## 3. 数据与行为合同

### 任务归属

每个入队回合固定 session/binding 快照、chat generation、bridge run epoch 和取消信号。旧回合的 status/result/finally、延时刷新和异步卡片创建都必须验证归属；绑定 ID 相等不足以证明还是同一个会话。`stop/new/bind` 统一清理合并、追加与串行队列，不将旧消息迁入新会话。

本地取消等待与外部实际中断分别对待。流读取、交互发送必须能响应取消，清理有界；超时不能伪称外部服务已经确认停止。核心 stop 禁止新准入，再取消和排空，最后关适配器。

### 投递与权限

`ResponseDeliveryRecord` 保留 ID、所属地址/会话、待发正文、分块及 sent/messageId、状态、尝试次数和时间。必须先 save + await flush，再进行平台发送；每块成功后更新进度。保存失败不可降级成无记录发送。只有宿主确实实现完整能力才称持久化；内存降级须明确重启可能丢失。

重试必须验证 chat/channel/user 来源并互斥。不能把失败记成成功去重，也不能按旧格式错误判断降级后的重试。成功记录清除重复正文并限制元数据保留。平台送达与本地保存之间有不确定窗口，不声称 exactly-once。

审批发送、登记、超时失败必须解开模型等待。原卡状态在网关确认解决后更新，超时使用真实 resolution，不再维护猜测时长的第二套计时器。卡片更新失败不能撤销已经成立的权限解决。

### 持久化与审查

JSON 写入采用同目录临时文件、同步内容后原子替换，并保留有效备份；仅 ENOENT 可代表首次运行。损坏且无有效备份应停止空载启动，不能覆盖原文件。并发 flush 必须等到调用前已有变更真正落盘。

工作流执行锁识别主机、PID 和随机 owner token；不因耗时长抢占活跃 PID。可确认退出的锁可恢复，损坏/异地主机/无法确定归属应返回可操作的错误。暂停返回前保证旧执行者停止写入。

审查 snapshot 的 diff、blob 和修复基线必须一致。`head_tree` 表示可重建的冻结 tree；缺失时拒绝猜测修复。每次修复用独立 attempt、worktree 和准确 base/head；失败组保留现场并停止后续组，不能无条件 add -A 或强删旧 worktree/branch。

## 4. 校验与错误矩阵

| 输入或故障 | 必须行为 |
| --- | --- |
| 合并/排队期间 stop | 不启动被取消的模型请求，消息得到明确处理 |
| 旧回合晚到或绑定切走再切回 | 不更新新 binding、状态或卡片 |
| 待发记录 flush 失败 | 不发送，返回可定位的持久化错误 |
| 第 N 块失败 | 保留前 N-1 块进度；补发不重调模型 |
| 审批卡发送或 link 登记失败 | deny 当前请求，清理转发状态 |
| 卡片/富文本超字节预算 | 按最终序列化预算分块，不按 JS 字符数猜测 |
| JSON 损坏 | 验证备份或失败退出，保留恢复材料 |
| 活跃执行锁 | 拒绝并发 resume，不按超时抢占 |
| 审查基线不可重建 | 不启动模型修复，提示重新审查 |
| 无关 diff、验证不通过、模型改提交历史 | 不计 fixed，不夹带到下一组提交 |

## 5. 正常、边界与失败示例

- 正常：完整回答保存后发送，原卡完成或所有块成功，记录变为 delivered。
- 边界：第 2 块失败后 `/retry <id>` 仅补第 2 块及后续，模型调用次数不变。
- 失败：磁盘拒绝写入时保留未送状态并明确错误，不能回复“已持久保存”。
- 边界：进程退出后遗留 running，在确认 owner 已退出并取得锁后恢复；另一个活跃 runner 恢复同一 run 时拒绝。
- 失败：修复模型改了不在本组范围的文件，即使 git diff 非空也不能称为已修复。

## 6. 必需测试断言

使用纯内存模型、平台传输和故障注入；普通测试禁止真实模型/IM。覆盖控制命令 × collecting/queued/running/waiting-input、stop/start 交错、旧卡创建晚到、并发 flush、发送后进度保存失败、权限到期回写、崩溃锁恢复、非 HEAD 快照、部分修复失败和准确补丁范围。相关单测通过后运行 typecheck/build 与整合单测；后台单测总时长不超过 60 秒。

## 7. 错误与正确做法

- 错：`await deliverResponse(...)` 后忽略结果并认为用户已收到。正确：送达状态独立记录，失败保留补发入口。
- 错：`abort()` 后立即让旧回调继续按 chatId 更新卡。正确：检查 generation/epoch 与具体卡片创建归属。
- 错：JSON.parse 失败后用空集合继续启动。正确：校验备份或拒绝覆盖原数据。
- 错：存在任何 diff 就增加 fixedCount。正确：范围/补丁检查产生候选，问题验证通过后才增加 fixedCount。

来源：`10-04-optimization-audit` 的隔离研究与 `10-04-reliability-fixes` 的实现/回归。
