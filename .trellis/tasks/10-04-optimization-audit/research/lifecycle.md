# Research: 会话任务生命周期、控制命令与排队一致性

- Query: 当前升级后的桥接项目，还可以在哪些地方优化任务生命周期、排队并发、停止和切换会话体验？
- Scope: internal；当前工作区代码（含上一轮未提交升级），不审查 storage 实现、workflow 内部或飞书 API 内部。
- Date: 2026-10-04

## Findings

### 结论与优先级

主要收益来自把“消息接收、任务调度、会话切换、回合结束”统一为明确的生命周期。目前核心问题不是缺少新版模型功能，而是控制命令与运行回合采用了几套不同的状态和路由规则。建议先修 3 个 P1 行为，再收紧停止和超时契约；不需要为此重写整个项目。

| 编号 | 级别 | 当前问题 | 确定性 |
| --- | --- | --- | --- |
| L1 | P1 | 模型透传命令会阻塞整个渠道的后续接收，包括停止、审批和问答 | 源码确认 + 内存复现 |
| L2 | P1 | `/new`、`/bind` 后，旧回合仍能写回新绑定的模型与 SDK 会话 | 源码确认 + `/new` 内存复现 |
| L3 | P1 | `/stop`、`/new`、`/bind` 对 debounce、append、串行队列的处理不一致，旧请求可能继续执行或进入新会话 | 源码确认 + 两个内存复现 |
| L4 | P2 | 核心 `stop()` 缺少有界结束契约：不结束运行回合，停止后还可能启动 append；超时也仅通知取消 | stop 行为由内存复现确认；runner 最终退出部分缓解。超时部分仅证明契约缺口，不声称当前 provider 正常路径失效 |

未发现足够证据支持 P0 定级。

### L1：接收循环需要区分控制命令和会运行模型的命令

**证据和触发场景**

- `src/lib/bridge/bridge-manager.ts:943`：每个 adapter 只有一个 `consumeOne()` 循环。
- `src/lib/bridge/bridge-manager.ts:954`—`960`：所有以 `/` 开头的消息都走 `await handleMessage(...)`，注释把这一路视为轻量路径。
- `src/lib/bridge/bridge-manager.ts:1138`—`1158`：`//review ...` 等透传请求最终落入普通模型处理。
- `src/lib/bridge/bridge-manager.ts:1159`—`1180`：`/codex:*` 的非 help 请求也落入普通模型处理。
- `src/lib/bridge/bridge-manager.ts:1326`：这里等待完整 `engine.processMessage()`，直到模型回合结束。

于是用户发出 `//review ...` 后，同一渠道后续的 `/stop`、`/perm`、问答响应乃至其他聊天的普通消息都无法继续从 adapter 消费。当模型等待授权/回答时，控制消息不能送到 broker，只能等超时，形成应用层互相等待。绕开串行队列还会破坏统一的 active-task 管理；不能只把这一处 `await` 删除。

**最小优化**

在入站分类阶段先得到 `control | model | workflow` 语义；将 `//...`、有效 `/codex:...` 作为 model 请求调度。真正的停止、审批、回答仍能即时处理。help 等纯显示命令保持轻量路径。普通消息和模型透传必须通过同一会话队列。

**长期优化**

将命令解析抽为无副作用的 Command Registry，返回 typed intent；控制入口不等待模型执行。慢的 Git/其他命令也通过同一任务接口管理，避免以后又出现隐藏的长任务。

**验证**

研究复现第 1 项：fake 模型保持未结束，发送 `//review` 后再发送 `/stop`，只消费第一条；模型结束后才消费 `/stop`，此时回复没有任务。修复后的验收应反向断言 `/stop`、审批/答案和另一个 chat 的消息在模型未结束时已被消费，同一 session 的两个 model intent 仍串行。

### L2：会话切换缺少代际校验，旧回合会污染新会话

**证据和触发场景**

- `src/lib/bridge/bridge-manager.ts:1553`—`1557`：`/new` 对旧回合调用 abort 后立即重绑，不等待旧回合完成。
- `src/lib/bridge/bridge-manager.ts:1609`—`1612`：`/bind` 相同。
- `src/lib/bridge/channel-router.ts:82`—`100`：通过 upsert 更新同一 chat 的 binding，并清空 SDK session。
- `src/lib/bridge/conversation-engine.ts:397`—`408`：旧流的 status 无条件按捕获的 `binding.id` 写入 model / reasoningEffort。
- `src/lib/bridge/bridge-manager.ts:1461`—`1465`：旧回合完成后同样无条件按 `binding.id` 写 SDK session；这里晚于最终卡片/回复发送，故即使 provider 很快响应 abort，也存在交错窗口。
- `src/lib/bridge/bridge-manager.ts:1339`、`1419`、`1483`：进度、结束回调只有 chatId，无法在公共契约中分辨新旧回合；平台内部保护不能替代核心的 ownership 检查。

