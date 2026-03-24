# 工作流引擎规范

> 适用于 `src/lib/workflow/`。本模块实现 Codex + Claude 的双模型多轮评审引擎，负责回合编排、状态持久化、问题账本、上下文压缩、补丁应用和最终报告产出。

---

## 1. 模块概览

### 1.1 责任边界

- `src/lib/workflow/` 是独立于 `src/lib/bridge/` 的后端子系统。
- 工作流引擎自己维护状态机、持久化目录、事件日志、模板装配、模型调用和终止判定。
- bridge 层只负责启动、恢复、停止和把事件转发到聊天界面，不直接改工作流内部状态。

真实入口示例：

```ts
// src/lib/workflow/index.ts
export function createSpecReviewEngine(basePath?: string): _WorkflowEngine {
  const store = new _WorkflowStore(basePath);
  const compressor = new _ContextCompressor();
  const packBuilder = new _PackBuilder(store, compressor);
  const promptAssembler = new _PromptAssembler(store);
  const modelInvoker = new _ModelInvoker();
  const terminationJudge = new _TerminationJudge();
  const jsonParser = new _JsonParser();
  const issueMatcher = new _IssueMatcher();
  const patchApplier = new _PatchApplier();
  const decisionValidator = new _DecisionValidator();

  return new _WorkflowEngine(
    store, packBuilder, promptAssembler, modelInvoker,
    terminationJudge, jsonParser, issueMatcher, patchApplier,
    decisionValidator,
  );
}
```

bridge 侧接入示例：

```ts
// src/lib/bridge/internal/workflow-command.ts
const engine = createCodeReviewEngine(basePath);

await engine.start({
  spec: '',
  plan: '',
  contextFiles,
  config: configOverrides,
  profile: CODE_REVIEW_PROFILE,
  snapshot,
});
```

约束：

- bridge 可以在 `resume/status` 这类边界查询场景读取 `WorkflowStore`，但不应自己改写 ledger、round artifact 或补丁语义。
- 新接入点优先调用 `createSpecReviewEngine()` 或 `createCodeReviewEngine()`，不要手写依赖接线。

### 1.2 运行模式

- `spec-review`：审查 spec/plan，Claude 可以回写文档补丁。
- `code-review`：审查 git diff 和快照文件，Claude 只做裁决，不自动改源码。
- `dev`：`WorkflowType` 中保留该值，但当前 `resolveProfileFromType()` 仍回落到 `SPEC_REVIEW_PROFILE`；如果未来真要支持 dev 工作流，必须新增独立 profile 和路由。

### 1.3 CLI 与宿主触发

CLI 示例：

```ts
// src/lib/workflow/cli.ts
if (resumeRunId) {
  await engine.resume(resumeRunId);
} else {
  runId = await engine.start({
    spec,
    plan,
    config: config as Partial<import('./types.js').WorkflowConfig> | undefined,
    contextFiles,
  });
}
```

结论：

- `src/lib/workflow/cli.ts` 是纯命令行入口。
- `src/lib/bridge/internal/workflow-command.ts` 是 IM/bridge 宿主入口。
- 两个入口最终都收束到同一个 `WorkflowEngine` 实例模型。

---

## 2. 签名与存储契约

### 2.1 公共签名

```ts
// src/lib/workflow/workflow-engine.ts
async start(params: {
  spec: string;
  plan: string;
  config?: Partial<WorkflowConfig>;
  contextFiles?: ContextFile[];
  profile?: WorkflowProfile;
  snapshot?: import('./types.js').ReviewSnapshot;
}): Promise<string>

async resume(runId: string, profile?: WorkflowProfile): Promise<void>

async pause(runId: string): Promise<void>
```

实现约束：

- `start()` 负责创建 run 目录、初始 `meta.json`、`spec-v1.md`、`plan-v1.md`、`issue-ledger.json`，然后才进入 `runLoop()`。
- `resume()` 必须先读持久化 `meta.workflow_type`，再恢复 profile。
- `pause()` 是“可恢复停止”，不是强制终止；它通过 `AbortController` 触发当前步骤保存检查点。

### 2.2 Profile 契约

