# Prompt 模板优化方案

- **依据**: `20260321-cc0ca1` 运行的 3 轮实际 Codex/Claude 输入输出
- **关联**: `workflow-engine-deep-audit.md`（代码层问题）
- **日期**: 2026-03-21

---

## 优化总览

| # | 问题 | 影响的模板 | 优先级 |
|---|------|-----------|--------|
| T1 | Claude 输出超长 JSON 导致 parse 失败 | claude-decision.md | **Critical** |
| T2 | Claude 几乎 accept 一切，缺乏真正的对抗 | claude-decision-system.md | **High** |
| T3 | Codex 跨轮重复提出同类问题 | spec-review-pack.md | **High** |
| T4 | Codex 输出尾部带非 JSON 内容 | spec-review-pack.md | **Medium** |
| T5 | severity 定义模糊，Codex 偏高标 | spec-review-pack.md | **Medium** |
| T6 | 缺少"已解决问题"上下文 | spec-review-pack.md | **Medium** |
| T7 | round_summary 在 R1 为空 | spec-review-pack.md | **Low** |
| T8 | round-summary.md 模板未被代码调用 | round-summary.md | **Low** |

---

## T1：Claude 输出超长 JSON 导致 parse 失败（Critical）

### 现象

从 `R1-claude-raw.md` 实际输出看，Claude 返回了一个巨大的 JSON：
- `spec_patch` 字段包含了整个 Spec 的 §4-§10 章节（几千行）
- JSON 中的字符串值需要大量 `\"` 和 `\n` 转义
- 总输出约 20000+ 字符

在另一次运行（`20260321-15c8bb`）中，这种超长 JSON 导致了 parse 失败，进而触发"3 轮 0 修复"。

### 根因

1. 模板要求 **单个 JSON** 同时包含 decisions + spec_patch + plan_patch + resolves_issues + summary
2. spec_patch/plan_patch 是完整的 Markdown 章节，嵌入 JSON 字符串后需要大量转义
3. LLM 在生成超长 JSON 时容易：
   - 漏掉结尾 `}`
   - 转义字符出错（`\n` 写成真换行）
   - 超出 max_output_tokens 被截断

### 修复方案

**将 decisions 和 patches 分离为两部分输出**：

```
第一部分：JSON 决策块
```json
{
  "decisions": [...],
  "spec_updated": true,
  "plan_updated": false,
  "resolves_issues": ["ISS-001", "ISS-003"],
  "summary": "..."
}
```

第二部分：Patch 内容（仅当 spec_updated/plan_updated 为 true 时）
--- SPEC PATCH ---
## 6.5 TerminationJudge
(完整的替换内容)
--- END SPEC PATCH ---

--- PLAN PATCH ---
(如有)
--- END PLAN PATCH ---
```

**好处**：
- JSON 部分小而简洁，parse 成功率大幅提高
- Patch 部分用 marker 分隔，不需要 JSON 转义
- `extractPatches()` 的 marker 回退逻辑本来就支持，改为**主路径**而非回退
- 即使 patch 部分格式不对，decisions 仍然可以正常处理

### 修改涉及

| 文件 | 改动 |
|------|------|
| `claude-decision.md` | 重写 Output format 章节 |
| `claude-decision-system.md` | 更新 Output Format 段落 |
| `json-parser.ts` | 新增 `parseDecisionsAndPatches()` 方法，先提取 JSON 块再提取 marker patches |
| `workflow-engine.ts` | 调用新方法替换当前的 `parse<ClaudeDecisionOutput>()` |

---

## T2：Claude 几乎 accept 一切，缺乏真正的对抗（High）

### 现象

实际运行数据：

| 轮次 | Findings | Accepted | Rejected | Accept 率 |
|------|----------|----------|----------|-----------|
| R1 | 8 | 8 | 0 | **100%** |
| R2 | 8 | 7 | 1 | **87.5%** |

Claude 在 R1 中一口气 accept 了全部 8 个 issues 并声称全部 resolved。这不是"对抗审查"，这是"橡皮图章"。

### 根因

1. **system prompt 中 reject 的门槛太高**：
   > "When to Reject: The finding is based on a **misunderstanding** of the spec's intent"

   这要求 Claude 证明 Codex "理解错了"才能 reject。但 Codex 发现的架构问题通常确实有一定道理，只是优先级和修复方式可能有争议。

2. **缺少 "defer" 的积极引导**：当前 defer 的定义是 "belongs to a future phase"，太被动。很多问题可以 defer 而不是 accept。

3. **没有"单轮修复上限"的概念**：Claude 试图在一轮内解决所有问题，导致 patch 超长且质量低。

### 修复方案

**修改 `claude-decision-system.md`**：

