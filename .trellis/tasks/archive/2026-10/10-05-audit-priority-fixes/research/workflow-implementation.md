# R2 实现与验证

## 范围与行为

仅修改工作流补丁恢复边界，未修改 PatchApplier、提示词预算、模型调用实现或 bridge。

- `src/lib/workflow/workflow-store.ts` 新增只读 `loadDocumentVersion(runId, target)`，返回同一文档的最新 `{ version, content }`；所有既有保存接口保持语义。
- `src/lib/workflow/patch-recovery.ts` 新增两种版本化 round artifact。首次调用 Claude 前保存 `claude-baseline.json`，固定 spec/plan 的版本、SHA-256 摘要及决策前账本；计算完成后先保存 `patch-application.json`，固定原始模型输出摘要、基线摘要、目标版本、完整 PatchResult、失败判定、最终账本和完成摘要。
- `WorkflowEngine.runLoop` 在重匹配问题或写入账本之前优先读取应用记录。已经完成计算的恢复只补齐不存在的固定版本，并保存同一最终账本；不会重复调用模型或对最新文档重新判断补丁成功与否。
- 全部目标版本先预检再写入；已存在相同内容视为完成，不同内容保留现场。应用记录落盘后，文档/账本完成，再推进 `post_decision`。
- 无应用记录但有合法基线时，复用原始决策及准确版本重新计算。旧步骤已有 raw 却没有可靠基线时，进入 `human_review` 并解释不能猜测重放。
- 记录采用最小 Zod 结构校验和 SHA-256 校验和。记录损坏、基线缺失/变化、原始输出变化、额外版本、目标版本冲突或账本外部变化均暂停，避免静默覆盖。
- `spec_updated` / `plan_updated` 事件在结果真正持久化后发出。事件仍沿用现有追加机制；本项不承诺事件精确一次。

## 影响分析

实施前已读取 `research/workflow.md` 的精确符号 GitNexus 分析：`WorkflowEngine.runLoop` 为 CRITICAL，直接调用方 start/resume，9 个符号、7 个流程；保存文档和 round artifact 接口影响已有记录，复用而未修改。

额外实际执行：

```text
gitnexus impact WorkflowStore --direction upstream --repo . --file src/lib/workflow/workflow-store.ts
```

结果：CRITICAL，27 个符号、12 个流程，d=1 16 个引用/调用，涉及 CLI、IM 工作流入口、auto-fixer、PackBuilder、PromptAssembler、报告器和工厂。新增方法不改变原方法语义；根代理已在实施前向用户补充通报。新 helper 为新增符号，无旧调用方；只由 runLoop 接入。

## RED → GREEN

新增 `src/__tests__/unit/workflow-patch-recovery.test.ts` 使用真实文件型 WorkflowStore、真实 WorkflowEngine 和明确注入的 fake invoker。所有运行目录均为测试独享临时目录；清理前验证其位于系统临时目录且具有测试前缀。未调用真实模型、网络或账号。

- 首次 RED：15 项中 13 项失败、2 项通过。证实旧代码会在重放后增加 spec/plan 版本；未知标题补丁可能变成 resolved；旧半完成步骤不会保守暂停。checkpoint 已落盘的两项原本通过。
- 最终新增 25 项：合法/未知标题 × raw、application、spec、plan、ledger 前后、checkpoint 前后共 16 项；旧步骤缺基线 1 项；损坏与冲突 8 项。
- 中断发生于真实保存成功后（或明确写前）。恢复创建全新 Store/Engine，并再次在 checkpoint 前中断；最终文档、账本、版本列表和完成状态与不中断运行完全相同，Claude 调用保持一次。
- 损坏矩阵包括：基线 JSON、应用 JSON、校验和正确但结构缺字段、基线正文变更、raw 正文变更、plan 目标版本冲突、额外文档版本、人工账本变更。

最终定向测试：

```text
node --test --import tsx --test-timeout=15000 \
  src/__tests__/unit/workflow-patch-recovery.test.ts \
  src/__tests__/unit/workflow-engine.test.ts \
  src/__tests__/unit/workflow-store.test.ts \
  src/__tests__/unit/workflow-reliability.test.ts \
  src/__tests__/unit/workflow-code-review.test.ts \
  src/__tests__/unit/workflow-patch-applier.test.ts
```

由 Python `subprocess.run(..., timeout=60)` 限制外层总时长。结果 **108/108 通过，31 suites，约 4.8 秒**。定向 `git diff --check` 通过。

根代理整合 typecheck 发现测试 fixture 少 `termination_state`、联合方法展开参数未收窄；已补齐真实必需字段并使用明确参数签名，没有用 `any` 或断言压制。随后 `npm run typecheck` 通过，新故障回归 **25/25** 再次通过（外层仍 60 秒）。

## 集成与限制

- build/整合单测、独立 Trellis check、最终 GitNexus detect-changes、提交与推送由根代理统一执行；typecheck 按根代理追加指示修复后复核通过。本实现者未执行提交、刷新索引、启动服务或修改生产数据。
- 旧版部分写入步骤没有准确基线时，不保证自动迁移；会保留产物并给人工恢复提示。
- 单执行锁与本轮应用记录保证文档/问题判定的幂等恢复；事件日志允许重放时重复，不引入额外事件事务。
- 若后续引入人工修改运行产物的正式入口，需要显式处理基线和应用记录失效，而不能直接改 latest 文档绕过冲突检查。
