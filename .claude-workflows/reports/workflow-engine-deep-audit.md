# Workflow Engine 深度审计报告

- **审计范围**: `src/lib/workflow/` 全部 12 个源文件 + 4 模板 + 3 Schema
- **代码总量**: ~4200 行 TypeScript
- **审计日期**: 2026-03-21
- **审计轮次**: 3 轮逐行审查
- **关联报告**: `20260321-15c8bb-review-analysis.md`（Codex 对抗审查原始报告）

---

## 问题总览

| 等级 | 数量 | 说明 |
|------|------|------|
| Critical（已知缺陷） | 4 | 第一轮评估发现，影响核心流程 |
| High | 6 | 第二、三轮深入发现，必须修复 |
| Medium | 9 | 需要修复但不阻断主流程 |
| Low | 5 | 改进项，择机处理 |
| 元问题 | 1 | Spec-Code 系统性断裂（跨 4 处） |
| **合计** | **25** | |

---

## 批次规划建议

| 批次 | 范围 | 预计工作量 |
|------|------|-----------|
| **P0** | 缺陷 1-4 + H-NEW-5 | 核心流程修复 + 测试基础设施 |
| **P1** | H-NEW-1~4, H-NEW-6 + 元问题 | 安全网补全 + Spec-Code 对齐 |
| **P2** | M-NEW-1~9 | 边界case + 配置治理 |
| **P3** | L-NEW-1~5 | 代码健壮性改进 |

---

## P0 — 核心流程修复（4 个已知缺陷 + 测试基础）

### 缺陷 1：Claude parse 失败后静默空转（最致命）

- **文件**: `workflow-engine.ts` 第 582-589 行
- **现状**:
  ```typescript
  const claudeOutput = this.jsonParser.parse<ClaudeDecisionOutput>(claudeRaw);
  if (!claudeOutput) {
    await this.emit(runId, round, 'claude_parse_error', { ... });
    // ⚠️ 没有 return！继续执行，但 decisions=undefined, patches=null
    // 结果：整轮什么都没改，却正常进入下一轮
  }
  ```
- **根因**: parse 失败后无 return/throw，后续 `claudeOutput?.decisions` 和 `claudeOutput?.resolves_issues` 全部跳过，整轮空壳执行
- **危害**: 这就是 "3 轮 0 修复" 的代码层根因
- **修复方案**:
  1. 在 engine 中增加 `consecutiveParseFailures` 计数器
  2. parse 失败时 `consecutiveParseFailures++`
  3. 连续 N 次（建议 N=2）parse 失败 → `pause_for_human`
  4. parse 成功时重置计数器
- **验收标准**: Claude parse 失败连续 2 次后工作流暂停，不再空转消耗 API 调用

---

### 缺陷 2：max_rounds 在 pre_termination（B2）提前截断

- **文件**: `termination-judge.ts` 第 144-157 行；`workflow-engine.ts` 第 453-471 行
- **现状**: `pre_termination` 中调用 `judge()`，`max_rounds` 检查在 Claude 决策之前触发
- **场景还原**:
  ```
  R3: Codex 审查完成（发现 6 个新 issue）
      → B2 pre_termination: round(3) >= max_rounds(3) → 直接终止
      → Claude 决策从未执行
      → 6 个 issue 永远停留在 open
  ```
- **危害**: 浪费了最后一轮 Codex API 调用（花了钱审查，结果审完就扔了）
- **修复方案**: 两种选择（二选一）
  - **方案 A**: 把 `max_rounds` 检查从 `pre_termination` 移到 `post_decision`，让最后一轮的 Claude 决策有机会执行
  - **方案 B**: 在 `TerminationJudge.judge()` 中，当 `max_rounds` 触发时返回一个特殊的 `action: 'terminate_after_decision'`，engine 据此跳过终止、继续执行 Claude 决策，然后在 `post_decision` 终止
- **推荐**: 方案 A（更简单）
- **验收标准**: 最后一轮 Codex 发现的 issue 能被 Claude 处理后再终止

---

### 缺陷 3：没有"零进展"安全网

