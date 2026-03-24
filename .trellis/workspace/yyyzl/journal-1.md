# Journal - yyyzl (Part 1)

> AI development session journal
> Started: 2026-03-17

---



## Session 1: 统一收口 backend 切换 MVP 与 bootstrap guidelines

**Date**: 2026-03-20
**Task**: 统一收口 backend 切换 MVP 与 bootstrap guidelines

### Summary

(Add summary)

### Main Changes

| ?? | ?? |
|------|------|
| Bridge MVP | ?? Claude / Codex ????? MVP??? backend ??? binding?router ?????SDK ????????? |
| Trellis ?? | ?? `.trellis/spec/backend/`??? frontend / guides / workflow / start???????????????????? |
| ???? | ?? `docs/superpowers/specs/` ? `docs/superpowers/plans/`????? bootstrap guidelines ???????? |

**??**?
- `npm test`?115 tests, 0 failures?

**????**?
- `a0c313f` `feat(bridge): ?? Claude ? Codex ???? MVP`
- `eb4ac25` `docs(trellis): ?? bootstrap guidelines ?????`
- `fb9bcb2` `docs(superpowers): ?? bootstrap guidelines ?????`

**????**?
- ?????????????`.claude/`?`.codex/`?`.gemini/`?`??????/`
- ????????????????????


### Git Commits

| Hash | Message |
|------|---------|
| `a0c313f` | (see git log) |
| `eb4ac25` | (see git log) |
| `fb9bcb2` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: Track Workflow Engine In Trellis

**Date**: 2026-03-20
**Task**: Track Workflow Engine In Trellis

### Summary

为 Workflow Engine 建立 Trellis 追踪父任务并激活当前任务。

### Main Changes

| ?? | ?? |
|------|------|
| ???? | ? Workflow Engine???????????? Trellis ???? |
| ???? | `.claude/plan/workflow-engine-spec.md`?`.claude/plan/workflow-engine-plan.md` |
| ???? | ?? Trellis ??????????? |
| ???? | ????????????????????? |

**????/??**?
- `.trellis/tasks/03-20-workflow-engine/task.json`
- `.trellis/tasks/03-20-workflow-engine/prd.md`
- `.trellis/tasks/03-20-workflow-engine/plan.md`
- `.trellis/tasks/03-20-workflow-engine/implement.jsonl`
- `.trellis/tasks/03-20-workflow-engine/check.jsonl`
- `.trellis/tasks/03-20-workflow-engine/debug.jsonl`

**????**?
- ? Workflow Engine ? spec / plan ??? Trellis ??????
- ?? backend implement/check/debug context
- ???? context ???? `.gemini/...` ????
- ?? `.trellis/tasks/03-20-workflow-engine` ?????
- ?????`f9995b4 chore(trellis): add workflow engine tracking task`

**????**?
- ???????????????
- ??????????? 7 ? tracking block ?? children ???


### Git Commits

| Hash | Message |
|------|---------|
| `f9995b4` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: Workflow Engine P0: Scaffolding, Templates & Schemas

**Date**: 2026-03-20
**Task**: Workflow Engine P0: Scaffolding, Templates & Schemas

### Summary

完成 Workflow Engine P0 阶段：创建目录结构、3 个 prompt 模板、3 个 JSON schema，更新 .gitignore

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `14a1380` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: Workflow Engine P0 + P1a MVP 完整实现

**Date**: 2026-03-20
**Task**: Workflow Engine P0 + P1a MVP 完整实现

### Summary

实现完整的双模型协作工作流引擎: 14个源文件(3965行), 108个测试全部通过, 含5-state步骤机/crash-safe resume/AbortSignal graceful pause/deadlock检测/CLI入口

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ab8cdb3` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: Workflow IM Integration (P2A)

**Date**: 2026-03-20
**Task**: Workflow IM Integration (P2A)

### Summary

(Add summary)

### Main Changes

## 完成内容

将 Workflow Engine 集成到 Bridge IM 命令系统（P2A 最小可用级别）。

| 项目 | 详情 |
|------|------|
| 新增文件 | `internal/workflow-command.ts` (~400行) — 命令解析、引擎管理、事件推送 |
| 新增测试 | `workflow-command.test.ts` (~155行) — 20 个子命令解析测试 |
| 修改文件 | `bridge-manager.ts` — +1 import, +4行 case, +2行帮助文案 |

## 命令设计

- `/workflow start <spec> <plan>` → 启动 Spec-Review
- `/workflow status [run-id]` → 查看状态
- `/workflow resume <run-id>` → 恢复暂停的工作流
- `/workflow stop` → 停止当前工作流

## 架构决策

- 每 chat 单工作流，Map<chatKey, RunningWorkflow> 防并发
- 后台异步执行，/workflow start 立即返回
- bindProgressEvents() 事件到消息单一映射点，便于 P2B 卡片化迭代
- Workflow Engine 保持独立，不引入 Bridge 依赖

## 验证

- TypeScript 类型检查通过
- 128 测试全通过（108 原有 + 20 新增），0 回归


### Git Commits

| Hash | Message |
|------|---------|
| `9859d91` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: Code Review & Fix: /workflow 命令竞态、安全和健壮性修复

**Date**: 2026-03-20
**Task**: Code Review & Fix: /workflow 命令竞态、安全和健壮性修复

### Summary

(Add summary)

### Main Changes

## 会话内容

对已实现的 `/workflow` 命令集成代码进行了系统性 Code Review，发现并修复 7 个问题：

| 严重度 | 问题 | 修复 |
|--------|------|------|
| Critical | 并发 /workflow start 竞态 -> 孤儿 engine 泄漏 | has()+set() 同步完成，finally 自动清理占位 |
| High | 路径遍历可读任意文件 | 新增 resolveSafePath() 校验路径在 cwd 内 |
| High | stop 语义矛盾 + 丢弃 runId 参数 | handleStop 接收 cmd，消息改为已停止，支持 run-id |
| Medium | fire-and-forget catch 中 unhandled rejection | .catch(() => {}) 吞掉 delivery 失败 |
| Medium | push 静默丢弃 delivery 错误 | 改为 .catch(err => console.error(...)) |
| Medium | 每次 status 创建新 WorkflowStore | 模块级 lazy 单例 |
| Low | esc() 使用风险 | JSDoc 注释限定 content 上下文 |

额外改进: fire-and-forget 的 then/catch 增加 current.engine === engine 守卫，防止误删新 engine 的 slot。

Updated Files:
- src/lib/bridge/internal/workflow-command.ts — 主要修复（+215 / -72）
- src/__tests__/unit/workflow-command.test.ts — 新增 8 个 resolveSafePath 测试（28/28 通过）

验证: TypeScript 零错误 | 单元测试 28/28 | workflow-engine 回归 17/17


### Git Commits

| Hash | Message |
|------|---------|
| `82dfe0a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 7: feat(bridge): /status 实时工具调用上下文