```ts
// src/lib/workflow/types.ts
export interface WorkflowProfile {
  type: WorkflowType;
  steps: WorkflowStep[];
  configOverrides: Partial<WorkflowConfig>;
  templates: {
    review: string;
    decision: string;
    decisionSystem: string;
  };
  behavior: {
    claudeIncludesPreviousDecisions: boolean;
    applyPatches: boolean;
    trackResolvesIssues: boolean;
    requireFixInstruction: boolean;
    acceptedIsTerminal: boolean;
  };
}
```

必须遵守：

- 新工作流类型先定义 `WorkflowProfile`，再接 pack builder、prompt assembler 和 resume 路由。
- 不要只加 `WorkflowType` 联合值而不补 `resolveProfileFromType()`。

### 2.3 文件持久化契约

真实目录来自 `src/lib/workflow/workflow-store.ts`：

```text
.claude-workflows/
├── templates/
├── schemas/
└── runs/
    └── {run-id}/
        ├── meta.json
        ├── spec-v1.md
        ├── plan-v1.md
        ├── issue-ledger.json
        ├── snapshot.json
        ├── events.ndjson
        ├── code-review-report.md
        ├── code-review-report.json
        └── rounds/
            ├── R1-pack.json
            ├── R1-codex-review.md
            ├── R1-claude-input.md
            └── R1-claude-raw.md
```

关键约束：

- 所有持久化都必须走 `WorkflowStore`。
- `spec` 和 `plan` 是版本化文件，不能覆盖原文件名。
- 事件日志是 `ndjson` 追加写，不要改成覆盖写。
- 模板必须放在 `{basePath}/templates/`；`loadTemplate()` 找不到时直接抛错，不静默降级。

### 2.4 事件契约

```ts
// src/lib/workflow/types.ts
export interface WorkflowEvent {
  timestamp: string;
  run_id: string;
  round: number;
  event_type: WorkflowEventType;
  data: Record<string, unknown>;
}
```

真实事件类型示例：

```ts
// src/lib/workflow/types.ts
export type WorkflowEventType =
  | 'workflow_started' | 'round_started'
  | 'codex_review_started' | 'codex_review_completed'
  | 'claude_decision_started' | 'claude_decision_completed'
  | 'issue_created' | 'issue_status_changed'
  | 'termination_triggered' | 'human_review_requested'
  | 'workflow_completed' | 'workflow_failed' | 'workflow_resumed';
```

---

## 3. 架构

### 3.1 5 步状态机

```ts
// src/lib/workflow/types.ts
export type WorkflowStep =
  | 'codex_review'
  | 'issue_matching'
  | 'pre_termination'
  | 'claude_decision'
  | 'post_decision';
```

```ts
// src/lib/workflow/workflow-engine.ts
// Step ordering per round:
//   codex_review -> issue_matching -> pre_termination -> claude_decision -> post_decision
```

每一步的真实职责：

1. `codex_review`
   从 `PackBuilder` 取上下文包，`PromptAssembler` 渲染 prompt，`ModelInvoker.invokeCodex()` 调模型。
2. `issue_matching`
   用 `IssueMatcher.processFindings()` 把本轮 finding 合并进 ledger。
3. `pre_termination`
   在 Claude 决策前先做一次终止判断，避免无意义调用。
4. `claude_decision`
   解析 Claude JSON、校验 decision、更新 issue 状态、按需应用补丁。
5. `post_decision`
   再次判定是否结束，并推进到下一轮或完成。

### 3.2 崩溃安全恢复

`WorkflowEngine` 顶部注释已经明确写出写入顺序：

```ts
// src/lib/workflow/workflow-engine.ts
// Key design decisions:
// - Crash-safe resume: each step persists its output before advancing
// - Write ordering: raw output -> ledger -> spec/plan -> checkpoint event -> meta
```

真实写入顺序示例：

```ts
// src/lib/workflow/workflow-engine.ts
await this.store.saveRoundArtifact(runId, round, 'codex-review.md', codexRaw);
await this.store.saveLedger(runId, ledger);
await this.store.saveSpec(runId, result.merged);
await this.store.updateMeta(runId, { current_step: 'post_decision' });
```

暂停检查点示例：

```ts
// src/lib/workflow/workflow-engine.ts
private async saveCheckpoint(runId: string, round: number, step: WorkflowStep): Promise<void> {
  await this.store.updateMeta(runId, {
    status: 'paused',
    current_round: round,
    current_step: step,
  });
}
```

恢复约束：