```markdown
## Decision Budget

YOU MUST NOT accept and patch more than 3 issues per round.

Rationale: Each patch needs careful surgical editing. Accepting too many issues at once
produces massive, error-prone patches that break more than they fix.

Strategy:
1. Prioritize: Pick the top 3 most impactful issues (by severity × feasibility)
2. Accept + Patch: Write precise, minimal patches for these 3
3. Defer the rest: Use "defer" for valid issues you can't address this round
4. Reject with reasoning: Push back on issues that are wrong or out of scope

A well-executed 3-issue fix is worth more than a sloppy 8-issue attempt.
```

**加强 reject 引导**：

```markdown
### When to Reject (ACTIVELY look for reasons)
- The finding conflates two separate concerns — address only the core issue
- The suggestion is **over-engineered** for the actual risk level
- The concern is valid in theory but **the current design handles it differently** (explain how)
- The reviewer is applying a generic best practice that **conflicts with this project's constraints**
- The issue is **cosmetic/stylistic** rather than correctness-related

You are expected to reject 20-40% of findings. If you accept everything, you are not
doing your job as Technical Decision Authority.
```

### 修改涉及

| 文件 | 改动 |
|------|------|
| `claude-decision-system.md` | 添加 Decision Budget 章节 + 强化 reject 引导 |
| `claude-decision.md` | 在 IMPORTANT 区域添加 "max 3 accepts per round" 提醒 |

---

## T3：Codex 跨轮重复提出同类问题（High）

### 现象

从审查分析报告可知：

| 轮次 | 独有发现 | 与前轮重复 |
|------|---------|-----------|
| R1 | 8 | — |
| R2 | 1（ISS-009） | 7 与 R1 本质相同 |
| R3 | 2（新角度） | 4 与 R1/R2 本质相同 |

R2 的 8 个 findings 中 7 个本质上是 R1 同类问题的变体措辞。IssueMatcher 的文本去重没有拦住这些（因为 Codex 每轮换了措辞）。

### 根因

1. **`{{unresolved_issues}}` 只列出 open/deferred，不列出 accepted/resolved**：Codex 看不到已经被处理的问题，自然会重新发现

2. **`{{rejected_issues}}` 的去重信号太弱**：只有 `"do NOT re-raise"` 的指令，缺乏结构化的"这些问题域已经覆盖"信号

3. **缺少 "已处理问题摘要" 章节**：当前模板没有展示哪些问题已经被 accept+resolve 了

### 修复方案

**在 `spec-review-pack.md` 中添加已处理问题上下文**：

```markdown
## Already Resolved Issues (DO NOT re-raise these)
{{resolved_issues}}

## Previously Accepted (being addressed, DO NOT re-raise)
{{accepted_issues}}

## Unresolved Issues (focus here — find NEW problems, not variations of known ones)
{{unresolved_issues}}

## Previously Rejected (do not re-raise without NEW evidence from a DIFFERENT angle)
{{rejected_issues}}
```

**加强去重指令**：

```markdown
CRITICAL DEDUP RULES:
1. Before raising any finding, check ALL sections above (Resolved, Accepted, Unresolved, Rejected)
2. If your finding is essentially the SAME CONCERN as an existing issue (even if worded differently),
   DO NOT raise it. Instead, note it in your summary if you think it needs more attention.
3. Your value comes from finding NEW problems, not restating known ones.
4. Findings that duplicate existing issues will be automatically discarded.
```

### 修改涉及

| 文件 | 改动 |
|------|------|
| `spec-review-pack.md` | 添加 resolved/accepted 章节 + 去重指令 |
| `prompt-assembler.ts` | `renderSpecReviewPrompt()` 新增 resolved/accepted issues 渲染 |
| `pack-builder.ts` | `buildSpecReviewPack()` 返回值增加 resolved_issues 和 accepted_issues 字段 |
| `types.ts` | `SpecReviewPack` 接口增加 `resolved_issues` 和 `accepted_issues` 字段 |

---

## T4：Codex 输出尾部带非 JSON 内容（Medium）

### 现象

`R1-codex-review.md` 的实际结尾：
```
..."summary": "..."}

---
SESSION_ID: 019d1041-f615-7390-aa34-3919877f1430
```

JSON 后面跟了 `---` 分隔线和 SESSION_ID。当前 `JsonParser` 的 Strategy 3（提取平衡 `{}` 块）能处理这种情况，但这是 **回退路径**，不是理想状态。

### 根因

`codeagent-wrapper` 在输出结尾追加了会话信息。Codex prompt 没有强调"输出必须是纯 JSON"。

### 修复方案

**在 `spec-review-pack.md` 尾部添加强制纯输出指令**：

```markdown
OUTPUT RULES:
- Your response must contain ONLY the JSON object, nothing else
- No markdown formatting, no code fences, no explanations before or after
- Start with { and end with }
- Do not include session IDs, separators, or any non-JSON content
```

同时在 `model-invoker.ts` 的 Codex 调用后添加后处理：

```typescript
// 清理 codeagent-wrapper 追加的 SESSION_ID 等内容
codexRaw = codexRaw.replace(/\n---\nSESSION_ID:.*$/s, '').trim();
```

