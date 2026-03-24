# 审查输出中文化

## Goal
将 Spec Review 与 Code Review 工作流中的审查输出统一为中文优先，避免最终审查报告、问题描述、裁决理由和修复建议默认产出英文。

## Requirements
- 审查提示词必须明确要求使用简体中文输出说明性文本。
- 保持现有 JSON 结构、严重级别枚举值、动作枚举值不变，避免破坏解析与状态机。
- 最终 Markdown 报告标题、统计项、结论和表头改为中文。
- 修改范围收敛在工作流模板、提示词装配和报告生成层，不扩散到无关模块。

## Acceptance Criteria
- [ ] Spec Review 模板与 Code Review 模板都明确要求中文输出说明字段。
- [ ] `ReportGenerator` 生成的 Markdown 报告正文为中文。
- [ ] 相关单元测试覆盖中文化后的关键输出。

## Technical Notes
- `severity`、`overall_assessment`、`action` 等机器消费字段继续保留英文枚举。
- 需要同步关注 `PromptAssembler` 中硬编码的提示文案，避免模板改了但兜底文案仍是英文。
