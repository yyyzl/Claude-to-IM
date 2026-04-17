# 调研备忘录 — Context Usage Indicator (IM 桥接场景)

> **日期**: 2026-04-17
> **Owner**: fusion-trellis bridge
> **状态**: Research 完成，待进入 PRD 阶段
> **关联任务**: （待创建）feat/ctx-usage-indicator

---

## 1. 背景与动机

当前 `Claude-to-IM` 桥接层把 Claude Code / Codex 的响应投递到飞书群。与传统 Terminal UI（自带 statusline / context 插件可实时显示窗口占用）相比，**IM 侧对上下文窗口的感知是盲区**：用户无法知道当前 session 的 token 占比，难以判断是否应该 `/clear` 或新开 session。

多群多项目场景下问题更显著：同一桥接进程服务 N 个群 × M 个项目 × K 个 session，任何一个"闷声吃满窗口"都会直接影响后续回答质量。

## 2. 需求收敛（用户已确认）

| 维度 | 决定 |
|------|------|
| **展示形式** | 方案 A1：纯字一行 `ctx 42% (84k/200k)`，贴在飞书卡片 footer |
| **范围** | **只做展示**；`/clear` 和 session 切换是已有能力，本任务不碰 |
| **Session 隔离** | 多群 × 多项目 × 多 session 并存，按复合 key 管理 |
| **核心约束** | 对上下文污染**尽可能小**（零污染优先） |
| **覆盖后端** | Claude Code + Codex（Gemini 未定） |

## 3. 关键发现（实锤证据）

### 3.1 Codex 侧（重点突破）

#### Rollout JSONL 持久化

- 路径：`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session_uuid>.jsonl`
- 每条 session 一个文件，每行一个事件（session_meta / response_item / event_msg / turn_context / …）
- Windows 实际路径：`C:\Users\<user>\.codex\sessions\...`

#### session_meta 首行结构

```json
{
  "timestamp": "...",
  "type": "session_meta",
  "payload": {
    "id": "019bcb70-512e-7560-a63d-e5ac2f369f63",
    "cwd": "G:\\RustProject\\push-2-talk",
    "cli_version": "0.87.0",
    "model_provider": "custom",
    "git": { "repo_url": "...", "branch": "main", "commit_hash": "..." }
  }
}
```

> **意义**：`session_meta.id` 即 session_id；`cwd` + `git.*` 直接提供"项目身份"，桥接层无需自建项目画像表。

#### token_count 事件结构（最关键）

```json
{
  "timestamp": "...",
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": {
      "last_token_usage": {
        "input_tokens": 6708,
        "cached_input_tokens": 0,
        "output_tokens": 51,
        "reasoning_output_tokens": 0,
        "total_tokens": 6759
      },
      "total_token_usage": {
        "input_tokens": 12529,
        "cached_input_tokens": 0,
        "output_tokens": 153,
        "reasoning_output_tokens": 64,
        "total_tokens": 12682
      },
      "model_context_window": 258400
    },
    "rate_limits": { "...": "..." }
  }
}
```

> **意义**：rollout 文件**同时**提供 `last_token_usage`（本轮实际 prompt 规模）、`total_token_usage`（session 累计）、`model_context_window`（窗口硬上限）。计算占比所需信息**全部就位**，无需硬编码窗口大小。

#### GitHub Issue #17539 的澄清

- Issue 抱怨 "turn.completed 只报 total，丢了 last"
- **作用域仅限 `codex exec --json` stdout 的 `turn.completed` 事件**
- **rollout JSONL 文件里 `last` 和 `total` 都存在**（已实锤）
- 故即便 stdout 通道失效，回落到文件读取即可

### 3.2 Claude Code 侧（对称对标）

