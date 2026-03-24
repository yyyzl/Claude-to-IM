# Spec: Code Review Workflow (Adversarial Verification)

> **Scope**: P1b-CR-0 (review-only MVP) + P1b-CR-1 (review-and-fix) — 在现有 Workflow Engine 上扩展代码审查 + 自动修复能力
>
> **前置依赖**: P0 ✅ · P1a ✅ · P2a ✅（Spec-Review 已完整实现）
>
> **状态**: ✅ **P1b-CR-0 + P1b-CR-1 已完成** — `Phase 1-5` 完成，独立 CLI `code-review` / `review-fix` 子命令已实现，`AutoFixer` worktree 隔离修复模块已实现，`393/393` 单元测试通过，TS 编译零错误
>
> **目标**: 复用 Workflow Engine 核心循环，新增 `code-review` 和 `review-fix` 工作流类型

---

## 1. Background

### 1.1 Pain Points

用户日常使用 Claude + Codex 进行代码审查，当前流程：

| 痛点 | 耗时 |
|------|------|
| 手动复制 git diff 给 Codex/Claude | 3-5 min |
| 手动搬运审查结果，过滤误报 | 5-10 min |
| 无结构化追踪：哪些问题已处理、哪些被否决 | 持续心智负担 |
| 审查报告散落在聊天记录中，不可回溯 | 不可追溯 |

### 1.2 Goal

通过 `/workflow start --type code-review` 一键启动自动化代码审查：

- Codex **盲审**代码变更（fresh context，避免确认偏差）
- Claude **仲裁**审查发现（fresh context，过滤误报，提供修复建议）
- 自动维护 Issue Ledger，追踪审查状态
- 多轮迭代直至收敛
- 输出结构化审查报告

### 1.3 与 Spec-Review 的关键差异

| 维度 | Spec-Review | Code-Review |
|------|------------|-------------|
| 审查对象 | spec + plan（文本文档） | code diff + 完整文件 |
| Claude 上下文策略 | 累积上下文（含 previous_decisions） | **Fresh 上下文**（不含裁决理由，避免偏见） |
| 输出产物 | 修改后的 spec/plan | 审查报告（issue list + fix instructions） |
| 是否修改文件 | 是（PatchApplier 修改文档） | 否（review-only MVP 不修改代码） |
| Codex 输出增强 | Finding（issue + severity + evidence） | **CodeFinding**（+ file + line_range + category） |
| Claude 输出格式 | decisions + spec_patch + resolves_issues | decisions + **fix_instruction** |
| accepted 语义 | 中间态（等待 patch resolve） | **终态**（审查结论，不阻塞终止） |
| 终止条件 | 基本相同 | **TerminationJudge 需感知 accepted 终态语义** |

### 1.4 Non-Goals (This Phase)

- 自动修复代码（P1b-CR-1: review-and-fix 模式）
- PR / MR 集成（GitHub/GitLab comment 自动回复）
- 增量审查（只审查新改动，跳过已审查的文件）
- 多语言感知的 AST 级分析

### 1.5 Phase Status

- **P1b-CR-1**: ✅ Review-and-Fix 模式 — `AutoFixer` + worktree 隔离 + Codex 修复（`auto-fixer.ts` 240行，CLI `review-fix` 子命令，Bridge `/workflow review-fix`）
- **P1b-CR-2**: 🟠 PR 集成 — 审查结果自动发布为 PR review comments（未开始）

---

## 2. User Stories

**US-CR-1**: 作为开发者，我想一键启动代码审查。系统自动读取 git diff，Codex 盲审，Claude 仲裁，输出审查报告。

**US-CR-2**: 作为开发者，我想看到结构化的审查报告：按文件分组，每个 issue 有严重性、分类、代码引用和修复建议。

**US-CR-3**: 作为开发者，当 Codex 和 Claude 对某个问题反复争论时，系统应暂停等待我的人工介入。

**US-CR-4**: 作为开发者，我想通过飞书 `/workflow start --type code-review` 启动审查，在聊天中实时看到进度。

---

## 3. Architecture

### 3.1 引擎泛化策略：WorkflowProfile

为了支持多种工作流类型，引入 `WorkflowProfile` 参数化配置，替代硬编码的 spec-review 逻辑：

```typescript
/**
 * 工作流配置档案（Profile）
 *
 * 定义一种工作流类型的所有可配置项：步骤序列、模板、配置覆盖。
 * WorkflowEngine 根据 profile 驱动循环，而非硬编码步骤逻辑。
 */
interface WorkflowProfile {
  /** 工作流类型标识 */
  type: WorkflowType;

  /** 步骤序列（引擎按此顺序执行） */
  steps: WorkflowStep[];

  /** 配置覆盖（叠加在 DEFAULT_CONFIG 之上） */
  configOverrides: Partial<WorkflowConfig>;

  /** 模板名映射 */
  templates: {
    review: string;                  // Codex 审查 prompt 模板
    decision: string;                // Claude 裁决 prompt 模板
    decisionSystem: string;          // Claude 系统角色模板
  };

  /** 步骤行为标志 */
  behavior: {
    /** Claude 是否接收 previous_decisions（true = 累积上下文，false = fresh） */
    claudeIncludesPreviousDecisions: boolean;
    /** 是否执行 PatchApplier（spec-review 需要，code-review 不需要） */
    applyPatches: boolean;
    /** 是否跟踪 resolves_issues（spec-review 需要，code-review 不需要） */
    trackResolvesIssues: boolean;
    /** accept action 是否需要 fix_instruction 字段 */
    requireFixInstruction: boolean;
    /**
     * accepted 状态是否视为终态（不阻塞终止判断）。
     *
     * - spec-review: false — accepted 是中间态，等待 patch resolve
     * - code-review: true  — accepted 是终态，代表"已确认问题 + 已提供修复建议"
     *
     * 影响 TerminationJudge：当 acceptedIsTerminal=true 时，
     * "unresolved" 计算排除 accepted 状态的 issue。
     * LGTM 终止条件：无 open/deferred（accepted 不再阻塞）。
     */
    acceptedIsTerminal: boolean;
  };
}
```

**预定义 Profile：**

```typescript
const SPEC_REVIEW_PROFILE: WorkflowProfile = {
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
    acceptedIsTerminal: false,             // accepted = 中间态，等待 resolve
  },
};

const CODE_REVIEW_PROFILE: WorkflowProfile = {
  type: 'code-review',
  steps: ['codex_review', 'issue_matching', 'pre_termination', 'claude_decision', 'post_decision'],
  configOverrides: {
    max_rounds: 3,                   // 代码审查通常 2-3 轮足够
  },
  templates: {
    review: 'code-review-pack.md',
    decision: 'code-review-decision.md',
    decisionSystem: 'code-review-decision-system.md',
  },
  behavior: {
    claudeIncludesPreviousDecisions: false,  // Fresh — 避免确认偏差
    applyPatches: false,                     // Review-only 不修改代码
    trackResolvesIssues: false,              // 无补丁，无需 resolves_issues
    requireFixInstruction: true,             // accept 时必须提供修复建议
    acceptedIsTerminal: true,                // accepted = 终态（审查结论）
  },
};
```

### 3.2 模块改动范围

