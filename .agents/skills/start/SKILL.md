---
name: start
description: "开始会话"
---

# 开始会话

初始化当前 AI 开发会话，并进入任务处理流程。

---

## 操作类型

| 标记 | 含义 | 执行者 |
|------|------|--------|
| `[AI]` | 由 AI 执行的脚本或工具调用 | 你（AI） |
| `[USER]` | 由用户触发的技能 | 用户 |

---

## 初始化 `[AI]`

### Step 1：理解开发工作流

先阅读工作流文档：

```bash
cat .trellis/workflow.md
```

必须遵循其中内容，包括：

- 核心原则
- 目录结构
- 开发流程
- 最佳实践

### Step 2：获取当前上下文

```bash
python3 ./.trellis/scripts/get_context.py
```

它会展示：

- 开发者身份
- Git 状态
- 当前任务（如果存在）
- 活跃任务列表

### Step 3：读取规范索引

```bash
[ -f .trellis/spec/frontend/index.md ] && cat .trellis/spec/frontend/index.md
[ -f .trellis/spec/backend/index.md ] && cat .trellis/spec/backend/index.md
[ -f .trellis/spec/guides/index.md ] && cat .trellis/spec/guides/index.md
```

> **重要**：索引文件只是导航页，用来告诉你有哪些规范可读。
> 这一步先了解目录结构和可用规范即可。
> 真正开始实现前，必须回到对应索引里列出的具体文档继续读。
>
> 有些仓库只有 `frontend/`，有些只有 `backend/`。如果某一侧不存在，就读现有索引并继续。

### Step 4：汇报并提问

汇报你读到的项目状态，并问用户：

`你想先处理什么？`

---

## 任务分类

收到用户任务后，先判断类型：

| 类型 | 判断标准 | 工作流 |
|------|----------|--------|
| **问题** | 询问代码、架构、实现原理 | 直接回答 |
| **微小修复** | typo、注释、单行变更、5 分钟内完成 | 直接修改 |
| **简单任务** | 目标明确，范围清晰，通常 1-2 个文件 | 快速确认 → 进入任务工作流 |
| **复杂任务** | 需求模糊、多文件、多决策点 | **先 Brainstorm，再进任务工作流** |

### 决策规则

> **拿不准时，一律先走 Brainstorm + Task Workflow。**
>
> 这样可以先把需求说清，再把 code-spec 正确注入上下文，整体质量更稳。

> **子任务拆分**：如果 brainstorm 后发现多个工作项彼此独立，可考虑创建 subtasks。

---

## 问题 / 微小修复

如果只是问题或微小修复：

1. 直接回答或直接修改
2. 如果改了代码，提醒用户后续运行 `$finish-work`

---

## 简单任务

对于简单且明确的任务：

1. 快速确认：`我理解你的目标是 [goal]，是否继续？`
2. 如果用户否定，先澄清再确认
3. 一旦用户确认，就连续执行以下步骤，不要在中间再要求额外确认：
   - 创建任务目录
   - 写 PRD
   - 研究代码库
   - 配置 context
   - 激活任务
   - 实施
   - 质量检查
   - 完成收尾

---

## 复杂任务：先 Brainstorm

对于复杂或模糊任务，不要直接跳到实现。

先走 `$brainstorm`，一般步骤是：

1. 复述理解并分类
2. 创建任务目录
3. 一次只问一个问题
4. 提出可选方案
5. 获得最终需求确认
6. 再进入 Task Workflow

---

## 任务工作流（开发任务）

### 为什么要走这套流程

- 先研究，再写代码
- 让规范通过 context 注入，而不是靠模型“记住”
- 实施和检查分开做
- 更容易保证代码与项目实际约定一致

### 两个入口

```text
来自 Brainstorm：
  PRD 确认 → Research → Configure Context → Activate → Implement → Check → Complete

来自 Simple Task：
  Confirm → Create Task → Write PRD → Research → Configure Context → Activate → Implement → Check → Complete
```

**关键原则**：Research 必须发生在 PRD 明确之后。

---

### Phase 1：明确需求

#### Path A：来自 Brainstorm

PRD 和任务目录已经存在，直接跳到 Phase 2。

#### Path B：来自 Simple Task

**Step 1：确认理解** `[AI]`

快速确认：

- 目标是什么
- 属于哪类开发：`frontend / backend / library / fullstack`
- 是否有特定约束

不清楚就先问。

**Step 2：创建任务目录** `[AI]`

```bash
TASK_DIR=$(python3 ./.trellis/scripts/task.py create "<title>" --slug <name>)
```

**Step 3：写 PRD** `[AI]`

在任务目录中创建 `prd.md`：

