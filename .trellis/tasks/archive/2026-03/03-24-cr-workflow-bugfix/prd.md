# Code-Review Workflow Bugfix

## Background

2026-03-24 运行 `/workflow code-review --range 3b401ce^..ccca9d6 --exclude .trellis/**,docs/**,.claude/**,.claude-workflows/**,AGENTS.md,CLAUDE.md` 后发现多个系统性问题。Run ID: `20260324-d83b57`。

问题经三个独立 AI 分析交叉验证确认。

## Root Cause Chain

```
P0-1: --exclude 不过滤 diff                 ← 根因入口
  → diff 包含 60% 噪声文件 (50/83)
  → snapshot.diff 膨胀到 467KB
  → P1-1: Claude 输入 876KB 无预算控制       ← 放大器
    → Claude Agent SDK 子进程处理超大输入
    → exit code 1 进程崩溃                   ← 用户看到的症状
    → P1-2: 被错误标记为"超时"               ← 误诊
    → 12 个问题全部 open
    → P0-2: accepted=0 → conclusion="clean"  ← 结论错误
    → P0-3: open 映射为 defer                ← 展示误导
    → P0-4: 点击"查看报告"看到 status        ← 最终体验断裂
```

---

## Issues

### P0-Critical (修了才能用)

#### P0-1: diff-reader.ts — exclude_patterns 没有过滤 snapshot.diff

- **文件**: `src/lib/workflow/diff-reader.ts`
- **位置**: L115 (`git diff` 获取完整 diff) vs L160-163 (只过滤 `files` 数组)
- **现象**: `--exclude .trellis/**,docs/**,.claude/**,.claude-workflows/**` 后, snapshot.diff 仍包含 50 个应排除的文件 (83 中的 50), diff 体积 467KB
- **验证**: `snapshot.json` 中 `scope.excluded_files` 为空数组
- **修复方向**: 在 `createSnapshot()` 中, 基于 `excludedFiles` 列表从 `diff` 字符串中剥离对应文件的 diff 段落 (按 `diff --git a/...` 分段过滤)
- **影响**: 下游所有 prompt 体积大幅缩减, 可能连带解决 Claude 崩溃

#### P0-2: report-generator.ts — determineConclusion() 逻辑错误

- **文件**: `src/lib/workflow/report-generator.ts`
- **位置**: `determineConclusion()` 方法
- **现象**: `accepted === 0` → 返回 `'clean'`, 但实际有 12 个 open 问题 (3 High + 9 Medium)
- **验证**: 报告 JSON: `{"conclusion":"clean","total_findings":12,"accepted":0}`
- **修复方向**: 正确的判定树:
  - 无任何 finding → `clean`
  - 有 finding 但全部 rejected → `clean`
  - 有 open (未处理) 的 finding → `needs_review` (新增)
  - 有 accepted + critical → `critical_issues`
  - 有 accepted + high → `issues_found`
  - 只有 accepted + medium/low → `minor_issues_only`
- **影响**: 用户从被误导为"无问题"变为看到真实状态

#### P0-3: report-generator.ts — open → defer 语义伪装

- **文件**: `src/lib/workflow/report-generator.ts`
- **位置**: L143 `open: 'defer'` 状态映射
- **现象**: 12 个从未被 Claude 审查的 open 问题, 在报告中全部显示 `Action: Defer`
- **验证**: JSON 报告所有 issue 的 action 字段为 `defer`
- **修复方向**: 引入 `'unreviewed'` 状态, 区分:
  - `defer` = Claude 审查后主动延期 (有 reason)
  - `unreviewed` = Claude 从未处理 (无 reason)
- **影响**: 用户能区分"主动延期"和"从未审查"

#### P0-4: 实现 /workflow report 子命令

- **文件**: `src/lib/bridge/bridge-manager.ts` L875-876, `src/lib/bridge/internal/workflow-command.ts`
- **现象**: "查看报告"按钮的 `workflow:report:<runId>` 被映射为 `/workflow status <runId>`, 用户看到 meta.json 摘要而非实际报告
- **缺失**: `parseWorkflowArgs()` 无 `case 'report'`, `WorkflowSubcommand` 无 report 变体, `handleWorkflowCommand()` 无 report 路由, 无 `handleReport()` 函数
- **修复方向**:
  1. `bridge-manager.ts`: `syntheticText` 改为 `/workflow report ${runId}`
  2. `workflow-command.ts`: 添加 `WorkflowSubcommand` report 变体
  3. `parseWorkflowArgs()`: 添加 `case 'report'`
  4. `handleWorkflowCommand()`: 添加 `case 'report'` → `handleReport()`
  5. 新建 `handleReport()`: 读取 `code-review-report.md`, 格式化发送 (可能需要截断/分段)
- **影响**: 用户能通过按钮直接查看完整审查报告

---

### P1-High (严重影响可信度)

#### P1-1: prompt-assembler.ts — Claude prompt 无预算控制

