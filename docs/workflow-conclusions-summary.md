# Workflow Engine 全结论汇总文档

> **用途**：供用户据此优化飞书 `/workflow` 工作流
>
> **生成日期**：2026-03-21
>
> **覆盖范围**：5 个 AI 方案 → 最终方案 v2 → Spec/Plan 设计 → 3 轮 Codex 对抗审查 → 13 项修复闭环 → 15 个开发 Session → 当前实现状态 → 优化建议

---

## 一、项目全景

### 1.1 核心痛点

用户日常使用 Claude + Codex 双模型协作，有三种固定工作流（Spec审查、开发编排、代码审查）。当前全部**手动操作**：

| 痛点 | 耗时 |
|------|------|
| 手动组装 Codex 累积 prompt（spec + plan + 历史意见 + 反馈） | 5-10 min/轮 |
| 手动搬运 Codex 结果给 Claude | 2-3 min/轮 |
| 手动追踪 issue 接受/拒绝/延后状态 | 持续心智负担 |
| 上下文压缩后历史丢失，无持久化 | 不可追溯 |

### 1.2 目标

在飞书群内通过 `/workflow` 命令一键启动自动化工作流，Bot 在后台编排 Claude + Codex 多轮协作，用户只在关键节点做人工裁决。

### 1.3 架构总览

```
┌──────────────────────────────────────┐
│       飞书 / Telegram / Discord 群     │
│  （唯一的人机界面，一个 Bot 门面）       │
└──────────────┬───────────────────────┘
               │ 消息 / 按钮回调
┌──────────────▼───────────────────────┐
│     Claude-to-IM Bridge（交互层）      │
│  • /workflow 命令路由                  │
│  • 进度推送 + 卡片渲染                 │
│  • 飞书按钮 → approve / reject        │
│  ⚠ Bridge 核心层不放编排逻辑           │
└──────────────┬───────────────────────┘
               │ 内部调用
┌──────────────▼───────────────────────┐
│     Workflow Engine（编排层）           │  ← 独立模块 src/lib/workflow/
│  • PackBuilder（从 Store 组装 Pack）   │
│  • PromptAssembler（模板渲染）          │
│  • ModelInvoker（Agent SDK / Codex CLI）│
│  • TerminationJudge（动态终止判断）     │
│  • IssueLedger（决策台账）             │
│  • DecisionValidator（语义校验）        │
│  • PatchApplier（文档补丁）            │
│  • ContextCompressor（上下文压缩）      │
└───────┬─────────────┬────────────────┘
        │             │
   Claude Agent SDK  Codex CLI (codeagent-wrapper)
   (本地，无需API Key) (天然 fresh)
        │             │
┌───────▼─────────────▼────────────────┐
│     Artifact Store（持久层）           │
│  .claude-workflows/{run-id}/          │
│  ├── meta.json（断点续传）             │
│  ├── spec-v{N}.md / plan-v{N}.md      │
│  ├── issue-ledger.json                │
│  ├── events.ndjson                    │
│  └── rounds/（每轮原始输入输出）        │
└───────────────────────────────────────┘
```

### 1.4 架构边界规则

| 层 | 职责 | 禁止做的事 |
|---|---|---|
| **Bridge 交互层** | 命令路由、消息推送、按钮回调 | ❌ 不放工作流状态机、不做 Pack 组装 |
| **Workflow Engine** | 编排、终止判断、Pack 构建、模型调用 | ❌ 不直接操作 IM API |
| **Artifact Store** | 读写文件、事件日志 | ❌ 不做业务判断 |

---

## 二、5 个 AI 方案的共识结论（高置信度，全部采纳）

1. **Claude = 控制面，Codex = 执行/审查面** — 不做对等协作
2. **一个 Bot 做门面** — 群里只有一个 Bot 发言，后端双引擎编排
3. **结构化 Pack 交接** — 不靠聊天记录搬运信息，靠标准化工件包
4. **工件必须落盘** — 不依赖上下文窗口保持历史，磁盘是事实源
5. **动态终止** — "有增量信息才继续"而不是"固定 N 轮"
6. **分阶段实施** — 先手动验证协议，再自动化，再接入平台

### 各 AI 贡献取舍