- **文件**: `workflow-engine.ts` 全局（缺少逻辑）
- **现状**: 工作流没有检测"连续 N 轮 accepted=0, resolved=0"的逻辑
- **危害**: 如果 Claude 步骤持续 parse 失败或输出无效决策，工作流跑满 max_rounds 轮才停，每轮都是完整的 Codex + Claude 调用，全是浪费
- **修复方案**:
  1. 在 `post_decision` 步骤中，统计本轮的 `accepted + resolved` 数量
  2. 如果为 0，`zeroProgressRounds++`
  3. 连续 2 轮零进展 → `pause_for_human`
  4. 有进展时重置计数器
  5. `zeroProgressRounds` 需要持久化到 meta 中（支持 resume）
- **验收标准**: 连续 2 轮零进展后工作流暂停

---

### 缺陷 4：TimeoutError 处理破坏终止条件

- **文件**: `workflow-engine.ts` 第 334-335 行（Codex timeout）、第 557 行（Claude timeout）
- **现状**:
  ```typescript
  if (err instanceof TimeoutError) {
    round++;
    previousRoundHadNewHighCritical = true;  // ← 强制重置
    continue;
  }
  ```
- **危害**: `previousRoundHadNewHighCritical = true` 让"连续 2 轮无新高危"的终止条件永远无法触发。一个 timeout 就能把安全网打穿
- **修复方案**: timeout 时不应该设为 `true`，应该保持原值不变（timeout 轮不算有效轮次，不应该影响计数器）
  ```typescript
  // 修改为：
  // previousRoundHadNewHighCritical 保持不变（不修改）
  // 或者改为: isSkippedRound = true 传给下一轮的 judge()
  ```
- **验收标准**: timeout 后"连续无高危"终止条件不被重置

---

### H-NEW-5：测试覆盖为零

- **文件**: `src/lib/workflow/` 目录下无任何 `.test.ts` 或 `.spec.ts`
- **现状**: 12 个源文件、~4200 行 TypeScript 代码没有一个测试
- **危害**:
  - 上面所有缺陷在提交时没有任何自动化手段能拦截
  - 任何修复也无法验证正确性
  - 未来重构必然引入回归
- **修复方案**: 建立测试基础设施，至少覆盖以下核心模块：
  1. `termination-judge.test.ts` — 5 个终止条件的单元测试
  2. `json-parser.test.ts` — 4 层 parse 策略 + extractPatches
  3. `issue-matcher.test.ts` — 去重逻辑 + 幂等性
  4. `patch-applier.test.ts` — heading 匹配 + 替换 + append
  5. `workflow-engine.test.ts` — 核心流程集成测试（mock model invoker）
- **验收标准**: 关键模块有单元测试，CI 可以跑

---

## P1 — 安全网补全 + Spec-Code 对齐

### H-NEW-1：Codex parse 失败的 fallback 伪造 LGTM

- **文件**: `workflow-engine.ts` 第 362-373 行、第 997-1004 行、第 1008-1013 行
- **现状**: 三处 fallback 全部使用 `overall_assessment: 'lgtm'`
  ```typescript
  codexOutput = {
    findings: [],
    overall_assessment: 'lgtm',  // ← 危险
    summary: 'Failed to parse Codex output',
  };
  ```
- **危害链**: Codex 实际发现了问题 → 输出格式不对 → parse 失败 → fallback 为 lgtm + findings:[] → TerminationJudge Check 1 看到 LGTM + 无 open issues → 直接终止，所有问题丢失
- **修复方案**: 三处 fallback 统一改为保守策略
  ```typescript
  codexOutput = {
    findings: [],
    overall_assessment: 'major_issues',  // 保守：假设有问题
    summary: 'Failed to parse Codex output — treating as major_issues for safety',
  };
  ```
- **验收标准**: Codex 输出 parse 失败后不会触发 LGTM 终止

---

### H-NEW-2：accept_and_resolve 绕过 hasPatchFailure 检查

- **文件**: `workflow-engine.ts` 第 600-614 行 vs 第 669-681 行
- **现状**:
  ```typescript
  // decisions 处理阶段 —— 不受 hasPatchFailure 保护
  case 'accept_and_resolve':
    issue.status = 'resolved';     // ← 即使 patch 失败也执行
    break;

  // resolves_issues 处理阶段 —— 有保护
  if (hasPatchFailure) {
    // 阻止 resolve
  }
  ```
