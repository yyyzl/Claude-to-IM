# 前端 Hook 规范

> 当前仓库没有 React Hook 或其他前端状态复用层。本文件仅定义未来新增 UI 时的边界。

---

## 当前状态

当前没有 `use*` Hook，也没有前端数据拉取层。

现有仓库的状态与行为管理主要在：

- `src/lib/bridge/bridge-manager.ts`
- `src/lib/bridge/conversation-engine.ts`
- `src/lib/bridge/channel-router.ts`

这些模块属于桥接核心，不应被未来 Hook 直接替代。

---

## 如果未来新增 Hook

- Hook 应只封装 UI 状态、数据订阅和用户操作
- Hook 不应承担桥接编排职责
- 如需访问桥接数据，应通过宿主层暴露的 API 或适配层

---

## 推荐模式

- `use*` 命名只用于真实可复用的 UI 状态逻辑
- 把数据拉取、轮询或订阅封装在宿主 UI 层，不直接耦合桥接内部文件
- 让 Hook 返回稳定的视图模型，而不是桥接内部对象

---

## 禁止事项

- Hook 直接导入 `src/lib/bridge/internal/`
- Hook 直接控制消息投递、权限审批或适配器生命周期
- 把桥接命令解析逻辑复制到 Hook

---

## 当前最相关的参考

- `src/lib/bridge/bridge-manager.ts`：桥接核心状态不属于 UI Hook
- `src/lib/bridge/conversation-engine.ts`：流式会话处理不应下沉到 UI Hook
- `src/lib/bridge/channel-router.ts`：路由绑定逻辑不应迁入前端层