**Date**: 2026-03-20
**Task**: feat(bridge): /status 实时工具调用上下文

### Summary

F:/Git/status 增加最近工具调用展示（名称+相对时间），onToolEvent 改为始终生效不再依赖 streaming card，全局 state 环形缓冲最近 10 条记录

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `17c10a3` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 8: feat: 实现 LLM Provider 工具调用事件转发

**Date**: 2026-03-21
**Task**: feat: 实现 LLM Provider 工具调用事件转发

### Summary

修复 /status 始终显示 No tool calls recorded yet 的问题。Codex 后端新增 5 个工具通知检测点（item/started, item/tool/call, commandExecution, mcpToolCall, item/completed 扩展），Claude 后端新增 3 种 SDK 工具事件检测模式。通知方法名基于 Codex CLI v0.115.0 二进制验证。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `0af6d88` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 9: 修复飞书最终卡片展示

**Date**: 2026-03-21
**Task**: 修复飞书最终卡片展示

### Summary

(Add summary)

### Main Changes

- ??????????????????????????????????? footer?
- ??????? `package-lock.json`??????????
- ??? `npm run test`?????????????? 253 ??????
- ????????`03-17-brainstorm-git`?`03-17-card-complete-notify`?`03-18-daily-token-usage`?

**????**?
- `src/lib/bridge/adapters/feishu-adapter.ts`
- `package-lock.json`


### Git Commits

| Hash | Message |
|------|---------|
| `fe316e8e91f90c191485afd2afa5481df42f8f99` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 10: Workflow Engine 改进: system prompt + 模型可配置 + 超时调优

**Date**: 2026-03-21
**Task**: Workflow Engine 改进: system prompt + 模型可配置 + 超时调优

### Summary

分析 /workflow TS 引擎架构后实施 3 个改进：(1) Claude 决策加 system prompt（Technical Decision Authority 角色 + 深度判断框架），(2) 模型版本可配置（claude_model/codex_backend + --model/--codex-backend CLI 参数），(3) 超时从 3min → 90min + max_tokens 从 4096 → 200k。修改 7 文件 + 新建 1 模板，全部 40 测试通过。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `fe0d2e3` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 11: fix(workflow): store path consistency & event message accuracy

**Date**: 2026-03-21
**Task**: fix(workflow): store path consistency & event message accuracy

### Summary

Fix two design defects in /workflow command: (1) unify basePath across start/resume/status so all operations read/write the same .claude-workflows directory under chat's workingDirectory; (2) correct misleading progress messages to match actual engine behavior (timeout=skip round, parse error=fallback empty output). Removed stale getWorkflowStore singleton.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `e418522` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 12: Workflow 引擎稳健性增强：系统提示、可配置模型、背压写入与诊断

**Date**: 2026-03-21
**Task**: Workflow 引擎稳健性增强：系统提示、可配置模型、背压写入与诊断

### Summary

(Add summary)

### Main Changes

## 变更概览

本次 session 围绕 **Spec Review Workflow 引擎**进行了三轮迭代，从功能增强到路径统一再到可靠性加固：

| 阶段 | Commit | 说明 |
|------|--------|------|
| 功能增强 | `fe0d2e3` | 添加 Claude 决策系统提示、可配置模型/超时参数 |
| 路径修复 | `e418522` | 统一 store basePath，修正事件消息措辞 |
| 稳健性加固 | `a165532` | 背压 stdin 写入、丰富诊断日志、CJK token 估算、压缩结果应用 |

## 核心功能

### 1. Claude 决策系统提示 (fe0d2e3)
- 新增 `claude-decision-system.md` 模板，定义 Technical Decision Authority 角色
- `ClaudePromptParts` 接口支持 system/user prompt 分离
- prompt-assembler 重构以产出结构化 prompt 对象

### 2. 可配置模型与参数 (fe0d2e3)
- `WorkflowConfig` 新增 `claude_model`, `claude_max_output_tokens`, `codex_backend` 字段
- `/workflow start --model <model> --codex-backend <backend>` 命令行支持
- 默认超时从 3min/2min 提升至 90min；Claude max_tokens 提升至 200K

### 3. Store 路径统一 (e418522)
- `handleStart/handleResume/deliverRunStatus` 均传入 cwd-based basePath
- 移除过时的 `getWorkflowStore()` 单例
- 修正超时/解析错误的进度消息措辞

### 4. 背压 stdin 写入与诊断 (a165532)
- model-invoker: 32KB 分块写入 + drain 背压，防止大 prompt 管道溢出
- model-invoker: spawn/timeout/exit/retry/abort/stdin-error 全路径诊断日志
- model-invoker: DI 构造函数 (spawnFn) 提升可测试性
- model-invoker: 添加 `-` 参数启用 codeagent-wrapper stdin 模式

### 5. 压缩与 Token 估算修复 (a165532)
- pack-builder: 压缩结果实际应用到 spec/plan（修复死代码）
- context-compressor: CJK 感知 token 估算 (CJK 0.67 vs ASCII 0.25)
- pack-builder: 复用 context-compressor 的 estimateTokens