- **文件**: `src/lib/workflow/prompt-assembler.ts`
- **位置**: `buildClaudeCodeReviewInput()` 方法
- **现象**: 每轮 Claude 输入 876-878KB, 无任何体积检查. Codex 有 `CODEX_PROMPT_BUDGET = 900_000` + 3 级降级
- **修复方向**: 为 Claude prompt 添加预算控制, 参照 Codex 的 full → hunks → truncate 三级降级
- **影响**: 防止超大输入导致 Claude 进程崩溃

#### P1-2: model-invoker.ts — 错误分类: exit code 1 被标为超时

- **文件**: `src/lib/workflow/model-invoker.ts`
- **位置**: `withRetry()` 最终 catch 块 (L177-186)
- **现象**: `"Claude Code process exited with code 1"` 被重试 3 次后包装为 `TimeoutError`. 每次尝试 8-10 秒, 总计 25-33 秒 (配置超时 90 分钟)
- **修复方向**:
  - `NON_RETRYABLE_PATTERNS` 添加 `/exited?\s+with\s+code\s+[1-9]/i`
  - 或引入 `ProcessExitError` 类型与 `TimeoutError` 区分
  - 在 UI 事件中显示真实错误类型
- **影响**: 不再误导排查方向, 不浪费时间重试注定失败的调用

#### P1-3: workflow-engine.ts — terminateWorkflow current_step 不一致

- **文件**: `src/lib/workflow/workflow-engine.ts`
- **位置**: `terminateWorkflow()` 方法
- **现象**: meta.json 出现 `status: "completed"` + `current_step: "claude_decision"` + `last_completed: {round:3, step:"post_decision"}` 自相矛盾
- **修复方向**: `terminateWorkflow()` 中将 `current_step` 更新为 `'terminated'` 或 `last_completed.step`
- **影响**: 状态页不再混乱

---

### P2-Medium (优化体验)

#### P2-1: workflow-engine.ts — 连续失败短路机制

- **文件**: `src/lib/workflow/workflow-engine.ts`
- **现象**: R1 Claude exit code 1 后, R2/R3 仍尝试同类调用 (3 轮 × 3 次 = 9 次全部失败)
- **修复方向**: 记录上一轮 Claude 失败类型, 如果是确定性错误 (exit code), 后续轮直接跳过
- **影响**: 从 9 次无效调用减少到 3 次

#### P2-2: workflow-engine.ts — Claude 降级方案

- **文件**: `src/lib/workflow/workflow-engine.ts`
- **现象**: Claude 不可用时, 所有问题永远 open, 报告结论错误, review-fix 形同虚设
- **修复方向**: Claude 连续 N 轮不可用时自动进入 Codex-only 模式, Codex findings 直接作为最终输出, 报告标注"未经 Claude 复审"
- **影响**: 工作流有降级保底而非完全失效

---

## Acceptance Criteria

- [ ] P0-1: `--exclude` 后 snapshot.diff 不包含排除文件的 diff 段落
- [ ] P0-2: 有 open 问题时 conclusion 不为 `clean`
- [ ] P0-3: 未审查的 issue 在报告中显示为 `Unreviewed` 而非 `Defer`
- [ ] P0-4: 点击"查看报告"按钮能看到实际的审查报告内容
- [ ] P1-1: Claude prompt 体积有上限保护
- [ ] P1-2: `exit code 1` 不再被标记为"超时", 不再重试
- [ ] P1-3: 工作流完成后 meta.json current_step 不矛盾
- [ ] P2-1: 连续同类 Claude 失败时后续轮自动跳过
- [ ] P2-2: Claude 不可用时工作流仍产出有意义的报告

## Files to Modify

| Priority | File | Changes |
|----------|------|---------|
| P0-1 | `src/lib/workflow/diff-reader.ts` | 按 exclude 过滤 diff 文本 |
| P0-2 | `src/lib/workflow/report-generator.ts` | determineConclusion 逻辑 |
| P0-3 | `src/lib/workflow/report-generator.ts` | 状态映射 + 报告渲染 |
| P0-4 | `src/lib/bridge/bridge-manager.ts` | 修复 syntheticText 路由 |
| P0-4 | `src/lib/bridge/internal/workflow-command.ts` | 新增 report 子命令 |
| P0-4 | `src/lib/workflow/types.ts` | WorkflowSubcommand 类型扩展 |
| P1-1 | `src/lib/workflow/prompt-assembler.ts` | Claude 预算控制 |
| P1-2 | `src/lib/workflow/model-invoker.ts` | 错误分类修正 |
| P1-2 | `src/lib/workflow/types.ts` | 可能新增 ProcessExitError |
| P1-3 | `src/lib/workflow/workflow-engine.ts` | terminateWorkflow 更新 step |
| P2-1 | `src/lib/workflow/workflow-engine.ts` | 短路逻辑 |
| P2-2 | `src/lib/workflow/workflow-engine.ts` | 降级方案 |

## Technical Notes

- 根因链: P0-1 (exclude) → P1-1 (预算) → Claude 崩溃 → P0-2/P0-3 (报告错误) → P0-4 (查看不到)
- 修好 P0-1 后需要重新运行一次 code-review 验证 Claude 是否恢复
- P0-4 的报告展示需要考虑飞书消息长度限制 (code-review-report.md 约 12KB)
- spec-review 的 Claude 决策正常工作 (run cf7630), code-review 专属问题
