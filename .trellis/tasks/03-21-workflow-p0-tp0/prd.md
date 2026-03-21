# Workflow Engine P0+TP0: Parse 安全网 + Prompt 模板优化

## Goal

修复 Workflow Engine 的 4 个代码缺陷 + 5 个 prompt 模板问题。它们是同一根因的两面：
- 代码层：parse 失败后没有安全网（空转/浪费 API 调用）
- 模板层：prompt 设计导致 parse 容易失败（超长 JSON/无对抗/无校准）

## Background

在 `20260321-cc0ca1` 和 `20260321-15c8bb` 两次实际运行中观察到：
- Claude 返回 15000+ 字符 JSON（含 spec_patch），parse 失败率高
- parse 失败后代码无 return，整轮空壳执行（"3 轮 0 修复"）
- Claude accept 率 100%（橡皮图章），缺乏真正对抗
- max_rounds 在 B2 提前截断，最后一轮 Codex 白做
- Codex severity 80%+ high/critical，缺少校准锚点

## Requirements

### 代码修复（P0）

1. **缺陷1: Claude parse 失败后空转**
   - 文件: `workflow-engine.ts`
   - 在 parse 失败时增加 consecutiveParseFailures 计数器
   - 连续 2 次 parse 失败 → pause_for_human
   - parse 成功时重置计数器
   - consecutiveParseFailures 持久化到 meta.termination_state

2. **缺陷2: max_rounds 在 B2 提前截断**
   - 文件: `termination-judge.ts`
   - 将 max_rounds 检查从 pre_termination(B2) 移到 post_decision(D)
   - 确保最后一轮 Codex 发现的 issue 能被 Claude 处理

3. **缺陷3: 零进展安全网缺失**
   - 文件: `workflow-engine.ts`, `types.ts`
   - 在 post_decision 统计本轮 accepted+resolved 数量
   - 连续 2 轮零进展 → pause_for_human
   - zeroProgressRounds 持久化到 meta.termination_state

4. **缺陷4: TimeoutError 破坏终止条件**
   - 文件: `workflow-engine.ts`
   - timeout 时不设 previousRoundHadNewHighCritical = true
   - 保持原值不变（timeout 轮不算有效轮次）

### 模板优化（TP0）

5. **T1: JSON/Patch 分离**
   - 文件: `claude-decision.md`, `claude-decision-system.md`, `json-parser.ts`, `workflow-engine.ts`
   - 将 decisions JSON 和 patch 内容分离为两部分输出
   - JSON 部分小而简洁（无 spec_patch/plan_patch 字段）
   - Patch 部分用 --- SPEC PATCH --- / --- PLAN PATCH --- marker
   - json-parser.ts 新增 parseDecisionsAndPatches() 方法

6. **T2: Claude 橡皮图章（accept 一切）**
   - 文件: `claude-decision-system.md`, `claude-decision.md`
   - 添加 Decision Budget: 每轮最多 accept+patch 3 个 issue
   - 强化 reject 引导: 预期 reject 20-40%
   - 超出 3 个的 valid issue 用 defer

7. **T4: Codex 尾部非 JSON 内容**
   - 文件: `spec-review-pack.md`, `model-invoker.ts`
   - 模板添加 OUTPUT RULES（纯 JSON 输出）
   - model-invoker 后处理清理 SESSION_ID 等

8. **T5: severity 定义模糊**
   - 文件: `spec-review-pack.md`
   - 添加 severity 锚定定义（含预期分布比例）

9. **T7: R1 round_summary 为空**
   - 文件: `pack-builder.ts`
   - round=1 时返回有意义的初始化文字

## Acceptance Criteria

- [ ] Claude parse 连续失败 2 次后工作流暂停（不再空转）
- [ ] 最后一轮 Codex 发现的 issue 能被 Claude 处理后再终止
- [ ] 连续 2 轮零进展后工作流暂停
- [ ] timeout 后"连续无高危"终止条件不被重置
- [ ] Claude 输出分为 JSON 决策块 + marker patch 两部分
- [ ] 每轮最多 accept+patch 3 个 issue（模板层约束）
- [ ] Codex 输出尾部 SESSION_ID 被自动清理
- [ ] severity 有明确的锚定定义
- [ ] R1 的 round_summary 不再为空字符串
- [ ] TypeScript 编译零错误
- [ ] 现有测试不回归

## Technical Notes

- 所有代码改动在 `src/lib/workflow/` 下
- 模板改动在 `.claude-workflows/templates/` 下
- meta.termination_state 需要增加 2 个新字段
- json-parser.ts 的新方法需要兼容旧格式（向后兼容）
