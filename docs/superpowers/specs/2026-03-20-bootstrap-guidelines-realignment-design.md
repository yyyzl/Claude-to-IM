# Bootstrap Guidelines 规范重整设计

## 背景

当前 `.trellis/spec/` 目录只有 `frontend/` 模板和通用 `guides/`，但仓库实际主体是一个 `Node.js + TypeScript` 的桥接库与集成工程：

- 核心代码位于 `src/lib/bridge/`
- 集成与启动脚本位于 `scripts/`
- 单元测试位于 `src/__tests__/unit/`

这会导致 Trellis 启动流程和后续开发上下文出现错位：

- `start` 流程会尝试读取不存在的 `backend/index.md`
- `frontend/` 模板会误导后续 agent，把当前仓库当成浏览器前端项目
- `guides/` 中的通用思考清单没有覆盖桥接库的典型跨层风险

本设计用于把 `Bootstrap Guidelines` 任务落地成一套与仓库现实一致的开发规范。

## 目标

1. 为当前仓库建立可用的 `backend/` 规范入口
2. 将 `frontend/` 明确收束为“当前仓库无浏览器前端层”
3. 将 `guides/` 改写为更适合桥接库与集成脚本场景的思考清单
4. 修正 `workflow.md` 与 `start` 技能中的结构假设，使其与真实仓库一致

## 非目标

- 不修改 `src/` 下的业务逻辑
- 不重构 `.trellis/scripts/*.py` 自动化脚本
- 不把当前未提交改动提升为项目长期规范
- 不推翻 Trellis 既有的 `frontend/backend/guides` 三段式结构

## 现状判断

### 仓库主形态

从已提交代码可以确认，这个仓库当前更接近“后端库 + 集成脚本”而不是浏览器前端工程：

- `package.json` 采用 `type: module`，使用 TypeScript 严格类型与 Node 20 运行时
- `src/lib/bridge/bridge-manager.ts` 负责桥接系统编排
- `src/lib/bridge/host.ts` 定义宿主接口契约
- `src/lib/bridge/types.ts` 定义共享类型
- `src/__tests__/unit/bridge-manager.test.ts` 使用 `node:test` 与最小 mock 模式
- `scripts/feishu-claude-bridge.ts` 和 `scripts/claude-to-im-bridge/*` 提供宿主集成入口

### 已观察到的稳定模式

- 通过 `getBridgeContext()` 做依赖注入，不直接绑定宿主应用
- 通过 `types.ts` 与 `host.ts` 维护共享契约
- 使用分目录组织平台适配、Markdown 渲染、安全能力与内部辅助逻辑
- 使用 `node:test`、`node:assert/strict`、最小 mock 进行单元测试
- 使用 Conventional Commits 作为提交格式

## 设计决策

### 决策 1：新增 `backend/`，作为当前项目主规范入口

新增 `backend/` 目录，而不是继续把所有内容硬塞进 `frontend/`。原因：

- 更符合真实项目形态
- 能为后续 agent 提供明确的主阅读入口
- 不需要改变 Trellis 现有脚本对 `backend/` 的默认期待

### 决策 2：保留 `frontend/`，但改写为“当前不适用”

不删除 `frontend/` 模板，避免和 Trellis 默认结构产生额外耦合；但所有文件都明确写清：

- 当前仓库没有浏览器前端层
- 如果未来新增 UI，只能作为宿主控制台或配置面板
- 桥接核心逻辑不得迁入前端层

### 决策 3：保留 `guides/`，但注入桥接库语境

`guides/` 已有结构可复用，因此不新增平行目录，只增强现有指南中的项目特定检查项：

- 跨层数据流从 IM 入站消息到出站投递的完整链路
- 配置 key、平台差异、权限回调、宿主接口变更的连锁影响
- 新增适配器、命令、配置项时的搜索与复用检查

### 决策 4：修正启动流程中的结构假设

调整 `.trellis/workflow.md` 与 `.agents/skills/start/SKILL.md` 中对规范目录的描述：

- 不再假设 `frontend/`、`backend/` 必然同时存在
- 启动时先识别项目形态，再读取对应规范
- 对“只有 backend / 只有 frontend”的仓库给出明确处理方式

## 文件改动范围

### 新增文件

