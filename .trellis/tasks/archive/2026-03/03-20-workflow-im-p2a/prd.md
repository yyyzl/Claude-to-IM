# Workflow IM Integration (P2A — 最小可用)

## Goal

在 Bridge 命令系统中新增 `/workflow` 命令族，让用户能在飞书/Telegram 里触发、监控和控制 Spec-Review 工作流，并通过 IM 消息实时接收进度推送。

## Requirements

### 命令设计

- `/workflow start --spec <path> --plan <path>` — 启动 Spec-Review 工作流
- `/workflow status [run-id]` — 查看当前/指定 run 的状态
- `/workflow resume <run-id>` — 恢复暂停/失败的工作流
- `/workflow stop [run-id]` — 停止当前运行的工作流
- `/workflow help` — 显示用法

### 进度推送（纯文本）

工作流事件通过 IM 消息推送到触发命令的聊天：
- `workflow_started` → "🚀 工作流已启动 (run: xxx)"
- `round_started` → "📋 第 N 轮审查开始"
- `codex_review_completed` → "✅ Codex 审查完成，发现 N 个问题"
- `claude_decision_completed` → "✅ Claude 决策完成 (accepted: N, rejected: N)"
- `termination_triggered` → "⏹ 工作流终止: <reason>"
- `workflow_completed` → "🎉 工作流完成！共 N 轮，N 个 issue"
- `workflow_failed` → "❌ 工作流失败: <error>"
- `human_review_requested` → "⚠️ 需要人工审查，使用 /workflow resume 继续"

### 架构约束

- Workflow Engine 保持独立，不引入 Bridge 依赖
- Bridge 侧新增 `internal/workflow-command.ts` 封装命令逻辑
- 通过 `WorkflowEngine.on()` 事件钩子驱动消息推送
- 工作流在后台异步执行，不阻塞 IM 消息处理
- 每个 chat 同时只能运行一个工作流实例

## Acceptance Criteria

- [ ] `/workflow start` 能通过 IM 触发 Spec-Review 工作流
- [ ] 工作流进度事件实时推送到触发聊天
- [ ] `/workflow status` 能查看运行状态和摘要
- [ ] `/workflow resume` 能恢复暂停的工作流
- [ ] `/workflow stop` 能优雅停止运行中的工作流
- [ ] `/workflow help` 显示命令用法
- [ ] 异步执行，不阻塞其他命令
- [ ] TypeScript 类型检查通过
- [ ] 补充单元测试

## Technical Notes

### 集成点

- `bridge-manager.ts` → `handleCommand()` switch 新增 `case '/workflow'`
- `internal/workflow-command.ts` → 命令解析、引擎创建、事件绑定、生命周期管理
- 复用 `deliver()` / `deliverRendered()` 推送消息
- 复用 `validateWorkingDirectory()` 校验 spec/plan 路径

### 状态管理

- 运行中的 WorkflowEngine 实例用 `Map<chatId, RunningWorkflow>` 管理
- RunningWorkflow 包含 engine 实例、runId、abort 方法
- 工作流结束后自动清理 Map 条目

### 后续迭代路线

- **P2B（卡片化）**：进度消息改用飞书/TG 富文本卡片，Issue Ledger 表格渲染
- **P2C（交互式）**：卡片按钮 accept/reject/defer、human_review 自动推卡片、streaming 预览

## Out Of Scope

- 飞书/Telegram 卡片渲染（P2B）
- 交互式按钮和回调（P2C）
- dev / code-review 工作流类型（P1b）
- 多工作流并行执行
