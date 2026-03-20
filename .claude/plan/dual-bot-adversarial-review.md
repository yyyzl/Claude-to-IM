# 📋 实施计划：双 Bot 对抗式审查 & IM-Driven Development

## 任务类型
- [x] 全栈 (→ Claude + Codex 协作)

## 背景与动机

### 为什么需要双 Bot 协作？

1. **模型特长互补** — Claude 擅长复杂推理/架构设计/需求分析，Codex 擅长代码生成/Sandbox执行/自动化
2. **对抗式审查消除盲点** — 不同模型有不同盲点，交叉审查大幅提升质量
3. **清空上下文避免锚定效应** — 每轮审查用全新会话，避免模型对自己之前的输出产生偏见
4. **成本效率** — 高价值决策用强模型(Claude Opus)，执行型任务用效率模型(Codex)
5. **人在回路** — 用户保留最终决策权，Bot 只是辅助

### 核心工作流：对抗式审查（Adversarial Review）

```
[生成 Spec/Plan]
     ↓
┌─── 审查循环 ──────────────────────┐
│                                    │
│  Claude(新会话) → 审查 → 意见       │
│  Codex(新进程) → 审查 → 意见        │
│  合并意见 → 推送到 IM 群            │
│  用户决策：修改 → 重来 / 通过 → 退出 │
│                                    │
│  退出条件：                        │
│  ✅ 两模型都 LGTM                  │
│  ✅ 用户手动跳过                    │
│  ⛔ 超过最大轮次(如5轮)             │
└────────────────────────────────────┘
     ↓
[执行实现] → [实现审查] → [提交部署]
```

---

## 技术方案

### 全景架构

```
═══════════════════════════════════════════════════════
         IM-Driven Development 完整架构
═══════════════════════════════════════════════════════

[飞书/Telegram/Discord 群]
         ↕ (适配器)
[Claude-to-IM Bridge 网关层]
  ├── 命令路由器
  │    ├─ 普通对话 → Claude SDK
  │    ├─ /review → 审查编排器 (新模块)
  │    ├─ /dev: → Session Orchestrator
  │    ├─ /codex: → Codex CLI (现有)
  │    └─ // → Claude 透传 (现有)
  │
  ├── 审查编排器 (新模块: review-orchestrator.ts)
  │    ├─ ReviewRound 管理
  │    ├─ 多模型调度 (Claude/Codex 交替)
  │    ├─ 意见合并 & 冲突检测
  │    ├─ LGTM 共识判定
  │    └─ 审查历史持久化
  │
  └── Session Orchestrator 集成层 (新模块)
       ├─ HTTP Client → Orchestrator API
       ├─ 事件订阅 → IM 进度推送
       └─ 审批桥接 → IM 按钮 → API

[Session Orchestrator 编排层] (G:\project\session-orchestrator)
  ├── 新增: Claude Runner (对标 RealRunner)
  ├── 新增: Review Phase 工作流
  ├── 新增: Webhook 事件推送
  └── 现有: Codex Runner, 工作项管理, 事件流
```

---

## 分阶段实施计划

### 阶段一：对抗式审查命令（核心价值，优先实现）

**目标**：在 IM 中一键触发双模型审查循环

#### Step 1.1 — 新增 ReviewOrchestrator 模块

**文件**: `src/lib/bridge/internal/review-orchestrator.ts`

**核心逻辑**:
```typescript
interface ReviewRound {
  roundIndex: number;
  claudeVerdict: ReviewVerdict;  // 'lgtm' | 'concerns' | 'pending'
  codexVerdict: ReviewVerdict;
  claudeFeedback: string;
  codexFeedback: string;
  specVersion: number;           // spec 文件版本
}

interface ReviewSession {
  sessionId: string;
  specFilePath: string;          // spec/plan 文件路径
  rounds: ReviewRound[];
  status: 'reviewing' | 'consensus' | 'max_rounds' | 'user_skip';
  maxRounds: number;             // 默认 5
}

class ReviewOrchestrator {
  // 启动审查流程
  async startReview(specPath: string, options?: ReviewOptions): Promise<ReviewSession>;

  // 执行一轮审查（Claude + Codex 串行，各自新会话）
  async executeRound(session: ReviewSession): Promise<ReviewRound>;

  // 判断是否达成共识
  isConsensusReached(round: ReviewRound): boolean;

  // 合并两个模型的意见
  mergeFeedback(claudeFeedback: string, codexFeedback: string): string;
}
```

**关键设计**:
- Claude 审查：创建新的 Claude Code SDK 会话，只传入 spec 文件内容 + 审查提示词
- Codex 审查：调用 codeagent-wrapper（天然新进程）
- 每轮审查结果保存到文件（审计追溯）
- 支持并行审查（Claude 和 Codex 同时审查）或串行审查（先 Claude 后 Codex）

