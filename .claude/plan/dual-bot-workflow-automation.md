# 📋 实施计划：双 Bot 工作流自动化

## 任务类型
- [x] 全栈 (Claude Code Skill + Claude-to-IM 集成)

---

## 一、问题分析

### 用户的三个核心工作流

#### 工作流 1：Spec/Plan 审查（2步循环）

```
Claude(保持上下文) ←→ Codex(每次清空，累积历史)

Round 1: Codex(清空) ← {需求, spec, plan}               → 审查意见
Round 2: Claude(保持) ← {Codex_R1意见}                   → 决策/修改
Round 3: Codex(清空) ← {需求, spec, plan, R1意见, R2反馈}  → 审查意见
Round 4: Claude(保持) ← {Codex_R3意见}                   → 决策/修改
...
终止: Codex LGTM 或 Codex 审查 5 次（共 10 轮）
```

**关键特征**：Codex prompt 累积式增长；Claude 保持上下文不清空

#### 工作流 2：开发（Claude 指挥 Codex 逐步执行）

```
Claude(保持上下文) → Codex(每次新窗口)

Round 1: Claude 拆解任务 → Codex(新) ← {spec, plan, "做第一部分"}
Round 2: Claude 评估结果 → Codex(新) ← {spec, plan, "已完成X，现在做Y"}
...
终止: 所有步骤完成
```

**关键特征**：Claude 是项目经理；Codex 每次只做一块

#### 工作流 3：代码审查（3步循环，双方都新窗口）

```
Codex(新窗口) → Claude(新窗口) → Codex(新窗口)

Cycle 1:
  R1: Codex(新) ← {背景, spec, plan, 代码}     → 审查报告
  R2: Claude(新) ← {Codex审查报告}              → 仲裁（哪些合理？）
  R3: Codex(新) ← {仲裁后的修复清单}             → 执行修复
Cycle 2:
  R4: Codex(新) ← {背景, spec, plan, 更新代码}  → 审查报告
  R5: Claude(新) ← {Codex审查报告}              → 仲裁
  R6: Codex(新) ← {修复清单}                    → 修复
...
终止: 没有新问题
```

**关键特征**：Claude 也新开窗口（避免偏见）；三步一循环

### 底层元模式

三个工作流共享同一个元模式：

```
工作流 = 循环 {
  步骤序列: [(模型, 上下文策略, 输入构造规则)]
  循环终止: 条件判断
  产出物: 文件池 {spec, plan, 历史意见[], 代码diff}
}
```

三个关键变量：
| 变量 | 工作流1 | 工作流2 | 工作流3 |
|------|--------|--------|--------|
| 上下文策略 | Codex=清空, Claude=保持 | Codex=清空, Claude=保持 | 双方都清空 |
| 循环步数 | 2 | 2 | 3 |
| 输入构造 | Codex累积历史 | Codex带进度摘要 | 每步独立输入 |

### 用户痛点排序

1. **手动构造累积 prompt**（最痛）— 每轮 Codex 都要手动把历史意见粘进去
2. **手动搬运结果**（次痛）— Codex 结果手动复制给 Claude
3. **手动清空上下文**（轻痛）— 开新窗口
4. **手动判断终止**（最轻）— 自己看还有没有新意见

---

## 二、Session Orchestrator 评估

### 匹配度分析

| 用户需求 | SO 现状 | 匹配度 |
|---------|---------|--------|
| 多轮循环 | ✅ `_run_loop` + `workflow_steps[]` | 高 |
| 人工干预 | ✅ `human_review` 暂停点 | 高 |
| 事件追踪 | ✅ NDJSON 事件流 | 高 |
| 持久化/恢复 | ✅ 快照 + RunPack | 高 |
| **双模型调度** | ❌ 只有 Codex Runner | 缺失 |
| **灵活上下文策略** | ❌ 只有"新窗口" | 缺失 |
| **累积式 prompt 构造** | ❌ 命令是固定字符串 | 缺失 |
| **循环工作流** | ❌ 线性推进 | 缺失 |
| **LGTM 自动检测** | ❌ 无 | 缺失 |
| **IM 集成** | ❌ 只有 Web UI | 缺失 |

