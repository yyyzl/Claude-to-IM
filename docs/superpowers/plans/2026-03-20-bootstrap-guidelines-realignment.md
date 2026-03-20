# Bootstrap Guidelines 规范重整 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
> 当前仓库默认不允许未获授权的子代理委派；如果用户没有明确要求并行或委派，使用 `superpowers:executing-plans` 在当前会话内执行。

**Goal:** 让 `.trellis/spec/`、`workflow.md` 与 `start` 技能反映当前仓库真实形态，使后续 agent 能按 Node.js + TypeScript 桥接库的方式工作，而不是误判为浏览器前端项目。

**Architecture:** 先建立 `backend/` 作为主规范入口，再将 `frontend/` 收束为“当前不适用”，最后增强 `guides/` 并对齐启动流程说明。所有文档只依据已提交代码提炼模式，不引入新的工程结构，也不修改业务逻辑。

**Tech Stack:** Markdown 文档、Trellis 工作流文档、Node.js + TypeScript 仓库结构、PowerShell、`rg`

---

## Chunk 1: 主规范与前端收束

### Task 1: 建立 backend 规范入口

**Files:**
- Create: `.trellis/spec/backend/index.md`
- Create: `.trellis/spec/backend/directory-structure.md`
- Reference: `package.json`
- Reference: `src/lib/bridge/bridge-manager.ts`
- Reference: `src/lib/bridge/host.ts`
- Reference: `scripts/feishu-claude-bridge.ts`

- [ ] **Step 1: 确认 backend 目录当前不存在**

Run:

```powershell
Get-ChildItem -Path '.trellis/spec/backend' -ErrorAction SilentlyContinue
```

Expected: 无输出，说明 backend 目录尚未建立。

- [ ] **Step 2: 写出 backend 索引**

将 `.trellis/spec/backend/index.md` 写成导航页，至少包含这些小节：

```md
# Backend Development Guidelines

## 项目定位
- 当前仓库是 Node.js + TypeScript 桥接库
- 后端范围包括 src/lib/bridge、scripts、src/__tests__/unit

## 开发前必读
- directory-structure.md
- module-boundaries.md
- type-safety.md

## 按任务补充阅读
- integration-guidelines.md
- testing-guidelines.md
- quality-guidelines.md

## 真实示例
- bridge-manager.ts
- host.ts
- feishu-claude-bridge.ts
```

- [ ] **Step 3: 写出目录结构规范**

将 `.trellis/spec/backend/directory-structure.md` 写成“目录职责 + 放置规则 + 反模式”的结构，至少覆盖：

```md
## 目录职责
- src/lib/bridge/: 核心桥接库
- src/lib/bridge/adapters/: 平台适配器
- src/lib/bridge/markdown/: 平台渲染
- src/lib/bridge/security/: 输入校验与限流
- src/lib/bridge/internal/: 内部帮助模块
- scripts/: 宿主集成与启动脚本
- src/__tests__/unit/: 单元测试

## 规则
- 新功能优先落在已有目录
- scripts 不承载桥接核心领域逻辑

## 反模式
- 在 bridge-manager.ts 中堆平台特有逻辑
- 在脚本里复制核心桥接逻辑
```

- [ ] **Step 4: 回读 backend 索引与目录规范**

Run:

```powershell
Get-Content -Path '.trellis/spec/backend/index.md' -Encoding UTF8
Get-Content -Path '.trellis/spec/backend/directory-structure.md' -Encoding UTF8
```

Expected: 两个文件均为简体中文，且包含真实示例与反模式。

### Task 2: 完成 backend 深度规范

**Files:**
- Create: `.trellis/spec/backend/module-boundaries.md`
- Create: `.trellis/spec/backend/type-safety.md`
- Create: `.trellis/spec/backend/testing-guidelines.md`
- Create: `.trellis/spec/backend/quality-guidelines.md`
- Create: `.trellis/spec/backend/integration-guidelines.md`
- Reference: `src/lib/bridge/channel-router.ts`
- Reference: `src/lib/bridge/conversation-engine.ts`
- Reference: `src/lib/bridge/delivery-layer.ts`
- Reference: `src/lib/bridge/types.ts`
- Reference: `src/lib/bridge/security/validators.ts`
- Reference: `src/__tests__/unit/bridge-manager.test.ts`
- Reference: `src/lib/bridge/CONTRIBUTING.md`
- Reference: `scripts/claude-to-im-bridge/store.ts`
- Reference: `scripts/claude-to-im-bridge/llm.ts`

- [ ] **Step 1: 写出模块边界规范**

将 `.trellis/spec/backend/module-boundaries.md` 写成“模块职责 + 跨层禁令 + 示例文件”结构，至少覆盖：

