# 飞书跨重启去重执行计划草案

## 前置条件

- 先完成并验收 10-13-feishu-codex-live-append，再改共享 manager/host。即时追加已被原回合接受的来源属于该回合，不能进入后轮再次执行；未知接收结果继续按未知处理，不按“未成功”自动重放。

- [x] 用户授权创建任务并规划。
- [x] 研究结果与 design.md 收敛；结果未知不自动重跑列入最终计划审阅。
- [ ] 用户审阅最终计划，确认中断结果未知时不自动重跑。
- [ ] task.py validate 通过，随后才能 task.py start。

## 切片（每片 RED → GREEN → 相关回归）

1. **记录与 JSON 宿主**：host.ts 可选入站能力；store.ts 运行时校验、原子快照、过期和旧数据加载。测试真实临时 JSON 保存/重建、坏字段、保存失败和活动记录保留。
2. **入站身份与消息组**：FeishuAdapter.handleIncomingEvent、现有 scheduleMessages/合并/追加透传全部来源 ID。先验证并发重复、下载/保存失败可重投，以及同文本不同消息 ID 均可处理。
3. **执行和 outbox 关联**：在真实模型/控制副作用前保存 running；在第一次平台发送前把 outbox 与来源记录一同保存。先验证模型完成但投递失败、首次 outbox 保存失败、部分执行错误均不误重跑。
4. **恢复及控制生命周期**：按设计处理 pending/running/unknown/completed/discarded；/status 呈现未知；覆盖 stop/new/bind、追加消息组、正常排空和旧回执。控制命令的登记/成功含义分别断言。
5. **审查与验收**：同步可靠性合同和必要使用说明；派发独立 trellis-check；相关回归后执行 typecheck/build、完整单测、GitNexus 检测及实际 diff 核对。

## 目标文件

src/lib/bridge/host.ts、types.ts、bridge-manager.ts、response-delivery.ts、adapters/feishu-adapter.ts；需要新私有 helper 时放 internal/。宿主 scripts/claude-to-im-bridge/store.ts。测试建议 bridge-feishu-inbound-dedup.test.ts、bridge-store-inbound.test.ts，并复用现有 lifecycle、delivery 和 feishu-reliability 工厂。

## 检查

每个既有符号修改前 upstream impact；HIGH/CRITICAL 先告知，UNKNOWN 用源码和调用链补证。fake 模型/平台/传输必须先注入并断言；每批后台单测外层硬超时 60 秒，单测试 15 秒。不读取实际聊天、认证或调用生产飞书。

按子任务审阅和提交后独立验收/归档，再允许文件子任务修改共享模块；不顺手扩大平台范围或建立自动执行恢复服务。