- `.trellis/spec/backend/index.md`
- `.trellis/spec/backend/directory-structure.md`
- `.trellis/spec/backend/module-boundaries.md`
- `.trellis/spec/backend/type-safety.md`
- `.trellis/spec/backend/testing-guidelines.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/backend/integration-guidelines.md`

### 重写文件

- `.trellis/spec/frontend/index.md`
- `.trellis/spec/frontend/directory-structure.md`
- `.trellis/spec/frontend/component-guidelines.md`
- `.trellis/spec/frontend/hook-guidelines.md`
- `.trellis/spec/frontend/state-management.md`
- `.trellis/spec/frontend/type-safety.md`
- `.trellis/spec/frontend/quality-guidelines.md`

### 增强文件

- `.trellis/spec/guides/cross-layer-thinking-guide.md`
- `.trellis/spec/guides/code-reuse-thinking-guide.md`

### 对齐文件

- `.trellis/workflow.md`
- `.agents/skills/start/SKILL.md`

## 各文件内容设计

### `backend/index.md`

作用：后端规范导航页。

重点内容：

- 定义本项目的“后端”范围：桥接核心库、集成脚本、单元测试
- 给出任务类型到必读规范的映射
- 强调本项目是 DI 驱动的集成库，而不是传统 MVC 服务

示例来源：

- `src/lib/bridge/bridge-manager.ts`
- `src/lib/bridge/host.ts`
- `scripts/feishu-claude-bridge.ts`

### `backend/directory-structure.md`

作用：说明目录职责与新增代码的放置规则。

重点内容：

- `src/lib/bridge/` 下各子目录职责
- `scripts/` 只承载 glue code，不承载桥接核心领域逻辑
- 新功能优先落在已有分层，而不是随意新开并列模块

示例来源：

- `src/lib/bridge/adapters/`
- `src/lib/bridge/markdown/`
- `src/lib/bridge/security/`

### `backend/module-boundaries.md`

作用：定义核心模块边界与职责分配。

重点内容：

- `bridge-manager` 负责编排，不承接所有细节
- `channel-router` 负责路由绑定
- `conversation-engine` 负责流式会话处理
- `delivery-layer` 负责重试、分块、去重与发送
- `host.ts` 负责契约，不应被宿主实现反向污染
- `internal/` 为内部复用细节，不应扩大为公共 API

示例来源：

- `src/lib/bridge/bridge-manager.ts`
- `src/lib/bridge/channel-router.ts`
- `src/lib/bridge/delivery-layer.ts`
- `src/lib/bridge/host.ts`

### `backend/type-safety.md`

作用：约束类型定义与运行时校验模式。

重点内容：

- 接口优先、联合类型优先、`unknown` 先收窄再使用
- 外部输入必须在边界做校验
- 配置值、命令参数、路径、模式切换均视为不可信输入
- 明确禁止滥用 `any` 与无依据断言

示例来源：

- `src/lib/bridge/types.ts`
- `src/lib/bridge/host.ts`
- `src/lib/bridge/security/validators.ts`

### `backend/testing-guidelines.md`

作用：约束测试框架、隔离方式与命名模式。

重点内容：

- 使用 `node:test` 与 `node:assert/strict`
- 测试文件命名为 `bridge-*.test.ts`
- 采用最小 mock `BridgeStore`
- `beforeEach` 清理 `globalThis` 中的桥接状态
- 验证命令为 `npm run typecheck` 与 `npm run test:unit`

示例来源：

- `src/__tests__/unit/bridge-manager.test.ts`
- `src/__tests__/unit/bridge-conversation-engine.test.ts`
- `src/__tests__/unit/bridge-channel-router.test.ts`

### `backend/quality-guidelines.md`

作用：沉淀代码风格、工程约束与提交流程。

重点内容：

- 维持 ESM 与 `.js` 导入后缀一致
- 注释只解释非显然约束，如并发、平台差异、锁语义
- 优先复用已有 helper，不随意增加新工具层
- 修改配置 key、slash 命令、宿主契约前必须全局搜索
- 代码完成前先跑 `typecheck` 与单元测试

示例来源：

- `src/lib/bridge/bridge-manager.ts`
- `src/lib/bridge/CONTRIBUTING.md`
- `README.zh-CN.md`

### `backend/integration-guidelines.md`

