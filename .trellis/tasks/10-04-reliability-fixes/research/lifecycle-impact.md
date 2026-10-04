# 生命周期修复：影响分析与验证

日期：2026-10-04。修改前均执行 `gitnexus impact <完整符号ID> --direction upstream -r Claude-to-IM`。
图为提交基线，不包含上一轮未提交升级，因此同时核对当前调用位置。没有重建索引或提交。

| 既有符号 | 风险 | 直接调用方 / 流程 |
| --- | --- | --- |
| manager.getState | CRITICAL | 18 个 manager 状态消费者，6 流程；仅增加运行代际、待执行记录、清理 Promise 集合 |
| manager.processWithSessionLock | HIGH | flushPendingAppends、flushDebouncedMessages、enqueueRegularMessage；4 流程 |
| manager.flushPendingAppends | HIGH | enqueueRegularMessage、handleMessage；4 流程 |
| manager.flushDebouncedMessages | HIGH | enqueueRegularMessage；3 流程 |
| manager.enqueueRegularMessage | LOW | runAdapterLoop；2 流程 |
| manager.start | LOW | tryAutoStart；1 流程 |
| manager.stop | LOW（图中） | 当前宿主 runner 和测试；补源码确认，按高影响生命周期路径验证 |
| manager.runAdapterLoop | LOW | start；1 流程 |
| manager.handleMessage | HIGH | 三条排队入口和 runAdapterLoop；3 流程 |
| manager.handleCommand | HIGH | handleMessage；4 流程 |
| manager.registerActiveTask | HIGH | handleMessage；4 流程；新增独立 UI ownership，迟到取消清理不关闭新卡 |
| manager.abortActiveTaskForChat（移除） | HIGH | handleCommand；改为覆盖所有等待阶段的 cancelChat |
| manager.deliverResponse（移除） | HIGH | handleMessage；改为导入投递模块唯一实现 |
| engine.processMessage | CRITICAL | manager.handleMessage、examples/mock-host.main；5 流程；新回调可选，不破坏示例宿主 |
| engine.consumeStream | HIGH | processMessage；4 流程 |
| internal/session-lock.processWithSessionLock | LOW（图中无边） | 当前源码 manager wrapper 和 manager 单测；增加可选 AbortSignal |
| internal/bridge-help.buildBridgeCommandHelp | HIGH | handleCommand；4 流程，仅同步取消及补发帮助 |
| types.SendResult | LOW（图查询受限） | GitNexus Interface declaredType binder 错误；源码确认 adapter→delivery→manager，增加可选 HTTP 状态和重试秒数 |

HIGH/CRITICAL 已在编辑前通过 commentary 告知用户与根代理。新 helper 和回归测试此前不存在；没有 rename symbol 或改平台注册列表。

## 实施合同

- TurnContext 在入队时固定 session、chat generation、run epoch 与取消句柄。执行时仅刷新前一回合保存的 SDK resume ID。
- `/stop`、`/new`、`/bind` 取消 debounce、append、queued、running；只在取消命令及对应代际中确认被丢弃 offset。无效 bind 不取消正在运行的会话。
- 模型透传复用会话队列；控制消息绕过模型锁。旧 consumeOne 的迟到值不能进入新运行周期。
- reader、问答发送和最终投递对本地 abort 响应；finally 取消/释放 reader、移除 listener、释放会话租约。迟到 provider runtime 回调被关闭。
- 本地取消不声明 provider 已确认终止；平台网络调用的实际结果可能未知。旧回合不再发送后续内容、写新绑定或关闭新 UI。
- 核心 stop 先关闭接收、废弃运行代际，再取消任务并最多等 5 秒清理，之后各 adapter 最多等 5 秒；超时可见。start 等待当前 stop。
- manager 将最终正文交给 response-delivery，先待发记录再 finalize/发送；`/retry` 不调用模型；`/status` 展示等待消息和待补发信息。
- 无正文的成功/错误回合也按 `bridge_delivery_timeout_ms`（默认 15 秒）限制卡片终结等待，超时可见，继续错误提示并释放队列；不把超时当成平台操作已经结束。

## 验证

新增 `src/__tests__/unit/bridge-lifecycle-regression.test.ts`：全部使用 fake store/provider/adapter，并断言注入身份，同时阻止子进程与 fetch。研究的 6 项问题转换成生产行为断言，另补跨会话并行、同会话串行与最新 resume ID、旧 consumeOne 迟到、补发不重调模型、问答投递悬挂取消。

最终 41/41 相关测试通过：23 项新增生命周期回归 + 18 项既有 manager/engine/ctx 测试（约 3.1 秒）。包括三种取消命令覆盖 debounce/queued/append、绑定切走再切回原 session、取消卡片终结前不清理 UI，以及无正文成功/错误卡片终结悬挂的断言。此前 `npx tsc --noEmit` 通过，最后收尾后的统一 typecheck 由根执行。单项 timeout 1500ms，进程 test-timeout 15000ms。没有真实模型、凭据、飞书或 runner 调用。

实际 Feishu adapter 的创建/终结跨 await 归属由 delivery owner 修复并补测试；此处 fake late-finalize 仅验证 manager 边界，不替代平台级测试。全量验证和最终 detect_changes 由根负责。
