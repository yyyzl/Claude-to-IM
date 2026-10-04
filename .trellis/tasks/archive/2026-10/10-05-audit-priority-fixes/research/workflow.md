# Research: 补丁恢复的确定性重放

- Query: 修复 spec-review 在文档部分落盘后恢复，补丁失败变成功、问题被错误 resolved 的可靠性缺陷；提供最小设计和故障回归方案。
- Scope: internal；只读代码与图查询，仅写本研究文件。
- Date: 2026-10-05
- Baseline: main `9a0bcb5`；根代理已核实 GitNexus 索引与当前 covered files 一致。本轮不重建索引。

## Findings

### 1. 已确认的故障及边界

`src/lib/workflow/patch-applier.ts:136` 对找不到的标题保留“追加内容，同时加入 failedSections”的既有语义。相同补丁第一次应用后，新标题已经存在；若恢复时对更新后的文档再次 apply，failedSections 会变空。这不是 PatchApplier 单次执行错误，不应修改它的追加或失败语义来掩盖恢复错误。

当前直接链路为 `WorkflowEngine.start/resume → executeOwned → runLoop → loadRoundArtifact(claude-raw.md) → PatchApplier.apply → saveSpec/savePlan → saveLedger → updateMeta(post_decision)`：

- `src/lib/workflow/workflow-engine.ts:602` 恢复复用本轮 Claude raw。
- `src/lib/workflow/workflow-engine.ts:911`、`:931` 却读取最新 spec/plan；`:914`、`:934` 自增版本保存应用结果。
- `src/lib/workflow/workflow-engine.ts:949`、`:976` 根据本次重新计算的 hasPatchFailure 决定 accept_and_resolve / resolves_issues 是否解决问题。
- `src/lib/workflow/workflow-engine.ts:1021` 保存 ledger，`:1051` 才推进 checkpoint。

因此，在任一文档写成功后、checkpoint 推进前中断，恢复有机会将第一次失败的补丁判为成功；只有 spec 写入而 plan 尚未写入的窗口还会让两份文档使用不同基线。单文件 atomicWriteFile 已有保障，但不能使这几个文件成为同一逻辑事务。

此前只读审查已实际运行纯内存复现：`apply('## Existing\noriginal', '## Missing\nreplacement')` 第一次 failedSections 为 `['## Missing']`；再对第一次 merged 应用同一补丁，failedSections 为 `[]`，两次 merged 内容相同。复现仅证明补丁重放判定变化；完整工作流故障回归尚待实施，不能声称已经通过。

### 2. 最小设计：版本文件继续复用，补充每轮应用记录

结论：复用已有 `spec-vN.md`、`plan-vN.md`、round artifacts、执行锁及原子写接口；新增结构化的本轮应用记录（manifest 或等价 artifact）。不引入数据库、不改变 PatchApplier 语义、不扩展 prompt 预算范围。

不能直接把 `R{round}-pack.json` 当成准确基线：`src/lib/workflow/pack-builder.ts:111` 会调用 tryCompress；`:507` 起的压缩可能用摘要替换 spec，并将 plan 改为 `(included in compressed context above)`。`buildClaudeDecisionInput` 在 `:143`、`:144` 读取真实全文，但现有 `claude-input.md` 是渲染文本，不能通过反向解析它证明原始版本。

建议两个小型 artifact，均以现有 saveRoundArtifact 原子写入：

1. **`R{round}-claude-baseline.json`**：在首次 Claude 调用前、任何补丁文档变更前保存。包含 schema、runId、round、实际 spec/plan 基线版本与内容摘要，以及决策前 ledger 快照。原文可用不可变版本文件读取，无需再复制全文。创建时由一个新的 Store 只读 helper 返回 `{version, content}`，内部复用 findLatestVersion 与显式版本 loadSpec/loadPlan；无需改变现有保存接口。若模型调用超时，恢复继续复用该基线。
2. **`R{round}-patch-application.json`**：解析/校验已保存的 Claude raw 后，从固定基线计算所有结果，**在写 spec、plan 或决策后 ledger 之前**保存。包含 raw 摘要、基线版本/摘要、需要写入的固定目标版本、merged 文本（或其可靠 artifact 引用）、appliedSections、failedSections、missing-patch 等最终失败判定，以及最终 ledger 快照。这样恢复无需重新决定成败，也无需重新处理已完成的 ledger 决策。