```
src/lib/workflow/
├── types.ts                  # [扩展] 新增 CodeReviewPack, CodeFinding, WorkflowProfile 等类型
├── workflow-engine.ts        # [改动] 根据 profile.behavior 条件执行步骤
├── pack-builder.ts           # [扩展] 新增 buildCodeReviewPack(), buildClaudeCodeReviewInput()
├── prompt-assembler.ts       # [扩展] 新增 renderCodeReviewPrompt(), renderClaudeCodeReviewPrompt()
├── issue-matcher.ts          # [增强] 新增文件路径+行号匹配策略（向后兼容）
├── decision-validator.ts     # [适配] 根据 profile 条件验证（fix_instruction / resolves_issues）
├── index.ts                  # [扩展] 新增 createCodeReviewEngine() 工厂
├── diff-reader.ts            # [新建] git diff 解析 + 文件内容读取
├── report-generator.ts       # [新建] 审查报告生成（Markdown 格式）
│
├── model-invoker.ts          # [不变] 完全复用
├── termination-judge.ts      # [适配] 接收 acceptedIsTerminal 标志，调整 unresolved 计算
├── context-compressor.ts     # [不变] 完全复用（内部适配 CodeReviewPack）
├── json-parser.ts            # [不变] 完全复用
├── patch-applier.ts          # [不变] 完全复用（code-review 时不调用）
├── workflow-store.ts          # [不变] 完全复用
└── cli.ts                    # [扩展] 新增 --type code-review 参数

.claude-workflows/templates/
├── code-review-pack.md              # [新建] Codex 代码盲审 prompt
├── code-review-decision.md          # [新建] Claude 代码仲裁 prompt
└── code-review-decision-system.md   # [新建] Claude 系统角色（代码审查）

src/lib/bridge/internal/
└── workflow-command.ts        # [扩展] 支持 --type code-review 参数
```

### 3.3 Architecture Boundaries

保持现有边界不变：

- Workflow Engine **不依赖** Bridge
- Bridge 通过 `workflow-command.ts` 调用 Engine
- Engine 通过 `ModelInvoker` 调用 LLM，从不直接调用
- Engine 通过 `WorkflowStore` 持久化，不直接操作文件系统

新增边界：

- `diff-reader.ts` 调用 `git` CLI 获取 diff，属于 Engine 内部模块
- `report-generator.ts` 读取 WorkflowStore 中的审查结果，生成报告

---

## 4. Data Structures

### 4.1 CodeReviewPack (Codex 代码审查输入)

```typescript
/**
 * 代码审查的 "review pack"，发送给 Codex 进行盲审。
 *
 * 与 SpecReviewPack 的区别：审查对象从 spec+plan 变为 diff+files。
 */
interface CodeReviewPack {
  /** git diff 全文 */
  diff: string;
  /** 变动文件的完整内容（不只是 diff，因为需要上下文理解） */
  changed_files: ChangedFile[];
  /** 审查范围描述 */
  review_scope: ReviewScope;
  /** 额外的上下文文件（配置、类型定义等） */
  context_files: ContextFile[];
  /** 上轮未解决的问题 */
  unresolved_issues: Issue[];
  /** 上轮被拒绝的问题（只含描述，不含拒绝理由，避免偏见） */
  rejected_issues: RejectedIssueSummary[];
  /**
   * 已确认的问题（accepted，用于去重）。
   *
   * code-review 中代码未修改，accepted 问题仍存在于代码中。
   * 必须告知 Codex 避免重复提出。
   * 复用 types.ts 中已定义的 AcceptedIssueSummary 类型。
   */
  accepted_issues: AcceptedIssueSummary[];
  /** 上轮结果摘要 */
  round_summary: string;
  /** 当前轮次 */
  round: number;
}

/** 变动文件详情 */
interface ChangedFile {
  /** 文件路径（相对于项目根目录） */
  path: string;
  /** 重命名/复制时的旧路径 */
  old_path?: string;
  /** 文件内容（当前版本；删除文件用 git show 获取原始内容） */
  content: string;
  /** 该文件的 diff 片段 */
  diff_hunks: string;
  /** 文件语言（从扩展名推断） */
  language: string;
  /** 变动统计 */
  stats: { additions: number; deletions: number };
  /** 变动类型（对应 git diff --name-status） */
  change_type: ChangeType;
}

/** 文件变动类型 */
type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

/** 审查范围描述 */
interface ReviewScope {
  /** 审查类型 */
  type: 'staged' | 'unstaged' | 'commit' | 'commit_range' | 'branch';
  /** diff 基准引用（如 main, HEAD~3） */
  base_ref?: string;
  /** diff 目标引用（如 HEAD, feature-branch） */
  head_ref?: string;
  /** 文件筛选模式（glob 匹配） */
  file_patterns?: string[];
  /** 排除文件模式 */
  exclude_patterns?: string[];
  /** 是否包含敏感文件（默认 false，自动排除） */
  include_sensitive?: boolean;
}
```

> **设计说明**：
> - `changed_files` 包含完整文件内容，而非只有 diff，因为 Codex 需要上下文理解函数调用关系、变量定义等
> - `diff` 字段保留全文 diff，告诉 Codex "关注哪些改动"
> - 如果变动文件过多/过大，由 ContextCompressor 裁剪

### 4.2 CodeFinding (Codex 代码审查发现)

```typescript
/**
 * Codex 在代码审查中产生的单条发现。
 *
 * 扩展基础 Finding，增加文件定位和分类信息。
 */
interface CodeFinding extends Finding {
  /** 涉及的文件路径 */
  file: string;
  /** 行号范围（可选，用于精确定位） */
  line_range?: { start: number; end: number };
  /** 问题分类 */
  category: CodeReviewCategory;
}

/** 代码审查问题分类 */
type CodeReviewCategory =
  | 'bug'              // 逻辑错误
  | 'security'         // 安全漏洞
  | 'performance'      // 性能问题
  | 'error_handling'   // 错误处理缺陷
  | 'type_safety'      // 类型安全
  | 'concurrency'      // 并发/竞态
  | 'style'            // 代码风格
  | 'architecture'     // 架构问题
  | 'test_coverage'    // 测试覆盖
  | 'documentation';   // 文档缺失
```

### 4.3 Codex 代码审查输出

```typescript
/** Codex 代码审查的结构化输出 */
interface CodexCodeReviewOutput {
  /** 审查发现列表 */
  findings: CodeFinding[];
  /** 整体评估 */
  overall_assessment: OverallAssessment;
  /** 审查总结 */
  summary: string;
  /** 文件级评估（可选，供报告生成使用） */
  file_assessments?: FileAssessment[];
}

/** 单文件评估 */
interface FileAssessment {
  /** 文件路径 */
  path: string;
  /** 该文件的风险等级 */
  risk_level: 'high' | 'medium' | 'low' | 'clean';
  /** 简短评价 */
  note: string;
}
```

### 4.4 Claude 代码审查裁决

```typescript
/** Claude 代码审查裁决的结构化输出 */
interface ClaudeCodeReviewDecision {
  /** 逐条裁决 */
  decisions: CodeReviewDecisionItem[];
  /** 裁决总结 */
  summary: string;
}

/** 单条代码审查裁决 */
interface CodeReviewDecisionItem {
  /** Issue ID（由 IssueMatcher 在 Step B1 分配） */
  issue_id: string;
  /** 裁决动作 */
  action: 'accept' | 'reject' | 'defer';
  /** 裁决理由 */
  reason: string;
  /** 修复指令（action=accept 时必填） */
  fix_instruction?: string;
}
```

