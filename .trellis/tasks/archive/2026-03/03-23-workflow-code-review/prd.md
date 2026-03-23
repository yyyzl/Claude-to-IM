# Workflow Engine: Code Review 工作流 (P1b-CR-0)

## Goal

在现有 Workflow Engine 上扩展 `code-review` 工作流类型（review-only MVP），实现自动化代码审查：Codex 盲审代码变更 → Claude 仲裁过滤误报 → 输出结构化审查报告。

## 背景

当前 Workflow Engine 仅支持 `spec-review` 一种工作流类型。所有步骤逻辑（Pack 构建、模板渲染、补丁应用）都硬编码为 spec-review。P1b-CR-0 通过引入 `WorkflowProfile` 参数化配置，使引擎支持多种工作流类型。

**关键约束**：
- 复用引擎核心循环（5 步状态机），不重写
- 通过 `WorkflowProfile.behavior` 条件执行步骤差异
- spec-review 功能完全不受影响（回归安全）
- 完整 Spec 见 `.claude/plan/code-review-workflow-spec.md`

## 核心不变量（必须在实现前对齐）

### INV-1: accepted 是终态 + 终止条件对齐

code-review 中 `accepted` = 最终审查结论（"问题确认 + 修复建议已给出"），**不阻塞终止判断**。
TerminationJudge 通过 `profile.behavior.acceptedIsTerminal` 感知此语义。

**所有终止条件（与 spec-review 对齐）**：
1. Codex LGTM + 无 open/deferred → 终止（accepted 不算 unresolved）
2. 死锁（repeat_count ≥ 2）→ 暂停→人工介入
3. 连续 2 轮无新 high/critical → 终止
4. 所有 unresolved 都是 low severity → 终止
5. max_rounds 到达 → 终止

> 低优先级 unresolved issue **允许自动终止**（规则 3、4）。这是有意的。

### INV-2: reason 和 fix_instruction 分开存储

`Issue.decision_reason` 存裁决理由（"为什么接受"），
`Issue.fix_instruction`（新增可选字段）存修复指令（"怎么修"）。
两者在 ReportGenerator 中分别展示。

### INV-3: 数据真相源分层

- **Issue 决策真相源**：IssueLedger（不 join round artifacts）
- **报告快照源**：ReviewSnapshot（scope、excluded_files、head_commit）
- **元信息源**：WorkflowMeta

Issue 扩展可选字段：`source_file`、`source_line_range`、`category`、`fix_instruction`。

### INV-4: 审查基于冻结快照（review-snapshot.json）

start 时创建 `review-snapshot.json`，记录 blob SHA，后续所有 round/resume/report 从快照读取。
**不使用 fs.readFile** — 全部通过 `git show <blob_sha>` 获取内容。

| git status | blob_sha 获取 |
|------------|--------------|
| A/M | `git ls-tree <head> -- <path>` 或 `git ls-files -s`（staged） |
| D | `git ls-tree <base> -- <path>`（从 base 端取） |
| R/C | `git ls-tree <head> -- <new_path>` + old_path |

仓库检测用 `git rev-parse --is-inside-work-tree`（兼容 worktree）。

### INV-7: accepted_issues 正式输入 Codex prompt

code-review 中代码未修改，accepted 问题仍存在于代码中。
accepted_issues 进入 prompt 的 "Previously Accepted" 节，避免 Codex 重复提出。

### INV-5: 敏感文件排除 + 审计

敏感文件（`.env`、`*.key`、`*.pem` 等）默认排除，记入 `excludedFiles`。
ReportGenerator 在报告 "Excluded Files" 节显式列出被跳过的文件及原因。
可通过 `--include-sensitive` 强制纳入。

### INV-6: CLI scope 无二义性

`--range A..B`（两点 diff）和 `--branch-diff base`（三点 diff）显式分离。
code-review 不需要 `<spec> <plan>` 位置参数。

## Requirements

### Phase 1: 类型 + 引擎泛化

1. **WorkflowProfile 接口** — 含 acceptedIsTerminal 行为标志
2. **types.ts 类型扩展** — CodeReviewPack、CodeFinding、ReviewSnapshot、SnapshotFile、ChangeType、Issue 可选字段扩展
3. **workflow-engine.ts 泛化** — 注入 profile 参数，Step C 根据 behavior 条件执行
4. **termination-judge.ts 适配** — 接收 acceptedIsTerminal，调整 unresolved 计算
5. **回归验证** — spec-review 所有测试通过

### Phase 2: DiffReader + PackBuilder + 模板