应用顺序固定为：保存完整 application → 校验并补齐固定目标 spec/plan → 保存 application 中的最终 ledger → checkpoint 切到 post_decision。不要保存一个“已准备好”标志而把结果留在内存；完整记录必须先持久化。

恢复处理应放在 claude_decision 阶段的前面，早于重新执行 issueMatcher / 决策 mutation：

- 有 application：校验 schema、run/round、raw 摘要、基线与目标内容；直接重放固定结果。
- 目标版本不存在：调用 saveSpec/savePlan 的现有显式 version 参数补齐；存在且内容相同：视为已完成；存在但内容不同：暂停并给出冲突原因，不能覆盖。
- 有 baseline、无 application：从基线版本重算结果并先保存 application；不能用最新版本作为替代。
- 没有 baseline、没有 Claude raw：可在调用模型前建立 baseline，因旧顺序下尚未开始补丁应用。
- 已有 Claude raw、无 baseline/application 的旧运行：只有能证明准确基线时才能迁移；最小实现直接暂停并说明需要人工确认，不能根据 latest、标题是否存在或压缩 pack 猜测。
- 记录损坏、引用版本缺失、摘要不匹配：暂停并保持检查点，不能静默创建新基线继续执行。

把最终 ledger 放进 application 的原因：当前恢复 claude_decision 会重新 processFindings 并保存 ledger，且中断可能发生在决策后 ledger 已写、meta 未写之间。仅持久化 hasPatchFailure 虽能挡住本次假成功，却没有覆盖完整重放窗口。重放最终 ledger 也应保留初次确定的 resolved_in_round 等字段；不得重新生成不同结果。

事件持久化可能仍出现重复，这不是本次要求的精确一次事件投递；本次回归主要检查文档、ledger、checkpoint、版本数量及模型调用。可沿用已有事件机制，不引入消息队列或事件事务。

### 3. 修改影响分析（已实际执行）

使用 GitNexus 1.6.12 CLI 精确 UID，所有命令显式 `--repo .`：

```text
gitnexus impact 'Method:src/lib/workflow/workflow-engine.ts:WorkflowEngine.runLoop#3' --direction upstream --repo .
gitnexus impact 'Method:src/lib/workflow/workflow-store.ts:WorkflowStore.saveSpec#3' --direction upstream --repo .
gitnexus impact 'Method:src/lib/workflow/workflow-store.ts:WorkflowStore.savePlan#3' --direction upstream --repo .
gitnexus impact 'Method:src/lib/workflow/workflow-store.ts:WorkflowStore.saveRoundArtifact#4' --direction upstream --repo .
```

| 符号 | 图风险 | 受影响符号 / 流程 | d=1 直接调用方 | 设计中的处理 |
| --- | --- | --- | --- | --- |
| WorkflowEngine.runLoop | CRITICAL | 9 / 7 | start、resume | 修改 spec-review 补丁计算/提交/恢复分支 |
| WorkflowStore.saveSpec | CRITICAL | 10 / 8 | runLoop、start | 保留实现，复用显式版本参数 |
| WorkflowStore.savePlan | CRITICAL | 10 / 8 | runLoop、start | 保留实现，复用显式版本参数 |
| WorkflowStore.saveRoundArtifact | CRITICAL | 8 / 7 | runLoop | 保留实现，新增 artifact 类型 |

受影响入口包括 `src/lib/workflow/cli.ts` 的 main / handleCodeReview，以及 `src/lib/bridge/internal/workflow-command.ts` 的 handleStartSpecReview / handleStartCodeReview / handleStartReviewFix / handleWorkflowCommand。图中跨 profile 的共享 runLoop 使风险等级很高；实际新行为应严格受 applyPatches / spec-review 约束，code-review / review-fix 不应被要求创建补丁记录。HIGH/CRITICAL 已在实施前向根代理通报，根代理确认已向用户说明 runLoop 风险。

实施者若改变上述保存方法、其他现有方法或新 helper 的调用位置，应追加实际符号的影响分析；本方案不要求修改 PatchApplier.apply 或 PackBuilder 的压缩逻辑。

### 4. 真实 Store + fake Invoker 故障回归

在 `src/__tests__/unit/workflow-reliability.test.ts` 增加有实际文件持久化的测试，可复用该文件 `:270` 起的真实 WorkflowStore、真实 WorkflowEngine 和合成 templates + fake invoker 框架。不要复用 `:209` 覆盖 runLoop 的 fakeEngine，它会绕过待修复逻辑。