### 结论

**Session Orchestrator 有 40% 的匹配度。骨架理念对，但改造成本 > 新建成本。**

原因：
- 改造需要：新增 Claude Runner + 重构工作流引擎(循环) + 动态 prompt 组装 + IM 推送 ≈ 重写 60%+
- SO 是 Python 项目，Claude-to-IM 是 TypeScript 项目，跨技术栈集成增加复杂度
- SO 的核心优势（Web UI、详细事件流、RunPack）对 IM 场景并非刚需

**建议：概念复用，不代码复用。** 从 SO 借鉴 RunPack 文件结构和事件流理念，在 Claude 生态中重新实现。

---

## 三、推荐方案

### 方案概述

**在 Claude Code 中实现三个自动化 Skill + 一个通用工作流引擎**

```
用户
  │
  ├─ 终端场景: claude code → /spec-review spec.md plan.md
  │    ↓
  │    Claude 内部循环（调 codeagent-wrapper + 自身决策）
  │    ↓
  │    终端输出每轮结果
  │
  └─ IM 场景: 飞书群 → /spec-review spec.md plan.md
       ↓
       Claude-to-IM → Claude Code SDK → 内部循环
       ↓
       每轮结果推送到飞书群
```

**核心思路**：Claude 既是编排器又是参与者。Codex 通过 codeagent-wrapper 调用（天然新进程 = 清空上下文）。不需要额外的编排系统。

### 为什么这样做？

1. **零额外基础设施** — 不需要启动 Python Web 服务、不需要数据库
2. **Claude 直接参与决策** — 不是只做调度，而是在每步做实质性判断
3. **Codex 清空天然实现** — codeagent-wrapper 每次是新进程
4. **累积 prompt 自动构造** — 引擎自动管理历史，用户不再手动粘贴
5. **终端和 IM 通用** — 同一个 Skill，两种场景
6. **渐进式增强** — 先做最简版，后续可加持久化、Web 可视化

---

## 四、技术设计

### 4.1 通用工作流引擎

**文件**: `~/.claude/skills/workflow-engine/SKILL.md` 或作为 Claude-to-IM 内部模块

**核心抽象**:

```typescript
// 工作流定义
interface WorkflowDefinition {
  name: string;                    // 'spec-review' | 'dev-loop' | 'code-review'
  description: string;
  cycleSteps: CycleStep[];         // 一个循环体中的步骤序列
  maxCycles: number;               // 最大循环次数
  terminationCheck: TerminationFn; // 终止条件判断函数
}

// 循环步骤
interface CycleStep {
  name: string;
  model: 'claude' | 'codex';
  contextStrategy: 'fresh' | 'kept' | 'fresh_with_history';
  promptTemplate: string;          // 支持 {{spec}}, {{plan}}, {{history}} 等变量
  outputRole: string;              // 输出的角色标签（如 'codex_review', 'claude_decision'）
}

// 运行时状态
interface WorkflowState {
  workflowName: string;
  cycleIndex: number;              // 当前第几轮循环
  stepIndex: number;               // 当前循环中第几步
  artifacts: Record<string, string>;  // 文件池 {spec, plan, ...}
  history: HistoryEntry[];         // 累积的历史记录
  status: 'running' | 'paused' | 'completed' | 'terminated';
}

// 历史条目
interface HistoryEntry {
  cycleIndex: number;
  stepName: string;
  model: string;
  input_summary: string;           // 输入摘要（用于累积 prompt）
  output: string;                  // 完整输出
  timestamp: string;
}
```

### 4.2 三个工作流定义

#### Spec/Plan 审查

