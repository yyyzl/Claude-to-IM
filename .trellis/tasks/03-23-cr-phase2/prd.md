# Code Review Workflow Phase 2: DiffReader + PackBuilder + Templates

## Goal

实现代码审查的数据管道：git diff 读取 → 冻结快照 → Pack 构建 → Prompt 模板渲染。

## Requirements

1. **diff-reader.ts (新建)** — 解析 git diff，创建冻结快照 (review-snapshot.json)
   - 支持 A/M/D/R/C 五种文件变动类型
   - 支持 5 种 scope：staged / unstaged / commit / commit_range / branch
   - 通过 `git show <blob_sha>` 读取文件内容（不用 fs.readFile）
   - 敏感文件默认排除 (.env, *.key, *.pem 等)
   - 二进制文件跳过并记入 excludedFiles

2. **PackBuilder 扩展** — 新增两个方法
   - `buildCodeReviewPack()`: 从快照构建 CodeReviewPack
   - `buildClaudeCodeReviewInput()`: 构建 Claude 裁决输入（fresh，不含 previousDecisions）

3. **PromptAssembler 扩展** — 根据 profile 加载正确模板
   - `renderCodeReviewPrompt()`: 渲染 Codex 盲审 prompt
   - `renderClaudeCodeReviewPrompt()`: 渲染 Claude 仲裁 prompt

4. **3 个新模板** — 放在 .claude-workflows/templates/
   - code-review-pack.md (Codex 盲审)
   - code-review-decision.md (Claude 仲裁)
   - code-review-decision-system.md (Claude 系统角色)

## Acceptance Criteria

- [ ] DiffReader.createSnapshot() 生成 review-snapshot.json
- [ ] 所有文件内容通过 git show blob_sha 获取
- [ ] staged 模式从 index 读 blob
- [ ] 敏感文件 + 二进制文件正确排除并记录
- [ ] PackBuilder 两个新方法返回正确类型
- [ ] accepted_issues 进入 Codex prompt "Previously Accepted" 节
- [ ] PromptAssembler 模板渲染输出完整 prompt
- [ ] TypeScript 编译通过
- [ ] 现有测试回归通过

## Technical Notes

- Spec: `.claude/plan/code-review-workflow-spec.md` Section 5 (DiffReader) + Section 9 (Templates)
- INV-4: 审查基于冻结快照
- INV-7: accepted_issues 正式输入 Codex prompt
