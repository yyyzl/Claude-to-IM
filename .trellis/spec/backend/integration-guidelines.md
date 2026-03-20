# 后端集成规范

> 当前仓库把“桥接核心”与“宿主装配”分开维护。`scripts/` 负责装配，`src/lib/bridge/` 负责能力。

---

## `scripts/` 层的职责

`scripts/` 应只负责：

- 读取环境变量、配置文件或命令行参数
- 组装 `BridgeStore`、LLM、权限网关等宿主实现
- 初始化桥接上下文并启动桥接
- 提供诊断、启动和运维辅助脚本

---

## `scripts/` 层不该做什么

- 不复制 `bridge-manager.ts` 的核心控制流
- 不复制 `conversation-engine.ts` 的流式处理
- 不把共享业务规则分别写进多个脚本
- 不绕过 `host.ts` 契约直接修改桥接内部状态

---

## 推荐模式

- 脚本负责装配，核心逻辑下沉到 `src/lib/bridge/`
- 如果两个脚本共享大量逻辑，先考虑抽出到 `scripts/claude-to-im-bridge/` 或桥接核心模块
- 脚本层的配置 key、默认值与帮助文案要和核心实现保持一致

---

## 修改脚本时的同步检查项

- 配置 key 是否与 `BridgeStore.getSetting()` 的读取点一致
- 启动命令是否需要同步更新到 README 或开发文档
- 相关测试或诊断脚本是否也要同步
- 是否把本应属于桥接核心的逻辑错误地留在了脚本里

---

## 反模式

- 在多个脚本里复制同一段设置解析逻辑
- 为了快，把桥接库内部细节直接写进脚本
- 只改脚本，不查文档、不查配置 key 的其它引用

---

## 真实示例

- `scripts/feishu-claude-bridge.ts`：桥接启动脚本与宿主装配入口
- `scripts/claude-to-im-bridge/store.ts`：宿主存储相关装配
- `scripts/claude-to-im-bridge/llm.ts`：LLM 相关装配
- `src/lib/bridge/context.ts`：桥接核心接收宿主依赖的入口

---

## 实施前检查清单

- [ ] 这次改动是否真的属于脚本层，而不是桥接核心层
- [ ] 是否搜索过相同配置 key 的全部引用
- [ ] 是否需要同步更新 README、开发文档或帮助文案
- [ ] 是否需要补一个最小测试或至少补一条诊断说明