- `resume()` 只允许从 `paused`、`failed`、`human_review` 恢复。
- 中途恢复时，`runLoop()` 会重新加载 `codex-review.md`、ledger、snapshot 等中间产物，而不是重跑已完成步骤。
- `WorkflowStore.loadEvents()` 会跳过损坏的 ndjson 行，保证异常退出后仍能恢复：

```ts
// src/lib/workflow/workflow-store.ts
try {
  events.push(JSON.parse(trimmed) as WorkflowEvent);
} catch {
  console.warn(`[WorkflowStore] Skipping corrupt event line: ${trimmed.substring(0, 120)}`);
}
```

### 3.3 文件化持久化模型

`WorkflowStore` 是唯一存储抽象：

```ts
// src/lib/workflow/workflow-store.ts
async saveSpec(runId: string, content: string, version?: number): Promise<number>
async savePlan(runId: string, content: string, version?: number): Promise<number>
async saveLedger(runId: string, ledger: IssueLedger): Promise<void>
async saveRoundArtifact(runId: string, round: number, name: string, content: string): Promise<void>
async appendEvent(event: WorkflowEvent): Promise<void>
```

工程要求：

- engine、report generator、prompt assembler 都只能通过 `WorkflowStore` 读写运行产物。
- 任何“顺手 `fs.readFile` / `fs.writeFile` 一下”的实现都会破坏恢复一致性。

### 3.4 追加式可观测性

事件发射顺序是“先落盘，再通知监听器”：

```ts
// src/lib/workflow/workflow-engine.ts
await this.store.appendEvent(event);

const callbacks = this.listeners.get(eventType);
if (callbacks) {
  for (const cb of callbacks) {
    try {
      cb(event);
    } catch {
      // swallow
    }
  }
}
```

这保证了：

- bridge/UI 监听器挂掉不会影响主流程。
- `events.ndjson` 可以作为审计和进度展示的事实来源；当前核心恢复仍以 `meta.json`、ledger 和 round artifact 为准。

### 3.5 冻结快照模式

这是 code-review 相比 spec-review 新增的关键模式。

```ts
// src/lib/workflow/types.ts
export interface ReviewSnapshot {
  created_at: string;
  head_commit: string;
  base_ref: string;
  scope: ReviewScope;
  diff: string;
  files: SnapshotFile[];
  changed_files: ChangedFile[];
  excluded_files: Array<{ path: string; reason: string }>;
}
```

```ts
// src/lib/workflow/diff-reader.ts
// Key invariant (INV-4): all file content is retrieved via `git show <blob_sha>`,
// never via `fs.readFile`.
```

必须遵守：

- code-review 只能审 `ReviewSnapshot` 中冻结下来的 diff 和文件内容。
- 暂停后恢复不能重新读工作树文件，否则会把用户后续修改混进旧 run。

---

## 4. 关键模式

### 4.1 Profile 驱动行为

真实 profile：

```ts
// src/lib/workflow/types.ts
export const SPEC_REVIEW_PROFILE: WorkflowProfile = {
  type: 'spec-review',
  steps: ['codex_review', 'issue_matching', 'pre_termination', 'claude_decision', 'post_decision'],
  configOverrides: {},
  templates: {
    review: 'spec-review-pack.md',
    decision: 'claude-decision.md',
    decisionSystem: 'claude-decision-system.md',
  },
  behavior: {
    claudeIncludesPreviousDecisions: true,
    applyPatches: true,
    trackResolvesIssues: true,
    requireFixInstruction: false,
    acceptedIsTerminal: false,
  },
};

export const CODE_REVIEW_PROFILE: WorkflowProfile = {
  type: 'code-review',
  steps: ['codex_review', 'issue_matching', 'pre_termination', 'claude_decision', 'post_decision'],
  configOverrides: { max_rounds: 3 },
  templates: {
    review: 'code-review-pack.md',
    decision: 'code-review-decision.md',
    decisionSystem: 'code-review-decision-system.md',
  },
  behavior: {
    claudeIncludesPreviousDecisions: false,
    applyPatches: false,
    trackResolvesIssues: false,
    requireFixInstruction: true,
    acceptedIsTerminal: true,
  },
};
```

实际效果：

- `applyPatches` 决定 Step C 是否进入 `PatchApplier`。
- `trackResolvesIssues` 决定 `DecisionValidator` 和 ledger 是否处理 `resolves_issues`。
- `requireFixInstruction` 决定 code-review 中 `accept` 是否必须携带 `fix_instruction`。
- `acceptedIsTerminal` 直接影响 `TerminationJudge` 对 unresolved 的定义。

