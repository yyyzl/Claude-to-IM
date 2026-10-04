# 工作流补丁恢复独立审查

## Findings (fixed)

### 1. 提交补丁期间暂停仍继续落盘并标记完成

- 文件：`src/lib/workflow/patch-recovery.ts`、`src/lib/workflow/workflow-engine.ts`。
- 证据：真实 Store 在保存 spec-v2 后挂起，调用 `pause()` 再释放保存；首次提交、已有 application 的恢复提交均继续保存 plan/ledger，最终状态为 completed 而非 paused。两项 RED 实际失败。执行锁本身仍由旧执行者持有，故问题不是 pause 返回后仍写入，而是提交阶段没有消费取消信号。
- 修复：`commitPatchApplication` 接收可选 AbortSignal 并返回完成状态，在各文档及账本写入边界停止后续提交；已进入的原子写仍完成。调用方保存 claude_decision 暂停检查点，保留 application。完成事件后及已推进 post_decision 时也检查暂停，防止末尾窗口落空。
- 回归：首次/恢复 × spec、plan、最终 ledger、完成事件、post_decision checkpoint，共 10 个场景。断言第二执行者在旧原子写排空前被锁拒绝、暂停状态与文档/账本进度正确、返回后无后续写入、再恢复不增加文档版本且 Claude 总调用一次。

### 2. 首次提交没有使用恢复路径的完整冲突保护

- 文件：`src/lib/workflow/workflow-engine.ts`。
- 证据：在首次 application 写入后注入人工 ledger、目标版本、额外版本或基线正文修改。4 项 RED 全失败：前两种抛未捕获 PatchRecoveryError；后两种继续保存产物并将问题标为 resolved。恢复入口已经能正确处理这些情况，首次入口漏了同样的验证与 human_review 转换。
- 修复：首次 application 保存后复用 `loadPatchRecovery` 的归属、摘要、文档版本与 ledger 验证，再执行提交；PatchRecoveryError 与恢复入口一样进入 human_review 并保留产物。没有另加校验协议、修改锁或改动 PatchApplier 语义。
- 回归：4 种首次提交冲突均暂停，文档、版本列表、ledger 保持冲突现场内容，模型只调用一次。

## 其他审查结论

- baseline 来自真实版本文件的版本号与 SHA-256，不使用可压缩 round pack。正常首次调用模型前保存 baseline；保存完整 application 后才写固定目标版本与最终账本。
- 已有 application 的恢复位于 issue matcher、模型调用和账本变更之前；完整 PatchResult、原始失败判定与最终 ledger 直接重用，不重新应用到 latest 文档。
- 合法/未知标题补丁的 raw、application、spec、plan、ledger 前后及 checkpoint 前后窗口均有真实文件故障回归；新 Store/Engine 重建后与无故障结果一致，重复恢复不增加版本。
- 旧 raw 无 baseline、坏 JSON、校验和正确但缺字段、原文变化、目标冲突、额外版本和人工 ledger 修改均保守进入 human_review。异常磁盘写入没有被误当恢复冲突吞掉。
- `profile.behavior.applyPatches` 约束新增协议；code-review 不创建补丁恢复记录，原 code-review 回归通过。既有 ModelInvoker AbortError 的 checkpoint 逻辑未改。
- `loadDocumentVersion` 只读返回准确版本及内容，保存仍使用既有显式版本接口；没有数据库迁移或直接修改用户运行产物。

## 修改前影响分析

- 已读取任务 PRD/design/implement/check.jsonl、完整相关规范、`research/workflow.md` 与实施记录。
- 实际执行 `gitnexus impact commitPatchApplication --direction upstream --repo . --summary-only`，本任务新增 helper 尚未进入基线图，返回 UNKNOWN；没有把未找到视为安全。
- 随即重新执行精确 `WorkflowEngine.runLoop#3` upstream impact：CRITICAL，9 个符号、7 个流程、2 个直接入口 start/resume。影响覆盖 CLI 与 IM 审查/恢复，与已提前通报范围相同。
- 当前源码确认 helper 仅由 runLoop 的首次提交、恢复提交两处调用；已同步两处及测试。根代理确认该最小修改和风险通报。本 reviewer 未重建索引；最终新增图符号和完整 detect-changes 由根代理整合验证。

## Verification

- Lint：项目无独立 lint script；workflow tracked diff 和两份新文件 whitespace 检查无错误。`git diff --no-index --check -- NUL <新文件>` 退出码 1 表示新增差异，不是 whitespace 失败。
- TypeCheck：`npm run typecheck` **通过**（包括 scripts 配置）。
- Tests：相关 6 文件 **122/122 通过**，31 suites，约 5.86 秒；外层 subprocess 超时 60 秒，内部每测试超时 15 秒。新 `workflow-patch-recovery.test.ts` 现在 39 项（原 25 + 审查补充 14）。
- 定向文件：workflow-patch-recovery、workflow-engine、workflow-store、workflow-reliability、workflow-code-review、workflow-patch-applier。
- 未重复全仓测试或 build；根代理需对最终新增修复整合验证。
- 全部模型为显式 fake invoker，持久化使用测试独享临时目录；未运行真实模型/飞书、生产接口或真实工作流。

## Findings (not fixed)

没有确认的剩余代码问题。事件日志仍允许重放时重复；无准确基线的旧半完成步骤仍需人工核对，均为已约定边界。

只读核对 `docs/reliability-fixes.zh-CN.md` 与可靠性规范，接口及现有恢复叙述匹配；已通知根代理补充本次发现的“暂停排空原子写、首次提交同样检测人工冲突”规则，本 reviewer 未越权修改文档或规范。
