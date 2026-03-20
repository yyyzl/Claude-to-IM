# 后端目录结构规范

> 当前仓库的主代码组织方式是“桥接核心库 + 集成脚本 + 单元测试”。

---

## 目录职责

### `src/lib/bridge/`

桥接核心库。这里承载真正的领域逻辑。

常见文件与子目录：

- `bridge-manager.ts`：主编排器，连接路由、会话、命令与投递
- `channel-router.ts`：从 `ChannelAddress` 解析到 `ChannelBinding`
- `conversation-engine.ts`：消费 LLM 流与会话消息
- `delivery-layer.ts`：统一发送、重试、分块、去重
- `host.ts`：宿主接口契约
- `types.ts`：共享类型
- `adapters/`：平台适配器
- `markdown/`：平台渲染器
- `security/`：输入校验与限流
- `internal/`：只供桥接内部复用的帮助模块

### `scripts/`

宿主集成与启动脚本。

这里负责：

- 读取环境变量或配置文件
- 组装 `BridgeStore`、LLM、权限网关等宿主实现
- 启动桥接系统

这里不应承载桥接核心领域逻辑。

### `src/__tests__/unit/`

单元测试目录。

当前模式是：

- 使用 `bridge-*.test.ts` 命名
- 使用 `node:test`
- 通过最小 mock 隔离宿主依赖

---

## 新代码应该放哪里

优先遵循已有分层，不随意新开顶层目录。

- 新平台接入：先看 `src/lib/bridge/adapters/`
- 新渲染策略：先看 `src/lib/bridge/markdown/`
- 新安全检查：先看 `src/lib/bridge/security/`
- 新命令或内部帮助逻辑：先看 `src/lib/bridge/internal/`
- 新宿主装配入口：放在 `scripts/`

如果一个改动既需要桥接核心，又需要启动脚本：

- 核心逻辑进入 `src/lib/bridge/`
- 脚本只负责调用和装配

---

## 当前结构示意

```text
src/
├── lib/bridge/
│   ├── adapters/
│   ├── internal/
│   ├── markdown/
│   ├── security/
│   ├── bridge-manager.ts
│   ├── channel-router.ts
│   ├── conversation-engine.ts
│   ├── delivery-layer.ts
│   ├── host.ts
│   └── types.ts
└── __tests__/unit/
    └── bridge-*.test.ts

scripts/
├── feishu-claude-bridge.ts
└── claude-to-im-bridge/
```

---

## 推荐模式

- 让 `src/lib/bridge/` 继续作为单一的桥接核心入口
- 让每个子目录只承载一类职责
- 让 `scripts/` 保持薄，只做 glue code
- 让测试紧贴桥接模块行为，而不是复制生产逻辑

---

## 反模式

- 把平台特有逻辑直接堆进 `bridge-manager.ts`
- 在 `scripts/` 里复制大段桥接逻辑，而不是抽回 `src/lib/bridge/`
- 为了一个小功能新增新的顶层领域目录
- 把内部 helper 暴露成事实上的公共 API，却仍塞在 `internal/`

---

## 真实示例

- `src/lib/bridge/adapters/telegram-adapter.ts`：平台适配器放在 `adapters/`
- `src/lib/bridge/markdown/telegram.ts`：平台渲染放在 `markdown/`
- `src/lib/bridge/security/validators.ts`：边界校验放在 `security/`
- `src/lib/bridge/internal/git-command.ts`：命令辅助逻辑放在 `internal/`
- `scripts/claude-to-im-bridge/store.ts`：宿主装配逻辑放在 `scripts/`
