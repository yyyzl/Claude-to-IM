# 📋 实施计划：双机器人同时支持（Claude Code + Codex）

## 需求背景

用户同时拥有两个渠道：Claude Code 和 Codex，希望在飞书上同时运行两个机器人，分别连接不同的 LLM 后端。

---

## 可行性分析

### 当前架构约束

经过对代码库的全面分析，发现以下核心约束：

| 约束点 | 文件 | 说明 |
|--------|------|------|
| **单一 LLM Provider** | `src/lib/bridge/context.ts:18-23` | `BridgeContext.llm` 是单个 `LLMProvider` 实例 |
| **单一飞书应用** | `feishu-adapter.ts:238-270` | 飞书适配器只读取一组 `app_id/app_secret` |
| **全局后端选择** | `feishu-claude-bridge.ts:288` | `bridge_llm_backend` 是全局设置（"claude" 或 "codex"） |
| **Adapter 注册表按类型去重** | `bridge-manager.ts` | 适配器以 `channelType` 为 key 存入 Map |
| **会话引擎使用单一 LLM** | `conversation-engine.ts:90` | `const { store, llm } = getBridgeContext()` 无路由能力 |

### 结论：**完全可行**，有三种方案可选

---

## 方案对比

### 方案 A：双进程方案（零代码改动）⭐ 推荐

**原理**：运行两个独立的 `feishu-claude-bridge.ts` 进程，各自配置不同的飞书应用和 LLM 后端。

```
进程 1 (.env.bridge.claude)          进程 2 (.env.bridge.codex)
┌─────────────────────────┐         ┌─────────────────────────┐
│ 飞书 App A (Claude Bot) │         │ 飞书 App B (Codex Bot)  │
│ bridge_llm_backend=claude│         │ bridge_llm_backend=codex│
│ Store: store-claude.json │         │ Store: store-codex.json │
│ Control: bridge-claude/  │         │ Control: bridge-codex/  │
└─────────────────────────┘         └─────────────────────────┘
```

**改动量**：0 行代码
**配置步骤**：
1. 创建两个 `.env` 文件（`.env.bridge.claude` 和 `.env.bridge.codex`）
2. 每个文件配置不同的飞书 App 凭据和后端
3. 通过 `BRIDGE_CONTROL_DIR` 环境变量隔离控制文件
4. 通过配置不同的 store 路径隔离数据

**优势**：
- 零代码改动，立即可用
- 故障隔离（一个崩溃不影响另一个）
- 独立重启、独立监控
- 可以独立升级/回滚

**劣势**：
- 两个进程占用更多内存（但 Node.js 进程轻量）
- 不共享会话状态（两个 bot 各自独立的对话历史）
- 需要管理两个进程的生命周期

---

### 方案 B：路由型 LLM Provider（中等改动量）

**原理**：在 runner 脚本中创建一个 `RouterLLMProvider`，同时持有 Claude 和 Codex 两个后端，根据会话的 `provider_id` 字段路由到对应后端。

```
                    飞书 App（单一）
                         │
                    ┌─────┴──────┐
                    │ Router LLM │
                    └──┬──────┬──┘
                       │      │
            ┌──────────┴┐  ┌──┴──────────┐
            │ Claude SDK│  │ Codex Server │
            └───────────┘  └─────────────┘
```

**改动文件**：
| 文件 | 操作 | 说明 |
|------|------|------|
| `scripts/feishu-claude-bridge.ts` | 修改 | 同时创建两个 LLM Provider，包装为 Router |
| `scripts/claude-to-im-bridge/router-llm.ts` | 新建 | RouterLLMProvider 实现 |

**核心逻辑**：
```typescript
class RouterLLMProvider implements LLMProvider {
  constructor(
    private claude: ClaudeCodeLLMProvider,
    private codex: CodexAppServerLLMProvider,
  ) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    // 利用已有的 provider 字段来决定路由
    const isCodex = params.provider?.id === 'codex';
    return isCodex ? this.codex.streamChat(params) : this.claude.streamChat(params);
  }
}
```

**用户通过 /backend 命令切换**：在飞书聊天中发送 `/backend codex` 或 `/backend claude` 切换当前会话的后端。

**优势**：
- 单一飞书 App，用户体验统一
- 共享会话存储
- 可以在同一对话中切换后端

**劣势**：
- 需要代码改动
- 仅一个飞书 Bot，无法从外观上区分两个后端
- 需要新增 `/backend` 命令
- Claude SDK 和 Codex 进程都常驻内存

---

### 方案 C：双适配器方案（较大改动量）

**原理**：修改核心桥接库，支持同类型的多个适配器实例，每个绑定不同的 LLM Provider。