**预期产物**: `review-orchestrator.ts`（约 200-300 行）

#### Step 1.2 — 新增 /review 命令

**文件**: `src/lib/bridge/bridge-manager.ts`（命令路由）

**命令格式**:
```
/review <file_path>              # 启动审查
/review status                   # 查看审查状态
/review next                     # 执行下一轮
/review skip                     # 跳过审查，直接执行
/review history                  # 查看审查历史
```

**交互流程**:
```
用户: /review .claude/plan/search-feature.md

Claude Bot: "📋 对抗式审查启动
  📄 文件: search-feature.md
  🔄 最大轮次: 5

  ⏳ Round 1 — Claude 正在审查..."

[Claude 审查完成]
Claude Bot: "🔍 Round 1 — Claude 审查结果:
  ⚠️ 缺少错误处理策略 (L45-L60)
  ⚠️ 搜索算法复杂度未评估
  ✅ 架构设计合理
  ✅ API 接口定义清晰

  ⏳ Codex 正在审查..."

[Codex 审查完成]
Claude Bot: "🔍 Round 1 — Codex 审查结果:
  ⚠️ 缺少单元测试定义
  ✅ 实现方案可行
  ✅ 性能方案合理

  ━━━━━━━━━━━━━━━━━━━━━━
  📊 Round 1 总结: 3 个待解决问题

  [修改后重新审查] [查看完整报告] [跳过执行]"
```

**预期产物**: 命令路由扩展 + 飞书卡片模板

#### Step 1.3 — 审查结果持久化

**文件**: `src/lib/bridge/internal/review-store.ts`

**存储结构**:
```
.claude-to-im/reviews/
├── {review_session_id}/
│   ├── spec-v1.md              # 原始 spec
│   ├── spec-v2.md              # 修改后 spec
│   ├── round-1-claude.md       # Claude 审查报告
│   ├── round-1-codex.md        # Codex 审查报告
│   ├── round-2-claude.md       # 第二轮...
│   └── summary.json            # 审查摘要
```

**预期产物**: `review-store.ts`（约 100 行）

---

### 阶段二：Session Orchestrator 集成

**目标**：将编排器的工作流能力引入 IM

#### Step 2.1 — Orchestrator HTTP Client

**文件**: `src/lib/bridge/internal/orchestrator-client.ts`

```typescript
class OrchestratorClient {
  constructor(baseUrl: string);  // 如 http://127.0.0.1:8765

  // 创建运行
  async startRun(params: StartRunParams): Promise<RunSnapshot>;

  // 获取快照
  async getSnapshot(runId: string): Promise<RunSnapshot>;

  // 获取事件流
  async getEvents(runId: string, since?: number): Promise<Event[]>;

  // 人工审批
  async submitReview(runId: string, verdict: 'approve' | 'reject'): Promise<void>;

  // 暂停/继续
  async pause(runId: string): Promise<void>;
  async resume(runId: string): Promise<void>;
}
```

**预期产物**: `orchestrator-client.ts`（约 150 行）

#### Step 2.2 — 新增 /dev: 命令前缀

**命令格式**:
```
/dev: 给 book-manage 加搜索功能    # 启动编排任务
/dev:status                        # 查看任务状态
/dev:pause                         # 暂停
/dev:resume                        # 继续
/dev:approve                       # 审批通过
/dev:reject                        # 驳回
```

**交互链路**:
```
用户: /dev: 给 book-manage 加搜索功能

Claude Bot: "🚀 开发任务已创建
  📋 Task ID: run-abc123
  📂 工作目录: book-manage/

  Phase 1: 需求分析 (Claude) ...
  Phase 2: 代码实现 (Codex) ...
  Phase 3: 代码审查 (Claude) ...
  Phase 4: 提交

  ⏳ 正在执行 Phase 1..."

[进度推送]
Claude Bot: "✅ Phase 1 完成 — 需求分析
  📎 查看分析报告
  ⏳ Phase 2 — Codex 正在实现..."

Claude Bot: "✅ Phase 2 完成 — 代码实现
  📎 变更: +120 -30 (3 files)
  ⏳ Phase 3 — Claude 正在审查..."

Claude Bot: "📋 Phase 3 — 审查需要人工确认
  ⚠️ 发现 1 个建议优化点
  [通过] [驳回] [查看详情]"

用户: [点击通过]

Claude Bot: "✅ 全部完成！
  📎 feat(book-manage): add search functionality
  🔗 Commit: abc1234"
```

#### Step 2.3 — 事件推送桥接

**文件**: `src/lib/bridge/internal/event-bridge.ts`