```markdown
# <Task Title>

## Goal
<要实现什么>

## Requirements
- <需求 1>
- <需求 2>

## Acceptance Criteria
- [ ] <验收项 1>
- [ ] <验收项 2>

## Technical Notes
<技术约束或决策>
```

---

### Phase 2：实现前准备

> 两条路径在这里汇合。进入本阶段前，PRD 与任务目录必须已存在。

**Step 4：Code-Spec 深度检查** `[AI]`

如果任务涉及基础设施或跨层契约，不要在深度未定义前开始实现。

出现以下任一情况时，必须先做这一步：

- 新增或修改命令 / API 签名
- 数据结构或迁移变更
- 存储、队列、缓存、密钥、环境变量等基础设施契约变更
- 跨层 payload 变化

开始前至少确认：

- [ ] 要更新哪些 code-spec 文件
- [ ] 契约细节是什么（签名、字段、env key）
- [ ] 校验与错误矩阵已定义
- [ ] 至少有一个 Good / Base / Bad 场景

**Step 5：研究代码库** `[AI]`

基于确认后的 PRD，输出：

1. 相关规范文件
2. 应跟随的现有代码模式（2-3 个）
3. 预计要修改的文件

输出格式：

```markdown
## Relevant Specs
- <path>: <why it's relevant>

## Code Patterns Found
- <pattern>: <example file path>

## Files to Modify
- <path>: <what change>
```

**Step 6：配置 Context** `[AI]`

初始化默认 context：

```bash
python3 ./.trellis/scripts/task.py init-context "$TASK_DIR" <type>
# type: backend | frontend | fullstack
```

把研究阶段发现的规范和模式加入 context：

```bash
python3 ./.trellis/scripts/task.py add-context "$TASK_DIR" implement "<path>" "<reason>"
python3 ./.trellis/scripts/task.py add-context "$TASK_DIR" check "<path>" "<reason>"
```

**Step 7：激活任务** `[AI]`

```bash
python3 ./.trellis/scripts/task.py start "$TASK_DIR"
```

这会设置 `.current-task`，供后续 hook 自动注入上下文。

---

### Phase 3：执行

**Step 8：实现** `[AI]`

按 `prd.md` 实施：

- 遵循 implement context 中的规范
- 保持改动聚焦
- 结束前做适合该任务类型的验证
- 文档任务用结构、一致性和搜索校验，不强行套代码 lint / 测试

**Step 9：质量检查** `[AI]`

- 用 check context 回看改动
- 直接修正发现的问题
- 确认相关验证通过

**Step 10：完成** `[AI]`

1. 确认该任务类型对应的验证已完成
2. 汇报实现内容
3. 提醒用户：
   - 测试改动
   - 准备提交
   - 运行 `$record-session` 记录会话

---

## 继续已有任务

如果 `get_context.py` 显示已有当前任务：

1. 阅读该任务的 `prd.md`
2. 查看 `task.json` 里的状态与阶段
3. 问用户：`是否继续处理 <task-name>？`

如果用户确认，通常从 Step 7 或 Step 8 继续。

---

## 技能与脚本参考

### 用户技能 `[USER]`

| 技能 | 用途 |
|------|------|
| `$start` | 开始会话 |
| `$finish-work` | 提交前收尾 |
| `$record-session` | 完成后记录会话 |

### AI 脚本 `[AI]`

| 脚本 | 用途 |
|------|------|
| `python3 ./.trellis/scripts/get_context.py` | 获取会话上下文 |
| `python3 ./.trellis/scripts/task.py create` | 创建任务目录 |
| `python3 ./.trellis/scripts/task.py init-context` | 初始化 jsonl |
| `python3 ./.trellis/scripts/task.py add-context` | 往 jsonl 中添加规范 |
| `python3 ./.trellis/scripts/task.py start` | 设置当前任务 |
| `python3 ./.trellis/scripts/task.py finish` | 清空当前任务 |
| `python3 ./.trellis/scripts/task.py archive` | 归档任务 |

### 工作阶段 `[AI]`

| 阶段 | 用途 | 上下文来源 |
|------|------|------------|
| research | 研究代码库 | 直接仓库 inspection |
| implement | 实施改动 | `implement.jsonl` |
| check | 回查与修复 | `check.jsonl` |
| debug | 修具体问题 | `debug.jsonl` |

---

## 核心原则

> **Code-spec 依赖注入，而不是依赖记忆。**
>
> Task Workflow 的意义，就是让 Agent 在正确阶段拿到正确规范，而不是赌模型“还记得”。

## 仓库形态提醒

- 前端项目：优先读 `.trellis/spec/frontend/`
- 后端、库、CLI、集成项目：优先读 `.trellis/spec/backend/`
- 跨层任务：补读 `.trellis/spec/guides/`
- 不要默认每个仓库都同时有 frontend 和 backend 两套规范
