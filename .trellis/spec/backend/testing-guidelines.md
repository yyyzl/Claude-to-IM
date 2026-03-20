# 后端测试规范

> 当前仓库以单元测试为主，重点验证桥接行为、契约边界和并发/命令语义，而不是依赖真实外部平台。

---

## 当前测试栈

- 测试框架：`node:test`
- 断言库：`node:assert/strict`
- 运行命令：`npm run test:unit`
- 全量校验：`npm test`

---

## 测试文件命名

- 使用 `src/__tests__/unit/bridge-*.test.ts`
- 文件名应指向被测模块或行为

例如：

- `bridge-manager.test.ts`
- `bridge-conversation-engine.test.ts`
- `bridge-channel-router.test.ts`

---

## 推荐测试模式

- 使用最小 mock `BridgeStore`、LLM、权限网关
- `beforeEach` 清理 `globalThis` 上的桥接状态
- 每个测试聚焦一个行为断言
- 优先验证外部可观察行为，而不是内部实现细节

对于单例或全局状态相关模块，必须显式清理：

- `__bridge_manager__`
- `__bridge_context__`

---

## 应该优先覆盖的行为

- 同一会话串行、不同会话并行
- 命令解析与命令分支
- 配置项解析与默认值行为
- 消息路由与绑定
- 校验失败时的错误分支

---

## 反模式

- 直接依赖真实平台网络请求
- 为了测试方便复制生产逻辑
- 只测 happy path，不测失败分支
- 忘记清理全局状态，导致测试互相污染

---

## 真实示例

- `src/__tests__/unit/bridge-manager.test.ts`：并发与生命周期行为测试
- `src/__tests__/unit/bridge-conversation-engine.test.ts`：会话引擎相关行为测试
- `src/__tests__/unit/bridge-usage-command.test.ts`：命令与报表行为测试

---

## 本仓库的验证命令

优先顺序：

1. `npm run typecheck`
2. `npm run test:unit`
3. `npm test`

说明：

- 如果 `npm test` 在 `HEAD` 就已失败，需要先明确这是既有问题还是本次引入的问题
- 文档类改动通常不需要重新跑所有测试，但应至少说明是否存在既有基线失败