### 6. 错误处理增强 (a165532)
- workflow-engine: 所有 catch 块添加详细 stack trace 日志
- bridge-runner: 提取 build-freshness 检查为独立模块
- bridge-runner: unhandledRejection 对非瞬态错误调用 shutdown

## 新增测试
- `bridge-build-freshness.test.ts` — 构建新鲜度检查
- `workflow-model-invoker.test.ts` — DI spawn、背压、超时测试
- `workflow-command.test.ts` — 新增 --model/--codex-backend 参数解析测试
- `workflow-engine.test.ts` — 新增引擎错误处理测试

## 变更文件 (17 files, +877 -141)
- `src/lib/workflow/model-invoker.ts` — 核心: 背压写入 + 诊断日志
- `src/lib/workflow/pack-builder.ts` — 压缩结果应用 + token 估算复用
- `src/lib/workflow/workflow-engine.ts` — 错误日志增强
- `src/lib/workflow/prompt-assembler.ts` — 结构化 prompt 输出
- `src/lib/workflow/types.ts` — 配置参数扩展
- `src/lib/workflow/context-compressor.ts` — CJK token 估算
- `src/lib/bridge/internal/workflow-command.ts` — 路径统一 + CLI 参数
- `src/lib/bridge/internal/build-freshness.ts` — 新模块
- `scripts/feishu-claude-bridge.ts` — 错误处理重构
- `.trellis/templates/claude-decision-system.md` — 新模板


### Git Commits

| Hash | Message |
|------|---------|
| `fe0d2e3` | (see git log) |
| `e418522` | (see git log) |
| `a165532` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete

---

## Session 13 — 2026-03-21

### Title

Workflow Engine Spec/Plan R4: 全部 9 个独立问题闭环 + 代码增强

### Summary

完成 Workflow Engine Spec/Plan 审查流程的 R4 Claude Decision 轮。修复了 R1-R3 Codex 盲审累计发现的全部 9 个独立问题（28 个 issue 条目全部 resolved），并提交了对应的代码增强。

### Changes

#### Spec/Plan 协议修复（9 个独立问题 → 全部 resolved）

| # | 问题 | 严重性 | 修复方案 |
|---|------|--------|---------|
| 1 | Step C 恢复非幂等 | Critical | C-parse/C-commit 两阶段 + `R{N}-claude-decision.json` 提交标记 + 幂等突变 |
| 2 | 补丁失败与 issue resolved 脱钩 | High | Patch-Resolution Binding (failedSections 阻止 resolved) |
| 3 | 终止条件未扫描全部未解决状态 | High | Unresolved High/Critical Guard (open/accepted/deferred) |
| 4 | ContextCompressor 接口不兼容 | High | 返回 `compressedRoundSummary` 映射 `SpecReviewPack.round_summary` |
| 5 | Claude 解析失败降级不完整 | High | Conservative Degradation (full/partial 两层降级协议) |
| 6 | contextFiles 持久化不一致 | High | 删除独立参数，统一到 `config.context_files` |
| 7 | 模板被实际内容污染 | High | Template Purity Rule + P0 验收条件 |
| 8 | 配置项 auto_terminate 未消费 | Medium | TerminationJudge 消费两个配置项 |
| 9 | CLI pause 时序 + 决策产物 + exports | Medium×3 | `StartResult { runId, completion }` + decision.json + `./workflow/*` |

#### 代码变更 (d4633fc)

| 文件 | 变更 |
|------|------|
| `src/lib/workflow/types.ts` | 新增 `ModelInvocationError` 类 + 默认模型调整为 claude-sonnet-4 |
| `src/lib/workflow/model-invoker.ts` | 4xx 错误分类为不可重试，直接抛出而非耗尽重试 |
| `src/lib/workflow/workflow-engine.ts` | 处理 ModelInvocationError + 事件载荷丰富化（决策统计、完成摘要） |
| `src/lib/bridge/internal/workflow-command.ts` | IM 消息展示丰富事件数据（严重度分布、状态分布） |

### Git Commits

| Hash | Message |
|------|---------|
| `d4633fc` | fix(workflow): add ModelInvocationError for non-retryable API errors, enrich event payloads |

### Testing

- [OK] Spec/Plan 协议一致性 — 28 个 issue 条目全部 resolved
- [OK] 代码编译通过 — git commit 成功

### Status

[OK] **Completed**

### Next Steps

- Spec + Plan 协议已完全收敛，可进入 P0 实现阶段


## Session 14: Workflow Claude 调用从 HTTP API 迁移到本地 Agent SDK

**Date**: 2026-03-21
**Task**: Workflow Claude 调用从 HTTP API 迁移到本地 Agent SDK

### Summary

(Add summary)

### Main Changes

## 问题诊断

用户报告 spec-review 工作流 (run: 20260321-4f1ae2) 出现 "Claude 决策超时"，但 Codex 审查正常。

事件日志揭示根因：Claude 决策在 11ms 内就"超时"（配置90分钟），不是真正超时而是立即失败。

项目有两条 Claude 调用路径——Bridge 用 Agent SDK（不需 API key），Workflow 用 HTTP API（需 ANTHROPIC_API_KEY 但未设置）。SDK 抛出认证错误，被 withRetry 误分类为可重试 → 3次毫秒级失败 → 包装为 TimeoutError。

## 修复内容

| 改动 | 说明 |
|------|------|
| `executeClaudeRequest` 从 HTTP API → Agent SDK | 消除 ANTHROPIC_API_KEY 依赖，统一使用本地 Claude Code |
| `withRetry` 增加 `isNonRetryableError()` | 启发式检测 auth/ENOENT/permission 错误，立即升级为 ModelInvocationError |
| 删除 `vendor-types.d.ts` | SDK 自带类型，旧声明覆盖真实类型导致编译错误 |

Agent SDK 配置：`tools: []`（纯文本）、`persistSession: false`、`maxTurns: 1`、`settingSources: []`（隔离模式）。

**验证**: tsc 0 错误，15/15 测试通过。