`abort()` 是通知，不等价于所有旧回调已经消失。新 session 与旧 session 复用一个 binding id，旧回合结束后能把旧 SDK session 再写进去。下一次请求可能恢复到用户刚刚想清空的旧上下文。晚到的 model status 也能覆盖新绑定配置。

**最小优化**

给绑定/任务捕获 `sessionId + generation`；写回模型、SDK session 和结束 UI 前进行“仍属于此回合”的校验。SDK session 本身优先作为 session 级数据保存，绑定写回采用 expected-session 条件更新。仅比较 binding id 不够；仅比较 sessionId 在绑定来回切换时也不够。

**长期优化**

每个 turn 有不可变 `TurnContext { turnId, sessionId, bindingGeneration, address, model, cwd }`；所有回调带 turnId，UI 与恢复信息仅接受当前 generation 的更新。区分“用户请求的下次模型”和“当前回合实际模型”，减少配置与运行状态互相覆盖。

**验证**

研究复现第 2 项：旧请求尚未结束时 `/new`，确认新绑定 SDK id 已清空；再注入旧 model status 与旧 result，最终新绑定出现旧 model 与旧 SDK id。回归应覆盖 `/bind`、旧回合在投递期间结束、新回合已开始、重复切换，以及旧 finally 不得关闭新回合 UI。

### L3：取消与会话切换必须覆盖所有等待阶段

**证据和触发场景**

- `src/lib/bridge/bridge-manager.ts:1774`—`1789`：`/stop` 仅检查 activeTasksByChat；有活跃任务才清 append。没有活跃任务时直接回复“No task is currently running”。
- `src/lib/bridge/bridge-manager.ts:732`—`762`：debounce buffer 独立持有 timer，命令不会清它。
- `scripts/claude-to-im-bridge/settings.ts:94`—`99`：飞书宿主默认启用 **1200 ms** debounce；不是只能人为构造的关闭默认功能场景。
- `src/lib/bridge/bridge-manager.ts:1553`—`1557`、`1609`—`1612`：`/new`、`/bind` 只清 append，没有清 debounce 或已入串行队列的任务。
- `src/lib/bridge/bridge-manager.ts:638`—`641`、`706`—`708`：普通请求入队时取得旧 session 锁，但回调只携带原始 msg。
- `src/lib/bridge/bridge-manager.ts:1214`：执行时重新 resolve，可能取得新 session，因此出现“排的是旧 session 队列，执行的是新 session”。
- 相比之下，append 路径 `src/lib/bridge/bridge-manager.ts:527`—`534` 已有 session 检查，说明三条路径语义确实不一致。
- `src/lib/bridge/internal/session-lock.ts:20`—`61`：队列只支持时间到取消，没有针对任务、chat 或 generation 的取消句柄。

用户在飞书连发消息的 1.2 秒合并窗口内发送 `/stop`，会得到没有任务的回复，随后请求照常开始。发送 `/new` 时，旧的待合并消息可能作为新会话第一条执行。关闭 append 后或排队较多时，旧队列请求也会在切换后进入新 session；实际 store 的二级锁可能返回 busy，并不能把错误路由变正确。

**最小优化**

统一取消 chat 当前 generation 的 debounce、append 与已排队记录；每个入队任务捕获不可变绑定快照，执行前核对 generation。明确通知用户取消了多少条，不以是否“已经调用模型”判断任务是否存在。不要把旧消息默默迁移到新会话。

**长期优化**

用一个 Scheduler 持有任务记录和队列，而不是三套消息容器各自决定生命周期。任务状态至少包含 collecting、queued、running、waiting-input、cancelling、completed/failed/cancelled。`/status` 从这份状态取队列长度、等待时长、取消进度。

**验证**

研究复现第 4 项证明 `/stop` 无法取消 debounce；第 5 项证明排队的旧上下文请求在 `/new` 后传给新 session。应补控制命令 × debounce/queued/running/waiting-input 四阶段的行为矩阵，保留已有不同 session 并发测试。

### L4：桥接 stop 应有可以依赖的结束边界

**证据和触发场景**

