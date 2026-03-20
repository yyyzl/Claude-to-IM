# Workflow Engine 跟踪计划

## Source Of Truth

- `spec`：`.claude/plan/workflow-engine-spec.md`
  - 最后修改：2026-03-20 03:16:16
- `plan`：`.claude/plan/workflow-engine-plan.md`
  - 最后修改：2026-03-20 03:22:56
- 背景方案：`多机器人协作/最终方案.md`

本任务目录中的 `prd.md` 是对上述文档的 Trellis 化摘要；
后续若原始 spec/plan 发生变更，需要同步回填本任务目录。

## Relevant Specs

- `.trellis/spec/backend/index.md`
  - 当前仓库以 Node.js + TypeScript 桥接库 / 集成工程为主，Workflow
    模块按 backend 任务处理。
- `.trellis/spec/backend/directory-structure.md`
  - 新领域模块应落在 `src/lib/` 下，避免把编排逻辑塞回 `scripts/`。
- `.trellis/spec/backend/module-boundaries.md`
  - 必须保持 Workflow Engine 与 Bridge Core 的边界清晰。
- `.trellis/spec/backend/type-safety.md`
  - 共享结构、JSON 解析、外部输入和恢复状态都需要显式类型与运行时校验。
- `.trellis/spec/backend/testing-guidelines.md`
  - 要用 `node:test` 风格补足单测 / 集成测试，并在 60s 内完成后台单测。
- `.trellis/spec/backend/quality-guidelines.md`
  - 完成前要同步检查导出、配置、路径和规范一致性。
- `.trellis/spec/guides/cross-layer-thinking-guide.md`
  - Workflow Engine 会触及 CLI、文件系统工件、模型调用与未来 Bridge 集成边界。
- `.trellis/spec/guides/code-reuse-thinking-guide.md`
  - Prompt 包装、配置读取、测试命名与导出模式要优先复用现有实现。

## Code Patterns Found

- 独立核心模块 + 宿主装配边界：
  - `src/lib/bridge/README.md`
- npm 导出与测试脚本入口：
  - `package.json`
- Trellis 任务追踪模式：
  - `.trellis/tasks/03-18-daily-token-usage/prd.md`

## Files To Modify

- `src/lib/workflow/`
  - 新建 Workflow Engine 模块、类型、存储、编排与 CLI。
- `src/__tests__/unit/workflow-*.test.ts`
  - 新增单元 / 集成 / 恢复路径测试。
- `package.json`
  - 增加依赖、导出与 workflow 测试 / CLI 脚本。
- `.gitignore`
  - 增加 `.claude-workflows/` 工件目录。

## Tracking Breakdown

### 1. P0 脚手架、模板与 Schema

- [ ] 创建 `src/lib/workflow/` 目录结构
- [ ] 约定 `.claude-workflows/` 工件结构
- [ ] 写 prompt templates
- [ ] 写 JSON schemas
- [ ] 更新 `.gitignore`

### 2. 核心类型与 WorkflowStore

- [ ] 实现 `types.ts`
- [ ] 实现 `workflow-store.ts`
- [ ] 补充存储层单元测试

### 3. JsonParser、IssueMatcher、PromptAssembler

- [ ] 实现 `json-parser.ts`
- [ ] 实现 `issue-matcher.ts`
- [ ] 实现 `prompt-assembler.ts`
- [ ] 覆盖 JSON 解析降级、issue 去重与 prompt 渲染测试

### 4. PackBuilder 与 ModelInvoker

- [ ] 实现 `pack-builder.ts`
- [ ] 实现 `model-invoker.ts`
- [ ] 覆盖 Pack 构建、超时、重试、AbortSignal 测试

### 5. TerminationJudge、ContextCompressor、PatchApplier

- [ ] 实现 `termination-judge.ts`
- [ ] 实现 `context-compressor.ts`
- [ ] 实现 `patch-applier.ts`
- [ ] 覆盖终止条件、压缩阈值和多级标题 patch 测试

### 6. WorkflowEngine 主循环与恢复机制

- [ ] 实现 `workflow-engine.ts`
- [ ] 跑通 5 状态步骤机与 checkpoint 写入顺序
- [ ] 覆盖超时跳过、恢复、deadlock、accept_and_resolve、
      resolves_issues_missing 等集成测试

### 7. CLI、导出接线与端到端验证

- [ ] 实现 `cli.ts`
- [ ] 实现 `index.ts`
- [ ] 更新 `package.json` 依赖、exports 与脚本
- [ ] 跑通 E2E 测试与 bug fix

## Milestone Notes

- 当前 Trellis 只负责“任务追踪与上下文注入”，不替代原始 spec/plan。
- 后续如果需要更细粒度进度统计，可以再把上述 7 个工作块升级为
  `children` 子任务。