**Updated Files**:
- `src/lib/workflow/model-invoker.ts` (重写)
- `src/lib/workflow/vendor-types.d.ts` (删除)


### Git Commits

| Hash | Message |
|------|---------|
| `923e95a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 15: fix(bridge): /stop 无法终止跨 session 的活跃任务

**Date**: 2026-03-21
**Task**: fix(bridge): /stop 无法终止跨 session 的活跃任务

### Summary

(Add summary)

### Main Changes

## Bug 修复

**问题**：飞书派发任务后输入 `/stop`，返回 "No task is currently running."，但旧任务仍在流式输出。

**根因**：`/stop` 通过 `router.resolve()` 获取当前 session ID 查找活跃任务，但任务运行期间 session 可能已切换（`/new`/`/bind`），导致用新 session ID 查不到旧任务。

**修复方案**：引入 `activeTasksByChat` Map（key = `channelType:chatId`），按 chat 维度追踪活跃任务，不再依赖可能已变化的 session ID。

| 改动点 | 说明 |
|--------|------|
| `registerActiveTask()` | 双写 session + chat 两个 Map |
| `clearActiveTask()` | 用 `=== abort` 引用比较防止竞态误删 |
| `/stop` | 改用 `getActiveTaskForChat()` 查找 + 主动清理 chat 索引 |
| `/new` | 统一为 `abortActiveTaskForChat()`，消除两段冗余 abort |
| `/bind` | 新增切换前 abort，防止旧任务"失联" |
| `/status` | 按 chat 维度查找，显示跨 session 任务信息 |

**Updated Files**:
- `src/lib/bridge/bridge-manager.ts`


### Git Commits

| Hash | Message |
|------|---------|
| `cfe2f4b` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 16: Workflow Engine P0+TP0: parse safety net + prompt optimization

**Date**: 2026-03-22
**Task**: Workflow Engine P0+TP0: parse safety net + prompt optimization

### Summary

(Add summary)

### Main Changes

## 变更概览

同批修复 Workflow Engine 的 5 个代码缺陷 + 5 个 prompt 模板问题——它们是同一根因的两面（代码没拦住 parse 失败 + prompt 导致了 parse 失败）。

## 代码修复 P0（5 项）

| # | 缺陷 | 文件 | 修复 |
|---|------|------|------|
| 1 | Claude parse 失败后空转 | workflow-engine.ts, types.ts | consecutiveParseFailures 计数器，连续2次 pause_for_human |
| 2 | max_rounds B2 提前截断 | termination-judge.ts | isPreTermination 参数，B2 跳过 max_rounds 检查 |
| 3 | 零进展安全网 | workflow-engine.ts, types.ts | zeroProgressRounds 持久化，连续2轮 pause_for_human |
| 4 | TimeoutError 破坏终止条件 | workflow-engine.ts | 移除 previousRoundHadNewHighCritical=true |
| H-NEW-1 | Codex fallback 伪造 LGTM | workflow-engine.ts | 三处 fallback 从 lgtm 改为 major_issues |

## 模板修复 TP0（5 项）

| # | 问题 | 文件 | 修复 |
|---|------|------|------|
| T1 | JSON/Patch 分离 | claude-decision.md, json-parser.ts | Part 1 JSON + Part 2 marker patch |
| T2 | Claude 橡皮图章 | claude-decision-system.md | Decision Budget 3/轮 + reject 20-40% |
| T4 | Codex 尾部清理 | spec-review-pack.md, model-invoker.ts | OUTPUT RULES + SESSION_ID 后处理 |
| T5 | severity 模糊 | spec-review-pack.md | Severity Calibration 锚定定义 |
| T7 | R1 summary 空 | pack-builder.ts | round=1 返回引导文字 |

## 验证

- TypeScript 编译零错误
- 265/266 测试通过（1 个失败是已有的 untracked bridge-stop-command.test.ts）
- 11 文件变更, +484 / -114 行


### Git Commits

| Hash | Message |
|------|---------|
| `0ba2ea4` | (see git log) |
| `843eb5e` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 17: Workflow P1+TP1 + cross-AI review fixes

**Date**: 2026-03-22
**Task**: Workflow P1+TP1 + cross-AI review fixes

### Summary

(Add summary)

### Main Changes

## 变更概览

P1+TP1 批次实施 + 跨 AI 审核修复。包含 5 个代码安全网补全 + 1 个模板去重优化 + 3 个审核发现的 bug 修复。

## P1 代码修复（5 项）

| # | 问题 | 修复 |
|---|------|------|
| H-NEW-2 | accept_and_resolve 绕过 hasPatchFailure | 延迟 resolve 到 patch 后，失败时降级为 accepted |
| H-NEW-3 | ContextCompressor 收到空 rounds | 加载真实 round 历史数据 |
| H-NEW-4 | DecisionValidator 不存在 | 新建 decision-validator.ts + 5 项校验 + 引擎集成 |
| 元问题 | last_processed_round / switch default | Issue 幂等字段 + default 分支 |
| 元问题 | auto_terminate / human_review_on_deadlock | 配置项落地到引擎和 judge |

## TP1 模板优化

| # | 问题 | 修复 |
|---|------|------|
| T3+T6 | Codex 缺少 resolved/accepted 上下文 | 新增模板章节 + DEDUP RULES |

## 跨 AI 审核修复（3 个真 bug）

| Finding | 问题 | 修复 |
|---------|------|------|
| F2(高) | LGTM 短路只查 open/accepted，漏了 deferred | 改为 open/accepted/deferred 三态 |
| F3(中) | 零进展用 i.round（首次提出轮次）而非本轮决策 | 改为统计 thisRoundDecided |
| F4(中) | DecisionValidator 检测 duplicate 但 engine 没过滤 | filter 加 seenIds 去重 |

## 验证

- TypeScript 编译零错误
- 269/270 测试通过（1 个失败是已有的 untracked bridge-stop-command.test.ts）
- 新增 1 个测试：LGTM+deferred → continue
- 新增文件：decision-validator.ts
- 总变更：15 文件 +512 行


### Git Commits

| Hash | Message |
|------|---------|
| `c07c85c` | (see git log) |
| `c8c51b2` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 18: PatchApplier 测试对齐 + P2 决策

**Date**: 2026-03-22
**Task**: PatchApplier 测试对齐 + P2 决策

### Summary

(Add summary)

### Main Changes

## 本次工作

| 项目 | 内容 |
|------|------|
| PatchApplier 测试修复 | 修复 5 个与代码行为不一致的旧测试（追加→丢弃、level 不匹配→Fallback 2 匹配） |
| 新增测试覆盖 | +3 个测试：case-insensitive 回退、ambiguous 拒绝、混合 patch |
| P2 决策 | PatchApplier 相关的 P2 项（M-NEW-4 + ISS-002）已在 edc92f1 中完成，无需单独开 P2 |

## 测试结果

- 修复前：7 pass / 5 fail (12 tests)
- 修复后：15 pass / 0 fail (15 tests)

## 修改的文件

- `src/__tests__/unit/workflow-patch-applier.test.ts` — 重写测试对齐新行为 (**未提交，pending commit**)

## 关键决策

- P2 不再单独开任务：核心价值（PatchApplier 两个 fix）已作为 P1 副产物完成
- 建议下一步：用修好的工作流跑端到端 spec-review 验证


### Git Commits

| Hash | Message |
|------|---------|
| `edc92f1` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 19: Review /git、/usage、卡片通知 + 重构重复代码

**Date**: 2026-03-22
**Task**: Review /git、/usage、卡片通知 + 重构重复代码

### Summary

(Add summary)

### Main Changes

## 本次工作

### 1. Code Review：三个功能确认完成

| 功能 | 文件 | 测试 | 结论 |
|------|------|------|------|
| `/git` 命令 | `git-command.ts` + `git-llm.ts` + bridge-manager | 21 pass | ✅ 完成 |
| `/usage` 命令 | `usage-command.ts` + `usage-summary.ts` + bridge-manager | 6 pass | ✅ 完成 |
| 卡片完成通知 | `feishu-adapter.ts` finalizeCard() | 3 pass | ✅ 完成 |

### 2. 重构：消除 bridge-manager.ts 重复代码

提取 2 个辅助函数，替换 6 处 IIFE / 内联重复块：

- `buildChangeSummaryBlock(stagedFiles, diffStatText)` — diffStat 截断 + 文件列表兜底
- `buildSemanticSummaryBlock(summaryLines)` — LLM 语义摘要要点列表

净减 71 行（+63 / -134），行为完全不变，30 个相关测试全部通过。

### 3. P2B 飞书深度集成确认已实现

发现设计文档 `docs/feishu-v2-streaming-cards.md` 状态为"待开始"，但代码已全部实现：
- ✅ CardKit v1 流式卡片（streaming_mode）
- ✅ 工具进度实时渲染
- ✅ 权限内联按钮（card.action.trigger + WSClient monkey-patch）
- ✅ Thinking 状态 + Footer 耗时
- ✅ 速率限制保护 + 并发防护

**Updated Files**:
- `src/lib/bridge/bridge-manager.ts`


### Git Commits

| Hash | Message |
|------|---------|
| `47d45a8` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 20: Remove /restart command, replace with start/stop management

**Date**: 2026-03-23
**Task**: Remove /restart command, replace with start/stop management

### Summary

(Add summary)

### Main Changes

## 变更概述

移除了不可靠的 `/restart` 斜杠命令，用更简单的 `start/stop` 管理方案替代。

| 类别 | 变更 |
|------|------|
| **移除** | `/restart` 命令处理、`DeferredLifecycleAction` 类型、`onRestartRequested` 生命周期钩子、`sendNotification()` 导出、`restart-artifacts.ts` 模块、`restart-bridge.ps1` 脚本、3 个 restart 测试文件 |
| **新增** | 同 controlDir 单实例锁（pid 文件 + 存活检测）、定向 stop token（JSON `{ targetPid }` + 旧格式兼容）、heartbeat 加入 git commit hash 版本追踪 |
| **重写** | `start-bridges.ps1` 升级为 start/stop 管理工具（npm install → build → 启动，优雅停止 + 超时强杀，降级机制）|
| **新增** | `bridges.bat` 入口脚本、`bridge-runner-scripts.test.ts` 守护测试 |

**统计**: 12 files changed, +255 / -977 lines

**关键文件**:
- `src/lib/bridge/bridge-manager.ts` — 移除 /restart case + sendNotification + afterReply 逻辑
- `src/lib/bridge/host.ts` — 移除 DeferredLifecycleAction / RestartRequestResult / onRestartRequested
- `src/lib/bridge/internal/restart-artifacts.ts` — 删除
- `scripts/feishu-claude-bridge.ts` — 移除 restart 钩子，新增单实例锁 + 定向 stop + commit 追踪
- `scripts/start-bridges.ps1` — 重写为 start/stop 管理脚本
- `scripts/restart-bridge.ps1` — 删除
- `scripts/bridges.bat` — 新建入口


### Git Commits

| Hash | Message |
|------|---------|
| `7718949` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 21: feat: workflow 进度推送飞书卡片化

**Date**: 2026-03-23
**Task**: feat: workflow 进度推送飞书卡片化

### Summary

(Add summary)

### Main Changes

## 改动概要

将 `/workflow` 命令的进度推送从多条纯文本消息改为**单张可更新的飞书卡片**，解决工作流运行期间刷屏问题（每轮 7-8 条消息 → 1 张实时更新卡片）。

## 改动文件

| 文件 | 改动 |
|------|------|
| `src/lib/bridge/channel-adapter.ts` | +3 个可选方法: createWorkflowCard / updateWorkflowCard / finalizeWorkflowCard |
| `src/lib/bridge/markdown/feishu.ts` | +`buildWorkflowCardJson()` 带 header/footer 的卡片构建函数 |
| `src/lib/bridge/adapters/feishu-adapter.ts` | 实现工作流卡片 3 方法，独立 workflowCards Map，stop() 清理 |
| `src/lib/bridge/internal/workflow-command.ts` | 重写 `bindProgressEvents()`：状态聚合 + 卡片/文本双模式 + debounce |

## 设计决策

1. 非 streaming_mode: 用 card.update() 更新整张卡片
2. 独立 workflowCards Map: 与 Claude 流式卡片互不干扰
3. 500ms debounce: 快速连续事件合并为一次 API 调用
4. 自动降级: 卡片创建失败时 fallback 到纯文本
5. sequence 仅在成功时递增: 防频控跳号

## 验证

- TypeScript 编译零错误，270/270 测试通过
- 代码审查 88/100，关键问题已修复


### Git Commits

| Hash | Message |
|------|---------|
| `e6f7af8` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 22: 补充工作流卡片渲染函数单元测试

**Date**: 2026-03-23
**Task**: 补充工作流卡片渲染函数单元测试

### Summary

(Add summary)

### Main Changes

## 任务背景

评估两个后续迭代项的价值后，优先补充 `renderProgressMarkdown()` 和 `renderCompletionMarkdown()` 的单元测试。

## 完成内容

| 项目 | 详情 |
|------|------|
| 新增测试文件 | `src/__tests__/unit/workflow-render.test.ts` (55 个测试用例) |
| 源码导出 | `_renderProgressMarkdown`, `_renderCompletionMarkdown`, 类型 `_RoundProgress`, `_WorkflowProgressState` |
| Bugfix | 修复全零决策时输出空行问题（fallback 为"已完成"） |

## 测试覆盖

**renderProgressMarkdown** (37 tests):
- Codex 状态: pending/running/done、findings 计数、lgtm/major_issues 评估
- Issue 匹配: 新增 issues、Critical/High、0/undefined 边界
- Claude 状态: pending/running/done、决策计数、零值省略、全零 fallback
- Spec/Plan 更新: 单独/同时/无更新
- 轮次图标: 活跃 vs 已完成、终止/人工审查切换
- 多轮排序、警告、终止判定、人工审查

**renderCompletionMarkdown** (17 tests):
- 结构顺序、数据字段、严重度、状态分布

## 决策记录

- **Inline 按钮**: 建议延后，已有命令替代，暂停引入状态机复杂度
- **测试优先**: 纯函数成本低、回归保护价值高


### Git Commits

| Hash | Message |
|------|---------|
| `a821824` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 23: P1b-CR-0 代码审查工作流设计（3 轮审查迭代）

**Date**: 2026-03-23
**Task**: P1b-CR-0 代码审查工作流设计（3 轮审查迭代）

### Summary

(Add summary)

### Main Changes

## 产出

| 产出 | 路径 | 说明 |
|------|------|------|
| Code Review Spec | `.claude/plan/code-review-workflow-spec.md` | ~1100 行完整设计文档 |
| 任务 PRD | `.trellis/tasks/.../03-23-workflow-code-review/prd.md` | 含 7 个核心不变量 + 分类验收清单 |
| 父 Spec 更新 | `.claude/plan/workflow-engine-spec.md` | P1b 章节精简为链接+核心约束 |

## 核心设计决策

1. **WorkflowProfile 参数化** — 引擎泛化策略，behavior 标志控制步骤差异
2. **ReviewSnapshot 冻结快照** — blob SHA 按需读取，不用 fs.readFile，解决 staged/resume 一致性
3. **accepted 终态语义** — acceptedIsTerminal 标志，TerminationJudge 感知
4. **Issue 结构化扩展** — source_file/line_range/category/fix_instruction 可选字段
5. **expectedDecisionIds 统一验证** — 覆盖有 findings 和无 findings 两种场景
6. **数据源分层** — IssueLedger（issue 决策）+ ReviewSnapshot（报告快照）+ WorkflowMeta

## 外部审查闭环

经过 3 轮外部 AI 审查，累计 12+ 个 findings 全部闭环：
- R1: 状态机不闭合 / 数据混装 / git 合同不完整 / CLI 二义性 → 全部修复
- R2: 非冻结快照 / 终止语义漂移 / accepted_issues 不闭环 / 真相源表述 → 全部修复
- R3: IssueMatcher 文字不一致 / reject reason 说明缺失 / prompt 措辞 → 全部修复

## 7 个核心不变量（INV-1~7）

- INV-1: accepted 是终态 + 终止条件对齐（5 条规则）
- INV-2: reason 和 fix_instruction 分开存储
- INV-3: 数据真相源分层
- INV-4: 审查基于冻结快照
- INV-5: 敏感文件排除 + 审计
- INV-6: CLI scope 无二义性
- INV-7: accepted_issues 正式输入 Codex prompt


### Git Commits

| Hash | Message |
|------|---------|
| `3b401ce` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 24: P1b-CR-0 Phase 1+2: Code Review Workflow 引擎泛化 + 数据管道

**Date**: 2026-03-23
**Task**: P1b-CR-0 Phase 1+2: Code Review Workflow 引擎泛化 + 数据管道

### Summary

Phase 1: WorkflowProfile 接口 + 15 个 Code Review 类型 + Issue 扩展 + engine/termination-judge 泛化。Phase 2: DiffReader (git diff+冻结快照) + PackBuilder/PromptAssembler 扩展 + 3 个新 prompt 模板。221 测试全部通过，向后兼容。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `3a848c1` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 25: Workflow P1b-CR-0 Phase 3+4

**Date**: 2026-03-23
**Task**: Workflow P1b-CR-0 Phase 3+4

### Summary

(Add summary)

### Main Changes

| ?? | ?? |
|------|------|
| ?? | `11c2033` |
| ?? | Workflow P1b-CR-0 Phase 3+4 |
| ???? | ?? `report-generator.ts`??? `IssueMatcher` ??????????`DecisionValidator` ??? profile ?????`WorkflowEngine` ?? `fix_instruction` |
| ???? | ?? `.claude/plan/code-review-workflow-spec.md` ??? `prd.md`??? code-review ??????? |
| ???? | `pnpm typecheck` ???`report-generator.ts` ??? `WorkflowStore.loadSnapshot()`?? `WorkflowStore` ??????? |
| ????? | ?????????????????? |

**??????**?
- ????????? Phase 3+4 ???????????? `11c2033`?
- ??? code-review ?????????? matcher / validator / engine ? code-review ?????
- ?????????????? P1b-CR-0 ??????????
- ????????????????????????????? `WorkflowStore` ? `ReportGenerator` ????


### Git Commits

| Hash | Message |
|------|---------|
| `11c2033` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 26: P1b-CR-0 Phase 4 fix + Phase 5: complete code-review MVP

**Date**: 2026-03-24
**Task**: P1b-CR-0 Phase 4 fix + Phase 5: complete code-review MVP

### Summary

Fix Phase 4 gaps (WorkflowStore snapshot, engine profile routing, IM code-review entry) + Phase 5 integration tests (14 new) + docs sync. 238/238 tests pass.

### Main Changes

### Phase 4 修复（遗漏问题）

| 文件 | 修复内容 |
|------|----------|
| `workflow-store.ts` | 新增 `saveSnapshot()` / `loadSnapshot()` 方法，持久化 ReviewSnapshot 为 `snapshot.json` |
| `workflow-engine.ts` | runLoop Step A/C 按 `profile.type` 路由 pack/prompt 方法（之前硬编码 spec-review） |
| `workflow-engine.ts` | `start()` 新增可选 `snapshot` 参数，在 runLoop 前持久化 |
| `workflow-engine.ts` | 新增 `loadCodeReviewContext()` 从 snapshot 构建 ChangedFile[] |
| `workflow-command.ts` | 新增 `handleStartCodeReview()` 支持 `--type code-review`、`--range`、`--branch-diff`、`--exclude` |
| `workflow-command.ts` | `resume` 根据 `meta.workflow_type` 动态选择引擎类型 |
| `workflow-command.ts` | 更新帮助文本，新增 code-review 用法说明 |

### Phase 5 集成测试

| 测试文件 | 内容 |
|----------|------|
| `workflow-code-review.test.ts`（新建） | 4 组 14 个集成测试：正常 2 轮流程、acceptedIsTerminal 语义、ReportGenerator 输出、Profile 行为标志 |
| `workflow-store.test.ts` | 新增 3 个 snapshot 方法测试 |
| `workflow-command.test.ts` | 更新 10 个断言适配新 `workflowType` 字段 |

### 文档同步

| 文档 | 更新 |
|------|------|
| `code-review-workflow-spec.md` | 顶部标记完成；Acceptance Criteria 36 项勾选；Implementation Sequence 标注各 Phase session |
| `workflow-engine-plan.md` | P1b-CR-0 标记完成；Future Points 更新为 P1b-CR-1/CR-2/P2b/P3 |

### 最终验证

- TypeScript 编译：零错误
- 全量测试：**238/238 通过**（含 17 个新增测试）
- 回归安全：spec-review 所有原有测试不受影响


### Git Commits

| Hash | Message |
|------|---------|
| `948603e` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 27: Close Out Code-Review IM MVP

**Date**: 2026-03-24
**Task**: Close Out Code-Review IM MVP

### Summary

(Add summary)

### Main Changes

| ?? | ?? |
|------|------|
| MVP ?? | ?? code-review IM ???????????? diff / ? changed_files ?? |
| ???? | workflow ????? `code-review-report.md` ? `code-review-report.json`???????????? |
| ?? | ???????????????? `npm run typecheck` ? `npm run test:unit`?367/367? |
| ???? | ?? code-review spec?workflow ??????? PRD????? CLI `code-review` ??? |

**????**?
- `src/lib/workflow/workflow-engine.ts`
- `src/lib/workflow/diff-reader.ts`
- `src/lib/workflow/workflow-store.ts`
- `src/lib/bridge/internal/workflow-command.ts`
- `src/__tests__/unit/workflow-code-review.test.ts`
- `docs/workflow-conclusions-summary.md`

**??**?
- `npm run typecheck`
- `npm run test:unit`


### Git Commits

| Hash | Message |
|------|---------|
| `5148d8d` | (see git log) |
| `a2e74a8` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 28: 拆分 workflow 审查命令

**Date**: 2026-03-24
**Task**: 拆分 workflow 审查命令

### Summary

将 /workflow 显式拆分为 spec-review 与 code-review 子命令，同步更新桥接帮助、命令解析单测和 workflow 总结文档。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `18978ba` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 29: feat: P1b-CR-1 Review-and-Fix + CLI subcommands + Feishu interactive cards

**Date**: 2026-03-24
**Task**: feat: P1b-CR-1 Review-and-Fix + CLI subcommands + Feishu interactive cards

### Summary

Three major features: (1) CLI rewrite with spec-review/code-review/review-fix subcommands, (2) AutoFixer module with worktree isolation + Codex fixes (P1b-CR-1), (3) Feishu workflow card interactive buttons (stop/resume/report). 393/393 tests pass, +1422/-154 lines across 12 files.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `cfedd9b` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 30: fix: 模板引擎 4 Bug 导致 Codex code-review 全轮超时

**Date**: 2026-03-24
**Task**: fix: 模板引擎 4 Bug 导致 Codex code-review 全轮超时

### Summary

(Add summary)

### Main Changes

## 问题现象

`/workflow code-review` 连续 3 轮 Codex 审查"超时"（实际每轮仅 11-14 秒），0 issue，以 `max_rounds_reached` 终止。

## 根因分析

4 个 Bug 叠加导致 725KB prompt 膨胀到 4.5MB，超出 Codex CLI 的 1M 字符硬限制：

| Bug | 类别 | 文件 | 严重度 |
|-----|------|------|--------|
| $ 反向引用膨胀 | String.replace 将 $' 解释为特殊模式 | prompt-assembler.ts | Critical |
| Prompt 超限 | diff(449K) + 文件内容(290K) 无预算控制 | prompt-assembler.ts | Critical |
| 误报 TimeoutError | withRetry 丢失真实错误 + 输入超限浪费重试 | model-invoker.ts | Medium |
| 占位符级联展开 | diff 中 {{changed_files}} x6 被二次替换 | prompt-assembler.ts | Critical |

## 修复内容

**prompt-assembler.ts**: replaceAllPlaceholders() 单次扫描替换 + CODEX_PROMPT_BUDGET 900K + renderChangedFilesHunksOnly()
**model-invoker.ts**: TimeoutError 保留真实错误 + NON_RETRYABLE_PATTERNS 新增输入超限

## 验证: 4,591,453 chars -> 742,781 chars (6.2x shrink)

## Spec 更新 (Break-the-Loop)

- workflow-engine.md: 模板渲染安全铁律 + 外部系统硬限制表
- cross-layer-thinking-guide.md: 内容注入导致跨层膨胀案例
- guides/index.md: 触发条件增加内容注入场景

**Updated Files**: prompt-assembler.ts, model-invoker.ts, workflow-engine.md, cross-layer-thinking-guide.md, guides/index.md


### Git Commits

| Hash | Message |
|------|---------|
| `ccca9d6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 31: Code-Review Workflow Bugfix (9 bugs + 4 review fixes)

