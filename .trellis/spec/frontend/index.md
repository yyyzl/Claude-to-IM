# 前端开发规范

> 当前仓库没有浏览器前端层。本目录保留是为了兼容 Trellis 的默认结构，并为未来可能出现的 UI 宿主提供边界说明。

---

## 当前状态

当前仓库的主体是：

- `src/lib/bridge/`：桥接核心库
- `scripts/`：宿主集成与启动脚本
- `src/__tests__/unit/`：单元测试

目前没有 React、Vue、Svelte、Web 页面或组件层代码，因此这里的 frontend 规范当前属于“预留说明”，不是现有代码主入口。

---

## 如果未来新增前端

未来可以新增 UI，但它只能扮演宿主控制台或配置面板，例如：

- 展示桥接状态
- 配置模型、工作目录、授权用户
- 查看会话、日志或统计信息

未来前端必须继续依赖桥接核心库暴露的正式接口，不得自己重写桥接逻辑。

---

## 明确禁止

- 不得把桥接编排逻辑迁入前端层
- 不得把权限解析、消息投递、平台渲染核心塞进前端组件
- 不得因为增加 UI，就把 `src/lib/bridge/` 退化成一组被动工具函数

---

## 目录索引

- [目录结构](./directory-structure.md)
- [组件规范](./component-guidelines.md)
- [Hook 规范](./hook-guidelines.md)
- [状态管理](./state-management.md)
- [类型安全](./type-safety.md)
- [质量规范](./quality-guidelines.md)

---

## 与当前仓库最相关的参考

- `README.zh-CN.md`：说明项目当前是桥接库
- `src/lib/bridge/README.md`：说明桥接核心职责
- `src/lib/bridge/host.ts`：说明正式宿主接口边界