| AI | 核心贡献 | 采纳 | 不采纳 |
|---|---|---|---|
| AI-1 | 元模式表格（上下文策略 × 循环步数 × 终止条件） | ✅ 元模式抽象精准 | ❌ 对 SO 评估过于绝对 |
| AI-2 | 4 盲点（飞书场景、Prompt 复杂度、SO 评估、工件持久化）+ 三阶段路径 | ✅ 模板系统；✅ 三阶段路径 | ❌ Handlebars 模板略重 |
| AI-3 | "结构化对抗性协作"理论框架；德尔菲法 / Manager-Worker / Adversarial Review | ✅ 理论框架；✅ "协议先于平台" | ❌ 5 次审查不过度但需动态终止 |
| AI-4 | "五个协议"设计框架；Pack 结构；"收敛优于轮次" | ✅ Pack 交接包是核心；✅ Issue Ledger | ❌ 2 轮封顶太激进 |
| AI-5 | 三层架构；单 Bot 门面；增量改造 SO (~400 行) | ✅ 单 Bot + 后端编排；✅ SO 评估最务实 | ❌ Phase 0 纯手动价值有限 |

---

## 三、三大工作流设计结论

### 3.1 工作流 1：Spec/Plan 审查（德尔菲法）✅ 已实现

**角色分工**：Claude 保持上下文做裁决，Codex 清空上下文做盲审。

**每轮流转**：

```
Claude(kept) ←→ Codex(fresh_with_pack)

Codex 每轮收到 SpecReviewPack:
{
  spec,                    // 当前 spec 全文
  plan,                    // 当前 plan 全文
  unresolved_issues,       // 只传未解决的（open/deferred）
  rejected_issues,         // 被拒绝的（只含描述，不含拒绝理由，避免偏见）
  context_files,           // 参考文件（路径+内容）
  round_summary,           // "上轮新增 3 个问题，接受 2 个，拒绝 1 个"
  round                    // 当前轮次
}

Codex 输出:
  findings: [{issue, severity, evidence, suggestion}]
  overall_assessment: 'lgtm' | 'minor_issues' | 'major_issues'

Claude 裁决:
  decisions: [{issue_id, action, reason}]
  spec_patch / plan_patch  // 修改的文档片段
  resolves_issues          // 明确指定哪些 issue 被此次补丁解决
```

**5 步状态机（每轮）**：

```
Step A (codex_review)    → Codex 盲审
Step B1 (issue_matching) → IssueMatcher 匹配/去重
Step B2 (pre_termination)→ TerminationJudge 预检
Step C (claude_decision) → Claude 裁决（含4个子检查点 C1-C4）
Step D (post_decision)   → 终止判断 + 轮次收尾
```

**动态终止条件（优先级从高到低）**：

| 优先级 | 条件 | 动作 |
|--------|------|------|
| 1 | Codex 输出 LGTM 且无未解决 issue | 终止 |
| 2 | 同一 issue 连续 2 轮被拒又被提（repeat_count ≥ 2） | 暂停→人工介入 |
| 3 | 连续 2 轮无新增 high/critical | 终止 |
| 4 | 所有未解决 issue 都是 low 级别 | 终止 |
| 5 | 达到最大轮次（默认 3，架构级 5） | 终止 |

**Claude 上下文压缩策略**：token > 60% 窗口容量 或 第 4 轮时触发，只保留最新 spec/plan + Ledger 摘要 + 最近一轮完整内容。

### 3.2 工作流 2：开发编排（Manager-Worker）⬜ 未实现

**角色分工**：Claude 保持上下文做项目经理，Codex 清空上下文做执行者。

**Pack 结构**：

```json
// TaskPack (Claude → Codex)
{
  "goal": "当前 WorkItem 目标",
  "scope": "允许修改的文件范围",
  "context_files": "参考文件列表",
  "acceptance": "验收标准",
  "forbidden": "禁止修改的范围",
  "completed_summary": "已完成工作摘要",
  "dependencies": "依赖的上游产物",
  "workspace_strategy": "branch / worktree 隔离策略"
}

// DeliveryPack (Codex → Claude)
{
  "changes": "改了什么",
  "files_modified": ["..."],
  "test_results": "测试结果",
  "risks": "遗留风险",
  "next_suggestion": "建议下一步"
}
```

**并行隔离策略**：

| 策略 | 适用场景 | 实现方式 |
|------|---------|---------|
| 分支隔离（默认） | 多数场景 | 每个 WorkItem 在独立 feature branch |
| Worktree 隔离 | 需同时编译/测试 | `git worktree add` |
| 文件所有权 | 轻量并行 | TaskPack.scope 严格互斥 |

### 3.3 工作流 3：代码审查（对抗性验证）⬜ 未实现

**角色分工**：Claude 和 Codex **都清空上下文**，避免确认偏差。

**5 步流程**：