| 维度 | Claude Code | Codex |
|------|-------------|-------|
| 数据载体 | `~/.claude/projects/<hash>/*.jsonl`（transcript） | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Token 字段 | `message.usage.{input,output,cache_read,cache_creation}_input_tokens` | `event_msg.payload.info.last_token_usage.input_tokens` |
| 上下文窗口 | **不直接提供**，需硬编码或按模型名推（200k/1M） | **直接给** `model_context_window`（零硬编码） |
| Hook 机制 | 原生 `Stop` / `PostToolUse` hooks 可直接触发 | 无原生 hook，靠 stdout 流 / 文件轮询 |
| session 边界 | `session_id` 字段 + CWD | `session_meta.id` + `cwd` + `git.*` 更丰富 |

> **反直觉**：Codex 侧的数据结构反而**比 CC 更规整**（窗口直接给），只是缺 hook 机制。

## 4. 技术路径对比矩阵

| # | 方案 | 后端 | 实时性 | 污染度 | 实现成本 | 可靠性 |
|---|------|------|--------|--------|----------|--------|
| 1 | CC: Stop hook + transcript 读取 | Claude Code | 高 | 0 | 低 | 高 |
| 2 | CC: Agent SDK 响应 `usage` 字段 | Claude Code | 高 | 0 | 低（已用 SDK 则几乎白嫖） | 高 |
| 3 | Codex: rollout 文件尾追读 | Codex | 中（~100ms） | 0 | 低 | 高 |
| 4 | Codex: `codex exec --json` stdout 解析 | Codex | 高 | 0 | 中 | 中（依赖版本是否带 last） |
| 5 | 斜杠命令 `/context` / 伪用户输入 | 任一 | 高 | **高** | 低 | — |

> **选择**: CC 走 `1 或 2` + Codex 走 `3`（主）+ `4`（增强）。方案 5 彻底排除。

## 5. 推荐方案（简单版 = 生产就绪版）

### 5.1 数据源决策

```
Codex:       rollout 文件最后一条 token_count 事件的 last_token_usage.input_tokens
Claude Code: transcript 最后一条 assistant 消息的 message.usage.input_tokens
公式:        input_tokens / model_context_window × 100
展示:        ctx {pct}% ({input_k}k/{window_k}k)
触发时机:    桥接层每次"turn 结束"准备封卡片前
```

### 5.2 抽象接口草案

```ts
// src/lib/bridge/internal/usage-probe.ts (建议位置)

export type Backend = 'claude-code' | 'codex';

export interface SessionKey {
  chatId: string;        // IM 群 id
  backend: Backend;
  sessionId: string;     // 后端 session uuid
}

export interface UsageSnapshot {
  backend: Backend;
  inputTokens: number;       // last-turn prompt size
  contextWindow: number;     // 模型最大窗口
  percent: number;           // 0-100 (round)
  capturedAt: number;        // epoch ms，用于 staleness 判断
}

export interface UsageProbe {
  probe(key: SessionKey): Promise<UsageSnapshot | null>;
}

export function formatFooter(s: UsageSnapshot | null): string | null {
  if (!s) return null;
  const kb = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  return `ctx ${s.percent}% (${kb(s.inputTokens)}/${kb(s.contextWindow)})`;
}
```

### 5.3 两个实现

- **`CodexRolloutProbe`**：给定 `sessionId` → 解析成 rollout 文件路径 → `tail` 扫最近 N 行 → 找最新 `token_count` 事件
- **`ClaudeCodeTranscriptProbe`**：给定 `sessionId` → 定位 transcript jsonl → 扫最近 assistant 消息 `usage` + 按模型名查窗口大小表

### 5.4 渲染路径

桥接层 markdown→card 管线在 footer / note block 追加一行（灰色小字），不污染正文区。

## 6. Session 生命周期处理

### 6.1 new / clear 时的映射刷新

- **方案 P1（主）**：`/clear` 或 new 命令触发时，桥接层**清空该 chatId 的 session 映射**；下次 probe 时重建（由桥接层启动 Codex 子进程时捕获新 session_id）
- **方案 P2（兜底）**：probe 每次调用前校验 `rollout_path` 的 mtime / 存在性，失效则扫 `~/.codex/sessions/` 找最新 mtime 文件