```md
## 核心边界
- bridge-manager: 编排，不吸收所有细节
- channel-router: 路由绑定
- conversation-engine: LLM 流处理
- delivery-layer: 发送、分块、重试、去重
- host.ts: 宿主契约
- internal/: 内部复用，不作为公共 API

## 禁止事项
- 绕过 getBridgeContext() 直接耦合宿主
- 跨层直接调用内部细节
```

- [ ] **Step 2: 写出类型安全规范**

将 `.trellis/spec/backend/type-safety.md` 写成“共享类型 + 边界校验 + 禁止事项”结构，至少覆盖：

```md
## 共享类型
- types.ts 维护共享消息与状态类型
- host.ts 维护宿主接口契约

## 边界校验
- 工作目录、模式、命令参数、外部消息都视为不可信输入
- unknown 先收窄再使用

## 禁止事项
- 滥用 any
- 无依据类型断言
```

- [ ] **Step 3: 写出测试与质量规范**

将 `.trellis/spec/backend/testing-guidelines.md` 与 `.trellis/spec/backend/quality-guidelines.md` 至少写成以下结构：

```md
## 测试
- 使用 node:test 与 node:assert/strict
- 采用最小 mock BridgeStore
- beforeEach 清理 globalThis 状态
- 参考 bridge-manager.test.ts

## 质量
- 维持 ESM 与 .js 导入后缀
- 注释只解释非显然约束
- 改配置 key、命令、接口前先全文搜索
- 文档修改完成后做结构与模板残留检查
```

- [ ] **Step 4: 写出集成规范**

将 `.trellis/spec/backend/integration-guidelines.md` 写成“脚本职责 + 桥接边界 + 同步检查项”结构，至少覆盖：

```md
## scripts 层职责
- 组装宿主实现
- 读取配置
- 启动桥接

## 边界
- 桥接核心逻辑进入 src/lib/bridge
- 脚本只做 glue code

## 同步检查
- 配置 key
- 启动命令
- 相关 README / docs
```

- [ ] **Step 5: 回读 backend 全量规范并检查示例引用**

Run:

```powershell
Get-ChildItem -Path '.trellis/spec/backend' | Select-Object Name
rg -n "src/lib/bridge|scripts/|src/__tests__/unit" .trellis/spec/backend
```

Expected: backend 目录包含 7 个文件，且每个文件都引用了真实代码路径。

### Task 3: 重写 frontend 目录为“当前不适用”

**Files:**
- Modify: `.trellis/spec/frontend/index.md`
- Modify: `.trellis/spec/frontend/directory-structure.md`
- Modify: `.trellis/spec/frontend/component-guidelines.md`
- Modify: `.trellis/spec/frontend/hook-guidelines.md`
- Modify: `.trellis/spec/frontend/state-management.md`
- Modify: `.trellis/spec/frontend/type-safety.md`
- Modify: `.trellis/spec/frontend/quality-guidelines.md`
- Reference: `README.zh-CN.md`
- Reference: `src/lib/bridge/README.md`

- [ ] **Step 1: 清空 frontend 模板思路**

在 7 个 frontend 文件中统一替换掉这些模板语义：

```md
- To be filled by the team
- Questions to answer
- Replace with your actual structure
```

- [ ] **Step 2: 给 frontend/index.md 写明当前状态**

至少包含：

```md
## 当前状态
- 当前仓库没有浏览器前端层
- frontend 规范仅为未来可能的 UI 宿主保留

## 未来边界
- UI 只能做宿主控制台或配置面板
- 不得承载桥接编排、权限解析、消息投递
```

- [ ] **Step 3: 统一改写其余 frontend 文件**

每个文件至少写出三部分：

```md
## 当前状态
## 如果未来新增该层应遵守的原则
## 禁止事项
```

并在每个文件中明确：

- 当前仓库暂无该类代码
- 若未来新增，应与 `src/lib/bridge/` 解耦
- 不得把桥接核心逻辑迁入 UI 层

- [ ] **Step 4: 检查 frontend 模板残留已清空**

Run:

```powershell
rg -n "To fill|To be filled by the team|Questions to answer|Replace with your actual structure" .trellis/spec/frontend
```

Expected: 无匹配。

## Chunk 2: 思考指南与流程对齐

### Task 4: 增强 guides 以匹配桥接库场景

**Files:**
- Modify: `.trellis/spec/guides/cross-layer-thinking-guide.md`
- Modify: `.trellis/spec/guides/code-reuse-thinking-guide.md`
- Reference: `src/lib/bridge/host.ts`
- Reference: `src/lib/bridge/types.ts`
- Reference: `src/lib/bridge/delivery-layer.ts`
- Reference: `src/lib/bridge/adapters/index.ts`
- Reference: `src/lib/bridge/internal/git-command.ts`