```yaml
name: spec-review
maxCycles: 5
cycleSteps:
  - name: codex-review
    model: codex
    contextStrategy: fresh_with_history    # 每次清空但带历史
    promptTemplate: |
      你是一个严格的技术审查者。请审查以下 spec 和 plan。

      ## 需求背景
      {{context}}

      ## Spec
      {{spec}}

      ## Plan
      {{plan}}

      {{#if history}}
      ## 之前的审查历史
      {{#each history}}
      ### 第{{cycleIndex}}轮
      **Codex 意见**: {{codex_output}}
      **Claude 反馈**: {{claude_output}}
      {{/each}}
      {{/if}}

      请指出问题和改进建议。如果没有问题，回复 "LGTM"。
    outputRole: codex_review

  - name: claude-decide
    model: claude
    contextStrategy: kept              # 保持上下文
    promptTemplate: |
      以下是 Codex 第{{cycleIndex}}轮的审查意见：

      {{last_codex_output}}

      请你结合上下文，决定：
      1. 哪些意见采纳？
      2. 哪些可以忽略？说明理由
      3. 如果采纳，请直接修改 spec/plan 的相关部分
    outputRole: claude_decision

terminationCheck: codex_output_contains_lgtm
```

#### 编排式开发

```yaml
name: dev-loop
maxCycles: 20  # 上限
cycleSteps:
  - name: claude-plan-step
    model: claude
    contextStrategy: kept
    promptTemplate: |
      ## 当前进度
      {{#each completed_steps}}
      ✅ {{name}}: {{summary}}
      {{/each}}

      ## 剩余任务
      {{remaining_steps}}

      请决定 Codex 下一步具体要做什么。给出清晰的任务描述。
    outputRole: claude_instruction

  - name: codex-execute
    model: codex
    contextStrategy: fresh
    promptTemplate: |
      ## 背景
      Spec: {{spec}}
      Plan: {{plan}}

      ## 已完成的工作
      {{completed_summary}}

      ## 当前任务
      {{last_claude_output}}

      请执行上述任务。
    outputRole: codex_execution

terminationCheck: all_steps_completed
```

#### 代码审查循环

```yaml
name: code-review
maxCycles: 5
cycleSteps:
  - name: codex-review
    model: codex
    contextStrategy: fresh
    promptTemplate: |
      你是一个代码审查者。请审查以下项目的代码实现。

      ## Spec
      {{spec}}

      ## Plan
      {{plan}}

      ## 当前代码状态
      {{code_snapshot}}

      指出不符合 spec/plan 的地方，以及代码质量问题。
    outputRole: codex_review

  - name: claude-judge
    model: claude
    contextStrategy: fresh              # 注意：这里也是新窗口！
    promptTemplate: |
      以下是 Codex 的代码审查结果：

      {{last_codex_output}}

      请判断每个意见是否合理，给出你的仲裁决策。
      合理的意见请生成具体的修复指令。
    outputRole: claude_judgment

  - name: codex-fix
    model: codex
    contextStrategy: fresh
    promptTemplate: |
      请执行以下修复：

      {{last_claude_output}}

      只修复上述列出的问题，不要做额外改动。
    outputRole: codex_fix

terminationCheck: codex_review_no_issues
```

### 4.3 Prompt 构造器 (最核心的模块)