现实注意点：

- `claudeIncludesPreviousDecisions` 现在主要是 profile 语义契约；真正的“累积上下文 vs fresh context”由 `buildClaudeDecisionInput()` 与 `buildClaudeCodeReviewInput()` 的不同路由实现。
- 新增工作流时，不要只改 behavior flag，还要补 builder / prompt 路由。

### 4.2 工厂函数而不是外部手动装配

```ts
// src/lib/workflow/index.ts
export function createCodeReviewEngine(basePath?: string): _WorkflowEngine {
  const store = new _WorkflowStore(basePath);
  const compressor = new _ContextCompressor();
  const packBuilder = new _PackBuilder(store, compressor);
  const promptAssembler = new _PromptAssembler(store);
  const modelInvoker = new _ModelInvoker();
  const terminationJudge = new _TerminationJudge();
  const jsonParser = new _JsonParser();
  const issueMatcher = new _IssueMatcher();
  const patchApplier = new _PatchApplier();
  const decisionValidator = new _DecisionValidator();
  return new _WorkflowEngine(...);
}
```

要求：

- 外部调用者只拿工厂，不直接拼 9 个依赖。
- 测试如果要定向替换 `ModelInvoker`，可以像 `workflow-engine.test.ts` 那样自己组装，但那属于测试专用模式。

### 4.3 Pack 装配与模板渲染

Spec-review pack：

```ts
// src/lib/workflow/pack-builder.ts
const unresolvedIssues = this.filterUnresolvedIssues(ledger.issues);
const rejectedIssues = this.buildRejectedIssues(ledger.issues);
const resolvedIssues = this.buildResolvedIssues(ledger.issues);
const acceptedIssues = this.buildAcceptedIssues(ledger.issues);

return {
  spec: compressed.spec,
  plan: compressed.plan,
  unresolved_issues: unresolvedIssues,
  rejected_issues: rejectedIssues,
  resolved_issues: resolvedIssues,
  accepted_issues: acceptedIssues,
  context_files: contextFiles,
  round_summary: roundSummary,
  round,
};
```

模板渲染：

```ts
// src/lib/workflow/prompt-assembler.ts
const template = await this.store.loadTemplate(SPEC_REVIEW_TEMPLATE);

// 单次替换 — 不允许级联展开
return this.replaceAllPlaceholders(template, {
  spec: pack.spec,
  plan: pack.plan,
  unresolved_issues: this.renderUnresolvedIssues(pack.unresolved_issues),
  // ...
});
```

要求：

- `PackBuilder` 负责结构化数据，`PromptAssembler` 只负责模板替换。
- 不要在 engine 里直接拼长 prompt 字符串。
- `accepted_issues`、`resolved_issues`、`rejected_issues` 是不同语义，不能合并成一个”issues”数组后让 prompt 自己猜。

#### 模板渲染安全约束（从 Bug 分析中沉淀）

> 背景：code-review 工作流中，diff 和源码内容会作为 value 注入模板。这些”用户内容”可能包含：
>
> - `$'` `$\`` `$&` `$1` 等 JS `String.replace` 特殊模式 → 导致 prompt 膨胀数倍
> - `{{changed_files}}` 等占位符字符串（当 diff 包含对模板文件本身的修改时）→ 导致级联展开
>
> 以上两个问题叠加，曾导致 725KB 的 prompt 膨胀到 4.5MB，超出 Codex 的 1M 字符限制。

**铁律：**

1. **必须使用 `replaceAllPlaceholders()` 单次替换**。不允许 sequential 调用 `replacePlaceholder()`。单次扫描保证已插入的 value 不会被后续替换再次处理。
2. **替换函数必须用 `() => value` 形式**。禁止将 value 作为 `String.replace` 的第二个字符串参数，因为 `$'` `$\`` 等会被解释为反向引用。
3. **code-review prompt 必须在渲染后检查字符数**。`CODEX_PROMPT_BUDGET = 900_000`（Codex CLI 硬限制 1,048,576 字符，留 148K 余量给 wrapper 自身的 system prompt）。超限时自动降级：full content → diff hunks → 截断 diff。

#### 外部系统硬限制