- `src/lib/bridge/bridge-manager.ts:838`—`878`：stop 清 debounce、终止接收循环和 adapters，但不 abort activeTasks、不取消 sessionLocks/append、不等待运行任务退出。
- `src/lib/bridge/bridge-manager.ts:1495`：旧任务 finally 仍 flush append。
- `src/lib/bridge/bridge-manager.ts:521`—`536`：flush append 没有检查 bridge 或 adapter 是否仍在运行。
- `src/lib/bridge/bridge-manager.ts:941`—`944`：consumeOne 返回后也没有再次验证运行 generation；停止/重启交错需要覆盖。

在调用库的 `stop()` 后，后台模型仍可能继续处理，旧回合结束后甚至启动下一条 append 请求，但渠道已经关闭，结果无法正常送达。重启后的旧 finally 也可能与新一轮状态交错。

**范围限制**

当前独立脚本 `scripts/feishu-claude-bridge.ts:518`—`522` 在 manager.stop 后又调用 provider.stop 并立即 process.exit。它降低了“脚本退出后模型永久留在本进程”的风险，因此此项定 P2；但强制退出不是核心 stop 语义完整的证明，也不保障在途消息/最终卡片处理完成。没有启动真实 runner 验证子进程树。

**最小优化**

先关闭 admission，取消排队与 append，abort 所有回合；在有界时间内等待已登记的 task promises 结束，再关闭 adapter。回调应检查运行 generation。超时后报告未结束任务数量，而不是把 running=false 当作全部结束。

**长期优化**

BridgeLifecycle 明确 running → draining → stopped，统一持有 consumer promises 和 turn promises；启动失败和停止失败也能由该对象汇总。

**验证**

研究复现第 3 项：fake adapter 停止、getStatus.running=false 后，旧 fake 模型的 signal 仍未 aborted；手动结束它会启动第二个 append fake 模型。验收要求 stop 后绝不启动新 turn，所有 active signal 收到取消，并能处理 stop/start 交错。

#### L4 的附属契约观察：将“通知取消”与“保证本地任务结束”分成两层

**证据和触发场景**

- `src/lib/bridge/conversation-engine.ts:213`—`220`：turn deadline 只执行 AbortController.abort。
- `src/lib/bridge/conversation-engine.ts:289`：reader.read 没有与 abort 竞争，也没有取消/释放 reader 的 finally。
- `src/lib/bridge/conversation-engine.ts:308`—`313`：问答发送回调直接 await；adapter 投递停滞也会阻塞消费。
- `src/lib/bridge/conversation-engine.ts:138`—`140`、`249`—`252`：只要消费未结束，lease 续约与 running 状态就持续存在。
- `src/lib/bridge/bridge-manager.ts:1778`—`1782`：`/stop` 提前删除 chat active 状态；`src/lib/bridge/bridge-manager.ts:1682`—`1691` 的 status 因而可能显示 idle，却仍持有 session lock。

当前模型 provider 已有 abort 支持，不应把本条描述成“所有 stop/timeout 都无效”。缺的是核心库对不遵循取消、网络卡住或问答投递不返回时的有界结束保障；这也是诊断“显示已停却不能再发消息”的关键。

**最小优化**

给流消费和交互发送建立 abort-aware 等待，并在 finally 取消/释放 reader，清理监听器。保留 cancelling 状态，直到本地执行完成；为模型中断请求与本地清理分别设置界限，标记未确认中断的 provider 状态。

**长期优化**

在 Provider 契约中写明 cancel/terminal acknowledgment；区分 deadline、idle deadline、waiting-input deadline、queue deadline，统一记录原因和最后活动时间。不能只把当前默认 90 分钟改短；交互等待与实际卡死必须能区分。

**验证**

研究复现第 6 项：turn timeout=20ms，fake stream 不响应 abort；50ms 后 signal 已取消但 processMessage 仍未返回，直到测试主动 close。应添加 provider 不响应、问答投递 pending、late result、正常取消后的锁释放断言。

### 适合当前项目的架构调整

建议保留现有 DI、adapter 注册表、conversation-engine/provider、delivery-layer 边界，按真实问题分三步收敛：

1. **Scheduler / TurnContext**：先统一 L1—L3 的入站分类、generation、排队取消、任务状态；产出是 `/stop` 可预测、`/new` 真正隔离、审批不会被阻塞。
2. **Lifecycle**：在同一任务记录上实现 draining、cancel、deadline、recovery 所需的终态；产出是 stop/restart 有边界、异常能够定位。恢复是否需要持久化由 storage 审计单独决定，不在本报告建议直接更换数据库。
3. **Command Registry**：最后把解析与 intent 接线从大 switch 移出去，复用上述 scheduler。收益是新增命令不会无意绕开并发和授权入口，而不是单纯缩短文件。

