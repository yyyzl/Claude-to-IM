# 可靠性与审查缺陷修复

用户已授权修复上一轮优化报告中的实际问题。基线是当前未提交工作树，保留全部运行时升级和用户原有文件。本任务不做数据库迁移、模型选择新面板或全量 runtime API 重写。

## 验收范围

1. 生命周期：模型透传命令不阻塞接收控制消息；stop/new/bind 对 debounce、append、queued、running 一致；旧回合不写回新会话或操作新卡；stop 有界排空且不再启动新回合；不响应 abort 的 reader 不永久占锁。
2. 持久化：JSON 原子保存、有效备份、损坏/写失败可见、flush/close 与 runner 停机接线；不覆盖真实旧数据或做迁移。fatal 退出非零。
3. 投递：最终发送失败保留可重投的回答与状态，不重新调用模型；失败/部分成功不误去重；HTML 降级按最新错误重试；审批发送或登记失败及时 deny 并允许合理重试；飞书长内容按字节预算分段。
4. 工作流：失联 running 可在确认无活跃执行者后恢复；检查点安全写与并发恢复保护；审查 diff/blob 使用同一冻结版本；修复从可确认的审查基线开始，不能重建则明确拒绝；重试不强删旧 worktree/branch；修复候选、验证状态、准确提交范围、失败组隔离和安全应用提示。
5. 飞书：与失败处理直接相关的审批卡结果回写和过期状态；附件部分失败明确反馈，已知不支持类型不静默假成功。新增产品功能不阻塞缺陷修复。
6. 防回归：将研究复现反向转成正式单测，保持隔离；必要的 typecheck/build/全量单测通过；先 impact 后编辑、结束 detect_changes；记录实际剩余边界。

## 实施边界

- 不读取真实 .env、凭据、聊天记录或生产日志；不运行真实模型/飞书或现有 runner；不修改全局依赖/配置；不提交或重启。
- 不在用户仓库执行真实 worktree remove、branch -D、reset/clean 等；自动修复测试使用显式 fake，必要临时仓库必须隔离。
- node:test 默认阻断真实模型/网络，每次单测总运行控制在 60 秒内，单项超时 15 秒。
- 每个修改的既有 symbol 先 GitNexus upstream impact，记录调用方/流程/风险。图缺失时运行工具并补源码证据；HIGH/CRITICAL 编辑前告知根和用户。
- 修改只围绕上述缺陷；不要保留已无用途的兼容或兜底；错误不能静默假成功。

## 文件责任与接线

- lifecycle 实施者：bridge-manager、channel-router、conversation-engine、internal/session-lock/timeouts、bridge/types、相关生命周期/manager/router 测试与帮助文案。
- storage-workflow 实施者：scripts/claude-to-im-bridge/store、scripts/feishu-claude-bridge、全部 src/lib/workflow 与对应测试；持久化接线共享契约由 delivery 实施者定义。
- delivery 实施者：delivery-layer、permission-broker/user-input-broker、channel-adapter、adapters/feishu-adapter、markdown/feishu、新响应投递模块、host.ts 和相关测试。
- host.ts 只由 delivery 修改。若 lifecycle 需要 engine 额外合同，优先函数私有参数或在 bridge/types 中定义，通知 delivery。storage 需要 flush/outbox/permission 合同立即发给 delivery。
- delivery 尽早与另外两位确定 durable response record/store API，以及 manager 的 send/retry/status 接线。新合同写入 research/contracts.md 后通知根与其他实施者。
- 根负责协调、任务文档、整合验证与最后独立 trellis-check；业务代码由实施/检查代理完成。

## 参考

上一任务 `.trellis/tasks/10-04-optimization-audit/research/` 的 optimization-report、lifecycle、storage-workflow、feishu-delivery、runtime-ops 与三个复现文件。研究测试断言的是旧缺陷，不能直接当本轮通过标准。