| 系统 | 限制 | 值 | 来源 |
|------|------|------|------|
| Codex CLI `turn/start` | 输入最大字符数 | **1,048,576 chars** (1M) | `Error: Input exceeds the maximum length of 1048576 characters` |
| Codex `config.toml` | 上下文窗口 | `model_context_window = 1000000` (token) | `~/.codex/config.toml` |
| Codex `config.toml` | 自动压缩阈值 | `model_auto_compact_token_limit = 900000` (token) | `~/.codex/config.toml` |
| codeagent-wrapper stdin | 管道缓冲区 | OS 依赖（Windows 4-64KB） | 已通过 32KB 分块写入处理 |
| Claude Agent SDK | 输出 token | 200,000 | `maxOutputTokens` 参数 |

> **字符 vs Token**：Codex 有两层限制。`turn/start` 的 1M 限制是**字符数**硬限制（由 CLI 本身检查，在 API 调用前拦截）。`model_context_window` 的 1M 限制是 **token 数**（由模型上下文窗口决定）。一般 1 token ≈ 3-4 chars，所以字符限制会先触发。`CODEX_PROMPT_BUDGET = 900_000` chars 就是基于这个字符硬限制设定的安全阈值。

### 4.4 上下文压缩

触发逻辑：

```ts
// src/lib/workflow/pack-builder.ts
const shouldCompress =
  round >= SPEC_REVIEW_OVERRIDES.context_compress_round ||
  estimatedTokens > threshold;
```

压缩策略：

```ts
// src/lib/workflow/context-compressor.ts
sections.push('## Spec\\n\\n' + spec);
sections.push('## Plan\\n\\n' + plan);
sections.push('## Issue Ledger Summary (open + accepted)\\n\\n' + ledgerSummary);
sections.push('## Last Round (Round ' + lastRound.round + ')\\n\\n' + formatRoundData(lastRound));
```

必须理解：

- 压缩不是摘要所有东西，而是保留最新 spec/plan、open+accepted ledger、最后一轮数据，丢掉中间轮次。
- `SPEC_REVIEW_OVERRIDES.max_rounds_extended` 当前没有并入 `WorkflowProfile.configOverrides`；不要误以为 spec-review 默认轮次已经自动扩成 5，实际默认仍由 `DEFAULT_CONFIG.max_rounds` 和 runtime override 决定。

### 4.5 Issue 生命周期

创建与复用：

```ts
// src/lib/workflow/issue-matcher.ts
const newIssue: Issue = {
  id: formatIssueId(nextSeq),
  round,
  raised_by: 'codex',
  severity: finding.severity,
  description: finding.issue,
  evidence: finding.evidence,
  status: 'open',
  repeat_count: 0,
  last_processed_round: round,
};
```

重提逻辑：

```ts
// src/lib/workflow/issue-matcher.ts
private handleMatchedIssue(issue: Issue): void {
  switch (issue.status) {
    case 'rejected':
      issue.status = 'open';
      issue.repeat_count++;
      issue.decided_by = undefined;
      issue.decision_reason = undefined;
      break;
    case 'deferred':
      break;
    case 'open':
    case 'accepted':
    case 'resolved':
      break;
  }
}
```

真实生命周期：

- `open -> accepted -> resolved`：spec-review 中最常见。
- `open -> rejected -> open`：被重提时 `repeat_count++`，可触发 deadlock。
- `open -> deferred`：继续保留，但 `PackBuilder` 只带最近的 deferred issue。
- `open -> accepted`：code-review 的终态之一，因为它不自动改代码。

### 4.6 补丁应用与 resolve gating

补丁应用器规则：

```ts
// src/lib/workflow/patch-applier.ts
// - Match found: replace matched section
// - No match: append to end and record in failedSections
// - No cross-level fallback: ## Foo 和 ### Foo 是不同 section
```

引擎里的保护逻辑：

```ts
// src/lib/workflow/workflow-engine.ts
if (claudeOutput?.spec_updated && !patches.specPatch) {
  hasPatchFailure = true;
  await this.emit(runId, round, 'patch_extraction_failed', { target: 'spec' });
}

if (hasPatchFailure) {
  await this.emit(runId, round, 'resolves_issues_missing', {
    round,
    reason: 'patch_apply_failed',
    blocked_issue_ids: claudeOutput.resolves_issues,
  });
}
```

约束：