> **设计说明**：
> - 没有 `accept_and_resolve` — 代码审查的 accept 意味着"同意此问题存在"，需要修复（即使是 review-only 模式，也是生成修复建议，而非直接 resolve）
> - 没有 `spec_patch` / `plan_patch` / `resolves_issues` — 代码审查不修改文档
> - `fix_instruction` 是可选字段，但 accept 时 DecisionValidator 强制要求

### 4.5 ClaudeCodeReviewInput (Claude 裁决输入)

```typescript
/** Claude 代码审查裁决的输入数据（由 PackBuilder 组装） */
interface ClaudeCodeReviewInput {
  /** 当前轮次 */
  round: number;
  /** Codex 发现（含分配的 Issue ID） */
  codexFindingsWithIds: Array<{
    issueId: string;
    finding: CodeFinding;
    isNew: boolean;
  }>;
  /** Ledger 状态摘要（含状态，不含裁决理由 — fresh 审查） */
  ledgerSummary: string;
  /** git diff 全文 */
  diff: string;
  /** 变动文件完整内容 */
  changed_files: ChangedFile[];
  /** 是否有新发现 */
  hasNewFindings: boolean;
}
```

> **与 ClaudeDecisionInput 的区别**：
> - 没有 `currentSpec` / `currentPlan` — 审查的是代码
> - 没有 `previousDecisions` — fresh context，避免确认偏差
> - ledgerSummary 中**不包含**之前的 `decision_reason`（只有 id + description + status + severity）
> - 增加了 `diff` 和 `changed_files`

### 4.6 Issue 接口扩展

扩展 `Issue` 接口，增加代码审查专用的**可选字段**。这些字段对 spec-review 透明（undefined / 不序列化），
确保向后兼容：

```typescript
interface Issue {
  // === 现有字段（全部保留，不变） ===
  id: string;
  round: number;
  raised_by: RaisedBy;
  severity: Severity;
  description: string;
  evidence: string;
  status: IssueStatus;
  decided_by?: DecidedBy;
  decision_reason?: string;         // 裁决理由（reason），与 fix_instruction 分开
  resolved_in_round?: number;
  repeat_count: number;
  last_processed_round?: number;

  // === 代码审查专用可选字段（P1b-CR-0 新增） ===

  /** 源文件路径（代码审查时由 IssueMatcher 从 CodeFinding.file 写入） */
  source_file?: string;

  /** 源代码行号范围（代码审查时由 IssueMatcher 从 CodeFinding.line_range 写入） */
  source_line_range?: { start: number; end: number };

  /** 问题分类（代码审查时由 IssueMatcher 从 CodeFinding.category 写入） */
  category?: CodeReviewCategory;

  /**
   * 修复指令（代码审查时由 Claude 裁决写入，仅 action=accept 时有值）。
   *
   * 与 decision_reason 分开存储：
   * - decision_reason: "为什么接受"（裁决理由）
   * - fix_instruction: "怎么修"（修复指令）
   *
   * ReportGenerator 同时展示两者。
   */
  fix_instruction?: string;
}
```

> **设计决策**：为什么直接扩展 Issue 而不是用嵌套对象或 evidence 约定？
>
> 1. **IssueLedger 是唯一真相源** — ReportGenerator 只需读 ledger 即可生成完整报告，不需要 join 多个数据源
> 2. **IssueMatcher 直接使用结构化字段** — 不需要解析 evidence 字符串，避免格式脆弱性
> 3. **可选字段对 spec-review 透明** — 序列化时 undefined 字段被忽略，不影响现有 schema
> 4. **reason 和 fix_instruction 分开存储** — 语义清晰，ReportGenerator 可以分别展示

### 4.7 审查报告

```typescript
/** 代码审查最终报告 */
interface CodeReviewReport {
  /** 工作流 run_id */
  run_id: string;
  /** 审查范围 */
  scope: ReviewScope;
  /** 总轮次 */
  total_rounds: number;
  /** 统计 */
  stats: {
    total_findings: number;
    accepted: number;
    rejected: number;
    deferred: number;
    by_severity: Record<Severity, number>;
    by_category: Record<CodeReviewCategory, number>;
  };
  /** 按文件分组的审查结果 */
  file_results: FileReviewResult[];
  /** 整体结论 */
  conclusion: 'clean' | 'minor_issues_only' | 'issues_found' | 'critical_issues';
  /** 生成时间 */
  generated_at: string;
}

/** 单文件审查结果 */
interface FileReviewResult {
  /** 文件路径 */
  path: string;
  /** 该文件的所有 issue（含裁决结果） */
  issues: Array<{
    id: string;
    severity: Severity;
    category: CodeReviewCategory;
    description: string;
    line_range?: { start: number; end: number };
    action: 'accept' | 'reject' | 'defer';
    reason: string;
    fix_instruction?: string;
  }>;
}
```

### 4.8 Review Snapshot（一等概念）

```typescript
/**
 * 代码审查快照 — 在 start 时冻结，后续所有 round/resume/report 只读快照。
 *
 * 解决的问题：
 * 1. staged 场景：同一文件有 unstaged 改动时，fs.readFile 读到的是工作区版本，不是暂存区版本
 * 2. resume 场景：暂停后用户修改了代码，恢复时必须审查原始版本
 * 3. 审计场景：报告对应的是哪个版本的代码必须确定
 *
 * 存储：{run_dir}/review-snapshot.json
 * 文件内容通过 blob_sha 按需读取（git show <blob_sha>），不存储在快照 JSON 中。
 */
interface ReviewSnapshot {
  /** 审查范围（冻结的副本） */
  scope: ReviewScope;
  /** git HEAD SHA（快照时刻） */
  head_commit: string;
  /** 变动文件元信息（不含 content，content 通过 blob_sha 按需读取） */
  files: SnapshotFile[];
  /** 被排除的文件（审计记录） */
  excluded_files: ExcludedFile[];
  /** diff 全文 */
  diff: string;
  /** 统计 */
  stats: { files_changed: number; additions: number; deletions: number };
  /** 快照创建时间 */
  created_at: string;
}

/** 快照中的文件元信息 */
interface SnapshotFile {
  /** 文件路径 */
  path: string;
  /** 重命名/复制的旧路径 */
  old_path?: string;
  /** git blob SHA（用于 git show 按需获取内容） */
  blob_sha: string;
  /** 变动类型 */
  change_type: ChangeType;
  /** 该文件的 diff hunks */
  diff_hunks: string;
  /** 文件语言 */
  language: string;
  /** 变动统计 */
  stats: { additions: number; deletions: number };
}
```