6. **diff-reader.ts** — 生成冻结快照（review-snapshot.json），支持 A/M/D/R/C + 5 种 scope + worktree + blob SHA
7. **PackBuilder 扩展** — buildCodeReviewPack() + buildClaudeCodeReviewInput()（fresh，不含 previousDecisions）
8. **PromptAssembler 扩展** — 根据 profile 加载正确模板
9. **3 个新模板** — code-review-pack.md、code-review-decision.md、code-review-decision-system.md

### Phase 3: Matcher + Validator 增强

10. **IssueMatcher 增强** — 新增文件路径+行号+category 匹配（使用 Issue 结构化字段，非 evidence 解析，已完成）
11. **DecisionValidator 适配** — 根据 profile 条件验证 fix_instruction / resolves_issues（已完成）

### Phase 4: Report + Factory + CLI/IM

12. **report-generator.ts** — 从 IssueLedger 生成报告（Markdown + JSON），含 Excluded Files 节
13. **createCodeReviewEngine()** — 工厂函数
14. **CLI code-review 子命令** — `--staged`、`--range`、`--branch-diff`、`--include-sensitive`
15. **IM 命令扩展** — `/workflow start --type code-review`（无 spec/plan 位置参数）

### Phase 5: 集成测试

16. **集成测试** — 完整 2-3 轮代码审查循环（mock ModelInvoker）
17. **端到端验证** — 真实 git 仓库测试

## Acceptance Criteria

### 状态机语义

- [ ] `acceptedIsTerminal=true` 时，LGTM 终止不被 accepted issue 阻塞
- [ ] `only_style_issues` 和 `no_new_high_severity` 在 code-review 中生效
- [ ] 低优先级 unresolved issue 允许自动终止（不必等所有 issue 裁决完毕）
- [ ] 回归：spec-review 的 accepted 仍是中间态，不触发终止

### 数据完整性

- [x] Issue.fix_instruction 和 Issue.decision_reason 分别存储
- [x] Issue.source_file / source_line_range / category 由 IssueMatcher 从 CodeFinding 写入
- [ ] ReportGenerator 从 IssueLedger（issue 决策）+ ReviewSnapshot（scope/excludedFiles）+ WorkflowMeta 组装报告
- [ ] 报告含 reason 和 fix_instruction 分列展示
- [ ] 报告含 Excluded Files 节

### 冻结快照（INV-4）

- [ ] start 时创建 `review-snapshot.json`，记录 blob SHA
- [ ] 所有文件内容通过 `git show <blob_sha>` 获取（不用 fs.readFile）
- [ ] staged 模式从 index 读 blob（不受工作区 unstaged 影响）
- [ ] resume 时加载快照，不重新读取 diff
- [ ] PackBuilder 从快照读取，不直接调用 git

### DiffReader 完整性

- [ ] `git rev-parse --is-inside-work-tree` 检测仓库（兼容 worktree）
- [ ] `git diff --name-status` 解析 A/M/D/R/C 状态
- [ ] 删除文件通过 `git show <base_blob_sha>` 获取内容
- [ ] 重命名文件保留 old_path + new_path
- [ ] 二进制文件跳过并记入 excludedFiles
- [ ] 敏感文件默认排除并记入 excludedFiles
- [ ] diff 为空时报告 "No changes to review"，workflow 正常终止

### Pack/Prompt/Validator 闭环

- [ ] accepted_issues 正式字段（非可选），进入 Codex prompt 的 "Previously Accepted" 节
- [x] DecisionValidator 根据 WorkflowProfile 条件验证 fix_instruction / resolves_issues
- [ ] DecisionValidator 使用 expectedDecisionIds 概念（有 findings → finding IDs；无 findings → unresolved issue IDs）
- [ ] 无新 findings 但有 unresolved issues 时，Claude 被要求处理剩余 issue

### CLI/IM

- [ ] `--range A..B` 和 `--branch-diff base` 语义分离
- [ ] code-review 不要求 spec/plan 位置参数
- [ ] `--include-sensitive` 可强制纳入敏感文件

### 通用

- [ ] WorkflowProfile 接口定义完成，含 acceptedIsTerminal
- [x] workflow-engine.ts 根据 profile.behavior 条件执行步骤
- [ ] 现有 spec-review 全部测试通过（回归安全）
- [x] IssueMatcher 文件路径匹配使用 Issue 结构化字段（非 evidence 解析）
- [ ] TypeScript 编译通过，无类型错误
- [ ] 集成测试覆盖完整审查循环

## Technical Notes

- Spec 文档：`.claude/plan/code-review-workflow-spec.md`（唯一设计源，PRD 不重复设计细节）
- **实现范围以子 spec 的模块清单为准**
- 预估工时：2.5-3 天
- 新模板位于 `.claude-workflows/templates/`