- spec-review 才允许 patch。
- patch 失败时不能把 issue 直接记为 `resolved`，否则 ledger 与文档内容会漂移。
- heading level 必须精确匹配，不能靠模糊匹配“猜到”目标 section。

### 4.7 模型调用抽象

实际实现以代码为准，不是裸 HTTP API：

```ts
// src/lib/workflow/model-invoker.ts
const CODEX_COMMAND = 'codeagent-wrapper';

const sdk = await import('@anthropic-ai/claude-agent-sdk');
const q = queryFn({
  prompt,
  options: {
    model,
    systemPrompt: opts.systemPrompt,
    abortController: internalController,
    tools: [],
    persistSession: false,
    maxTurns: 1,
    settingSources: [],
  },
});
```

重试分类：

```ts
// src/lib/workflow/model-invoker.ts
if (err instanceof AbortError) throw err;
if (err instanceof ModelInvocationError) throw err;
if (isNonRetryableError(errMsg)) {
  throw new ModelInvocationError(model, undefined, err, `${model} non-retryable error: ${errMsg}`);
}
if (attempt >= maxRetries) {
  // 保留真实错误信息，不要丢弃
  throw new TimeoutError(model, maxRetries,
    `${model} failed after ${totalAttempts} attempts. Last error: ${errMsg}`);
}
```

不可重试错误模式（`NON_RETRYABLE_PATTERNS`）：

```ts
/authenticat/i,           // 认证失败
/api[_\s-]?key/i,        // API 密钥问题
/ENOENT/,                 // 可执行文件缺失
/exceeds.*maximum.*length/i,  // 输入超限（Codex 1M 限制）
/input.*too.*large/i,         // 通用输入过大
```

要求：

- 所有模型调用都必须走 `ModelInvoker`。
- 不要在 engine 里自己 `spawn` 子进程或自己 import Claude SDK。
- 非重试错误必须尽早归类成 `ModelInvocationError`，不要浪费轮次。
- `TimeoutError.message` 必须保留最后一次真实错误信息，不能只说 "timed out after N retries"。
- 新增外部服务错误模式时，先判断是否不可重试，加入 `NON_RETRYABLE_PATTERNS`。

---

## 5. 类型系统与配置分层

### 5.1 联合类型优先

```ts
// src/lib/workflow/types.ts
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type IssueStatus = 'open' | 'accepted' | 'rejected' | 'deferred' | 'resolved';
export type DecisionAction = 'accept' | 'reject' | 'defer' | 'accept_and_resolve';
export type TerminationReason =
  | 'lgtm'
  | 'no_new_high_severity'
  | 'only_style_issues'
  | 'deadlock_detected'
  | 'max_rounds_reached';
```

规范：

- 新状态必须先补 union type，再补判定逻辑、事件、测试。
- 不要在代码里散落裸字符串而不回写 `types.ts`。

### 5.2 自定义错误类型

```ts
// src/lib/workflow/types.ts
export class TimeoutError extends Error { ... }
export class AbortError extends Error { ... }
export class ModelInvocationError extends Error { ... }
```

用途对应：

- `TimeoutError`：所有重试耗尽后的超时。
- `AbortError`：用户暂停或外部取消。
- `ModelInvocationError`：认证、配置、缺可执行文件、invalid model 等非重试错误。

### 5.3 配置分层

真实合并顺序：

```ts
// src/lib/workflow/workflow-engine.ts
const config: WorkflowConfig = {
  ...DEFAULT_CONFIG,
  ...profile.configOverrides,
  ...params.config,
  context_files: mergedContextFiles,
};
```

结论：

- 默认值来自 `DEFAULT_CONFIG`。
- profile 只覆盖自己负责的差异。
- 运行时传参优先级最高。
- `contextFiles` 和 `config.context_files` 会被统一合并进 `config.context_files`，保证 resume 前后一致。

---

## 6. 校验与错误矩阵

### 6.1 模型超时

真实行为：

- Codex 超时：发 `codex_review_timeout`，跳到下一轮；超出 `max_rounds` 后终止。
- Claude 超时：发 `claude_decision_timeout`，跳到下一轮；超出 `max_rounds` 后终止。

对应代码：

```ts
// src/lib/workflow/workflow-engine.ts
if (err instanceof TimeoutError) {
  await this.emit(runId, round, 'claude_decision_timeout', { round });
  round++;
  ...
  continue;
}
```

### 6.2 解析失败

真实行为：