> **INV-7: 审查基于冻结快照，不基于实时工作区**
>
> - DiffReader 在 start 时被调用一次，结果冻结为 `review-snapshot.json`
> - PackBuilder 从快照读取文件元信息，通过 `git show <blob_sha>` 按需获取文件内容
> - resume 时不重新读取 diff，直接加载快照
> - ReportGenerator 从快照获取 scope 和 excluded_files
>
> **内容获取方式（按 scope 类型）**：
>
> | scope.type | blob_sha 获取方式 | 说明 |
> |------------|------------------|------|
> | staged | `git ls-files -s <path>` → 取 index blob | 读暂存区版本，不受工作区影响 |
> | unstaged | 先 `git hash-object -w <path>` 生成 blob，记录 SHA | 冻结当前工作区版本 |
> | commit | `git ls-tree <ref> -- <path>` → 取 blob SHA | 精确到 commit 版本 |
> | commit_range | `git ls-tree <head_ref> -- <path>` → 取 blob SHA | 取 head 端版本 |
> | branch | `git ls-tree <head_ref> -- <path>` → 取 blob SHA | 取 head 端版本 |
>
> 删除文件的 blob_sha：从 base_ref 端获取（`git ls-tree <base_ref> -- <path>`）。

### 4.9 配置覆盖

```typescript
/**
 * 代码审查特有的配置覆盖。
 *
 * 这些字段不在 WorkflowConfig 中，因为它们是 code-review 专有的。
 * 存储在 WorkflowProfile.configOverrides 中，运行时合并。
 *
 * 与 SPEC_REVIEW_OVERRIDES 同理——两者都是 profile 级常量，
 * 不扩展通用的 WorkflowConfig 接口。
 */
const CODE_REVIEW_OVERRIDES = {
  /** 默认最大轮次（代码审查通常 2-3 轮足够） */
  max_rounds: 3,
  /** 上下文压缩阈值（代码文件可能比 spec 更大） */
  context_compress_threshold: 0.5,
  /** 上下文压缩触发轮次 */
  context_compress_round: 3,
  /** 最大变动文件数（超出则只保留 diff，不传完整内容） */
  max_changed_files_full_content: 20,
  /** 单文件最大行数（超出则截断，只传 diff hunks 上下文） */
  max_file_lines: 2000,
} as const;
```

> **设计说明**：`context_compress_threshold` 等字段不在 `WorkflowConfig` 中。
> 它们与 `SPEC_REVIEW_OVERRIDES` 中的同名字段一样，是 profile 级常量，
> 在 PackBuilder/ContextCompressor 中直接引用，不通过 WorkflowConfig 传递。
> 未来如果需要用户可配，可以扩展 WorkflowConfig 或引入 `ProfileConfig` 接口。

---

## 5. DiffReader Module

### 5.1 接口

```typescript
/**
 * 负责从 git 获取 diff、文件元信息和 blob SHA。
 *
 * 封装所有 git CLI 调用，生成冻结的 ReviewSnapshot。
 * 仅在 workflow start 时调用一次，结果持久化为快照。
 * 支持普通仓库和 worktree（.git 可能是文件而非目录）。
 */
class DiffReader {
  constructor(private cwd: string);

  /**
   * 创建审查快照。在 start 时调用一次，结果冻结。
   *
   * @param scope - 审查范围配置
   * @returns ReviewSnapshot（不含文件内容，内容通过 blob_sha 按需读取）
   * @throws Error 如果 cwd 不是有效的 git 仓库
   * @throws Error 如果 diff 为空（无变更）
   */
  async createSnapshot(scope: ReviewScope): Promise<ReviewSnapshot>;

  /**
   * 从快照读取单个文件内容（通过 git show <blob_sha>）。
   * PackBuilder 用此方法按需获取文件内容组装 Pack。
   */
  async readFileContent(blobSha: string): Promise<string>;

  /**
   * 批量读取文件内容。
   */
  async readFileContents(files: SnapshotFile[]): Promise<ChangedFile[]>;

  /**
   * 检测是否在有效的 git 仓库内。
   * 使用 git rev-parse --is-inside-work-tree（兼容 worktree）。
   */
  async isGitRepo(): Promise<boolean>;

  /** 推断文件语言（从扩展名） */
  static inferLanguage(filePath: string): string;
}

/** 被排除的文件记录（用于报告审计） */
interface ExcludedFile {
  path: string;
  reason: 'binary' | 'sensitive' | 'too_large' | 'pattern_excluded';
}
```

### 5.2 ChangedFile 结构（增强）

```typescript
/** 变动文件详情 */
interface ChangedFile {
  /** 文件路径（相对于项目根目录） */
  path: string;
  /** 重命名/复制时的旧路径 */
  old_path?: string;
  /** 文件内容（当前版本；删除文件用 git show 获取原始内容） */
  content: string;
  /** 该文件的 diff 片段 */
  diff_hunks: string;
  /** 文件语言（从扩展名推断） */
  language: string;
  /** 变动统计 */
  stats: { additions: number; deletions: number };
  /** 变动类型 */
  change_type: ChangeType;
}

/** 文件变动类型（对应 git diff --name-status 的状态码） */
type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
```

### 5.3 ReviewScope 到 git 命令的映射

| ReviewScope.type | diff 命令 | name-status 命令 | 说明 |
|------------------|-----------|-----------------|------|
| `staged` | `git diff --cached` | `git diff --cached --name-status` | 已暂存的变更 |
| `unstaged` | `git diff` | `git diff --name-status` | 工作区变更 |
| `commit` | `git diff {ref}~1..{ref}` | `git diff {ref}~1..{ref} --name-status` | 指定 commit |
| `commit_range` | `git diff {base_ref}..{head_ref}` | 同上加 `--name-status` | 两点 diff |
| `branch` | `git diff {base_ref}...{head_ref}` | 同上加 `--name-status` | 三点 diff（分支对比） |

### 5.4 文件变动类型处理矩阵

| git status | ChangeType | blob_sha 获取 | 内容读取 | old_path |
|------------|-----------|--------------|---------|----------|
| A (Added) | `added` | `git ls-tree <head> -- <path>` 或 `git ls-files -s <path>` (staged) | `git show <blob_sha>` | — |
| M (Modified) | `modified` | 同上 | `git show <blob_sha>` | — |
| D (Deleted) | `deleted` | `git ls-tree <base> -- <path>`（从 base 端取） | `git show <blob_sha>` | — |
| R (Renamed) | `renamed` | `git ls-tree <head> -- <new_path>` | `git show <blob_sha>` | old_path 赋值 |
| C (Copied) | `copied` | `git ls-tree <head> -- <new_path>` | `git show <blob_sha>` | old_path 赋值 |

> **关键细节**：
> - **不使用 fs.readFile** — 所有内容通过 `git show <blob_sha>` 获取，确保快照一致性
> - **staged 模式**：`git ls-files -s <path>` 获取暂存区 blob SHA，不受工作区未暂存改动影响
> - **unstaged 模式**：`git hash-object -w <path>` 将工作区文件写入 git 对象库并返回 blob SHA
> - **删除文件**：从 base_ref 端获取 blob SHA（`git ls-tree <base> -- <path>`）
> - **重命名/复制**：`git diff --name-status` 输出格式为 `R100\told_path\tnew_path`，需要解析
> - **所有文件内容统一通过 `git show <blob_sha>` 按需读取**，不在快照中存储 content

### 5.5 文件内容读取策略

1. 通过 `git diff --name-status` 获取变动文件列表（含变动类型）
2. 解析变动类型：A/M/D/R/C
3. 应用过滤规则（按优先级）：
   a. 二进制文件 → 排除（通过 `git diff --numstat` 检测 `-` 标记）
   b. 敏感文件模式匹配 → 排除（记入 excludedFiles）
   c. `exclude_patterns` 用户自定义排除
   d. `file_patterns` 用户自定义包含（如果指定）