```
Step 1: Codex 盲审 (fresh) → issue list
Step 2: Claude 仲裁 (fresh) → 过滤误报 + 生成修复指令
Step 3: Codex 修复 (fresh) → 代码修改
Step 4: Codex 快审 (fresh) → diff 级检查
Step 5: 有新问题→回 Step 2；无新问题→结束（最大 3 轮）
```

---

## 四、核心数据结构结论

### 4.1 Issue Ledger（决策台账）— 单一事实源

```typescript
interface Issue {
  id: string;                      // "ISS-001"
  round: number;                   // 首次提出的轮次
  raised_by: 'codex' | 'claude' | 'human';
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  evidence: string;
  status: 'open' | 'accepted' | 'rejected' | 'deferred' | 'resolved';
  decided_by?: 'claude' | 'human';
  decision_reason?: string;
  resolved_in_round?: number;
  repeat_count: number;            // 死循环检测
  last_processed_round?: number;   // 幂等性标记
}
```

**Issue 生命周期**：

```
open → accepted → resolved（通过 resolves_issues 映射 + 补丁成功）
open → accept_and_resolve → resolved（无需补丁直接解决）
open → rejected → open（Codex 再次提出，repeat_count++）
open → deferred（延后，不增加 repeat_count）
```

### 4.2 Claude 决策输出

```typescript
interface ClaudeDecisionOutput {
  decisions: Decision[];           // 逐条裁决
  spec_updated: boolean;
  plan_updated: boolean;
  spec_patch?: string;             // 修改的 spec 片段
  plan_patch?: string;             // 修改的 plan 片段
  resolves_issues?: string[];      // 此轮补丁解决了哪些 issue（必填！缺失则不自动 resolve）
  summary: string;
}
```

### 4.3 Artifact Store 目录

```
.claude-workflows/
├── templates/                     # Prompt 模板
│   ├── spec-review-pack.md        # Codex 盲审 prompt
│   ├── claude-decision.md         # Claude 裁决 prompt
│   ├── claude-decision-system.md  # Claude 系统角色定义
│   └── round-summary.md           # 轮次摘要模板
├── schemas/                       # JSON Schema
│   ├── issue-ledger.schema.json
│   ├── meta.schema.json
│   └── event.schema.json
└── runs/{run-id}/                 # 运行时数据（.gitignore）
    ├── meta.json                  # 状态 + 断点续传
    ├── spec-v1.md ... spec-v{N}.md
    ├── plan-v1.md ... plan-v{N}.md
    ├── issue-ledger.json
    ├── events.ndjson
    └── rounds/
        ├── R1-pack.json
        ├── R1-codex-review.md
        ├── R1-claude-input.md
        ├── R1-claude-decision.md
        └── ...
```

---

## 五、Codex 对抗审查发现的全部问题及修复

> 3 轮 Codex 盲审，累计 27 个 issue 条目，归类为 13 个独立问题域，**全部已在 Spec+Plan 中修复**。

### 5.1 Critical × 1

| # | 问题 | 描述 | 修复方案 | 修复位置 |
|---|------|------|---------|---------|
| **C1** | Step C 恢复不幂等 | 崩溃后 `resume()` 复用原始 Claude 输出重新执行补丁/状态迁移，导致重复版本和状态污染 | 把 Step C 拆成 4 个子检查点（C1:raw_saved → C2:decisions_validated → C3:ledger_updated → C4:committed），引入幂等操作日志 | Spec §7.1 + §7.3 |

### 5.2 High × 9

| # | 问题 | 描述 | 修复方案 | 修复位置 |
|---|------|------|---------|---------|
| **H1** | Claude 解析失败无闭环 | 只有 extractPatches() 回退，缺 decisions[] 降级策略 | 新增 Safety Protocol：decisions[] 不可恢复时禁止所有副作用，转 human_review | Spec §6.8 + §10 |
| **H2** | ContextCompressor 接口不匹配 | 返回 `{text}` 与 SpecReviewPack 结构不兼容 | 改为结构化输入/输出，返回压缩后的 SpecReviewPack | Spec §6.6 |
| **H3** | Patch-Resolve 一致性 | 补丁 heading 未命中时仍允许 resolved，"文档未改/状态已关"假阳性 | 新增 Patch-Resolve Consistency Rule：failedSections 阻止对应 issue 被 resolve | Spec §6.10 |
| **H4** | 终止条件覆盖不全 | 只看 `open` issue，遗漏 `accepted`/`deferred` | 统一为 open \| accepted \| deferred 都算"未解决" | Spec §6.5 / §7.2 |
| **H5** | 终止状态未持久化 | "连续无高危"计数没有持久化，resume 后丢失 | WorkflowMeta 新增 termination_state 字段 | Spec §4.5 |
| **H6** | 决策缺乏语义校验 | 重复/未知 issue_id、resolves_issues 指向非法目标 | 新增 DecisionValidator（5 项校验） | Spec §6.11 |
| **H7** | IssueMatcher 非幂等 | 崩溃重跑会重复 repeat_count++ | 增加 last_processed_round 字段，同轮重跑跳过 | Spec §4 / §6.9 |
| **H8** | Empty-findings 模板死锁 | 禁止 accept，卡死旧 issue 补丁闭环 | 允许 accept 动作 | Spec §8.2 |
| **H9** | 原子写入缺失 | 写截断 JSON 不可恢复 | 新增 Atomic Write Protocol（write-tmp → fsync → rename） | Spec §6.7 |