- Codex JSON 解析失败：构造保守 fallback，`overall_assessment = 'major_issues'`，继续流程。
- Claude JSON 解析失败：累计 `consecutive_parse_failures`，连续 2 次后 `pause_for_human`。

对应代码：

```ts
// src/lib/workflow/workflow-engine.ts
if (!codexOutput) {
  codexOutput = {
    findings: [],
    overall_assessment: 'major_issues',
    summary: 'Failed to parse Codex output (conservative fallback — not LGTM)',
  };
}
```

```ts
// src/lib/workflow/workflow-engine.ts
if (parseFailures >= 2) {
  await this.pauseForHuman(runId, round, {
    reason: 'deadlock_detected',
    action: 'pause_for_human',
    details: `Claude output parse failed ${parseFailures} consecutive times.`,
  });
}
```

### 6.3 人工暂停

真实行为：

- `pause()` 先触发 abort。
- 当前步骤捕获 `AbortError` 后调用 `saveCheckpoint()`。
- 最终 `meta.status = 'paused'`，可由 `resume()` 恢复。

### 6.4 非重试错误

真实行为：

- `ModelInvocationError` 一律 `terminateWorkflowWithError()`。
- 不在 workflow 内部吞掉 auth、model、executable 缺失类错误。

### 6.5 决策校验失败

`DecisionValidator` 会检查：

- issue_id 必须存在。
- 不能重复决定同一个 issue。
- action 必须属于当前 workflow 允许的集合。
- code-review 下 `accept` 必须带 `fix_instruction`。
- spec-review 下 `resolves_issues` 只能指向本轮 accepted issue。

### 6.6 补丁失败

真实行为：

- heading 找不到时，`PatchApplier` 追加到文末并返回 `failedSections`。
- engine 发出 `patch_apply_failed`。
- `resolves_issues` 会被阻断，不自动 resolved。

---

## 7. Good / Base / Bad Cases

### 7.1 Good：按 profile 启动 code-review

```ts
// src/lib/bridge/internal/workflow-command.ts
await engine.start({
  spec: '',
  plan: '',
  contextFiles,
  config: configOverrides,
  profile: CODE_REVIEW_PROFILE,
  snapshot,
});
```

为什么对：

- 用了工厂函数。
- profile、snapshot、config 都通过正式入口传入。
- code-review 不读取源码工作树，而是读取 snapshot。

### 7.2 Base：默认 spec-review

```ts
// src/lib/workflow/cli.ts
const engine = createSpecReviewEngine(basePath);
runId = await engine.start({ spec, plan, config, contextFiles });
```

为什么可接受：

- 未显式传 profile 时，`start()` 默认使用 `SPEC_REVIEW_PROFILE`。
- 对纯文档评审场景足够直接。

### 7.3 Bad：绕开 store 或 matcher

```ts
// 错误示例：不要这样写
const spec = await fs.readFile('spec.md', 'utf-8');
ledger.issues.push({
  id: 'ISS-999',
  status: 'resolved',
});
```

为什么错：

- 绕过 `WorkflowStore` 破坏版本化和恢复一致性。
- 绕过 `IssueMatcher` 破坏 issue id、repeat_count、last_processed_round 语义。

---

## 8. 测试方式

### 8.1 命名与栈

真实文件：

- `src/__tests__/unit/workflow-engine.test.ts`
- `src/__tests__/unit/workflow-code-review.test.ts`
- `src/__tests__/unit/workflow-termination-judge.test.ts`
- `src/__tests__/unit/workflow-context-compressor.test.ts`
- `src/__tests__/unit/workflow-issue-matcher.test.ts`
- `src/__tests__/unit/workflow-patch-applier.test.ts`
- `src/__tests__/unit/workflow-json-parser.test.ts`

约束：

- 命名统一为 `workflow-*.test.ts`。
- 测试框架使用 `node:test` + `node:assert/strict`。

### 8.2 真实依赖 + 假模型调用

```ts
// src/__tests__/unit/workflow-engine.test.ts
function buildEngine(store: WorkflowStore, mockInvoker: MockModelInvoker): WorkflowEngine {
  const compressor = new ContextCompressor();
  const packBuilder = new PackBuilder(store, compressor);
  const promptAssembler = new PromptAssembler(store);
  const terminationJudge = new TerminationJudge();
  const jsonParser = new JsonParser();
  const issueMatcher = new IssueMatcher();
  const patchApplier = new PatchApplier();
  const decisionValidator = new DecisionValidator();

  return new WorkflowEngine(
    store,
    packBuilder,
    promptAssembler,
    mockInvoker as unknown as ModelInvoker,
    terminationJudge,
    jsonParser,
    issueMatcher,
    patchApplier,
    decisionValidator,
  );
}
```

