# Codex 运行时影响与验证记录

日期：2026-10-05。实施者：model_runtime_implement；基线索引与HEAD均为a12b8fc。

## 修改前影响分析

- CodexAppServerLLMProvider、ensureInitialized、selectModel、startTurn、selectCodexModel：GitNexus upstream LOW；主要直接调用为streamChat.start，runner.main负责装配。
- constructor、stop、streamChat：图返回UNKNOWN。实施者通过源码补证runner.main构造和LLMProvider注入、conversation-engine.processMessage调用streamChat；请求关键路径以离线协议测试覆盖，未把UNKNOWN视为零风险。
- 修改围绕目录发现、连接初始化／刷新隔离、完整分页缓存、偏好解析和新turn速度传参。

## 实施结果与验证

- 新偏好每轮重新验证，明确default忽略旧型号／强度hint。
- resume后的新turn继续显式传serviceTierForTurn；正常=default，Fast仅目录支持时fast。
- 线程建立先发session_id；turn/start被接受后才报告运行配置，拒绝Fast不能显示为已使用。
- 连接epoch防旧异步结果覆盖重连状态；目录刷新失败不关闭正在服务其他聊天的连接。
- 实施者交付59项相关离线测试通过，每次外层60秒；根会话阶段性全仓typecheck/build通过。最终全范围审查及测试另行记录。
- 未调用生产接口，未改变全局配置；fast_mode证据见codex-protocol.md。