### 5.3 Medium × 3

| # | 问题 | 描述 | 修复方案 | 修复位置 |
|---|------|------|---------|---------|
| **M1** | 配置契约未收口 | max_deferred_issues 散落，auto_terminate 未使用 | 统一到 WorkflowConfig + TerminationJudge 消费 | Spec §4.5 / §9 |
| **M2** | Exports 路径冲突 | Spec vs Plan 的 package.json exports 不一致 | 修正为 `"./workflow/*"` | Plan Step 13 |
| **M3** | 模板占位符污染 | 占位符定义混入字面值 | 清理占位符说明 | Spec §8.2 |

---

## 六、代码实现过程中发现的全部问题及修复

> 15 个开发 Session，以下是每个 Session 中发现的关键问题和修复。

### 6.1 Session 1-4：基础实现（无重大问题）

| Session | 产出 | 关键数据 |
|---------|------|---------|
| S1 | Bridge MVP + backend 切换 | 115 tests |
| S2 | Trellis 追踪建立 | 追踪框架 |
| S3 | P0 完成（模板+Schema） | 3 模板 + 3 Schema |
| S4 | P1a 完整实现 | 14 文件 / 3965 行 / 108 tests / 5-state 状态机 |

### 6.2 Session 5：IM 集成 P2A

**产出**：`/workflow` 命令接入 Bridge

| 项目 | 详情 |
|------|------|
| 新增文件 | `internal/workflow-command.ts` (~400 行) |
| 命令 | `start <spec> <plan>` / `status [run-id]` / `resume <run-id>` / `stop` |
| 架构决策 | 每 chat 单工作流，Map 防并发；后台异步执行，start 立即返回 |
| 测试 | 20 个子命令解析测试，总 128 tests |

### 6.3 Session 6：竞态 + 安全 + 健壮性修复（⚠ 重要）

| 严重度 | 问题 | 修复 |
|--------|------|------|
| **Critical** | 并发 `/workflow start` 竞态 → 孤儿 engine 泄漏 | has()+set() 同步完成，finally 自动清理 |
| **High** | 路径遍历可读任意文件（spec/plan 参数未校验） | 新增 `resolveSafePath()` 校验路径在 cwd 内 |
| **High** | `/stop` 语义矛盾 + 丢弃 runId 参数 | handleStop 接收 cmd，支持 run-id |
| **Medium** | fire-and-forget 中 unhandled rejection | `.catch(() => {})` 吞掉 delivery 失败 |
| **Medium** | push 静默丢弃 delivery 错误 | 改为 `.catch(err => console.error(...))` |
| **Medium** | 每次 status 创建新 WorkflowStore | 模块级 lazy 单例 |
| **Low** | esc() 使用风险 | JSDoc 注释限定 |

额外改进：fire-and-forget 的 then/catch 增加 `current.engine === engine` 守卫，防止误删新 engine 的 slot。

### 6.4 Session 7-9：/status + 工具事件 + 卡片

| Session | 问题 | 修复 |
|---------|------|------|
| S7 | /status 缺少工具调用上下文 | 全局 state 环形缓冲最近 10 条记录 |
| S8 | /status 始终显示 "No tool calls" | Codex 5 个 + Claude 3 个事件检测点 |
| S9 | 飞书最终卡片展示异常 | 修复 footer 和格式问题 |

### 6.5 Session 10-12：引擎增强（⚠ 重要）