### 修改涉及

| 文件 | 改动 |
|------|------|
| `spec-review-pack.md` | 添加 OUTPUT RULES 章节 |
| `model-invoker.ts` 或 `workflow-engine.ts` | Codex 输出后处理清理 |

---

## T5：severity 定义模糊，Codex 偏高标（Medium）

### 现象

R1 的 8 个 findings 中：
- Critical: 1
- High: 6
- Medium: 1
- Low: 0

80%+ 都是 high 以上。这说明 Codex 没有校准的锚点。

### 根因

模板只给了 `"severity": "critical|high|medium|low"` 和一句 `"IMPORTANT: severity must be one of: critical, high, medium, low"`。没有定义每个级别的含义。

### 修复方案

**在 `spec-review-pack.md` 中添加 severity 定义**：

```markdown
Severity definitions (be honest — inflating severity wastes review bandwidth):
- **critical**: Blocks implementation. Fundamental design flaw that requires architectural rethinking.
                Expected: 0-1 per review. If you have 3+ critical findings, reconsider your calibration.
- **high**: Correctness risk. Will cause bugs, data loss, or security issues if not fixed before coding.
            Expected: 1-3 per review.
- **medium**: Improvement needed but won't block or break implementation. Missing edge case handling,
              incomplete error paths, documentation gaps.
              Expected: 2-5 per review.
- **low**: Style, naming, minor inconsistency, "nice to have" improvements.
           Expected: 0-3 per review.

If your findings are 80%+ high/critical, you are likely over-calibrating. Recalibrate before submitting.
```

### 修改涉及

| 文件 | 改动 |
|------|------|
| `spec-review-pack.md` | 添加 Severity definitions 段落 |

---

## T6：缺少"已解决问题"上下文（Medium）

### 现象

与 T3 重叠但角度不同。当前 `SpecReviewPack` 只包含 `unresolved_issues` 和 `rejected_issues`。Codex 不知道哪些问题已经被解决，也看不到 Claude 对已解决问题做了什么修改。

### 根因

`pack-builder.ts` 的 `filterUnresolvedIssues()` 只取 open+deferred。resolved 和 accepted 的 issues 不进入 pack。

### 修复方案

在 T3 的方案中已包含：增加 `resolved_issues` 和 `accepted_issues` 字段。

额外优化：对 resolved issues 附带 `resolved_in_round` 信息，让 Codex 知道是什么时候解决的：

```markdown
## Already Resolved Issues
- [ISS-001] (critical, resolved in R1) 终止条件会在仍有高优先级未解决问题时提前结束流程
- [ISS-002] (high, resolved in R1) claude_decision 步骤的恢复语义不具备幂等性
```

### 修改涉及

（同 T3，不重复列出）

---

## T7：round_summary 在 R1 为空（Low）

### 现象

`prompt-assembler.ts` 中：
```typescript
result = this.replacePlaceholder(result, 'round_summary', pack.round_summary || 'First round');
```

R1 时 `round_summary` 为空字符串，fallback 为 `'First round'`。这对 Codex 来说信息量为零。

### 修复方案

R1 时替换为更有用的上下文：

```
First review round. No prior issues or decisions exist.
Focus on thorough coverage of the entire spec and plan.
```

### 修改涉及

| 文件 | 改动 |
|------|------|
| `pack-builder.ts` | `generateRoundSummary()` round=1 时返回更有意义的文字 |

---

## T8：round-summary.md 模板未被代码调用（Low）

### 现象

`templates/round-summary.md` 定义了 8 个占位符，但代码中没有任何地方引用 `'round-summary.md'` 模板名。

```typescript
// prompt-assembler.ts 中只引用了这三个：
const SPEC_REVIEW_TEMPLATE = 'spec-review-pack.md';
const CLAUDE_DECISION_TEMPLATE = 'claude-decision.md';
const CLAUDE_DECISION_SYSTEM_TEMPLATE = 'claude-decision-system.md';
```

### 修复方案

要么：
- **删除** `round-summary.md`（如果不打算用）
- **接入** 到 `pack-builder.ts` 的 `generateRoundSummary()` 中，用模板渲染而不是硬编码字符串

### 修改涉及

| 文件 | 改动 |
|------|------|
| `round-summary.md` | 删除或接入 |
| `pack-builder.ts` | 如保留，改用模板渲染 |

---

## 实施批次建议

| 批次 | 范围 | 预期效果 |
|------|------|---------|
| **TP0** | T1（JSON/Patch 分离） | 解决 parse 失败根因，直接消除"N 轮 0 修复" |
| **TP1** | T2（Decision Budget） + T3（去重上下文） | 提升对抗质量 + 减少重复 findings |
| **TP2** | T4 + T5 + T6 | 输出清洁 + severity 校准 + 上下文完整性 |
| **TP3** | T7 + T8 | 清理小问题 |

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
