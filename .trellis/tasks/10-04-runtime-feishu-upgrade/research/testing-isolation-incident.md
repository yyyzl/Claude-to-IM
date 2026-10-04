# 协议测试隔离失误记录

## 经过与已知证据

在 `bridge-codex-protocol.test.ts` RED 阶段，我把 FakeClient 通过构造器 `client` 选项传入；旧实现尚未支持此选项，忽略了该选项，实际通过 PATH 启动了本机 Codex app-server。运行命令为 `node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-codex-protocol.test.ts`，工具 session ID 13970。

- 所有测试 prompt 都是 `hi`，构造器 projectRoot/cwd 为 `G:/project/Claude-to-IM`。不能据此断言没有发送项目上下文，因为真实 Codex 可自动加载项目指令。
- 第 1 个测试约 337ms 后失败：FakeClient.calls 为空，未记录真实请求响应。该用例显式给了 sdkSessionId `thread` 和图片 data URI 字符串；旧实现忽略 files/model 参数。
- 第 2 个测试约 2683ms 后失败，实际错误是：`等待 turn 输出超时 ... : 01a106cf-4497-7581-8dab-14a4a66e20ed`。该 ID 是 **turn ID**。由旧实现能进入 collectTurnText 并返回 turn 超时可确认至少一次真实 thread/start、turn/start 获得成功响应；测试未记录真实 thread ID。
- 第 3 个取消用例约 2733ms 后失败，FakeClient 没有 turn/interrupt 记录；假客户端的触发器未执行，因此该取消用例实际也没有按照设计触发 abort。
- 第 4 个审批问答用例约 3434ms 后失败，FakeClient 的 replies 断言失败。测试未展示实际文本/工具事件。
- 检测到错误后立即向 session 13970 发送 Ctrl+C；结束 exit code 1。测试文件设置的 15 秒超时亦限制了运行。
- 后续进程检查仅剩 Codex 桌面自身的既有 app-server（PID 6900 / parent 46784），没有该测试创建的 Codex app-server；没有终止桌面进程或桥接进程。
- 未主动扫描 CODEX_HOME、凭据或用户会话。无法从已保留测试输出确认是否持久化真实 thread、上游请求发送了哪些项目上下文、是否完成过模型/工具调用；不能把本次误调用称为离线 mock 或受控生产联调。

## 修复

所有协议测试在调用 streamChat 前立即断言 provider.client 严格等于 FakeClient，不相等直接失败。构造器将在正式实现中提供受类型约束的 client 注入。在修复后重新执行 RED，五个测试全部在这个隔离断言处失败（总耗时约 337ms），未启动真实进程。进一步测试必须使用此隔离保护，禁止真实后端调用。