```typescript
class PromptAssembler {
  /**
   * 根据模板和当前状态，构造完整的 prompt
   *
   * 处理三种上下文策略：
   * - fresh: 只传入当前步骤需要的文件 + 上一步输出
   * - kept: 不构造新 prompt，直接追加到当前会话
   * - fresh_with_history: 传入文件 + 累积的所有历史轮次
   */
  assemble(
    template: string,
    state: WorkflowState,
    strategy: ContextStrategy
  ): string {
    const vars = {
      spec: state.artifacts.spec,
      plan: state.artifacts.plan,
      context: state.artifacts.context,
      history: this.buildHistorySummary(state.history, strategy),
      last_codex_output: this.getLastOutput(state, 'codex'),
      last_claude_output: this.getLastOutput(state, 'claude'),
      completed_summary: this.buildCompletedSummary(state),
      cycleIndex: state.cycleIndex,
      code_snapshot: this.getCodeSnapshot(state),
    };
    return this.interpolate(template, vars);
  }

  /**
   * 构造累积历史摘要
   * fresh_with_history: 包含所有轮次的意见和反馈
   * fresh: 只包含上一步输出
   * kept: 不需要（已在上下文中）
   */
  private buildHistorySummary(
    history: HistoryEntry[],
    strategy: ContextStrategy
  ): string {
    if (strategy === 'fresh') return '';
    if (strategy === 'kept') return '';
    // fresh_with_history: 累积所有轮次
    return history.map(h =>
      `### 第${h.cycleIndex}轮 - ${h.stepName}\n${h.output}`
    ).join('\n\n');
  }
}
```

### 4.4 模型调用器

```typescript
class ModelInvoker {
  /**
   * 调用 Codex（通过 codeagent-wrapper，天然新进程）
   */
  async callCodex(prompt: string, workDir: string): Promise<string> {
    // 每次调用都是新进程 = 自动清空上下文
    const result = await exec(
      `codeagent-wrapper --backend codex - "${workDir}" <<'EOF'\n${prompt}\nEOF`
    );
    return result.stdout;
  }