4. 对每个通过过滤的文件，按 §5.4 矩阵获取内容
5. 内容截断规则：
   - 行数 ≤ `max_file_lines` → 读取完整内容
   - 行数 > `max_file_lines` → 只保留 diff hunks ± 上下 50 行上下文
6. 文件总数 > `max_changed_files_full_content` → 只保留改动行数最多的 top N 个文件的完整内容，其余只保留 diff hunks

### 5.6 安全边界

- **仓库检测**：`git rev-parse --is-inside-work-tree`（兼容 worktree，不检查 `.git` 目录）
- **路径遍历保护**：变动文件路径 resolve 后必须在 `cwd` 范围内
- **二进制文件**：自动跳过，记入 `excludedFiles`
- **敏感文件**：自动排除以下模式，记入 `excludedFiles`：
  ```
  .env, .env.*, *.secret, *.key, *.pem, *.p12, *.pfx,
  credentials.*, *password*, *token*, id_rsa*, id_ed25519*
  ```
  可通过 `--include-sensitive` 强制纳入（CLI/IM 参数，默认 false）
- **无变更检测**：diff 为空时直接报告 "No changes to review"，workflow 正常终止
- **排除审计**：所有被排除的文件记入 `excludedFiles`，ReportGenerator 在报告中显式列出

---

## 6. Code Review Flow (Detailed)

### 6.1 状态机

代码审查 MVP 使用与 spec-review **相同的 5 步状态机**：

```
start(scope, config)
  |-- diffReader.createSnapshot(scope)    // 冻结快照（含 blob SHA，不含 content）
  |-- store.createRun(meta)               // meta.workflow_type = 'code-review'
  |-- store.saveRoundArtifact('review-snapshot.json', snapshot)  // 持久化快照
  v
=== Round Loop =============================================
|                                                          |
|  Step A: Codex blind code review                        |
|  |-- packBuilder.buildCodeReviewPack(runId, round)      |
|  |-- promptAssembler.renderCodeReviewPrompt(pack)       |
|  |-- modelInvoker.invokeCodex(prompt, {signal})         |
|  |-- jsonParser.parse -> CodexCodeReviewOutput          |
|  |-- store.saveRoundArtifact(R{N}-codex-review.md)      |
|  |-- updateMeta(current_step='issue_matching')          |
|                                                          |
|  Step B1: Issue matching                                 |
|  |-- issueMatcher.processFindings(findings, ledger)     |
|  |     |-- 新增文件路径 + 行号匹配策略                     |
|  |-- store.saveLedger(updated)                           |
|  |-- updateMeta(current_step='pre_termination')          |
|                                                          |
|  Step B2: Pre-termination check                          |
|  |-- terminationJudge.judge({..., acceptedIsTerminal})   |
|  |-- acceptedIsTerminal=true: accepted 不算 unresolved   |
|                                                          |
|  Step C: Claude code review decision                     |
|  |-- packBuilder.buildClaudeCodeReviewInput(...)         |
|  |     |-- 不包含 previousDecisions（fresh）              |
|  |     |-- ledgerSummary 不含 decision_reason             |
|  |-- promptAssembler.renderClaudeCodeReviewPrompt(input) |
|  |-- modelInvoker.invokeClaude(prompt, {signal})         |
|  |-- jsonParser.parse -> ClaudeCodeReviewDecision        |
|  |-- decisionValidator.validate(...)                     |
|  |     |-- 验证 fix_instruction（accept 时必填）           |
|  |     |-- 不验证 resolves_issues（code-review 无此字段）  |
|  |-- 更新 IssueLedger（accept/reject/defer 状态转移）    |
|  |     |-- accept → status=accepted                      |
|  |     |--   decision_reason = decision.reason            |
|  |     |--   fix_instruction = decision.fix_instruction   |
|  |     |-- 不执行 PatchApplier（review-only）             |
|  |     |-- 不执行 resolves_issues 映射                    |
|  |-- store.saveLedger(updated)                           |
|  |-- store.saveRoundArtifact(R{N}-claude-decision.md)    |
|  |-- updateMeta(current_step='post_decision')            |
|                                                          |
|  Step D: Post-termination check                          |
|  |-- terminationJudge.judge({...})                       |
|  |-- 同 spec-review 逻辑                                |
|                                                          |
|  round++                                                 |
============================================================
  v
reportGenerator.generate(runId)   // 生成审查报告
workflow_completed
```

### 6.2 终止条件对齐

代码审查的终止条件**全部复用** spec-review 的 TerminationJudge 规则，唯一差异是 `acceptedIsTerminal` 影响 "unresolved" 的计算：

| 优先级 | 条件 | 动作 | code-review 行为 |
|--------|------|------|-----------------|
| 1 | Codex LGTM + 无 unresolved | 终止 | unresolved = open + deferred（accepted 不算） |
| 2 | repeat_count ≥ 2（死锁） | 暂停→人工 | 同 spec-review |
| 3 | 连续 2 轮无新 high/critical | 终止 | **生效** — 避免为 low issue 浪费调用 |
| 4 | 所有 unresolved 都是 low | 终止 | **生效** — style 级别自动收敛 |
| 5 | max_rounds 到达 | 终止 | 同 spec-review |

> **对齐声明**：`only_style_issues` 和 `no_new_high_severity` 在 code-review 中**同样启用**。
> 这意味着即使仍有 open 的 low severity issue，如果连续 2 轮没新高危发现，工作流会正常终止。
> 这是有意的——低优先级问题不应阻塞审查流程的收敛。

### 6.3 Step C 的关键差异（与 spec-review 对比）

在 `workflow-engine.ts` 的 Step C 中，以下逻辑根据 `profile.behavior` 条件执行：

```typescript
// Step C: Claude decision
// ... (invoke Claude, parse output, validate) ...

// 更新 Ledger — 两种模式共用
// updateIssueStatus 对所有 action 都写入 decision_reason：
//   accept  → status=accepted, decision_reason=reason
//   reject  → status=rejected, decision_reason=reason
//   defer   → status=deferred, decision_reason=reason
// 这确保 ReportGenerator 对任何 action 都能展示 reason。
for (const decision of validatedDecisions) {
  updateIssueStatus(ledger, decision);
}

// 条件执行：仅 spec-review
if (profile.behavior.applyPatches) {
  // PatchApplier 逻辑
  const patches = jsonParser.extractPatches(raw, parsed);
  if (patches.specPatch) { patchApplier.apply(spec, patches.specPatch); }
  if (patches.planPatch) { patchApplier.apply(plan, patches.planPatch); }
}

// 条件执行：仅 spec-review
if (profile.behavior.trackResolvesIssues) {
  // resolves_issues 映射逻辑
  if (parsed.resolves_issues) {
    markIssuesResolved(ledger, parsed.resolves_issues);
  } else {
    emitEvent('resolves_issues_missing');
  }
}

// code-review 特有：reason 和 fix_instruction 分别存储到 Issue 的独立字段
if (profile.behavior.requireFixInstruction) {
  for (const decision of validatedDecisions) {
    const issue = ledger.issues.find(i => i.id === decision.issue_id);
    if (issue && decision.action === 'accept') {
      issue.decision_reason = decision.reason;            // "为什么接受"
      issue.fix_instruction = decision.fix_instruction;   // "怎么修"
    }
  }
}
```