```typescript
class EventBridge {
  // 轮询 orchestrator 事件并推送到 IM
  async startPolling(runId: string, chatId: string): Promise<void>;

  // 事件 → IM 消息的映射
  mapEventToMessage(event: OrchestratorEvent): OutboundMessage | null;

  // 智能聚合（合并短时间内的多个事件）
  aggregateEvents(events: OrchestratorEvent[]): AggregatedMessage;
}
```

**事件映射规则**:
| Orchestrator 事件 | IM 消息 |
|---|---|
| `step_started` | "⏳ 正在执行: {step_name}" |
| `step_finished(success)` | "✅ 完成: {step_name}" |
| `step_finished(failed)` | "❌ 失败: {step_name} - {reason}" |
| `human_review` | "📋 需要审查 [approve] [reject]" |
| `paused` | "⏸️ 已暂停: {reason}" |
| `work_item_selected` | "📌 当前工作项: {title}" |
| `consensus_reached` | "🎉 审查通过！" |

**预期产物**: `event-bridge.ts`（约 150 行）

---

### 阶段三：Session Orchestrator 增强

**目标**：让编排器原生支持双模型 + 审查工作流

#### Step 3.1 — 新增 Claude Runner

**文件**: `session-orchestrator/src/runners.py`

```python
class ClaudeRunner(BaseRunner):
    """通过 Claude Code SDK 执行步骤"""

    def __init__(self, sdk_path: str, model: str = "claude-sonnet-4-6"):
        self.sdk_path = sdk_path
        self.model = model

    def run_step(self, command: str, context: dict) -> RunnerStepResult:
        # 创建新会话（清空上下文）
        # 传入命令 + 相关文件
        # 返回模型输出
        ...
```

#### Step 3.2 — 新增 Review Phase 工作流

**文件**: `session-orchestrator/src/orchestrator_prompts.json`

```json
{
  "prompt_overrides": {
    "review": {
      "workflow_steps": [
        {"name": "claude_review", "runner": "claude", "command": "审查 spec"},
        {"name": "codex_review", "runner": "codex", "command": "审查 spec"},
        {"name": "merge_feedback", "command": "$merge-reviews"},
        {"name": "human_decision", "command": "human_review"}
      ]
    }
  }
}
```

#### Step 3.3 — Webhook 事件推送

**文件**: `session-orchestrator/src/service.py`（增强）

```python
# 新增配置
webhook_url: str = ""  # 如 http://claude-to-im:3000/api/events

# 事件产生时自动推送
async def _emit_event(self, event: dict):
    self._store.append_event(event)
    if self.webhook_url:
        await self._webhook_client.post(self.webhook_url, json=event)
```

---

## 关键文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/lib/bridge/internal/review-orchestrator.ts` | 新增 | 对抗审查核心逻辑 |
| `src/lib/bridge/internal/review-store.ts` | 新增 | 审查结果持久化 |
| `src/lib/bridge/bridge-manager.ts` | 修改 | 新增 /review 命令路由 |
| `src/lib/bridge/conversation-engine.ts` | 修改 | 审查流程集成 |
| `src/lib/bridge/internal/orchestrator-client.ts` | 新增 | Orchestrator HTTP 客户端 |
| `src/lib/bridge/internal/event-bridge.ts` | 新增 | 事件→IM 消息桥接 |
| `src/lib/bridge/adapters/feishu-adapter.ts` | 修改 | 审查卡片模板 |
| `session-orchestrator/src/runners.py` | 修改 | 新增 ClaudeRunner |
| `session-orchestrator/src/service.py` | 修改 | Webhook + Review Phase |
| `session-orchestrator/src/orchestrator_prompts.json` | 修改 | Review 工作流模板 |

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 审查循环不收敛（两个模型互相找茬） | 设置最大轮次上限(5轮)；LGTM 阈值可配置 |
| Codex 调用延迟高 | 支持超时配置；Claude 和 Codex 可并行审查 |
| 清空上下文后丢失重要信息 | spec 文件是唯一信息源，包含所有上下文 |
| Session Orchestrator 不可用 | 阶段一（/review）不依赖 Orchestrator，可独立运行 |
| IM 消息过多打扰用户 | 智能聚合事件；只推送关键节点通知 |
| 两个 Bot 在群里冲突响应 | Claude Bot 作为唯一入口；Codex 只在后台被调用 |

## 优先级建议

```
P0 (阶段一): /review 对抗审查 ← 核心价值，用户当前最频繁的操作
P1 (阶段二): /dev: 编排集成 ← 完整开发流程自动化
P2 (阶段三): Orchestrator 增强 ← 长期架构升级
```

## SESSION_ID（供 /ccg:execute 使用）
- CODEX_SESSION: N/A（纯规划，无调用）
- GEMINI_SESSION: N/A（纯规划，无调用）
