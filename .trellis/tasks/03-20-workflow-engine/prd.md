# Workflow Engine（双模型协作工作流）

## Goal

为仓库建立一个可持续推进的 Workflow Engine 父任务，用 Trellis 跟踪
Workflow Engine 的实现工作，并以现有 spec/plan 作为单一需求来源。

当前跟踪范围仅覆盖：

- P0：协议定义与脚手架
- P1a：Spec-Review 单工作流 MVP

## Requirements

- 在 `src/lib/workflow/` 下实现独立模块，不进入 `src/lib/bridge/`
  核心层。
- 支持通过 CLI 启动 / 恢复 Spec/Plan 审查工作流。
- 自动构建 Codex 审查 Pack、调用 Codex 与 Claude、维护
  Issue Ledger，并在合适时自动终止。
- 将所有工件落盘到 `.claude-workflows/{run-id}/`，支持断点恢复。
- 保持 Workflow Engine 与 Bridge 解耦：
  - Workflow Engine 不依赖 `src/lib/bridge/`
  - Bridge 未来仅通过命令入口或事件与其集成
- 验证范围覆盖：
  - 单元测试
  - 集成测试
  - 至少一条端到端跑通链路

## Acceptance Criteria

- [ ] 建立 `src/lib/workflow/` 模块结构、模板、schema 与基础类型。
- [ ] 实现 WorkflowStore，能持久化 meta、spec、plan、ledger、events
      与轮次产物。
- [ ] 实现 Spec-Review MVP 的完整循环：
      PackBuilder -> PromptAssembler -> ModelInvoker -> IssueMatcher ->
      TerminationJudge -> PatchApplier -> WorkflowStore。
- [ ] 支持 `start()` / `resume()` / `pause()`，并具备崩溃后恢复能力。
- [ ] CLI 能基于 spec/plan 文件启动一次审查流程。
- [ ] `package.json`、导出配置与测试脚本同步更新。
- [ ] 测试覆盖 plan 中列出的关键分支与恢复场景。

## Technical Notes

- 需求来源：
  - `.claude/plan/workflow-engine-spec.md`
  - `.claude/plan/workflow-engine-plan.md`
  - `多机器人协作/最终方案.md`
- 现有工程边界要求：
  - 新模块应作为独立顶层领域目录落在 `src/lib/workflow/`
  - 不复用 Bridge 的 `LLMProvider.streamChat()` 抽象
  - 文件系统工件目录与 npm 导出配置需要同步设计
- 预计高影响文件：
  - `src/lib/workflow/*`
  - `src/__tests__/unit/workflow-*.test.ts`
  - `package.json`
  - `.gitignore`

## Out Of Scope

- P1b：开发工作流 / 代码审查工作流
- P2：IM 集成（`/workflow` 命令、卡片、实时推送）
- P3：Session Orchestrator 集成
- 多实例并行 Codex 执行
- 对外发布 npm package 的完整产品化工作