### 6.3 Checkpoint Resume

完全复用 spec-review 的 resume 逻辑。因为步骤序列和检查点机制完全相同：

- `codex_review`: 检查 `R{N}-codex-review.md` 是否存在
- `issue_matching`: 检查 `issue_matching_completed` 事件
- `pre_termination`: 直接跳到 B2
- `claude_decision`: 检查子检查点事件
- `post_decision`: 跳到 D

---

## 7. IssueMatcher Enhancement

### 7.1 新增匹配策略：文件路径 + 行号

在现有的 4 级匹配策略基础上，为 `CodeFinding` 类型新增第 2.5 级匹配：

```
匹配优先级：
1. 精确描述匹配（不变）
2. 证据 + 严重性匹配（不变）
2.5 [新增] 文件路径 + 行号重叠 + 相同分类 + 相近严重性
3. 标识符重叠（不变）
4. 无匹配 → 新建 Issue
```

> **注意**：策略 2.5 不检查描述相似度。category + severity + 位置重叠已足够区分。
> 同文件相近行号 + 相同 category 的两个不同问题非常罕见；即使误合并，
> repeat_count 机制会在后续轮次处理。MVP 阶段不引入描述相似度，避免复杂度。

**新策略细节**：

```typescript
/**
 * 文件路径 + 行号重叠匹配（仅对 CodeFinding 生效）
 *
 * 条件（全部满足）：
 * 1. finding.file === issue.source_file（结构化字段，非 evidence 解析）
 * 2. 行号范围有重叠（任一行在另一个范围内）
 * 3. finding.category === issue.category（结构化字段）
 * 4. 严重性相近（±1 级）
 *
 * 数据来源：Issue 的结构化可选字段（source_file、source_line_range、category），
 * 由 IssueMatcher.processFindings() 在创建新 Issue 时从 CodeFinding 写入。
 */
function matchByFileLocation(finding: CodeFinding, issue: Issue): boolean {
  if (!issue.source_file || !issue.source_line_range) return false;

  return (
    finding.file === issue.source_file &&
    rangesOverlap(finding.line_range, issue.source_line_range) &&
    finding.category === issue.category &&
    severityClose(finding.severity, issue.severity)
  );
}
```

> **设计说明**：不再从 `evidence` 字符串中解析文件路径和行号。
> Issue 的 `source_file`、`source_line_range`、`category` 是正式的结构化字段，
> 由 IssueMatcher 在创建 Issue 时直接从 `CodeFinding` 拷贝写入。
> 这消除了格式约定的脆弱性，也让 ReportGenerator 可以直接按文件和分类分组。

### 7.2 向后兼容

- 新策略只在 finding 具有 `file` 和 `line_range` 字段时生效
- 对于 `SpecReviewPack` 的 `Finding`（无 file/line_range），自动跳过此策略
- 现有的 spec-review 匹配行为完全不受影响

---

## 8. DecisionValidator Adaptation

### 8.1 条件验证规则

```typescript
class DecisionValidator {
  validate(
    decisions: Decision[] | CodeReviewDecisionItem[],
    context: {
      resolves_issues?: string[];        // spec-review 提供
      ledger: IssueLedger;
      currentRoundFindings: Array<{ issueId: string }>;
      profile: WorkflowProfile;          // [新增] 根据 profile 决定验证规则
    },
  ): { valid: true } | { valid: false; errors: string[] };
}
```

**验证规则矩阵**：

| 验证规则 | spec-review | code-review |
|----------|------------|-------------|
| issue_id 引用已知 issue | ✅ | ✅ |
| 无重复 issue_id | ✅ | ✅ |
| expectedDecisionIds 覆盖检查 | ✅ | ✅ |
| resolves_issues 引用合法 | ✅ | ❌ 跳过 |
| accept 时 fix_instruction 必填 | ❌ 不检查 | ✅ |

> **expectedDecisionIds 概念**：
>
> Validator 不再只检查"每个 finding 有对应 decision"，而是统一为 expectedDecisionIds：
> - **有新 findings 时**：expectedDecisionIds = 本轮所有 finding 的 issue ID
> - **无新 findings 但有 unresolved issues 时**：expectedDecisionIds = unresolved issue ID 列表
>   （对应 prompt 中"Codex found no new issues, please address remaining unresolved issues"场景）
> - 验证：decisions 必须覆盖所有 expectedDecisionIds
>
> 这同时覆盖了 spec-review 和 code-review，避免 Claude 返回空 decisions 被放过。

---

## 9. Prompt Templates

### 9.1 Codex 代码盲审 (code-review-pack.md)

```markdown
You are an independent code reviewer. Review the following code changes rigorously.

Your responsibilities:
- Find bugs, logic errors, and potential runtime failures
- Identify security vulnerabilities (injection, auth bypass, data exposure)
- Check error handling completeness (missing try-catch, unchecked null)
- Assess type safety and potential type errors
- Identify performance issues (N+1 queries, memory leaks, unnecessary allocations)
- Evaluate concurrency safety (race conditions, deadlocks)
- Check code readability and maintainability
- Note missing or inadequate test coverage
- Focus on issues in the CHANGED CODE, not pre-existing issues
- Do NOT re-raise issues listed in "Previously Rejected" unless you have strong new evidence

Output format (strict JSON):
{
  "findings": [{
    "issue": "description of the problem",
    "severity": "critical|high|medium|low",
    "file": "path/to/file.ts",
    "line_range": { "start": 10, "end": 25 },
    "evidence": "[path/to/file.ts:10-25] relevant code snippet or reference",
    "suggestion": "proposed fix or improvement",
    "category": "bug|security|performance|error_handling|type_safety|concurrency|style|architecture|test_coverage|documentation"
  }],
  "overall_assessment": "lgtm|minor_issues|major_issues",
  "summary": "one-paragraph summary of the review"
}

IMPORTANT:
- severity must be one of: critical, high, medium, low (exactly these values)
- category must be one of the values listed above (exactly these values)
- evidence MUST start with [file:line-line] format for precise location tracking
- Focus on the DIFF — changes are what matter, not pre-existing code

## Code Changes (diff)
{{diff}}

## Changed Files (content for context; large files may be truncated to diff hunks ± surrounding lines)
{{changed_files}}

## Unresolved Issues (focus here)
{{unresolved_issues}}

## Previously Accepted (confirmed issues — do NOT re-raise, already tracked)
{{accepted_issues}}

## Previously Rejected (do not re-raise without new evidence)
{{rejected_issues}}

## Previous Rounds Summary
{{round_summary}}

## Current Round
{{round}}

## Reference Files
{{context_files}}
```

### 9.2 Claude 代码仲裁 (code-review-decision.md)