测试策略：

- 真实使用 `WorkflowStore`、`PackBuilder`、`TerminationJudge`、`PatchApplier`。
- 只替换 `ModelInvoker`，避免外部模型调用。
- 模板文件在测试临时目录里按生产命名写入。

### 8.3 必测行为

- `WorkflowEngine` 正常两轮流转、事件顺序、最终状态。
- `resume()` 从正确 round / step 继续，并产出 `workflow_resumed`。
- `TerminationJudge` 的全部优先级分支。
- `ContextCompressor` 的 round 阈值和 token 阈值。
- `IssueMatcher` 的幂等性、重提、模糊匹配。
- `PatchApplier` 的 heading level 严格匹配和追加失败语义。
- code-review 的 `acceptedIsTerminal`、`fix_instruction`、报告生成。

---

## 9. 反模式

### 9.1 不要把 workflow type 条件分支撒满全流程

- 错误做法：在 engine 多处直接判断 `'spec-review'` / `'code-review'` 后手写差异。
- 正确做法：把稳定差异放进 `WorkflowProfile.behavior`，只在 pack/prompt 路由边界保留最小分支。

### 9.2 不要直接文件 I/O

- spec/plan/run artifact 一律走 `WorkflowStore`。
- code-review 文件内容一律走 `DiffReader` 快照或 `snapshot.changed_files`，不要 `fs.readFile` 当前工作树。

### 9.3 不要绕过 IssueMatcher 改 ledger

- Issue ID、重复计数、已处理轮次、重提行为都在 `IssueMatcher` 里定义。
- 直接 `ledger.issues.push()` 会让 deadlock、dedup、resume 失真。

### 9.4 不要忽略检查点

- 中断点必须保留在 `meta.current_round` + `meta.current_step`。
- 任何“暂停时只改 status、不写 step”的实现都会让 resume 从错误位置继续。

### 9.5 不要误判 accepted 的含义

- spec-review：`accepted` 不是终态，通常等待 patch 或 `resolves_issues`。
- code-review：`accepted` 是终态之一，由 `acceptedIsTerminal = true` 驱动。

---

## 10. Wrong vs Correct

### 10.1 Wrong：只改 flag，不补路由

```ts
// 错误示例
const MY_PROFILE: WorkflowProfile = {
  ...CODE_REVIEW_PROFILE,
  behavior: {
    ...CODE_REVIEW_PROFILE.behavior,
    claudeIncludesPreviousDecisions: true,
  },
};
```

问题：

- 仅改 flag 不会自动让 code-review 走 `buildClaudeDecisionInput()`。
- 当前实现里 fresh / cumulative context 是通过 builder 路由实现的。

```ts
// 正确方向：同时补 profile + 路由
if (profile.type === 'my-review') {
  const input = await this.packBuilder.buildClaudeDecisionInput(...);
  claudePrompt = await this.promptAssembler.renderClaudeDecisionPrompt(input);
}
```

### 10.2 Wrong：patch 失败仍然 resolved

```ts
// 错误示例
issue.status = 'resolved';
await this.store.saveLedger(runId, ledger);
```

问题：

- 文档没改成功，但 ledger 已显示 resolved，会造成事实不一致。

```ts
// 正确方向：先看 patch 结果，再决定是否 resolve
if (hasPatchFailure) {
  await this.emit(runId, round, 'patch_apply_failed', { target: 'spec' });
} else {
  issue.status = 'resolved';
  issue.resolved_in_round = round;
}
```

---

## 11. 变更前检查清单

- [ ] 是否只通过 `createSpecReviewEngine()` / `createCodeReviewEngine()` 暴露入口
- [ ] 是否所有 run 数据都经过 `WorkflowStore`
- [ ] 是否为新行为补了 `WorkflowProfile`、`TerminationJudge`、测试
- [ ] 是否确认 spec-review 与 code-review 在 `accepted`、patch、snapshot 上的语义差异
- [ ] 是否检查过 `workflow-*.test.ts` 是否需要同步更新