- **危害**: Spec H3 声称修复了 "Patch-Resolve 一致性"，但 `accept_and_resolve` 路径完全绕过了检查。文档未改但 issue 被标记为 resolved
- **修复方案**: 在 decisions 处理中，`accept_and_resolve` 也要检查 `hasPatchFailure`
  ```typescript
  case 'accept_and_resolve':
    // accept_and_resolve 用于"无需 patch 的 resolve"
    // 但如果本轮有 patch 失败，降级为 accepted（不自动 resolve）
    if (hasPatchFailure) {
      issue.status = 'accepted';
    } else {
      issue.status = 'resolved';
      issue.resolved_in_round = round;
    }
    break;
  ```
  注意：`hasPatchFailure` 在 decisions 处理之后才计算（因为 patch 在 decisions 之后 apply）。需要调整执行顺序：先 apply patches → 计算 hasPatchFailure → 再处理 decisions 中的 status 变更。或者拆成两步：先记录 decisions，patch 之后再 resolve。
- **验收标准**: 当 patch 部分失败时，`accept_and_resolve` 不会将 issue 标记为 resolved

---

### H-NEW-3：ContextCompressor 收到空 rounds 数组

- **文件**: `pack-builder.ts` 第 346 行
- **现状**:
  ```typescript
  const result = this.compressor.compress({
    spec, plan, ledger,
    rounds: [], // Rounds data would be loaded async; empty for now  ← TODO遗留
    currentRound: round,
    windowTokens,
  });
  ```
- **危害**: "保留最后一轮、丢弃中间轮" 的压缩策略完全不工作。压缩输出只有 spec+plan+ledger summary，没有 round 历史数据
- **修复方案**: 在 `tryCompress` 中异步加载 rounds 数据
  ```typescript
  private async tryCompress(...) {
    // ...
    const rounds: RoundData[] = [];
    for (let r = 1; r < round; r++) {
      const packJson = await this.store.loadRoundArtifact(runId, r, 'pack.json');
      const codexOutput = await this.store.loadRoundArtifact(runId, r, 'codex-review.md');
      const claudeDecision = await this.store.loadRoundArtifact(runId, r, 'claude-raw.md');
      rounds.push({ round: r, packJson, codexOutput, claudeDecision });
    }
    // 传给 compressor
  }
  ```
  注意：`tryCompress` 需要改为 async，`buildSpecReviewPack` 需要传入 `runId`
- **验收标准**: round >= 4 时，压缩输出包含最后一轮的完整数据

---

### H-NEW-4：DecisionValidator 只在 Spec 中定义，代码不存在

- **文件**: 缺失 `decision-validator.ts`
- **现状**: `workflow-engine.ts` 中处理 decisions（第 595-623 行）没有任何 runtime 校验
  - `issue_id` 指向不存在的 issue → 静默 `continue`
  - 同一个 `issue_id` 出现多次 → 后者覆盖前者
  - `action` 值不在枚举内 → switch 无 default，隐式空操作
- **修复方案**: 新建 `decision-validator.ts`，实现以下 5 项校验：
  1. `issue_id` 是否存在于 ledger 中
  2. `issue_id` 是否重复（同一轮 decisions 中出现多次）
  3. `action` 是否为合法的 DecisionAction 值
  4. `resolves_issues` 中的 ID 是否都有对应的 accept/accept_and_resolve decision
  5. decision 数量是否合理（不超过 findings 数量的 2 倍）
- **调用位置**: 在 `claudeOutput.decisions` 处理之前调用
- **验收标准**: 非法 decisions 被拦截并记录事件日志，不静默忽略

---

### H-NEW-6：JSON Schema 存在但未被 runtime 使用

- **文件**: `.claude-workflows/schemas/` 下 3 个 schema 文件
- **现状**: `workflow-store.ts` 读写 JSON 时全部 `JSON.parse() as T`，零 schema 校验
- **修复方案**: 两种选择
  - **方案 A**（推荐）: 使用 `ajv` 在 `loadLedger`、`getMeta`、`loadEvents` 中做 runtime 校验，失败时 emit 告警事件但不 throw（向后兼容）
  - **方案 B**: 删除 schema 文件，避免给人"有校验"的假象