| 改进项 | 修改详情 |
|--------|---------|
| **Claude 系统提示** | 新增 `claude-decision-system.md`，定义 Technical Decision Authority 角色 |
| **可配置模型** | `claude_model` / `codex_backend` + `--model` / `--codex-backend` CLI 参数 |
| **超时调优** | 默认从 3min/2min → 90min；Claude max_tokens 4096 → 200K |
| **Store 路径统一** | start/resume/status 统一使用 cwd-based basePath |
| **背压 stdin 写入** | 32KB 分块写入 + drain 背压，防大 prompt 管道溢出 |
| **诊断日志** | spawn/timeout/exit/retry/abort/stdin-error 全路径日志 |
| **CJK token 估算** | CJK 字符 0.67 token vs ASCII 0.25 token |
| **压缩修复** | 压缩结果实际应用到 spec/plan（之前是死代码） |
| **错误处理** | 所有 catch 块添加详细 stack trace |

### 6.6 Session 13：审查问题全闭环 + 事件增强

| 改进项 | 详情 |
|--------|------|
| **ModelInvocationError** | 4xx 错误分类为不可重试，直接抛出而非耗尽重试 |
| **事件载荷丰富化** | 决策统计（接受/拒绝/延后/解决数量）、严重度分布、完成摘要 |
| **默认模型** | 调整为 claude-sonnet-4 |

### 6.7 Session 14：Claude 调用迁移（⚠ 关键修复）

**问题**：spec-review 工作流出现 "Claude 决策超时"，Codex 审查正常。

**根因分析**：

```
项目有两条 Claude 调用路径：
- Bridge 用 Agent SDK（不需 API key）  ← 正常工作
- Workflow 用 HTTP API（需 ANTHROPIC_API_KEY） ← 未设置，立即失败

SDK 抛出认证错误 → withRetry 误分类为"可重试" → 3 次毫秒级失败 → 包装为 TimeoutError
实际 11ms 内就"超时"了（配置是 90 分钟）
```

**修复**：

| 改动 | 说明 |
|------|------|
| `executeClaudeRequest` HTTP API → Agent SDK | 消除 API Key 依赖，统一使用本地 Claude Code |
| `withRetry` 增加 `isNonRetryableError()` | 启发式检测 auth/ENOENT/permission 错误，立即升级 |
| 删除 `vendor-types.d.ts` | SDK 自带类型，旧声明覆盖真实类型 |

Agent SDK 配置：`tools: []`（纯文本）、`persistSession: false`、`maxTurns: 1`、`settingSources: []`（隔离模式）

### 6.8 Session 15：/stop 跨 session 修复

**问题**：飞书派发任务后输入 `/stop`，返回 "No task is currently running."，但旧任务仍在流式输出。

**根因**：`/stop` 通过 session ID 查找活跃任务，但任务运行期间 session 可能已切换（`/new`/`/bind`），用新 session ID 查不到旧任务。

**修复**：引入 `activeTasksByChat` Map（key = `channelType:chatId`），按 chat 维度追踪：

| 改动点 | 说明 |
|--------|------|
| `registerActiveTask()` | 双写 session + chat 两个 Map |
| `clearActiveTask()` | 用 `=== abort` 引用比较防竞态误删 |
| `/stop` | 改用 `getActiveTaskForChat()` 查找 |
| `/new` | 统一为 `abortActiveTaskForChat()`，消除冗余 abort |
| `/bind` | 新增切换前 abort，防旧任务"失联" |
| `/status` | 按 chat 维度查找，显示跨 session 任务信息 |

---

## 七、14 项关键设计决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | 简单 `{{var}}` 模板替换，不用 Handlebars | 减少依赖，P1a 足够 |
| 2 | ModelInvoker 独立抽象，不复用 Bridge 的 LLMProvider | Bridge 返回 `ReadableStream<string>`（SSE），Workflow 返回 `Promise<string>` |
| 3 | ndjson 格式事件日志 | 追加模式，不需解析全文件；兼容 SO |
| 4 | JsonParser 4 策略解析 | Direct → Strip fences → Regex extract → null；应对 LLM 输出格式不确定 |
| 5 | IssueMatcher 先于 TerminationJudge 执行 | 确保终止判断基于去重后的真实数据 |
| 6 | 文件系统存储，不用数据库 | 自包含、手动可检查、符合 .claude-workflows 惯例 |
| 7 | TerminationResult.action 分离 "why" 和 "what" | action 决定终止 vs 暂停，reason 提供审计信息 |
| 8 | LGTM + open-issue 守卫 | Codex 说 LGTM 但有未解决 issue → 不终止，继续 Claude 处理 |
| 9 | 统一超时策略 + TIMEOUT GUARD | ModelInvoker 重试 N 次 → TimeoutError → skip-round → 检查 max_rounds 防无限循环 |
| 10 | 补丁 via PatchApplier（heading 匹配） | 支持 `#` 到 `####` 任意层级；resolves_issues 必填防意外 resolve |
| 11 | AbortController 优雅暂停 | pause() → abort() → 传播到子进程/HTTP → checkpoint 保存 |
| 12 | 写入顺序保证崩溃安全 | raw → ledger → spec/plan → checkpoint event → meta（最后） |
| 13 | accept_and_resolve 直接解决 | 无需补丁的 issue 不会卡在 accepted 状态 |
| 14 | resolves_issues 缺失不自动 resolve | 防止 Claude 遗漏字段导致假解决 |