**Date**: 2026-03-24
**Task**: Code-Review Workflow Bugfix (9 bugs + 4 review fixes)

### Summary

(Add summary)

### Main Changes

## 修复概览

修复 code-review 工作流根因链上的 9 个 Bug，加上审查反馈中发现的 4 个额外问题。

### P0 修复（用户可见的关键问题）

| Bug | 文件 | 修复 |
|-----|------|------|
| P0-1 | `diff-reader.ts` | `exclude_patterns` 现在过滤 `snapshot.diff` 文本，移除 60% 噪音 |
| P0-2 | `report-generator.ts` | `determineConclusion()` 重写判定树，open 不再误报 clean |
| P0-3 | `report-generator.ts` | `open→unreviewed` 语义区分，不再伪装为 defer |
| P0-4 | `bridge-manager.ts` + `workflow-command.ts` | 新增 `/workflow report` 子命令完整链路 |

### P1 修复（性能与错误分类）

| Bug | 文件 | 修复 |
|-----|------|------|
| P1-1 | `prompt-assembler.ts` | Claude prompt 添加 800K 预算，三级降级 full→hunks→truncate |
| P1-2 | `model-invoker.ts` | exit code 1 不再被误标为超时重试 |
| P1-3 | `workflow-engine.ts` | `terminateWorkflow()` 同步更新 `current_step` |

