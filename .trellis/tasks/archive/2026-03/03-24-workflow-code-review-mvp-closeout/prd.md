# Workflow Code-Review MVP Closeout

## Goal

补齐 `code-review` 的 IM 主链路收尾条件，使当前 `review-only MVP` 达到“真实可用”的完成标准。

## Requirements

- `WorkflowEngine` 在 `code-review` 主链路中必须向 Codex / Claude 提供真实的 `diff` 与 `changed_files.content`
- 复用 `DiffReader` 现有能力，不重复实现 git diff / blob 读取逻辑
- 工作流完成后必须生成结构化报告产物，并在 IM 完成消息中显式提示报告已生成
- 独立 CLI `code-review` 子命令本次不实现，但必须在文档中明确记录为未完成 / 非本次 MVP 范围
- 修正文档漂移，统一 `code-review spec`、总结文档与任务文档对当前 MVP 状态的描述

## Acceptance Criteria

- [x] `code-review` 的 `CodeReviewPack.diff` 不再是空字符串
- [x] `code-review` 的 `CodeReviewPack.changed_files[].content` 使用真实 git blob 内容或受控截断内容
- [x] `ClaudeCodeReviewInput.diff` 与 `changed_files` 也使用真实上下文
- [x] 工作流完成后在 run 目录生成 Markdown / JSON 报告产物
- [x] IM 完成消息包含“报告已生成”的提示
- [x] 相关单元测试先失败后通过
- [x] `npm run typecheck` 通过
- [x] 相关单元测试通过
- [x] 文档明确标注独立 CLI `code-review` 未实现

## Technical Notes

- 本次只收 `IM` 闭环 MVP，不扩展到独立 CLI
- 优先修改 `src/lib/workflow/workflow-engine.ts`、`src/lib/workflow/workflow-store.ts`、`src/lib/bridge/internal/workflow-command.ts`
- 优先补 `src/__tests__/unit/workflow-code-review.test.ts`