- [ ] **Step 1: 补充 cross-layer 指南中的桥接链路**

在 `.trellis/spec/guides/cross-layer-thinking-guide.md` 中新增本项目特有检查项，至少覆盖：

```md
- IM 入站消息
- ChannelBinding / session 绑定
- 会话锁与运行态
- LLM 流事件
- Markdown 渲染
- 出站投递与去重
```

- [ ] **Step 2: 补充 code-reuse 指南中的搜索清单**

在 `.trellis/spec/guides/code-reuse-thinking-guide.md` 中新增本项目特有搜索点，至少覆盖：

```md
- delivery-layer
- markdown/*
- security/*
- BridgeStore.getSetting(
- PLATFORM_LIMITS
- /help 与现有命令测试
```

- [ ] **Step 3: 回读 guides 并确认仍保留通用价值**

Run:

```powershell
Get-Content -Path '.trellis/spec/guides/cross-layer-thinking-guide.md' -Encoding UTF8
Get-Content -Path '.trellis/spec/guides/code-reuse-thinking-guide.md' -Encoding UTF8
```

Expected: 同时包含通用思考框架与桥接项目特有检查项。

### Task 5: 对齐 workflow 与 start 技能说明

**Files:**
- Modify: `.trellis/workflow.md`
- Modify: `.agents/skills/start/SKILL.md`
- Reference: `.trellis/spec/backend/index.md`
- Reference: `.trellis/spec/frontend/index.md`

- [ ] **Step 1: 修正 workflow 中的结构假设**

在 `.trellis/workflow.md` 中改掉“默认 frontend/backend 都存在”的暗示，至少补上：

```md
- 项目可能只有 frontend 或只有 backend
- 启动时先识别真实项目形态
- 缺少某一侧规范目录时，读取已有规范并继续
```

- [ ] **Step 2: 修正 start 技能中的读取顺序**

在 `.agents/skills/start/SKILL.md` 中补充或改写：

```md
- 先检查对应 index 是否存在再读取
- 前端项目读取 frontend/index.md
- 后端/库项目读取 backend/index.md
- 跨层项目再读 guides/index.md
```

- [ ] **Step 3: 检查流程文档不再引用缺失结构**

Run:

```powershell
rg -n "backend/index.md|frontend/index.md" .trellis/workflow.md .agents/skills/start/SKILL.md
```

Expected: 两份文档都保留正确路径，但不再把缺失目录描述成异常前提。

### Task 6: 做最终一致性校验

**Files:**
- Verify: `.trellis/spec/backend/index.md`
- Verify: `.trellis/spec/frontend/index.md`
- Verify: `.trellis/spec/guides/cross-layer-thinking-guide.md`
- Verify: `.trellis/spec/guides/code-reuse-thinking-guide.md`
- Verify: `.trellis/workflow.md`
- Verify: `.agents/skills/start/SKILL.md`

- [ ] **Step 1: 搜索模板残留**

Run:

```powershell
rg -n "To fill|To be filled by the team|Questions to answer|Replace with your actual structure" .trellis/spec
```

Expected: 无匹配。

- [ ] **Step 2: 搜索 backend 规范引用**

Run:

```powershell
rg -n "\.trellis/spec/backend|src/lib/bridge|scripts/" .trellis/spec/backend .trellis/workflow.md .agents/skills/start/SKILL.md
```

Expected: backend 规范、workflow 和 start 之间存在一致的路径引用。

- [ ] **Step 3: 人工回读关键文件**

重点检查：

```md
- backend 是否成为主入口
- frontend 是否只保留未来边界
- guides 是否覆盖桥接特有风险
- workflow 与 start 是否和真实项目形态一致
```

- [ ] **Step 4: 记录验证结果并停止在待提交状态**

说明：

```md
- 本仓库规则要求 AI 不执行 git commit
- 完成后向用户汇报修改范围、验证命令和未覆盖风险
```

## 执行说明

- 本计划是文档重整，不涉及 `src/` 业务逻辑变更
- 不需要运行 `npm run typecheck` 或 `npm run test:unit`
- 主要验证方式是全文搜索、路径回读与结构一致性检查
- 实施时严格基于已提交代码提炼规则，不把当前未提交改动写成规范

## 完成后的交付

实施完成后，应向用户交付：

1. 修改了哪些规范文档
2. 做了哪些一致性检查
3. 是否还有未覆盖的目录或流程错位
4. 提醒用户后续如需归档任务，可继续执行 Trellis 的 finish / record 流程