所有数据放测试独享的系统临时目录；输入 spec/plan、finding、Claude raw 全部为合成文本。显式 fake invokeCodex/invokeClaude，意外模型调用立即抛错；测试中阻断真实 child_process/fetch/net.connect。中断用包装 Store 方法“先 await 原方法落盘，再仅一次抛出合成错误”，之后创建全新 Store/Engine 实例恢复，不能沿用内存状态。测试清理仅限测试自身创建且核实路径的临时目录。单次测试超时不超过 15 秒，整组不超过 60 秒。

| 场景 | 故障注入点 | 必须断言 |
| --- | --- | --- |
| 未知标题第一次失败后恢复 | saveSpec 原方法成功后抛错 | 恢复后仍为失败；accept_and_resolve 降为 accepted，resolves_issues 不能解决该问题；新标题仍只追加一次 |
| spec/plan 部分保存 | spec 已保存，plan 尚未保存 | 两者最终内容与无故障执行一致，版本各只增加一次；plan 使用同一轮原始基线 |
| application 已保存 | application 原子写成功后抛错，文档尚未写 | 恢复直接补齐两文档和 ledger，不重复模型调用 |
| 文档均已保存 | saveLedger 写前抛错 | 重放不新建额外文档版本；最终 ledger 等于记录结果 |
| ledger 已保存 | saveLedger 写后、updateMeta(post_decision) 前抛错 | 新 Engine 恢复不重算决定；ledger/问题状态保持一致，并正确推进 checkpoint |
| checkpoint 已推进 | updateMeta(post_decision) 成功后抛错 | 进入后续阶段，不重新应用本轮补丁 |
| 匹配标题正常补丁 | 无故障与上述窗口分别执行 | 正常可 resolved，不能因为新增恢复保护永久降级所有成功补丁 |
| 损坏、冲突或旧记录缺失 | 缺版本 / 不同目标内容 / 已有 raw 但无可证基线 | 明确暂停；不覆盖冲突版本、不猜测基线、不真实调用模型 |

最有价值的比较是同一组合成输入的无故障结果与每个故障恢复结果一致。正常后续轮次若还需模型输出，应为其提供显式 fake，并分别统计“已完成本轮模型不得再次调用”，不能把合法下一轮调用误判为失败。

本研究阶段未新增或运行业务测试；以上为实施时必须执行的回归设计，不能记录为已通过。实际执行命令及结果由实施者在变更完成后补充。

## Files found

- `src/lib/workflow/workflow-engine.ts`：本轮决策、补丁应用、ledger 与 checkpoint 顺序。
- `src/lib/workflow/workflow-store.ts`：执行锁、原子写、版本文档和 round artifacts，可复用存储能力。
- `src/lib/workflow/patch-applier.ts`：标题匹配与失败追加语义，保持不变。
- `src/lib/workflow/pack-builder.ts`：round pack 的压缩与真实 Claude 决策输入，解释为何 pack 不能直接当准确基线。
- `src/__tests__/unit/workflow-reliability.test.ts`：真实 Store 与 fake invoker 的现有可靠性测试框架。
- `src/__tests__/unit/workflow-engine.test.ts`：既有决策/patch 行为的测试夹具与兼容性覆盖。

## Related specs / references

- `.trellis/workflow.md`：研究、规划、实施与验证分工。
- `.trellis/spec/backend/workflow-engine.md`：多 profile 引擎、恢复和存储约定。
- `.trellis/spec/backend/testing-guidelines.md`：测试隔离、显式 fake 与真实模型调用限制。
- `.agents/skills/gitnexus/gitnexus-impact-analysis/SKILL.md`：上游影响分析与风险通报。
- 无外部 API 或版本事实依赖，本项无需网络检索。

## Caveats / Not Found

- 当前 task.py current 指针仍为空；根代理已明确分配本任务目录，故仅在指定 research 路径落盘，没有切换其他任务或写业务文件。
- 不把以前已修复的 atomic save、owner lock、Git baseline 等问题重复列为当前缺陷。
- 单机 JSON + 原子文件写入 + 单运行执行锁在本次范围内足够；缺失的是跨文件恢复协议，不是已有证据要求迁移数据库。
- 确定性应用记录增加少量每轮存储；本轮没有测得性能瓶颈，也不以此推断需要压缩、清理历史或改数据库。
- 旧运行已写部分文档却缺准确基线时，暂停是诚实边界；不能宣称所有历史中断状态均可无损自动迁移。