> 推荐 **P1 + P2 兜底**。不做 P3（独立 watcher），避免过度工程。

### 6.2 Session 定位（启动时）

- 桥接层 spawn Codex 时用 `codex exec --json`，首条事件 `thread.started` / `session_meta` 即含 id → 抓下来存映射
- CC 同理，通过 Agent SDK 的 session id 回调或 transcript 文件最新 mtime 定位

## 7. 自动压缩（auto-compaction）免疫论证

### 7.1 为什么选的数据源天然免疫

1. **压缩本身是一次 API 调用**（让模型做 summary），必然产生新的 `token_count` 事件写进 rollout
2. `last_token_usage.input_tokens` = 最近一次 API 调用的实际 prompt 规模 → 压缩前 ≈200k，压缩后立即变成 ≈30k
3. 用户看到的数字序列本身就是"压缩已发生"的最清晰信号：
   ```
   ctx 82% (212k/258k)   ← turn N
   ctx 12% (31k/258k)    ← turn N+1（发生压缩）
   ctx 18% (46k/258k)    ← turn N+2
   ```

### 7.2 唯一理论边界（实际不存在）

- 若后端在单个 turn 内做"哑截断"且不触发 token_count 事件 → 漏感知
- 经源码/文档查阅：CC 和 Codex 均**不存在此路径**，任何模型交互都走完整 usage 统计

### 7.3 可选增强（后续迭代，MVP 不做）

- 跨 turn 比较 input_tokens，若 `new < old × 0.5` 追加 `↻` 符号：`ctx 12% (31k/258k) ↻`
- 提示用户"刚发生压缩"，感知更主动

## 8. 风险与后续增强

| 风险 / 缺口 | 严重度 | 对策 |
|-------------|--------|------|
| Codex rollout 文件在极长 session 下膨胀（MB 级） | 低 | tail 读取而非全量扫描 |
| Codex 版本升级后事件字段变化 | 中 | parser 做容错 + 回退到 `total_token_usage` 近似 |
| Claude Code 不同模型的 context_window 需硬编码表 | 中 | 集中到 `model-registry.ts`，模型升级时只改一处 |
| 多进程并发写 rollout 的读锁问题 | 低 | Codex 一个 session 一文件，天然无冲突 |
| Windows 路径分隔符 `\` vs `/` | 低 | `path.join` / `path.normalize` 统一 |

## 9. 开放问题（需 PRD 阶段决策）

1. CC 侧首选 SDK 内嵌 usage 还是 Stop hook？取决于桥接当前接入形态（`src/lib/bridge/adapters/` 里看）
2. 窗口注册表 `model-registry.ts` 是否要支持运行时热更新（用户自定义模型）？
3. footer 渲染位置：飞书 card 的哪个区域（note / footer / markdown block）渲染最不突兀？需要对照 `src/lib/bridge/markdown/` 的现有实现
4. Gemini 后端是否纳入本期？（当前优先级：P2，不阻塞）
5. footer 是否需要"数据新鲜度"标识（例如 ctx 数据 >5s 陈旧时追加 `~`）？

## 10. 下一步行动

- [ ] `fusion:checkpoint` 快照本次 research（本文档完成后执行）
- [ ] 进入 PRD 阶段（`product-requirements` skill），产出：
  - 功能验收标准
  - 测试用例清单
  - 灰度 / 降级策略
- [ ] PRD 通过后进入任务拆分与实现

## 附：关键链接

- Codex CLI reference: https://developers.openai.com/codex/cli/reference
- Codex non-interactive mode: https://developers.openai.com/codex/noninteractive
- Codex config reference: https://developers.openai.com/codex/config-reference
- Issue #17539（last 在 exec JSONL 被丢）: https://github.com/openai/codex/issues/17539
- DeepWiki session management: https://deepwiki.com/openai/codex/3.3-session-management-and-persistence
- ccusage Codex guide: https://ccusage.com/guide/codex/