```markdown
An independent reviewer (Codex) completed round {{round}} of code review.

Evaluate each finding and decide:
- **accept**: The issue is valid. You MUST provide a `fix_instruction` with specific, actionable guidance.
- **reject**: The issue is invalid, a false positive, or already handled. Explain why.
- **defer**: Valid but low priority, can be addressed later.

Each finding below has an assigned issue ID. Use these IDs in your decisions.

## Codex Findings (with assigned IDs)
{{codex_findings_with_ids}}

(If no findings above: Codex found no new issues. Review the remaining unresolved issues
in the ledger below and decide whether to accept, reject, or defer each one.)

## Current Issue Status
{{ledger_summary}}

## Code Changes (diff)
{{diff}}

## Changed Files (content for context; large files may be truncated to diff hunks ± surrounding lines)
{{changed_files}}

Output format (strict JSON):
{
  "decisions": [{
    "issue_id": "ISS-001",
    "action": "accept|reject|defer",
    "reason": "detailed rationale",
    "fix_instruction": "specific fix guidance (REQUIRED when action=accept)"
  }],
  "summary": "overall assessment of the code quality"
}

IMPORTANT:
- When action="accept", you MUST provide "fix_instruction" with specific, actionable guidance
- Be practical — reject stylistic preferences that don't impact correctness
- Consider the full file context, not just the diff, before making decisions
```

### 9.3 Claude 系统角色 (code-review-decision-system.md)

```markdown
You are a senior code reviewer acting as an impartial arbiter.

You receive independent code review findings from another reviewer (Codex).
Your role is to:
1. Filter false positives — Codex sometimes flags valid patterns as issues
2. Validate genuine bugs, security issues, and error handling gaps
3. Provide clear, actionable fix instructions for accepted issues
4. Consider project-wide context and conventions before rejecting

Be rigorous but practical:

REJECT findings that are:
- Stylistic preferences without functional impact
- False positives based on misunderstanding the context
- Already handled elsewhere in the codebase
- Pre-existing issues not introduced by the current changes

ACCEPT findings that are:
- Genuine bugs or logic errors
- Security vulnerabilities
- Missing error handling that could cause runtime failures
- Type safety violations that could cause errors
- Significant performance issues
- Concurrency/race condition risks

When accepting, your fix_instruction should be specific enough that a developer can implement it without ambiguity.
```

---

## 10. ReportGenerator Module

### 10.1 接口

```typescript
/**
 * 生成结构化的代码审查报告。
 *
 * 在工作流完成后调用，从 WorkflowStore 读取所有轮次数据，
 * 生成 Markdown 格式的审查报告。
 */
class ReportGenerator {
  constructor(private store: WorkflowStore);

  /**
   * 生成审查报告并保存到 WorkflowStore。
   *
   * @param runId - 工作流运行 ID
   * @returns 报告内容（Markdown 格式）和结构化数据
   */
  async generate(runId: string): Promise<{
    markdown: string;
    data: CodeReviewReport;
  }>;
}
```

### 10.2 数据来源

> **数据来源分层**：
>
> - **Issue 决策真相源**：IssueLedger — issue 列表、状态、severity、category、source_file、fix_instruction、decision_reason。所有 issue 级别的数据只从 ledger 读取，不 join round artifacts。
> - **报告快照源**：ReviewSnapshot（`review-snapshot.json`）— scope、excluded_files、diff stats、head_commit
> - **元信息源**：WorkflowMeta — run_id、workflow_type、total rounds
>
> ReportGenerator 的输入是三者的组合，不是"只靠 ledger"。
> 但 issue 级别的决策数据（谁 accept 了、理由是什么、修复建议是什么）唯一来源是 ledger。

### 10.3 报告格式

```markdown
# Code Review Report

**Run ID**: 20260323-abc123
**Scope**: branch diff (main...feature-xyz)
**Rounds**: 2
**Generated**: 2026-03-23T10:30:00Z

## Summary

| Metric | Count |
|--------|-------|
| Total findings | 12 |
| Accepted | 7 |
| Rejected (false positive) | 3 |
| Deferred | 2 |

### By Severity
- Critical: 1
- High: 3
- Medium: 5
- Low: 3

### By Category
- Bug: 2
- Security: 1
- Error Handling: 3
- ...

## Conclusion: Issues Found

---

## File Results

### `src/lib/workflow/engine.ts`

| ID | Severity | Category | Lines | Description | Action | Reason | Fix Instruction |
|----|----------|----------|-------|-------------|--------|--------|-----------------|
| ISS-001 | Critical | Bug | 42-48 | Null pointer | Accept | Genuine null deref | Add null check... |
| ISS-002 | Medium | Style | 10 | Unused import | Reject | Used in test file | — |

### `src/lib/workflow/types.ts`

...

---

## Excluded Files

| File | Reason |
|------|--------|
| .env.local | Sensitive file (auto-excluded) |
| assets/logo.png | Binary file |
```

---

## 11. CLI / IM Command Extension

### 11.1 CLI

```bash
# 审查已暂存的变更（默认）
npx workflow code-review

# 审查工作区未暂存变更
npx workflow code-review --unstaged

# 审查指定 commit
npx workflow code-review --commit HEAD

# 审查 commit 范围（两点 diff：A..B）
npx workflow code-review --range "main..HEAD"

# 审查分支差异（三点 diff：A...B，只看分支新增）
npx workflow code-review --branch-diff main

# 带上下文文件 + 排除测试
npx workflow code-review --context tsconfig.json,.eslintrc.js --exclude "*.test.ts"
```

### 11.2 IM 命令

```
/workflow start --type code-review [scope] [options]

scope（互斥，默认 --staged）:
  --staged                      审查已暂存的变更
  --unstaged                    审查未暂存的工作区变更
  --commit [ref]                审查指定 commit（默认 HEAD）
  --range <base>..<head>        审查 commit 范围（两点 diff）
  --branch-diff <base>          审查分支差异（三点 diff，head 默认 HEAD）

options:
  --context file1,file2         额外上下文文件
  --exclude "*.test.ts"         排除文件模式
  --include-sensitive            包含敏感文件（默认排除）
  --model <id>                  Claude 模型（默认 claude-sonnet-4）
  --codex-backend <backend>     Codex 后端（默认 codex）
```

> **设计说明**：
> - `--range` 和 `--branch-diff` 显式分离两种 diff 语义（两点 vs 三点），避免二义性
> - `--range "main..HEAD"` 对应 `git diff main..HEAD`（两点 diff：比较 base tree 与 head tree 的差异）
> - `--branch-diff main` 对应 `git diff main...HEAD`（三点 diff：比较 merge-base 与 head 的差异，即分支分叉后的变更）
> - code-review 模式下**不需要** `<spec> <plan>` 位置参数（这是 spec-review 专有的）
> - 如果 scope 缺省，默认 `--staged`

---

## 12. Error Handling

所有 spec-review 的错误处理机制完全复用。新增以下场景：

| 场景 | 处理 | 事件类型 |
|------|------|---------|
| git 不可用 | 检查 `git --version`，失败则抛出 | `workflow_failed` |
| 无变更文件 | diff 为空，直接报告 "No changes to review" | `workflow_completed` |
| 变更文件过多 | 截断到 `max_changed_files_full_content`，余下只保留 diff | 正常流程 |
| 单文件过大 | 截断到 `max_file_lines` 行 | 正常流程 |
| 二进制文件 | 自动跳过 | 正常流程 |
| `.env` 等敏感文件 | 自动排除，emit warning | `workflow_started` data 中标记 |

---

## 13. Acceptance Criteria

### P1b-CR-0 (Review-Only MVP)

**状态机语义（INV-1）**

- [x] `WorkflowProfile.behavior.acceptedIsTerminal` 定义并生效
- [x] code-review: accepted 不阻塞 LGTM 终止（unresolved 计算排除 accepted）
- [x] spec-review: accepted 仍是中间态（回归不变）
- [x] 所有 issue 裁决完毕 + Codex 无新发现 → 正常终止