### P2 修复（弹性与降级）

| Bug | 文件 | 修复 |
|-----|------|------|
| P2-1/P2-2 | `workflow-engine.ts` | Claude 连续失败 ≥2 次后跳过，Codex-only 降级模式 |

### 审查反馈修复

| # | 问题 | 修复 |
|---|------|------|
| Fix1 | 非超时错误仍发 `claude_decision_timeout` 事件 | 新增 `claude_decision_skipped` 事件 + UI handler |
| Fix2 | rejected critical 抬高结论 | `bySeverityActive` 排除 rejected |
| Fix3 | 降级分支调 `saveCheckpoint()` 误写 paused | 移除不当调用 |
| Fix4 | `handleReport` 路径缺 `runs/` | 修正为 `{basePath}/runs/{runId}/` |

### 类型变更

- `CodeReviewReport.conclusion` 新增 `needs_review`
- `FileReviewResult.action` 新增 `unreviewed`
- `WorkflowEventType` 新增 `claude_decision_skipped`
- `WorkflowSubcommand` 新增 `{ kind: 'report'; runId: string }`

### 验证

- TypeCheck: ✅ 通过
- 单元测试: ✅ 267/267 通过


### Git Commits

| Hash | Message |
|------|---------|
| `82889b3` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 32: 方向A: Prompt模板优化 + Bug修复 + 降级透明性