不建议现在引入消息队列服务、微服务、第二套工作流引擎或全面改 RxJS；现有规模用进程内显式状态机已足以解决本报告确认的问题。

## Files found

| 文件 | 描述 |
| --- | --- |
| `src/lib/bridge/bridge-manager.ts` | 消费循环、命令、队列、回合 UI 和启停编排；主要改进入口 |
| `src/lib/bridge/channel-router.ts` | 会话创建与重绑；需要配合绑定代际 |
| `src/lib/bridge/conversation-engine.ts` | store lease、provider 流、终态与绑定写回 |
| `src/lib/bridge/internal/session-lock.ts` | Promise 链串行化与排队超时；尚无任务取消句柄 |
| `src/lib/bridge/internal/timeouts.ts` | 队列默认 turn timeout + 10 分钟；默认合计 100 分钟 |
| `src/lib/bridge/channel-adapter.ts` | UI/流事件只携带 chatId 的公共边界 |
| `scripts/claude-to-im-bridge/settings.ts` | 飞书默认 1.2 秒 debounce 的可核验来源 |
| `scripts/feishu-claude-bridge.ts` | 独立 runner 在 manager stop 后停止 provider 并退出，限定 L4 影响解释 |
| `src/__tests__/unit/bridge-manager.test.ts` | 已覆盖底层同会话串行、跨会话并发、超时跳过；尚不足以覆盖完整控制命令交错 |
| `src/__tests__/unit/bridge-manager-ctx.test.ts` | 卡片与模型/问答等主流程测试 |
| `src/__tests__/unit/bridge-conversation-engine.test.ts` | 权限模式/默认模型入口测试 |
| `src/__tests__/unit/bridge-channel-router.test.ts` | 创建、绑定、backend 切换的顺序行为测试 |
| 本目录 `lifecycle-repro.test.ts` | 六项已确认生命周期行为的独立内存复现 |

## 验证记录

命令：

```text
node --test --import tsx --test-timeout=15000 .trellis/tasks/10-04-optimization-audit/research/lifecycle-repro.test.ts
```

结果：**6/6 复现断言通过**，测试进程统计 1541.6638 ms。这表示确认了上述不理想行为，不表示项目已经修复。业务代码未改动。

隔离方式：先注入纯内存 BridgeStore 与 LLMProvider 并断言 provider 身份；注册纯内存 adapter；所有平台 enable 配置均为空，真实工厂不会实例化。禁止 child_process 的 spawn/exec/fork 等入口并同步 built-in exports，禁止 fetch。没有实例化 Codex/Claude 运行时，没有凭据、真实会话、生产日志或真实 IM API 访问；结果无 token usage，未触发用量写盘；无附件文件写入。每项 timeout=1500ms，进程 timeout=15000ms。

## Related specs

- `.trellis/workflow.md`：Phase 1.2 研究须持久化。
- `.trellis/spec/backend/module-boundaries.md`：manager 编排、router 绑定、engine 消费、adapter 平台细节的边界。
- `.trellis/spec/backend/testing-guidelines.md`：同会话串行/跨会话并行、全局状态清理、fake transport 与禁止真实运行时测试。
- `.trellis/spec/backend/index.md`：DI 与共享契约优先。

## External references

无。本报告是当前本地代码行为审计，未对新版厂商 API 作额外断言，不需要外部版本信息支持。

## Caveats / Not Found

- GitNexus `context processMessage -f src/lib/bridge/conversation-engine.ts` 成功，确认主要调用方为 manager.handleMessage 与 mock-host.main。但索引给出的 engine 起始行 98，而当前代码为 107，说明索引不能代表上一轮未提交升级；本报告行号全部以当前源码为准。
- 根代理已确认 GitNexus query FTS 缺失；未重建索引，未把图中未出现的边当作没有调用方。
- 没有修改函数，不需要执行 symbol impact；实际修复前仍须对调度/结束/绑定写回等变更符号跑 impact 并告知 HIGH/CRITICAL。
- 研究 fake 的 store 锁刻意可控，不模拟真实存储实现；L3 的结论是错误路由与锁身份不一致，不擅自推导真实 store 必然同时放行两个模型。
- L2 复现的“晚到旧事件”是受控注入；真实发生频率未量化。现有代码的异步边界及无 generation 校验已足够证明无法排除此交错。
- 未评估消息持久化、投递去重/重试与 workflow 状态恢复，这些属于其他研究责任。
- 未执行生产停止/重启，也未以测试结果宣称实际 provider 的所有取消路径失效。