  /**
   * 调用 Claude
   * - kept: 直接在当前会话中发送消息（利用 Claude Code SDK 的会话连续性）
   * - fresh: 创建新的 SDK 会话
   */
  async callClaude(
    prompt: string,
    strategy: 'fresh' | 'kept',
    session?: ClaudeSession
  ): Promise<string> {
    if (strategy === 'kept' && session) {
      return session.sendMessage(prompt);
    }
    // fresh: 新会话
    const newSession = await ClaudeSDK.createSession();
    return newSession.sendMessage(prompt);
  }
}
```

### 4.5 执行日志（概念借鉴自 Session Orchestrator）

```
.claude-workflows/
├── {workflow-id}/
│   ├── state.json              # 当前状态（断点续传）
│   ├── events.ndjson           # 事件流日志
│   ├── artifacts/
│   │   ├── spec.md             # 原始 spec
│   │   ├── spec-v2.md          # 修改后的 spec
│   │   ├── plan.md             # 原始 plan
│   │   └── plan-v2.md          # 修改后的 plan
│   └── rounds/
│       ├── cycle-1-codex-review.md
│       ├── cycle-1-claude-decision.md
│       ├── cycle-2-codex-review.md
│       └── ...
```

---

## 五、与 IM 的集成

### 在 Claude-to-IM 中新增命令

```
/spec-review <spec-path> <plan-path>     → 工作流 1
/dev-loop <spec-path> <plan-path>        → 工作流 2
/code-review <spec-path> <plan-path>     → 工作流 3
/workflow status                         → 查看进度
/workflow pause                          → 暂停当前工作流
/workflow resume                         → 继续
/workflow skip                           → 跳过当前步骤
```

### IM 消息推送策略

| 事件 | 推送内容 |
|------|---------|
| 循环开始 | "🔄 第 N 轮审查开始" |
| Codex 审查完成 | "🔍 Codex 意见: {摘要}（{问题数}个问题）" |
| Claude 决策完成 | "💡 Claude 决策: 采纳 {N} 项，忽略 {M} 项" |
| Codex 执行完成 | "✅ Codex 完成: {摘要}" |
| LGTM 达成 | "🎉 审查通过！共经过 {N} 轮" |
| 需要人工介入 | "⏸️ 需要你的判断 [继续] [修改] [终止]" |
| 工作流结束 | "📋 工作流完成，查看报告: {path}" |

---

## 六、实施步骤

### Phase 1：Prompt 构造器 + 单工作流验证（P0）

| # | 步骤 | 预期产物 |
|---|------|---------|
| 1.1 | 实现 PromptAssembler | `prompt-assembler.ts` |
| 1.2 | 实现 ModelInvoker（Codex 调用） | `model-invoker.ts` |
| 1.3 | 实现 Spec/Plan 审查工作流（硬编码版） | `spec-review-skill/SKILL.md` |
| 1.4 | 终端验证：手动触发 `/spec-review` | 通过 |

### Phase 2：通用引擎 + 三个工作流（P1）

| # | 步骤 | 预期产物 |
|---|------|---------|
| 2.1 | 抽象通用 WorkflowEngine | `workflow-engine.ts` |
| 2.2 | 实现 dev-loop 工作流 | `dev-loop-skill/SKILL.md` |
| 2.3 | 实现 code-review 工作流 | `code-review-skill/SKILL.md` |
| 2.4 | 实现执行日志持久化 | `workflow-store.ts` |

### Phase 3：IM 集成（P2）

| # | 步骤 | 预期产物 |
|---|------|---------|
| 3.1 | Claude-to-IM 新增 /workflow 命令路由 | `bridge-manager.ts` 修改 |
| 3.2 | 工作流进度 → IM 消息映射 | `workflow-bridge.ts` |
| 3.3 | 飞书卡片模板（审查进度、按钮交互） | `feishu-adapter.ts` 扩展 |

### Phase 4：可选增强（P3）

| # | 步骤 | 预期产物 |
|---|------|---------|
| 4.1 | 断点续传（从 state.json 恢复） | WorkflowEngine 增强 |
| 4.2 | 与 Session Orchestrator 事件格式对齐 | 导出工具 |
| 4.3 | Web 可视化面板（借鉴 SO 的 Web UI） | 独立页面 |

---

## 七、关键文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `~/.claude/skills/spec-review/SKILL.md` | 新增 | Spec/Plan 审查 Skill |
| `~/.claude/skills/dev-loop/SKILL.md` | 新增 | 编排式开发 Skill |
| `~/.claude/skills/code-review-loop/SKILL.md` | 新增 | 代码审查循环 Skill |
| `src/lib/bridge/internal/workflow-engine.ts` | 新增 | 通用工作流引擎 |
| `src/lib/bridge/internal/prompt-assembler.ts` | 新增 | 动态 Prompt 构造 |
| `src/lib/bridge/internal/model-invoker.ts` | 新增 | 模型调用抽象 |
| `src/lib/bridge/internal/workflow-store.ts` | 新增 | 执行日志持久化 |
| `src/lib/bridge/bridge-manager.ts` | 修改 | 新增 /workflow 命令 |

---

## 八、风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 累积 prompt 超过 Codex 上下文窗口 | 历史摘要自动压缩（只保留关键意见，不保留原文） |
| 审查循环不收敛 | 硬性上限 5 轮；超过后强制终止并推送报告 |
| codeagent-wrapper 调用超时 | 可配置超时（默认 90s）；超时后跳过并记录 |
| Claude "kept" 模式上下文爆炸 | 定期压缩上下文（只保留决策摘要） |
| 工作流中途崩溃 | state.json 断点续传；每步完成后自动保存 |

---

## 九、与 Session Orchestrator 的关系

**不直接使用，但概念复用**：

| SO 概念 | 在本方案中的映射 |
|---------|----------------|
| RunPack | `.claude-workflows/{id}/` 目录结构 |
| 事件流 NDJSON | `events.ndjson` 日志 |
| Window/Handoff | Codex 新进程 + 累积历史 = handoff |
| 工作流步骤 | WorkflowDefinition.cycleSteps |
| 人工干预 | 暂停 + IM 按钮交互 |
| 快照恢复 | state.json 断点续传 |

**未来可能的联动**：
- 将工作流执行数据导出为 SO 兼容格式，用 SO 的 Web UI 做可视化分析
- 如果 SO 未来支持多模型 + 循环工作流，可以反向迁移

---

## SESSION_ID（供 /ccg:execute 使用）
- CODEX_SESSION: N/A（纯分析规划，无模型调用）
- GEMINI_SESSION: N/A（纯分析规划，无模型调用）
