# 开发工作流

> 参考 [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) 整理，结合当前仓库的 Trellis 目录与协作方式落地。

---

## 目录

1. [快速开始](#快速开始)
2. [工作流总览](#工作流总览)
3. [会话启动流程](#会话启动流程)
4. [开发流程](#开发流程)
5. [会话结束](#会话结束)
6. [目录说明](#目录说明)
7. [最佳实践](#最佳实践)

---

## 快速开始

### Step 0：初始化开发者身份（首次需要）

> **多开发者支持**：每个开发者或 Agent 都需要先初始化自己的身份。

```bash
# 检查是否已初始化
python3 ./.trellis/scripts/get_developer.py

# 如果未初始化，执行：
python3 ./.trellis/scripts/init_developer.py <your-name>
# 示例：python3 ./.trellis/scripts/init_developer.py cursor-agent
```

这会创建：

- `.trellis/.developer`：当前开发者身份文件（已 gitignore）
- `.trellis/workspace/<your-name>/`：个人工作区目录

命名建议：

- 人类开发者：使用自己的名字，例如 `john-doe`
- Cursor：`cursor-agent` 或 `cursor-<task>`
- Claude Code：`claude-agent` 或 `claude-<task>`
- iFlow CLI：`iflow-agent` 或 `iflow-<task>`

### Step 1：理解当前上下文

```bash
# 一条命令拿到完整上下文
python3 ./.trellis/scripts/get_context.py

# 或手动查看：
python3 ./.trellis/scripts/get_developer.py
python3 ./.trellis/scripts/task.py list
git status && git log --oneline -10
```

### Step 2：先读项目规范（强制）

**动手前必须先读规范。**

```bash
# 读取当前仓库实际存在且与你任务相关的索引
[ -f .trellis/spec/frontend/index.md ] && cat .trellis/spec/frontend/index.md
[ -f .trellis/spec/backend/index.md ] && cat .trellis/spec/backend/index.md
[ -f .trellis/spec/guides/index.md ] && cat .trellis/spec/guides/index.md
```

如何判断该读哪一套：

- 仓库有 UI / 浏览器前端层：读 `frontend/index.md`
- 仓库是后端、库、CLI、集成脚本型项目：读 `backend/index.md`
- 任务确实跨前后端：两边都读
- 改共享契约或跨层行为：再读 `guides/index.md`

### Step 3：编码前补读细项规范（强制）

按任务类型补读具体文档。

**前端任务**：

```bash
cat .trellis/spec/frontend/hook-guidelines.md
cat .trellis/spec/frontend/component-guidelines.md
cat .trellis/spec/frontend/type-safety.md
```

**后端 / 库 / 集成任务**：

```bash
cat .trellis/spec/backend/directory-structure.md
cat .trellis/spec/backend/module-boundaries.md
cat .trellis/spec/backend/type-safety.md
cat .trellis/spec/backend/integration-guidelines.md
cat .trellis/spec/backend/testing-guidelines.md
cat .trellis/spec/backend/quality-guidelines.md
```

---

## 工作流总览

### 核心原则

1. **先读后写**：先理解上下文，再动手
2. **遵循规范**：编码前必须阅读 `.trellis/spec/`
3. **先分析影响，再动手修改**：改函数、类型、配置、命令或关键流程前，先确认影响范围、直接调用方、相关执行流与风险
4. **增量推进**：一次只推进一个任务
5. **及时记录**：完成后立刻补充追踪信息
6. **控制文档体积**：单个 journal 文档最多 2000 行

### 文件系统

```text
.trellis/
|-- .developer           # 当前开发者身份（gitignore）
|-- scripts/
|   |-- common/          # Python 共享工具
|   |-- multi_agent/     # 多代理辅助脚本
|   |-- init_developer.py
|   |-- get_developer.py
|   |-- task.py
|   |-- get_context.py
|   +-- add_session.py
|-- workspace/           # 开发者个人工作区
|   |-- index.md
|   +-- {developer}/
|       |-- index.md
|       +-- journal-N.md
|-- tasks/               # 任务追踪
|   +-- {MM}-{DD}-{name}/
|       +-- task.json
|-- spec/                # 开发规范
|   |-- frontend/        # 前端规范（如果适用）
|   |-- backend/         # 后端 / 库 / 集成规范（如果适用）
|   +-- guides/          # 思考指南
+-- workflow.md          # 本文档
```

---

## 会话启动流程

### Step 1：获取会话上下文

```bash
python3 ./.trellis/scripts/get_context.py
# 或：
python3 ./.trellis/scripts/get_context.py --json
```

### Step 2：读取开发规范（强制）

按项目真实形态读取：

**前端开发**：

```bash
cat .trellis/spec/frontend/index.md
```

**后端、库、CLI、集成脚本开发**：

```bash
cat .trellis/spec/backend/index.md
```

**跨层功能**：

```bash
cat .trellis/spec/guides/index.md
cat .trellis/spec/guides/cross-layer-thinking-guide.md
```

特别说明：

- 有些仓库只有 `frontend/`
- 有些仓库只有 `backend/`
- 有些仓库虽然没有 HTTP API，也应按 backend-oriented 项目处理
- 如果某一侧不存在，就读现有那一侧并继续，不把缺失目录当异常

### Step 3：选择要开发的任务

```bash
python3 ./.trellis/scripts/task.py list
python3 ./.trellis/scripts/task.py create "<title>" --slug <task-name>
```

---

## 开发流程

### 任务推进流程

```text
1. 选择或创建任务
2. 阅读相关规范
3. 实现改动
4. 做适合该任务类型的验证
5. 由人类提交代码
6. 记录会话
```

对应命令示例：

```bash
python3 ./.trellis/scripts/task.py create "<title>" --slug <name>
python3 ./.trellis/scripts/add_session.py --title "Title" --commit "hash"
```

### 质量检查要求

提交前必须满足：

- [OK] 相关验证通过
- [OK] 规范已同步更新
- [OK] 文档或代码没有明显冲突
- [OK] 影响范围与实际改动面一致，没有顺手扩散修改

项目相关检查参考：

- 前端任务：看 `.trellis/spec/frontend/quality-guidelines.md`
- 后端任务：看 `.trellis/spec/backend/quality-guidelines.md`

说明：

- 文档类任务可以使用结构搜索、路径一致性和内容回读作为主要验证
- 代码类任务应运行对应的 lint / typecheck / test
- 如果 `HEAD` 已有基线失败，必须明确标注为既有问题

---

## 会话结束

### 一键记录会话

代码提交后可使用：

```bash
python3 ./.trellis/scripts/add_session.py \
  --title "Session Title" \
  --commit "abc1234" \
  --summary "Brief summary"
```

它会自动：

1. 检测当前 journal 文件
2. 超过 2000 行时自动建新文件
3. 追加本次会话内容
4. 更新 `index.md`

### 结束前检查

使用 `/trellis:finish-work` 做收尾检查：

1. [OK] 代码已由人类提交，提交信息符合规范
2. [OK] 会话已通过 `add_session.py` 记录
3. [OK] 相关验证已完成
4. [OK] 工作区状态清晰，WIP 已说明
5. [OK] 规范文档如有学习沉淀已更新

---

## 目录说明

### 1. `workspace/`

用途：记录每个开发者或 Agent 的会话内容。

结构：

```text
workspace/
|-- index.md
+-- {developer}/
    |-- index.md
    +-- journal-N.md
```

什么时候更新：

- 会话结束
- 完成重要任务
- 修复重要 bug

### 2. `spec/`

用途：沉淀项目实际开发规范。

结构：

```text
spec/
|-- frontend/
|   |-- index.md
|   +-- *.md
|-- backend/
|   |-- index.md
|   +-- *.md
+-- guides/
    |-- index.md
    +-- *.md
```

什么时候更新：

- 发现了稳定新模式
- 修 bug 暴露出规范缺口
- 团队形成了新的明确约定

### 3. `tasks/`

每个任务一个目录，包含 `task.json`：

```text
tasks/
|-- 01-21-my-task/
|   +-- task.json
+-- archive/
    +-- 2026-01/
        +-- 01-15-old-task/
            +-- task.json
```

常用命令：

```bash
python3 ./.trellis/scripts/task.py create "<title>" [--slug <name>]
python3 ./.trellis/scripts/task.py archive <name>
python3 ./.trellis/scripts/task.py list
python3 ./.trellis/scripts/task.py list-archive
```

---

## 最佳实践

### 应该做

1. 会话开始前：
   - 运行 `python3 ./.trellis/scripts/get_context.py`
   - 阅读相关 `.trellis/spec/` 文档

2. 开发过程中：
   - 严格按规范实现
   - 跨层改动先读 `guides/`
   - 一次只推进一个任务
   - 按任务类型选择合适的验证方式

3. 开发完成后：
   - 使用 `/trellis:finish-work` 做收尾
   - 人类在测试通过后提交代码
   - 用 `add_session.py` 记录会话

### 不该做

1. 不读规范就直接动手
2. 让单个 journal 文件超过 2000 行
3. 同时推进多个无关任务
4. 在验证失败时直接提交
5. 学到新约束却不更新规范
6. AI 自行执行 `git commit`

---

## 快速参考

### 开发前必读

| 任务类型 | 必读文档 |
|----------|----------|
| 前端任务 | `frontend/index.md` → 相关细项 |
| 后端 / 库 / 集成任务 | `backend/index.md` → 相关细项 |
| 跨层任务 | `guides/index.md` → `cross-layer-thinking-guide.md` |

### 提交约定

```bash
git commit -m "type(scope): description"
```

`type`：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`

### 常用命令

```bash
# 会话管理
python3 ./.trellis/scripts/get_context.py
python3 ./.trellis/scripts/add_session.py

# 任务管理
python3 ./.trellis/scripts/task.py list
python3 ./.trellis/scripts/task.py create "<title>"

# Slash commands
/trellis:finish-work
/trellis:break-loop
/trellis:check-cross-layer
```

---

## 总结

遵循这套工作流的目标是：

- [OK] 保证多会话连续性
- [OK] 保证规范与实现一致
- [OK] 让任务进展可追踪
- [OK] 把经验沉淀回规范文档
- [OK] 提高多人或多 Agent 协作透明度

**核心理念**：先读后写，遵循规范，及时记录，及时沉淀。