---

## 八、当前实现状态总览

### 8.1 完成阶段

| 阶段 | 状态 | 详情 |
|------|------|------|
| **P0 协议定义** | ✅ 完成 | 3 模板 + 3 Schema + .gitignore |
| **P1a Spec-Review MVP** | ✅ 完成 | 14 源文件 / 3965 行 / 108 tests |
| **P2A IM 集成** | ✅ 完成 | /workflow 命令 + 事件推送 + 竞态修复 |
| **引擎增强** | ✅ 完成 | system prompt + 可配模型 + 背压 + CJK + Agent SDK 迁移 |

### 8.2 代码文件清单

```
src/lib/workflow/
├── index.ts                  # 公共导出 + createSpecReviewEngine 工厂
├── workflow-engine.ts        # 5-state 循环状态机
├── pack-builder.ts           # Pack 组装（含压缩调用）
├── prompt-assembler.ts       # 模板渲染（支持 system/user prompt 分离）
├── model-invoker.ts          # Agent SDK + Codex CLI（背压+诊断）
├── termination-judge.ts      # 动态终止（5 条件优先级）
├── context-compressor.ts     # 上下文压缩（CJK 感知）
├── workflow-store.ts         # 文件系统持久层（原子写入）
├── json-parser.ts            # 4 策略 JSON 解析
├── issue-matcher.ts          # Issue 去重/匹配（幂等）
├── patch-applier.ts          # 文档补丁（heading 匹配）
├── decision-validator.ts     # 决策语义校验（5 项）
├── cli.ts                    # CLI 入口
└── types.ts                  # 类型定义

src/lib/bridge/internal/
└── workflow-command.ts       # /workflow 命令处理（路径安全+竞态保护）
```

### 8.3 测试覆盖

| 测试集 | 状态 | 覆盖范围 |
|--------|------|---------|
| Workflow / Bridge 单元测试 | ✅ | 覆盖引擎、命令解析、路径安全、桥接核心、回归路径 |
| Code-Review 集成测试 | ✅ | 覆盖 review-only MVP 主链路、报告生成、resume、完成态提示 |
| **当前基线** | `367/367` | `npm run test:unit` |

### 8.4 /workflow 命令当前能力

| 命令 | 功能 | 状态 |
|------|------|------|
| `/workflow start <spec> <plan>` | 启动 Spec-Review 工作流 | ✅ |
| `/workflow start --type code-review [--range A..B|--branch-diff base]` | 启动 Code-Review review-only MVP（IM 入口） | ✅ |
| `/workflow start --model <m> --codex-backend <b>` | 指定模型 | ✅ |
| `/workflow status [run-id]` | 查看进度 | ✅ |
| `/workflow resume <run-id>` | 恢复暂停的工作流 | ✅ |
| `/workflow stop` | 停止当前工作流 | ✅ |

> **说明**：当前 `code-review` 只支持 IM `/workflow` 入口。
> 独立 CLI `code-review` 子命令尚未实现，需要单独排期。

### 8.5 事件推送（已实现）

| 事件 | 推送消息 |
|------|---------|
| 轮次开始 | "🔄 Round {N} started" |
| Codex 审查完成 | 发现数量 + 严重度分布 |
| Claude 裁决完成 | 接受/拒绝/延后/解决统计 |
| 终止 | 原因 + 总结 + 报告路径提示 |
| 人工介入 | 暂停提示 |
| 错误/超时 | 错误详情 |

---

## 九、未完成阶段及待优化方向

### 9.1 P1b：开发流 + 代码审查流（🟡 部分完成）

**预估工作量**：3-5 天

**当前状态说明**：

- `code-review review-only MVP` 已完成 IM 闭环：真实 `diff + changed_files` 输入、Issue Ledger、报告 artifact、resume、完成态提示都已打通
- 独立 CLI `code-review` 子命令 **未实现**
- `dev workflow` 仍未开始

