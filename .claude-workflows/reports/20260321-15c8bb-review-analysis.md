# Spec-Review 审查分析报告

- **工作流 ID**: `20260321-15c8bb`
- **类型**: Spec-Review（Codex 对抗审查）
- **日期**: 2026-03-21
- **轮次**: 3 轮（已达 `max_rounds` 上限）
- **终止原因**: `pre_termination`（达到最大轮次）
- **总 Issue 数**: 27 个
- **已解决**: 0 个
- **所有轮次评估**: `major_issues`（重大问题）

---

## 核心问题：3 轮审查同一批问题反复出现，零修复

Codex 连续 3 轮提出本质相同的问题，但 Spec/Plan 没有做任何修订，导致每一轮都在重复发现。27 个 issue 全部处于 `open` 状态。

原因分析：`rounds/` 下只有 `R{N}-codex-review.md` 和 `R{N}-claude-input.md`，但没有 `R{N}-claude-raw.md`（Claude 的决策响应）。说明 Claude 决策环节未执行或结果未保存，Spec/Plan 从未被修改，3 轮本质上是同一份文档被审了 3 遍。

---

## 去重后的核心问题归类（10 个独立问题域）

### Critical × 1（每轮必提，3 轮重复）

| # | 问题 | 轮次 |
|---|------|------|
| **C1** | **Step C 恢复不幂等**：崩溃后 `resume()` 会复用原始 Claude 输出重新执行补丁/状态迁移，导致重复版本和状态污染 | R1→R2→R3 |

> **建议**：把 Step C 拆成子检查点（`raw_saved` → `decisions_applied` → `patches_applied` → `committed`），引入幂等操作日志/内容哈希

### High × 9

| # | 问题 | 轮次 | 关键词 |
|---|------|------|--------|
| **H1** | Claude JSON 解析失败后无安全闭环，只有 `extractPatches()` 回退，缺 `decisions[]` 降级策略 | R1→R2→R3 | 解析降级 |
| **H2** | `ContextCompressor` 返回 `{ text }` 与 `SpecReviewPack` 结构不兼容，无法接入 | R1→R2→R3 | 接口不匹配 |
| **H3** | 补丁 heading 未命中时仍允许 `resolved`，存在"文档未改/状态已关"假阳性 | R1→R2→R3 | patch-resolve 一致性 |
| **H4** | 终止条件只看 `open` issue，遗漏 `accepted`/`deferred` 未闭环状态 | R1→R2→R3 | 终止条件覆盖 |
| **H5** | TerminationJudge 的"连续无高危"计数没有持久化，resume 后状态丢失 | R2→R3 | 终止状态持久化 |
| **H6** | Claude 决策缺乏语义校验（重复/未知 ID、`resolves_issues` 指向非法目标） | R2→R3 | 决策校验 |
| **H7** | B1 `processFindings()` 幂等性不成立，崩溃重跑会重复 `repeat_count++` | R2 独有 | IssueMatcher 幂等 |
| **H8** | Empty-findings 模板禁止 `accept`，卡死旧 issue 的补丁闭环 | R3 独有 | 模板死锁 |
| **H9** | 崩溃安全缺少原子写入（write-tmp → fsync → rename），截断 JSON 不可恢复 | R3 独有 | 原子写入 |

### Medium × 3

| # | 问题 | 轮次 |
|---|------|------|
| **M1** | 配置契约未收口（`max_deferred_issues` 散落在 overrides，`auto_terminate` 声明但未使用） | R1→R2→R3 |
| **M2** | `package.json` exports 路径 Spec vs Plan 冲突 | R1→R2→R3 |
| **M3** | 模板占位符定义混入字面值，与验收标准不一致 | R1 独有 |

---

## 问题收敛趋势

| 轮次 | 独有发现 | 重复发现 | 新增视角 |
|------|---------|---------|---------|
| R1 | 8 个 | — | 基线发现 |
| R2 | 9 个 | 8 个与 R1 重复 | 新增：B1 幂等性 |
| R3 | 10 个 | 8 个与 R1/R2 重复 | 新增：Empty-findings 死锁、原子写入 |

R3 比 R1 多发现了 2 个新问题域（H8、H9），说明 Codex 在深入审查，但核心的 8 个老问题完全没被处理。

---

## 修复状态（2026-03-21 已全部修复）

| # | 问题 | 修复方式 | 状态 |
|---|------|---------|------|
| **C1** | Step C 幂等恢复 | Spec §7.1 拆 C1-C4 子检查点 + §7.3 sub-checkpoint resume | ✅ 已修复 |
| **H1** | Claude 解析失败闭环 | Spec §6.8 增加 Safety Protocol + §10 表格更新 | ✅ 已修复 |
| **H2** | ContextCompressor 接口 | Spec §6.6 改为结构化 SpecReviewPack 输入/输出 | ✅ 已修复 |
| **H3** | Patch-Resolve 一致性 | Spec §6.10 增加 Patch-Resolve Consistency Rule | ✅ 已修复 |
| **H4** | 终止条件覆盖 | Spec §6.5/§7.2 统一为 open\|accepted\|deferred | ✅ 已修复 |
| **H5** | 终止状态持久化 | Spec §4.5 WorkflowMeta 增加 termination_state | ✅ 已修复 |
| **H6** | 决策语义校验 | Spec §6.11 新增 DecisionValidator（5 项校验） | ✅ 已修复 |
| **H7** | IssueMatcher 幂等 | Spec §4/§6.9 增加 last_processed_round 字段 | ✅ 已修复 |
| **H8** | Empty-findings 模板 | Spec §8.2 允许 accept 动作 | ✅ 已修复 |
| **H9** | 原子写入 | Spec §6.7 增加 Atomic Write Protocol | ✅ 已修复 |
| **M1** | 配置契约 | Spec §4.5/§9 统一 max_deferred_issues 到 WorkflowConfig | ✅ 已修复 |
| **M2** | Exports 路径 | Plan Step 13 修正为 `"./workflow/*"` | ✅ 已修复 |
| **M3** | 模板占位符 | Spec §8.2 清理占位符说明 | ✅ 已修复 |

### 修改涉及文件

- `workflow-engine-spec.md` — 13 处修改
- `workflow-engine-plan.md` — 15 处修改
- Spec-Plan 一致性验证 — 13 项检查全部通过
