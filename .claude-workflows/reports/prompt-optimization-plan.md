# Prompt 模板优化方案

- **依据**: `20260321-cc0ca1` 运行的 3 轮实际 Codex/Claude 输入输出
- **关联**: `workflow-engine-deep-audit.md`（代码层问题）
- **日期**: 2026-03-21
- **状态更新**: 2026-03-23 — 逐项对比模板实际状态，标记修复情况

---

## 优化总览

| # | 问题 | 影响的模板 | 优先级 | 状态 |
|---|------|-----------|--------|------|
| T1 | Claude 输出超长 JSON 导致 parse 失败 | claude-decision.md | **Critical** | ✅ 已修复 |
| T2 | Claude 几乎 accept 一切，缺乏真正的对抗 | claude-decision-system.md | **High** | ✅ 已修复 |
| T3 | Codex 跨轮重复提出同类问题 | spec-review-pack.md | **High** | ✅ 已修复 |
| T4 | Codex 输出尾部带非 JSON 内容 | spec-review-pack.md | **Medium** | ✅ 已修复 |
| T5 | severity 定义模糊，Codex 偏高标 | spec-review-pack.md | **Medium** | ✅ 已修复 |
| T6 | 缺少"已解决问题"上下文 | spec-review-pack.md | **Medium** | ✅ 已修复 |
| T7 | round_summary 在 R1 为空 | spec-review-pack.md | **Low** | ✅ wontfix — R1 无前轮数据，空值是正确行为 |
| T8 | round-summary.md 模板未被代码调用 | round-summary.md | **Low** | ✅ closed — 模板已删除，round_summary 由 PackBuilder 内联生成 |

**总结**: 8 项全部关闭（6 项已修复，2 项 Low 级别确认为 wontfix/closed）。

---

## T1：Claude 输出超长 JSON 导致 parse 失败（Critical） — ✅ 已修复

### 修复实现

`claude-decision.md` 已改为 JSON/Patch 分离格式：
- 第一部分：精简 JSON 决策块（decisions + spec_updated/plan_updated + resolves_issues + summary）
- 第二部分：Patch 内容用 `--- SPEC PATCH ---` / `--- END SPEC PATCH ---` marker 分隔
- `extractPatches()` 的 marker 路径成为主路径

### 原始问题记录

从 `R1-claude-raw.md` 实际输出看，Claude 返回了一个巨大的 JSON：
- `spec_patch` 字段包含了整个 Spec 的 §4-§10 章节（几千行）
- JSON 中的字符串值需要大量 `\"` 和 `\n` 转义
- 总输出约 20000+ 字符

在另一次运行（`20260321-15c8bb`）中，这种超长 JSON 导致了 parse 失败，进而触发"3 轮 0 修复"。

---

## T2：Claude 几乎 accept 一切，缺乏真正的对抗（High） — ✅ 已修复

### 修复实现

`claude-decision-system.md` 已添加：
- **Decision Budget**: ≤3 issues per round
- **强化 reject 引导**: 期望 reject 20-40% of findings
- **defer 积极引导**: 本轮无法处理的 valid issues 应 defer 而非全部 accept

### 原始问题记录

| 轮次 | Findings | Accepted | Rejected | Accept 率 |
|------|----------|----------|----------|-----------|
| R1 | 8 | 8 | 0 | **100%** |
| R2 | 8 | 7 | 1 | **87.5%** |

---

## T3：Codex 跨轮重复提出同类问题（High） — ✅ 已修复

### 修复实现

`spec-review-pack.md` 已添加四段式 issue 上下文：
- `{{resolved_issues}}` — Already Resolved Issues (DO NOT re-raise)
- `{{accepted_issues}}` — Previously Accepted (being addressed)
- `{{unresolved_issues}}` — Unresolved Issues (focus here)
- `{{rejected_issues}}` — Previously Rejected (need NEW evidence)
- **CRITICAL DEDUP RULES** 指令段

`pack-builder.ts` / `prompt-assembler.ts` / `types.ts` 相应扩展。

### 原始问题记录

| 轮次 | 独有发现 | 与前轮重复 |
|------|---------|-----------|
| R1 | 8 | — |
| R2 | 1（ISS-009） | 7 与 R1 本质相同 |
| R3 | 2（新角度） | 4 与 R1/R2 本质相同 |

---

## T4：Codex 输出尾部带非 JSON 内容（Medium） — ✅ 已修复

### 修复实现

`spec-review-pack.md` 尾部已添加 **OUTPUT RULES** 强制纯 JSON 输出指令。

---

## T5：severity 定义模糊，Codex 偏高标（Medium） — ✅ 已修复

### 修复实现

`spec-review-pack.md` 已添加详细 **Severity definitions** + 校准指导：
- critical: 0-1 per review
- high: 1-3 per review
- medium: 2-5 per review
- low: 0-3 per review
- 80%+ high/critical → 需要重新校准

---

## T6：缺少"已解决问题"上下文（Medium） — ✅ 已修复

（同 T3，通过四段式 issue 上下文解决）

---

## T7：round_summary 在 R1 为空（Low） — ✅ wontfix

R1 没有前轮数据，round_summary 为空是正确行为，不需要修复。

---

## T8：round-summary.md 模板未被代码调用（Low） — ✅ closed

`round-summary.md` 模板文件已在文档治理中删除（2026-03-23）。round_summary 由 `PackBuilder.buildSpecReviewPack()` 内联生成，不需要独立模板。

---

## 附录：实际运行数据证据

### R1 Codex 输出特征
- 格式：有效 JSON + 尾部 SESSION_ID
- Findings 数量：8
- Severity 分布：1 critical, 6 high, 1 medium
- 重复率：基线（无前轮）

### R1 Claude 输出特征
- 格式：前导自然语言 "Looking at these findings..." + ` ```json ` 代码块
- Accept 率：8/8 = 100%（过高）
- spec_patch 长度：~15000 字符（过长）
- resolves_issues：一次列出全部 8 个（不现实）

### R2 Codex 输出特征
- Findings 数量：8
- 与 R1 重复：7/8 是同类问题的变体措辞
- 独有新发现：仅 1 个

### R2 Claude 输出特征
- Accept 率：7/8 = 87.5%
- 仅 reject 了 1 个（ISS-009，模板定义问题）
- spec_patch 长度：~18000 字符（比 R1 更长）

### R3 Codex 输出特征
- Findings 数量：6
- 与 R1/R2 重复：4/6 是同类问题
- 独有新发现：2 个
- **未到达 Claude 决策**（max_rounds 在 pre_termination 截断）