- **验收标准**: 不合法的 JSON 数据被检测到

---

### 元问题：Spec-Code 系统性断裂（4 处）

- **本质**: Codex 审查报告声称 13 项全部 ✅ 已修复，但至少 4 项只修了 Spec 文档没修代码
- **涉及项**:

| 报告项 | Spec 声称修复 | 代码实际状态 |
|--------|-------------|-------------|
| H6 DecisionValidator | Spec §6.11 新增 5 项校验 | ❌ 文件不存在 |
| H7 `last_processed_round` | Spec §4/§6.9 增加字段 | ❌ Issue 类型中无此字段 |
| H3 Patch-Resolve 一致性 | Spec §6.10 增加规则 | ❌ `accept_and_resolve` 路径绕过 |
| M1 `auto_terminate` 配置 | Spec §4.5/§9 统一到 config | ❌ 代码中未检查 |

- **修复方案**: 对每个声称修复的项目，逐一检查代码是否实现。此问题在 H-NEW-2、H-NEW-4 和 M-NEW-3 中分别处理

---

## P2 — 边界 Case + 配置治理

### M-NEW-1：pause() 与 saveCheckpoint() 竞态

- **文件**: `workflow-engine.ts` 第 197-209 行；`workflow-store.ts` 第 79-94 行
- **现状**: `updateMeta` 是 read-merge-write（非原子操作）。`pause()` 和 `runLoop` 的 catch 块可能并发调用 `updateMeta`，导致 lost update
- **修复方案**:
  - 方案 A: 在 `pause()` 中 await runLoop 完成后再写 meta（但需要改为 pause 只设 flag、loop 自行退出的模式）
  - 方案 B: 给 `updateMeta` 加文件锁（`proper-lockfile` 或自实现）
  - 方案 C（简单）: `pause()` 只调用 `abort()`，不调用 `updateMeta`。让 runLoop 的 AbortError handler 负责所有 meta 更新
- **推荐**: 方案 C
- **验收标准**: pause 后 meta.json 的 current_step 准确

---

### M-NEW-2：ndjson loadEvents 无单行容错

- **文件**: `workflow-store.ts` 第 241-246 行
- **现状**:
  ```typescript
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    events.push(JSON.parse(trimmed) as WorkflowEvent);  // ← 无 try-catch
  }
  ```
- **危害**: 一行损坏的 JSON（崩溃时 appendFile 写入不完整）→ 整个 loadEvents 抛异常 → resume 失败
- **修复方案**:
  ```typescript
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as WorkflowEvent);
    } catch {
      console.warn(`[WorkflowStore] Skipping corrupt event line: ${trimmed.substring(0, 100)}`);
    }
  }
  ```
- **验收标准**: 损坏的事件行被跳过而非导致整个 load 失败

---

### M-NEW-3：auto_terminate 配置字段未使用

- **文件**: `types.ts` 第 270 行（声明）；`workflow-engine.ts`（无使用）
- **现状**: `auto_terminate: false` 不会产生任何效果，工作流总是自动终止
- **修复方案**: 在 `terminateWorkflow` 方法开头检查
  ```typescript
  if (!config.auto_terminate) {
    // 不自动终止，改为 pause_for_human
    await this.pauseForHuman(runId, round, { reason, action: 'pause_for_human', details: '...' });
    return;
  }
  ```
- **验收标准**: `auto_terminate: false` 时，终止条件触发后暂停而非直接终止

---

### M-NEW-4：PatchApplier case-sensitive heading 匹配

- **文件**: `patch-applier.ts` 第 88-89 行
- **现状**:
  ```typescript
  const match = docSections.find(
    (ds) => ds.level === ps.level && ds.heading.trim() === ps.heading.trim(),
  );
  ```
  大小写严格匹配。Claude 生成的 patch heading "## architecture" 无法匹配原文 "## Architecture"
- **修复方案**:
  ```typescript
  const match = docSections.find(
    (ds) => ds.level === ps.level &&
            ds.heading.trim().toLowerCase() === ps.heading.trim().toLowerCase(),
  );
  ```