| 子项 | 状态 | 说明 |
|------|------|------|
| Code-Review review-only MVP | ✅ 完成 | IM `/workflow start --type code-review` 可用，完成后落地 Markdown / JSON 报告 |
| 独立 CLI `code-review` 子命令 | ⬜ 未完成 | 当前仅 IM 入口，需单独实现 CLI 命令与帮助文案 |
| Dev workflow | ⬜ 未开始 | TaskPack / DeliveryPack / Manager-Worker 状态机仍待实现 |

| 任务 | 说明 |
|------|------|
| WorkflowDefinition 注册机制 | 支持 spec-review / dev / code-review 三种类型 |
| TaskPack / DeliveryPack 数据结构 | 开发流专用 Pack |
| ReviewPack 数据结构 | 代码审查专用 Pack |
| 工作流 2 状态机 | Manager-Worker 模式，WorkItem 粒度 |
| 工作流 3 状态机 | Adversarial 5 步循环 |
| 并行 Codex 支持 | 多 WorkItem 并行执行 + 隔离策略 |
| 对应 prompt 模板 | task-pack.md / review-pack.md |

### 9.2 P2B：飞书深度集成（⬜ 未开始）

**预估工作量**：3-5 天

| 任务 | 说明 | 优先级 |
|------|------|--------|
| **飞书 Interactive Card** | 用卡片替代纯文本推送，展示结构化进度 | 🔴 高 |
| **Inline 按钮** | approve / reject / skip / 终止，直接在卡片内操作 | 🔴 高 |
| **人工介入流程** | 死循环检测时弹出裁决卡片，用户点击后 resume | 🔴 高 |
| **进度卡片更新** | 不发新消息，而是更新已有卡片的状态 | 🟡 中 |
| **结果报告卡片** | 工作流结束时推送汇总报告（轮次、问题统计、最终状态） | 🟡 中 |
| **文件预览** | 在卡片内展示修改后的 spec/plan diff | 🟢 低 |

### 9.3 引擎优化方向

| 方向 | 说明 | 优先级 |
|------|------|--------|
| **prompt 模板优化** | 根据实际运行结果调优 Codex 盲审 prompt 和 Claude 裁决 prompt | 🔴 高 |
| **context_files 自动发现** | 根据 spec/plan 中引用的文件路径自动读取并内联 | 🟡 中 |
| **历史工作流浏览** | `/workflow list` 列出历史运行记录 | 🟡 中 |
| **工作流模板自定义** | 用户可在飞书侧配置 max_rounds、终止条件等 | 🟡 中 |
| **多工作流并行** | 同一 chat 支持多个工作流并行（当前限制：每 chat 一个） | 🟢 低 |
| **Webhook 回调** | 工作流完成时触发外部 Webhook | 🟢 低 |

### 9.4 P3：SO 下沉（⬜ 远期）

**启动条件**（3 项量化标准）：

1. 在 **3+ 个真实项目**中跑通
2. **连续 2 周**无结构性变更（字段增删、流程步骤变化）
3. 核心模块的单元测试覆盖率 > 80%

**兼容性契约**（已预定义）：

| 格式 | 现在 | SO 下沉映射 |
|------|------|------------|
| Pack JSON | SpecReviewPack / TaskPack / ReviewPack | → SO RunPack.observation_pack 扩展 |
| Issue Ledger | issue-ledger.json | → SO work_items.csv 的结构化升级 |
| 事件流 | events.ndjson | → SO events.ndjson（直接兼容） |
| 元信息 | meta.json | → SO snapshot.json 的超集 |

---

## 十、反模式清单（不该做的事）

1. **不要让两个机器人做成对等群聊成员** — 弱化责任边界
2. **不要把聊天记录本身当状态** — Issue Ledger 才是事实源
3. **不要把多轮当目标** — 增量信息才是价值，无增量就停
4. **不要一上来重写多智能体平台** — 先固化协议，再自动化，最后平台化
5. **不要让 Claude 微观遥控 Codex** — Claude 拆工 + 验收，Codex 自主实现
6. **不要简单改动也双审** — 只在高杠杆节点使用双模型
7. **不要把编排逻辑塞进 Bridge 核心层** — Bridge 是通用消息桥，Workflow 独立成模块

---

## 十一、风险缓解措施汇总