**数据模型（INV-2 + INV-3）**

- [x] `Issue.fix_instruction` 独立可选字段（不复用 decision_reason）
- [x] `Issue.source_file` / `source_line_range` / `category` 由 IssueMatcher 写入
- [x] ReportGenerator 只读 IssueLedger 生成完整报告（不 join round artifacts）
- [x] 报告含 reason 和 fix_instruction 分列展示

**DiffReader（INV-4）**

- [x] 仓库检测：`git rev-parse --is-inside-work-tree`（兼容 worktree）
- [x] 文件枚举：`git diff --name-status` 解析 A/M/D/R/C
- [x] 删除文件：`git show <base>:<path>` 获取原始内容
- [x] 重命名/复制：保留 old_path + new_path
- [x] 二进制文件：跳过并记入 excludedFiles
- [x] 敏感文件：默认排除并记入 excludedFiles，`--include-sensitive` 可覆盖
- [x] diff 为空：报告 "No changes to review"，workflow 正常终止（非 failed）
- [x] 冻结 `ReviewSnapshot` 持久化真实 `diff` 与 `changed_files`，Step A / C 不再使用空占位上下文

**CLI/IM（INV-5 + INV-6）**

- [x] `--range A..B`（两点 diff）和 `--branch-diff base`（三点 diff）语义分离
- [x] code-review 不要求 `<spec> <plan>` 位置参数
- [x] 报告含 "Excluded Files" 节（敏感/二进制/超限/pattern 排除）
- [x] workflow 完成后在 run 目录生成 `code-review-report.md` 与 `code-review-report.json`
- [x] IM 完成消息显式提示报告路径

**引擎泛化**

- [x] `WorkflowProfile` 接口定义完成，含所有 behavior 标志
- [x] SPEC_REVIEW_PROFILE 和 CODE_REVIEW_PROFILE 预定义
- [x] `workflow-engine.ts` 根据 profile.behavior 条件执行 PatchApplier/resolves_issues/fix_instruction
- [x] `workflow-engine.ts` runLoop Step A/C 根据 profile.type 路由 pack/prompt 方法
- [x] 现有 spec-review / workflow 回归通过（回归安全）— 当前单元测试基线 `367/367`

**模块实现**

- [x] `CodeReviewPack`、`CodeFinding`、`CodeReviewCategory`、`ChangeType`、`ReviewScope` 类型定义
- [x] `PackBuilder.buildCodeReviewPack()` 正确组装代码审查 Pack
- [x] `PackBuilder.buildClaudeCodeReviewInput()` 不包含 previousDecisions（fresh）
- [x] `PromptAssembler` 根据 profile 加载正确模板
- [x] 3 个新模板：`code-review-pack.md`, `code-review-decision.md`, `code-review-decision-system.md`
- [x] `IssueMatcher` 文件路径+行号匹配使用 Issue 结构化字段（非 evidence 解析）
- [x] `DecisionValidator` 根据 profile 条件验证
- [x] `TerminationJudge` 接收 acceptedIsTerminal 标志
- [x] `ReportGenerator` 生成 Markdown + JSON 报告
- [x] `createCodeReviewEngine()` 工厂函数
- [x] `CODE_REVIEW_OVERRIDES` 配置定义（内联于 CODE_REVIEW_PROFILE.configOverrides）
- [x] `WorkflowStore.saveSnapshot()` / `loadSnapshot()` 持久化 ReviewSnapshot

**集成**

- [ ] CLI `code-review` 子命令（未实现独立 CLI，通过 IM 入口覆盖）
- [x] IM `/workflow start --type code-review` 支持
- [x] 完整 2-3 轮代码审查集成测试（mock ModelInvoker）— 4 组 14 个用例
- [x] Checkpoint resume 在 code-review 模式下正常工作（resolveProfileFromType）
- [x] TypeScript 编译通过，无类型错误
- [x] 完成事件携带报告路径，文本/卡片完成态均可提示报告已生成

---

## 14. Implementation Sequence

```
Phase 1: 类型 + 引擎泛化（~0.5 天）  ✅ Session 24
├── types.ts: 新增所有代码审查类型 + WorkflowProfile
├── workflow-engine.ts: 引入 profile 参数，条件执行步骤
└── 回归测试 spec-review

Phase 2: DiffReader + PackBuilder + 模板（~1 天）  ✅ Session 24
├── diff-reader.ts: git diff 解析模块
├── pack-builder.ts: buildCodeReviewPack + buildClaudeCodeReviewInput
├── prompt-assembler.ts: renderCodeReviewPrompt + renderClaudeCodeReviewPrompt
└── 3 个新模板文件

Phase 3: IssueMatcher + Validator 增强（~0.5 天）  ✅ Session 25
├── issue-matcher.ts: 文件路径+行号匹配
└── decision-validator.ts: 条件验证

Phase 4: ReportGenerator + 工厂 + CLI/IM（~0.5 天）  ✅ Session 25 + 26
├── report-generator.ts: 报告生成
├── index.ts: createCodeReviewEngine
├── workflow-command.ts: --type code-review + handleStartCodeReview
├── workflow-store.ts: saveSnapshot / loadSnapshot
└── workflow-engine.ts: runLoop Step A/C profile 路由 + start() snapshot 参数

Phase 5: 集成测试 + 端到端验证（~0.5 天）  ✅ Session 26
├── workflow-code-review.test.ts: 4 组 14 个集成测试
├── workflow-store.test.ts: 3 个 snapshot 测试
├── workflow-command.test.ts: 更新 10 个断言适配 workflowType
├── 全量回归: 238/238 通过
└── 文档更新: spec AC + plan 状态
```

**总预估**: 2.5-3 天  |  **实际**: Session 24-26（跨 3 个 session）

---

## Appendix A: WorkflowEngine 改动对比

```typescript
// === 改动前（硬编码 spec-review）===
class WorkflowEngine {
  async start(params: { spec: string; plan: string; config?: ... }) { ... }
}

// === 改动后（参数化 profile）===
class WorkflowEngine {
  constructor(
    ...,
    private profile: WorkflowProfile,   // [新增] 注入 profile
  );

  // 保留原有 start() 签名（spec-review 兼容）
  async start(params: { spec: string; plan: string; config?: ... }): Promise<string>;

  // 新增代码审查入口
  async startCodeReview(params: {
    scope: ReviewScope;
    cwd: string;
    config?: Partial<WorkflowConfig>;
    contextFiles?: ContextFile[];
  }): Promise<string>;
}
```

## Appendix B: 与结论文档的对齐

对比 `docs/workflow-conclusions-summary.md` §3.3 的原始设计：

| 原始设计 | 本 Spec | 说明 |
|---------|---------|------|
| 5 步流程（含修复和快审） | 5 步状态机（复用 spec-review 骨架） | MVP 跳过修复步骤 |
| Claude 和 Codex 都 fresh | ✅ Claude 不收 previousDecisions | 完全对齐 |
| issue list + fix instructions | ✅ CodeReviewDecisionItem.fix_instruction | 完全对齐 |
| 最大 3 轮 | ✅ max_rounds: 3 | 完全对齐 |
| 修复步骤 | 延后到 P1b-CR-1 | MVP 先 review-only |