**改动文件**：
| 文件 | 操作 | 说明 |
|------|------|------|
| `src/lib/bridge/context.ts` | 修改 | `BridgeContext` 增加 `llmProviders: Map<string, LLMProvider>` |
| `src/lib/bridge/host.ts` | 修改 | 增加多 LLM 接口定义 |
| `src/lib/bridge/conversation-engine.ts` | 修改 | 按 binding 的 provider 选择 LLM |
| `src/lib/bridge/bridge-manager.ts` | 修改 | 适配器注册表改为支持同类型多实例 |
| `src/lib/bridge/channel-adapter.ts` | 修改 | 适配器增加 instanceId 概念 |
| `src/lib/bridge/types.ts` | 修改 | `ChannelBinding` 增加 `llmProviderId` 字段 |

**优势**：
- 架构最优雅，原生支持多后端
- 可扩展到任意数量的 LLM 后端

**劣势**：
- 改动量大，涉及核心库
- 需要数据库 schema 迁移
- 开发周期长，风险高

---

## 推荐方案

### ⭐ 方案 A（双进程）为首选

理由：
1. **零代码改动** — 立即可用，零风险
2. **故障隔离** — 生产环境最佳实践
3. **已有基础设施** — `bridge.ps1` 已支持 `BRIDGE_CONTROL_DIR` 环境变量

如果未来需要"单 Bot 内切换后端"的体验，可以按方案 B 补充实现。

---

## 方案 A 详细实施步骤

### 步骤 1：创建 Claude Bot 配置文件

创建 `.env.bridge.claude`：
```env
# 飞书 App A（Claude 机器人）
bridge_feishu_app_id=cli_CLAUDE_APP_ID
bridge_feishu_app_secret=CLAUDE_APP_SECRET
bridge_feishu_allowed_users=ou_xxx

# LLM 后端
bridge_llm_backend=claude
bridge_default_model=claude-sonnet-4-20250514

# 工作目录
bridge_default_work_dir=G:\RustProject\push-2-talk
```

### 步骤 2：创建 Codex Bot 配置文件

创建 `.env.bridge.codex`：
```env
# 飞书 App B（Codex 机器人）
bridge_feishu_app_id=cli_CODEX_APP_ID
bridge_feishu_app_secret=CODEX_APP_SECRET
bridge_feishu_allowed_users=ou_xxx

# LLM 后端
bridge_llm_backend=codex
bridge_codex_model_hint=gpt-5.2 xhigh
bridge_codex_cli_config=model_provider=openai

# 工作目录
bridge_default_work_dir=G:\RustProject\push-2-talk
```

### 步骤 3：修改 runner 支持指定 env 文件（可选小改动）

在 `feishu-claude-bridge.ts` 中支持通过命令行参数指定 env 文件路径：

```typescript
// 在 main() 中，替换固定的 .env.bridge.local 加载逻辑
const envFile = process.argv[2] || ".env.bridge.local";
loadDotEnvFile(path.join(runnerRoot, envFile));
```

这样启动命令变为：
```bash
# 终端 1：启动 Claude Bot
BRIDGE_CONTROL_DIR=.ccg/bridge-claude npx tsx scripts/feishu-claude-bridge.ts .env.bridge.claude

# 终端 2：启动 Codex Bot
BRIDGE_CONTROL_DIR=.ccg/bridge-codex npx tsx scripts/feishu-claude-bridge.ts .env.bridge.codex
```

### 步骤 4：更新 bridge.ps1 支持双进程管理（可选）

扩展 `bridge.ps1` 增加 `-Bot` 参数：
```powershell
param(
  [ValidateSet("start", "stop", "restart", "status", "watchdog")]
  [string]$Action = "status",
  [ValidateSet("claude", "codex", "all")]
  [string]$Bot = "all",  # 新增
  ...
)
```

### 步骤 5：飞书后台创建第二个 Bot

在飞书开放平台创建第二个企业自建应用：
1. 应用名称建议区分（如 "Claude 助手" 和 "Codex 助手"）
2. 启用机器人能力
3. 配置事件订阅（`im.message.receive_v1`）
4. 发布应用并获取 `app_id` + `app_secret`

---

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 两个进程同时操作同一工作目录可能冲突 | 建议不同 Bot 操作不同项目目录，或用户自行协调 |
| 内存占用翻倍 | Node.js 单进程 ~100-200MB，两个进程 ~400MB，现代机器可接受 |
| 运维复杂度增加 | 通过 `bridge.ps1 -Bot all` 统一管理 |
| 两个 Bot 的会话不互通 | 这是隔离的预期行为；如需互通改用方案 B |

---

## 任务类型
- [x] 后端 (→ Codex)
- [ ] 前端 (→ Gemini)
- [ ] 全栈 (→ 并行)

## SESSION_ID（供 /ccg:execute 使用）
- CODEX_SESSION: (未调用)
- GEMINI_SESSION: (未调用)