| 风险 | 缓解措施 | 状态 |
|------|----------|------|
| 累积 prompt 超 Codex 上下文窗口 | ContextCompressor（CJK 感知 token 估算） | ✅ 已实现 |
| 审查循环不收敛 | 动态终止 + 硬性上限 + 死循环检测（repeat_count ≥ 2） | ✅ 已实现 |
| codeagent-wrapper 调用超时 | 90min 超时 + 1 次重试 + TIMEOUT GUARD | ✅ 已实现 |
| Claude kept 上下文爆炸 | token > 60% 时压缩，保留最新 spec + Ledger + 最近一轮 | ✅ 已实现 |
| 并行 Codex 踩文件 | workspace_strategy 三种隔离方案 | ⬜ P1b 实现 |
| 工作流中途崩溃 | meta.json 断点续传 + 5-state 检查点 + 原子写入 | ✅ 已实现 |
| IM 消息过多打扰 | 只推送关键节点事件 | ✅ 已实现 |
| SO 下沉格式不兼容 | 兼容性契约已预定义 | ✅ 已定义 |
| 大 prompt 管道溢出 | 32KB 分块背压写入 | ✅ 已实现 |
| 认证错误误分类 | isNonRetryableError() 启发式检测 | ✅ 已实现 |
| /stop 跨 session 失效 | activeTasksByChat 按 chat 维度追踪 | ✅ 已实现 |
| 路径遍历安全漏洞 | resolveSafePath() 校验 cwd 内 | ✅ 已实现 |

---

## 十二、配置参数速查

```typescript
interface WorkflowConfig {
  max_rounds: number;                    // 默认 3（架构级改动 5）
  auto_terminate: boolean;               // 默认 true
  human_review_on_deadlock: boolean;     // 默认 true（repeat_count ≥ 2 触发）
  codex_timeout_ms: number;              // 默认 5400000 (90min)
  claude_timeout_ms: number;             // 默认 5400000 (90min)
  codex_max_retries: number;             // 默认 1
  claude_max_retries: number;            // 默认 1
  codex_context_window_tokens: number;   // 默认 128000
  max_deferred_issues: number;           // 默认 10
  context_files: ContextFile[];          // 全局参考文件
  claude_model: string;                  // 默认 "claude-sonnet-4"
  claude_max_output_tokens: number;      // 默认 200000
  codex_backend: string;                 // 默认 "codex"
}
```

---

## 附录 A：Session 开发时间线

| Session | 日期 | 标题 | Commit |
|---------|------|------|--------|
| S1 | 03-20 | Bridge MVP + backend 切换 | `a0c313f` |
| S2 | 03-20 | Trellis 追踪建立 | `f9995b4` |
| S3 | 03-20 | P0: 模板 + Schema | `14a1380` |
| S4 | 03-20 | P1a: 完整实现 (14文件/3965行/108tests) | `ab8cdb3` |
| S5 | 03-20 | P2A: IM 集成 (/workflow 命令) | `9859d91` |
| S6 | 03-20 | Code Review: 竞态/安全/健壮性 (7项修复) | `82dfe0a` |
| S7 | 03-20 | /status 实时工具调用 | `17c10a3` |
| S8 | 03-21 | LLM Provider 工具事件转发 | `0af6d88` |
| S9 | 03-21 | 飞书最终卡片修复 | `fe316e8` |
| S10 | 03-21 | system prompt + 可配模型 + 超时调优 | `fe0d2e3` |
| S11 | 03-21 | store path 统一 + event 消息修正 | `e418522` |
| S12 | 03-21 | 背压写入 + 诊断 + CJK + 压缩 | `a165532` |
| S13 | 03-21 | R4 全部 9 问题闭环 + ModelInvocationError | `d4633fc` |
| S14 | 03-21 | Claude HTTP → Agent SDK 迁移 | `923e95a` |
| S15 | 03-21 | /stop 跨 session 修复 | `cfe2f4b` |

---

## 附录 B：相关文档索引

| 文档 | 路径 | 说明 |
|------|------|------|
| 最终方案 v2 | `多机器人协作/最终方案.md` | 5AI 综合方案 + 评审意见 |
| Workflow Engine Spec | `.claude/plan/workflow-engine-spec.md` | 完整规范（1326行） |
| Workflow Engine Plan | `.claude/plan/workflow-engine-plan.md` | 实施计划（494行） |
| 审查分析报告 | `.claude-workflows/reports/20260321-15c8bb-review-analysis.md` | 3 轮 Codex 审查结果 |
| 开发日志 | `.trellis/workspace/yyyzl/journal-1.md` | 15 个 Session 记录 |
| 双模型支持方案 | `.claude/plan/dual-bot-support.md` | Claude SDK + Codex 方案 |
| 对抗性审查设计 | `.claude/plan/dual-bot-adversarial-review.md` | 代码审查工作流详设 |
| 自动化方案 | `.claude/plan/dual-bot-workflow-automation.md` | 原始自动化方案 |
| 用户工作流模式 | `~/.claude/projects/.../memory/user_workflow_patterns.md` | 三种核心模式记忆 |