作用：规范 `scripts/` 与桥接核心库之间的边界。

重点内容：

- `scripts/` 负责组装宿主实现、读取配置、启动桥接
- 核心逻辑归属 `src/lib/bridge/`
- 修改脚本时同步检查配置、README、测试与启动命令
- 不允许在多个脚本里复制大段桥接逻辑

示例来源：

- `scripts/feishu-claude-bridge.ts`
- `scripts/claude-to-im-bridge/store.ts`
- `scripts/claude-to-im-bridge/llm.ts`

### `frontend/*`

作用：保留目录兼容性，但明确当前仓库无浏览器前端层。

统一内容策略：

- 当前状态：不适用
- 如果未来新增 UI：只作为宿主控制台或配置面板
- 明确禁止把桥接编排、权限解析、消息投递、渲染核心挪进前端层

### `guides/cross-layer-thinking-guide.md`

增强方向：

- 增加“IM 入站消息 → 路由绑定 → 会话锁 → LLM 流 → 渲染/投递”链路检查
- 增加 `host.ts` 契约变更时的同步检查项
- 增加配置 key、消息格式、权限回调的跨层影响检查

### `guides/code-reuse-thinking-guide.md`

增强方向：

- 新增平台适配器前，先搜 `delivery-layer`、`security`、`markdown/*`
- 新增命令前，先搜命令解析、帮助文案与单测
- 改配置项前，先搜 `BridgeStore.getSetting(key)` 的全部引用
- 改平台限制前，先搜 `PLATFORM_LIMITS`、适配器注册与渲染分发

### `workflow.md` 与 `start/SKILL.md`

增强方向：

- 明确允许仓库只有一侧规范目录
- 启动时优先判断真实项目形态
- 当某一侧索引不存在时，读取已有规范并继续，不把缺失目录当成异常

## 规范写作原则

所有规范文档遵循以下原则：

1. 全部使用简体中文
2. 记录“现状”，不是理想国
3. 每个文件至少引用 2-3 个真实代码或文档例子
4. 每个文件都包含推荐模式与反模式
5. 句子尽量短，适合终端阅读

## 实施顺序

1. 新增并补全 `backend/`
2. 重写 `frontend/`
3. 增强 `guides/`
4. 修正 `workflow.md` 与 `start/SKILL.md`

这个顺序确保先建立主规范入口，再清理误导性模板，最后对齐流程说明。

## 验证方案

### 结构校验

- `backend/index.md` 可正常导航到所有新增 backend 规范
- `frontend/` 中不再残留 `To fill` 或模板占位文案

### 内容校验

- 每个规范文件都有真实示例引用
- 每个规范文件都有反模式或常见误区
- 文档结论来自已提交代码，而非当前未提交改动

### 一致性校验

- `workflow.md`、`start/SKILL.md`、`.trellis/spec/` 的说明一致
- 不再出现要求读取不存在 `backend/index.md` 的流程错位

### 可执行性校验

- 后续 agent 能根据任务类型判断应先读哪些规范
- 修改桥接核心、脚本或测试时都有明确入口文档

## 风险与控制

### 风险 1：把临时实现写成长期规范

控制方式：

- 仅依据已提交代码提炼模式
- 不把当前工作区中的未提交 WIP 当成规范基线

### 风险 2：把 README 描述误当成强约束

控制方式：

- README 只作为辅助背景
- 规范优先引用源码、测试和贡献文档

### 风险 3：文档结构调整影响 Trellis 既有工作流

控制方式：

- 不改动 `.trellis/scripts/*.py`
- 只在既有目录框架内补齐 `backend/` 并修正文档说明

## 验收标准

- 已新增完整 `backend/` 规范体系
- 已明确 `frontend/` 当前不适用且未来边界清晰
- `guides/` 已覆盖桥接库常见跨层与复用检查
- `workflow.md` 与 `start/SKILL.md` 已与真实仓库形态对齐
- 所有规范均为简体中文，并引用真实代码示例

## 后续实施提示

设计获批后，进入实施阶段时应：

1. 先创建 backend 文档并完成索引
2. 再同步清理 frontend 模板内容
3. 修改 guides 与启动流程说明
4. 最后做一轮全文搜索，确认没有残留模板措辞或错误路径
