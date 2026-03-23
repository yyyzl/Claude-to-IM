# Code Review Workflow Phase 1: Types + Engine Generalization

## Goal

在现有 Workflow Engine 上引入 `WorkflowProfile` 泛化机制，使引擎从 spec-review 专用变为多工作流类型通用。这是 Code Review Workflow (P1b-CR-0) 的基础阶段。

## Scope

仅 Phase 1 — 类型定义 + 引擎核心泛化。不包含 DiffReader、PackBuilder 扩展、模板、报告生成等。

## Requirements

1. **WorkflowProfile 接口** — 含 type、behavior（acceptedIsTerminal 等行为标志）、configOverrides
2. **types.ts 类型扩展** — CodeReviewPack、CodeFinding、ReviewSnapshot、SnapshotFile、ChangeType、Issue 可选字段扩展（source_file、source_line_range、category、fix_instruction）
3. **workflow-engine.ts 泛化** — 接受 profile 参数（默认 SPEC_REVIEW_PROFILE），Step C 根据 behavior 条件执行（applyPatches、claudeIncludesPreviousDecisions）
4. **termination-judge.ts 适配** — 接收 acceptedIsTerminal，unresolved 计算排除/包含 accepted
5. **回归安全** — spec-review 所有现有测试通过，行为完全不变

## Acceptance Criteria

- [ ] WorkflowProfile 接口定义完成，含 acceptedIsTerminal 行为标志
- [ ] SPEC_REVIEW_PROFILE 和 CODE_REVIEW_PROFILE 常量导出
- [ ] CodeReviewPack、CodeFinding、ReviewSnapshot 等新类型定义
- [ ] Issue 接口扩展 source_file?、source_line_range?、category?、fix_instruction?
- [ ] workflow-engine.ts 根据 profile.behavior 条件执行步骤
- [ ] termination-judge.ts 根据 acceptedIsTerminal 调整 unresolved 计算
- [ ] TypeScript 编译通过，无类型错误
- [ ] 现有 spec-review 全部测试通过（回归安全）

## Technical Notes

- 完整 Spec：`.claude/plan/code-review-workflow-spec.md`
- 归档 PRD：`.trellis/tasks/archive/2026-03/03-23-workflow-code-review/prd.md`
- 核心不变量：INV-1 (accepted 终态)、INV-2 (reason/fix_instruction 分离)、INV-3 (数据真相源分层)