**Date**: 2026-03-25
**Task**: 方向A: Prompt模板优化 + Bug修复 + 降级透明性

### Summary

(Add summary)

### Main Changes

## 工作内容

本次 session 执行"方向A: 先打磨再扩展"路线图的阶段1（Prompt模板优化）和阶段2（Bug修复），共完成 9 项任务。

### 阶段1: Prompt 模板优化（6项）

| # | 优化项 | 文件 | 效果 |
|---|--------|------|------|
| 1-1 | Few-shot 正反例 | `code-review-pack.md` | 基于真实运行数据的好/坏finding对比示例 |
| 1-2 | 类别边界定义表 | `code-review-pack.md` | 10个类别的 IS/Is NOT 对比表，减少误分类 |
| 1-3 | 审查深度优先级 | `code-review-pack.md` | 70% bug/security > 25% perf/type_safety > 5% style |
| 1-4 | Claude 驳回引导 | `code-review-decision-system.md` | 6种常见应驳回模式 |
| 1-5 | 语言指示 | 全部6个模板 | 统一简体中文输出 |
| 1-6 | 降级透明性 | assembler + engine + command + types | 新增 context_degraded 事件 + IM 推送 |

### 阶段2: Bug 修复（3项）

| # | 状态 | 说明 |
|---|------|------|
| 2-1 | 已在之前修复 | determineConclusion() 混合状态逻辑已正确 |
| 2-2 | 已在之前修复 | chunkMarkdownReport() 超长单行分割已实现 |
| 2-3 | 本次修复 | TimeoutError 不再触发永久降级，只有 ModelInvocationError 触发 |

### 验证: 394 tests pass, tsc --noEmit clean

### 剩余计划（阶段3: 体验增强）
- context_files 自动发现
- /workflow list 历史浏览
- 工作流参数自定义


### Git Commits

| Hash | Message |
|------|---------|
| `c55c15c` | (see git log) |
| `de6f3e8` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