- **验收标准**: heading 大小写不一致时仍能正确匹配替换

---

### M-NEW-5：decisions 处理中 switch 无 default 分支

- **文件**: `workflow-engine.ts` 第 600-614 行
- **现状**: 如果 `decision.action` 是非法值（如拼写错误 "acccept"），switch 不匹配任何 case，但 issue.decided_by 和 issue.decision_reason 仍然被设置（第 615-616 行）
- **修复方案**:
  ```typescript
  default:
    console.warn(
      `[WorkflowEngine] Unknown decision action '${decision.action}' for issue ${decision.issue_id}. Skipping.`
    );
    await this.emit(runId, round, 'claude_parse_error', {
      round, issue_id: decision.issue_id,
      unknown_action: decision.action,
    });
    continue; // 跳过 decided_by/decision_reason 的设置
  ```
- **验收标准**: 非法 action 不会修改 issue 的 decided_by

---

### M-NEW-6：resolves_issues 只处理 status=accepted 的 issue

- **文件**: `workflow-engine.ts` 第 683-696 行
- **现状**:
  ```typescript
  const issue = ledger.issues.find(
    (i) => i.id === issueId && i.status === 'accepted',
  );
  ```
  只查找 `accepted` 状态的 issue。如果 Claude 在 resolves_issues 中列出了 `open` 状态的 issue，请求被静默忽略
- **修复方案**: 扩展状态匹配范围
  ```typescript
  const issue = ledger.issues.find(
    (i) => i.id === issueId && (i.status === 'accepted' || i.status === 'open'),
  );
  ```
  或者在找不到时 emit 一个告警事件
- **验收标准**: resolves_issues 中引用的非 accepted issue 至少产生一条告警日志

---

### M-NEW-7：Schema 默认值与 DEFAULT_CONFIG 不一致

- **文件**: `.claude-workflows/schemas/meta.schema.json` vs `types.ts`
- **现状**:

| 配置项 | Schema 默认值 | DEFAULT_CONFIG | 差距 |
|--------|-------------|----------------|------|
| `codex_timeout_ms` | 180,000 (3 分钟) | 5,400,000 (90 分钟) | 30 倍 |
| `claude_timeout_ms` | 120,000 (2 分钟) | 5,400,000 (90 分钟) | 45 倍 |
| `codex_context_window_tokens` | 128,000 | 1,000,000 | 8 倍 |

- **修复方案**: 统一为代码中的 DEFAULT_CONFIG 值（代码是真实运行的，schema 是文档）
- **验收标准**: schema 和 DEFAULT_CONFIG 的所有默认值一致

---

### M-NEW-8：human_review_on_deadlock 字段未使用

- **文件**: `types.ts` 第 273 行；`termination-judge.ts` 第 80-93 行
- **现状**: deadlock 检测永远返回 `pause_for_human`，不检查 `human_review_on_deadlock` 配置
- **修复方案**: 在 TerminationJudge 中注入 config，检查该字段
  ```typescript
  if (deadlockedIssues.length > 0) {
    if (config.human_review_on_deadlock) {
      return { reason: 'deadlock_detected', action: 'pause_for_human', ... };
    } else {
      return { reason: 'deadlock_detected', action: 'terminate', ... };
    }
  }
  ```
  需要给 `judge()` 的 ctx 参数添加 `config` 字段（已有）
- **验收标准**: `human_review_on_deadlock: false` 时 deadlock 直接终止而非暂停

---

### M-NEW-9：last_completed 语义偏差

- **文件**: `workflow-engine.ts` 第 791 行、第 892 行
- **现状**: `last_completed` 只在 post_decision 和 terminateWorkflow 中写入，中间步骤（issue_matching、pre_termination、claude_decision）完成后不更新
- **语义问题**: 字段名叫 "last_completed"（暗示最后完成的步骤），但实际含义是"最后完成的完整轮次"
- **修复方案**: 两种选择
  - **方案 A**: 每个步骤完成后都更新 `last_completed`，使其语义与名称一致
  - **方案 B**: 重命名为 `last_completed_round`，明确语义（最小改动）
- **推荐**: 方案 B（改名不影响逻辑，减少回归风险）
- **验收标准**: 字段名和实际行为语义一致

