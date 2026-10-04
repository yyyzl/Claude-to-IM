# 执行计划

- [x] 用户明确确认三项范围、建任务、实现及提交推送；检查 main 与 origin/main 一致且工作区干净。
- [x] 记录 PRD、边界及验收；载入 backend 规范。
- [x] 完成两路研究与逐符号 GitNexus upstream 影响检查，先告知 HIGH/CRITICAL。
- [x] Trellis 实现者 A：桥接补发生命周期、当前聊天历史及宿主持久化、相关最小回归（77/77 相关测试，新增 14 项）。
- [x] Trellis 实现者 B：补丁步骤确定性重放及崩溃窗口回归，不改原 PatchApplier 语义。
- [x] 独立 Trellis check：桥接 77/77；工作流补齐暂停与首次提交冲突检查，相关 122/122，完整 typecheck 通过。
- [x] 主会话更新可靠性规范与用户文档；typecheck、build、最终整合单测701/701通过（后台总超时60秒）。
- [x] `git diff --check` 与GitNexus staged完整检测通过；93符号、49流程、CRITICAL，全部在预期范围，无partial/truncated。
- [ ] 按逻辑批次提交本任务；归档、记录会话并提交记账；刷新 GitNexus（`--index-only`，保留 embeddings）。
- [ ] 正常推送 origin main，核验本地/远端 HEAD 相同和工作区干净；报告具体变更与验证限制。

## 验证矩阵

- 桥接：补发发送挂起时其他聊天 stop/审批可消费；同聊天 stop/new/bind 停后续块；重复 retry不重复发送；shutdown有界；旧结果保留正确outbox进度。
- 会话：new 后旧会话可列出并切回；完整ID；跨chat/channel隔离；当前标记/分页/按钮来源校验；JSON关闭重开保留历史；无能力宿主仅列当前绑定。
- 工作流：未知标题失败在恢复后仍失败；spec/plan 分别保存后中断；ledger已保存但step未提交；重复恢复不重复版本或追加；合法补丁成功恢复；code-review行为不变。
- 普通测试禁止真实模型/飞书及真实账号；使用 fake transport/invoker、临时store及故障注入。

## 回滚点

两路实现分别可审查；如核心行为不成立，停止整合并在负责模块修复，不跳过失败测试。提交与推送已经用户授权，不再设置额外审批流程。
