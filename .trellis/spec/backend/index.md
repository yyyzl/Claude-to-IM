# 后端开发规范

> 适用于当前仓库中的 Node.js + TypeScript 桥接库、宿主集成脚本与单元测试。

---

## 项目定位

当前仓库不是传统 Web 前端项目，主体是一个桥接库与集成工程：

- `src/lib/bridge/`：桥接核心库
- `scripts/`：宿主集成与启动脚本
- `src/__tests__/unit/`：单元测试

这里的“后端”不是指 HTTP Controller 或 MVC，而是指：

- 桥接系统编排
- 宿主接口契约
- 消息路由、渲染、投递、安全与命令处理
- 桥接启动脚本与配置装配

---

## 开发前必读

开始任何桥接核心或脚本改动前，先读：

1. [目录结构](./directory-structure.md)
2. [模块边界](./module-boundaries.md)
3. [类型安全](./type-safety.md)

按任务补充阅读：

- 改 `src/lib/workflow/`：读 [工作流引擎规范](./workflow-engine.md)
- 改脚本、配置或宿主接入：读 [集成规范](./integration-guidelines.md)
- 改测试或补回归：读 [测试规范](./testing-guidelines.md)
- 做收尾检查或补规范：读 [质量规范](./quality-guidelines.md)

涉及跨层链路时，再读：

- [跨层思考指南](../guides/cross-layer-thinking-guide.md)
- [代码复用思考指南](../guides/code-reuse-thinking-guide.md)

---

## 当前仓库的稳定模式

- 通过 `getBridgeContext()` 做依赖注入，不直接导入宿主实现
- 通过 `host.ts` 与 `types.ts` 维护共享契约
- 按职责拆分 `adapters/`、`markdown/`、`security/`、`internal/`
- 使用 `node:test` + 最小 mock 做单元测试
- 提交信息使用 Conventional Commits

---

## 真实示例

- `src/lib/bridge/bridge-manager.ts`：桥接主编排器，负责协调多个模块
- `src/lib/bridge/host.ts`：宿主接口契约，定义存储、LLM、权限与生命周期依赖
- `src/lib/bridge/types.ts`：共享消息、绑定、状态类型
- `scripts/feishu-claude-bridge.ts`：宿主装配与桥接启动入口
- `src/__tests__/unit/bridge-manager.test.ts`：最小 mock + `node:test` 测试模式

---

## 不要误判的点

- 不要把当前仓库当成浏览器前端项目
- 不要默认存在数据库层、HTTP API 层或 ORM 层
- 不要把 `scripts/` 视为业务主层，核心逻辑仍应落在 `src/lib/bridge/`

---

## 进入实现前的检查清单

- [ ] 这次改动主要落在 `src/lib/bridge/` 还是 `scripts/`
- [ ] 是否会影响 `host.ts`、`types.ts` 或配置 key
- [ ] 是否已先确认影响范围、直接调用方和需要联动的执行流
- [ ] 是否需要补单元测试或思考指南
- [ ] 是否先复用了已有 helper、渲染器、验证器和命令解析逻辑