---

## P3 — 代码健壮性改进

### L-NEW-1：spec/plan 版本号不在 meta 中跟踪

- **文件**: `workflow-store.ts`（saveSpec/loadSpec）；`types.ts`（WorkflowMeta）
- **现状**: 版本号靠 `findLatestVersion` 扫描文件系统确定，meta 中没有 `spec_version` / `plan_version` 字段
- **修复方案**: 在 WorkflowMeta 中增加 `spec_version: number` 和 `plan_version: number`，每次 saveSpec/savePlan 后同步更新
- **验收标准**: meta.json 中能看到当前 spec/plan 版本号

---

### L-NEW-2：round_rejected 语义不准确

- **文件**: `pack-builder.ts` 第 246-254 行
- **现状**: `round_rejected: issue.round` 用的是 issue 首次提出的 round，不是被拒绝的 round
- **修复方案**:
  - 在 Issue 类型中增加 `rejected_in_round?: number` 字段
  - 在 decisions 处理的 `reject` 分支中赋值
  - `buildRejectedIssues` 使用 `rejected_in_round`
- **验收标准**: rejected issue summary 中的 round 是被拒绝的轮次

---

### L-NEW-3：HEADING_PATTERN 是全局状态正则

- **文件**: `patch-applier.ts` 第 42 行
- **现状**: `const HEADING_PATTERN = /^(#{1,4})\s+(.+)$/gm;` 是模块级全局正则（有 `g` flag）。虽然 `parseSections` 中有 `lastIndex = 0` 重置，但未来并发调用风险
- **修复方案**: 在 `parseSections` 函数内部创建新的正则实例
  ```typescript
  function parseSections(doc: string): Section[] {
    const headingPattern = /^(#{1,4})\s+(.+)$/gm;
    // ...
  }
  ```
- **验收标准**: 正则不再是全局共享状态

---

### L-NEW-4：Run ID 碰撞风险

- **文件**: `workflow-engine.ts` 第 51-59 行
- **现状**: `Math.random().toString(16).slice(2, 8)` 生成 6 位 hex 随机后缀（~1677 万种可能）。碰撞时 `createRun` 覆盖已有 run
- **修复方案**:
  ```typescript
  import { randomUUID } from 'node:crypto';
  function generateRunId(): string {
    const datePrefix = ...;
    return `${datePrefix}-${randomUUID().slice(0, 8)}`;
  }
  ```
  或者在 `createRun` 前检查目录是否已存在
- **验收标准**: run ID 碰撞概率降低到可忽略

---

### L-NEW-5：Claude Agent SDK non-result 消息被静默忽略

- **文件**: `model-invoker.ts` 第 483-508 行
- **现状**: `for await` 循环只处理 `type === 'result'`，其他 SDK 消息类型被 continue 跳过
- **修复方案**: 对非 result 消息记录 debug 日志
  ```typescript
  if (m.type !== 'result') {
    console.debug(`[ModelInvoker] Claude SDK message: type=${m.type}`);
    continue;
  }
  ```
- **验收标准**: 非 result 消息至少有 debug 级别日志

---

## 附录：审计覆盖的文件清单

| # | 文件 | 行数 | 角色 |
|---|------|------|------|
| 1 | `workflow-engine.ts` | 1056 | 核心引擎 |
| 2 | `termination-judge.ts` | 180 | 终止判断 |
| 3 | `json-parser.ts` | 257 | JSON 解析 |
| 4 | `issue-matcher.ts` | 235 | Issue 去重 |
| 5 | `patch-applier.ts` | 199 | 补丁应用 |
| 6 | `model-invoker.ts` | 580 | 模型调用 |
| 7 | `workflow-store.ts` | 317 | 持久化 |
| 8 | `pack-builder.ts` | 401 | 包构建 |
| 9 | `context-compressor.ts` | 220 | 上下文压缩 |
| 10 | `prompt-assembler.ts` | 239 | 提示汇编 |
| 11 | `types.ts` | 526 | 类型定义 |
| 12 | `cli.ts` | 130 | CLI 入口 |
| 13 | `index.ts` | 61 | 公共 API |
| — | 4 模板 + 3 Schema | — | 配置/模板 |
