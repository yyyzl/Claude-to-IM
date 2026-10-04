# Research: 补发控制通道与当前聊天历史会话

- Query: 为 PRD R1/R3 提供最小方案、宿主契约、归属与持久化边界，以及修改前上游影响。
- Scope: internal；仅研究 `/retry` 与 `/sessions`，不改业务代码。
- Date: 2026-10-05
- 基线：根代理提供 main `9a0bcb5`；前轮 GitNexus 1.6.12 索引内容匹配该基线。本轮明确使用根提供的任务路径；子代理的会话 task 指针为 none，不擅自切换。

## Findings

### 1. 补发等待阻塞控制消息：已确认，P1

`bridge-manager.ts:996–1008` 的控制入口仅将模型卡后台跟踪，其他控制消息同步等待 `handleMessage`；`:1905–1908` 的 `/retry` 直接等待网络补发。`response-delivery.ts:101–105` 没有接受已有 `isCurrent` 选项，尽管底层 `attempt` 已支持分块取消检查。

此前纯内存复现实证：fake adapter 的首个补发 send 保持 pending，依次投递聊天 A 的 `/retry`、聊天 B 的 `/stop`；40ms 后仅消费第一条，释放 send 后才消费第二条。模型调用计数为 0。执行使用 Node+tsx 内联代码、fake store/adapter、LLM 调用抛错，mock 阻断 child_process 与 fetch；退出 0，约 1.89s。此证据复现的是 manager 消费循环依赖关系，不是模拟 SDK 忽略 abort 后将其当真实上游故障。本任务未重复运行，也未保存测试脚本。

**推荐最小方案：**

1. 为补发独立记录聊天任务 context（chat key、generation、runEpoch、AbortController/有效性谓词），和现有 `taskPromises` 一起跟踪，不占用模型 `activeTasks` 或 stream UI 所有权。
2. 在 `admissionGate` 内仅完成“能否开始、记录 context”的短事务；gate 与 adapter 消费循环均不等待补发网络/flush。可以让 `/retry` 直接启动受跟踪工作后返回，避免额外修改整个 `handleMessage` 调度策略。
3. `retryResponseDelivery` 增加可选 `isCurrent` 参数/选项，并传给既有 `attempt`。保留按 record 的 `running` 互斥和 channel/chat/user 过滤。重复补发不能并发发送相同记录。
4. `cancelChat` 取消本聊天的补发，覆盖 `/stop`、`/new`、`/bind`；bridge stop 也须枚举补发 context 或统一使 epoch 失效，并纳入现有有界排空。cleanup 按 context 身份删除，不能删除新补发。
5. completion/error 回复发送前再次验证 context，迟到补发不能把“已送达/失败”写到切换后的新会话；停止回复需要正确反映取消了补发，不能说“没有运行任务”。
6. 沿用 `attempt:68–80` 的“确认成功→sent=true→save→有效性检查”顺序。不能在网络已确认成功后先取消检查再丢弃 sent 标记，否则下次会重发。取消阻止后续块；已交付网络的请求未必可撤销，不声称实现平台 exactly-once。

当前新消息与补发之间允许并行、不串 UI 是最小范围；原有“模型 active 时拒绝补发”可保留。开始检查必须与入队共享 admissionGate，避免明显检查/登记竞态。尚在 collecting/queued 的消息无需为此扩大全模型状态机；若实现选择额外互斥，必须给明确排队/拒绝反馈并测试。

### 2. 历史会话不可找回：已确认，P2

`bridge-manager.ts:1882–1894` 使用 `router.listBindings(adapter.channelType)`，既非当前聊天历史，又只显示 ID 前 8 位；`/bind:1709–1713` 要求完整有效 ID 和实际存在的 session。`channel-router.ts:81` 的 `/new`、`:159` 初始绑定、`:199` 显式 bind 均经过 `store.upsertChannelBinding`；当前 JSON store `:132–164` 会覆盖同 channel/chat 的当前 session，历史 session 本体仍存在但归属索引丢失。

此前纯内存调用真实 `handleMessage('/sessions')` 得到截断 ID，再传 `/bind <截断ID>` 得到 `Invalid session ID format`，断言通过；没有真实模型或 IM 调用。

**推荐最小宿主契约与持久化：**

- `BridgeStore` 增加可选只读能力，例如 `listChannelSessionHistory?(channelType, chatId): ChannelSessionHistoryEntry[]`，条目最少为 `sessionId` 与 `lastBoundAt`。这是宿主对其绑定生命周期的历史索引承诺；不要求旧宿主实现，不新增必选写方法。
- JSON 宿主在 `upsertChannelBinding` 同一个同步事务里记录旧绑定和目标 session，并以 sessionId 去重、更新最近绑定时间。新建时也记录首个 session。因此 router 三条写路径无需改动。
- 当前历史归属沿既有 binding 的 `channelType+chatId`，群聊保持已有共享会话语义。历史列表不混用 outbox 的 userId 权限含义。跨聊天显式 `/bind` 仍沿现有显式完整 ID 行为，本次不悄悄改变其授权契约。
- 增加可选 JSON 顶层历史字段，在 `load/save/parsePersistedData` 中读取、保存与校验。缺字段视为旧格式；当前 binding 是可靠归属证据，可以在读取时合并当前项、在下次 upsert 时将旧当前项入历史。不得扫描 `sessions` 将无归属旧会话公开给当前聊天。
- 历史随 bindings 在同一 JSON 快照原子保存；沿用现有 scheduleSave、flush、backup、atomicWrite，不另加文件或第二套保存队列。本次为可选字段兼容，不需要用户手工迁移数据库。
- 查询返回副本；忽略/明确处理已经不存在的 session，列表详情从 `getSession` 获取，不把旧 cwd/model 快照当当前运行配置。保存失败沿已有 dirty/flush 报错合同，不宣称本次修改达成严格 fsync 后才回复。
- `/sessions` 只读当前 channel/chat；展示当前标记、完整 `<code>/bind ID</code>` 和 HTML 转义后的目录/可用标题。排序按最近绑定。若限制条数，必须让用户知道还有更多；需要全部可找回时可加简单页码，勿只 silently slice 掉历史。
- 没有可选能力的宿主：只列当前 binding 的完整 ID，说明宿主不支持历史列表。没有当前 binding 时返回无会话；不能回退为同渠道全部 bindings。
- 推荐本轮使用完整可复制 `/bind` 文本。已有 Feishu callback `adapters/feishu-adapter.ts:598` 仅允许 `perm|workflow`，审批卡 `:1305/:1321` 含审批特定解析；因此新增 sessions 按钮需要同步 callback 协议和校验，不能当成完全免费的通用按钮复用。完整 ID 已满足 AC4，避免为此改平台模板。

## 修改前上游影响

已执行全局 GitNexus 1.6.12 CLI，形式为 `gitnexus impact '<完整UID>' --direction upstream --repo .`。所有 HIGH/CRITICAL 已立即通报根代理；根回复已向用户通报。原始 JSON 未另存，避免生成范围外文件；下表保留影响结论和可复跑 UID。

| 符号 UID（省略共同路径前缀时见下文） | 图风险 | d=1 调用方 | 真实执行流与注意事项 |
| --- | --- | --- | --- |
| `Function:src/lib/bridge/bridge-manager.ts:handleCommand` | CRITICAL | handleMessage | 图报告 6 条受影响流程；控制入口、停止/切会话、会话列表 |
| `Function:src/lib/bridge/bridge-manager.ts:runAdapterLoop` | LOW | start | 渠道消费入口；如采用 handleCommand 内启动任务可不改此函数 |
| `Function:src/lib/bridge/bridge-manager.ts:cancelChat` | CRITICAL | handleCommand、stop | 图报告 6 条流程；单聊天 stop/new/bind 与全局停机 |
| `Function:src/lib/bridge/bridge-manager.ts:getState` | CRITICAL | 25 个直接调用方 | 图报告 16 条流程，核心 caller 含 start/stop/handleCommand/handleMessage/cancelChat/captureTurn/ownsTurn/scheduleMessages/enqueueRegularMessage；只增补发状态，不改旧 map 语义 |
| `Function:src/lib/bridge/bridge-manager.ts:stop` | UNKNOWN | 图未解析到 | 导出/动态宿主边界；不能视为无调用。源码本身 `:875` 负责 epoch 失效、取消和 taskPromises 有界排空，补发必须接入 |
| `Function:src/lib/bridge/response-delivery.ts:retryResponseDelivery` | CRITICAL | handleCommand | 图报告 5 条流程；补发透传取消谓词 |
| `Method:scripts/claude-to-im-bridge/store.ts:JsonFileBridgeStore.upsertChannelBinding#1` | UNKNOWN | 图未解析到宿主接口调用 | 当前源码确认 router startNewSession/createBinding/bindToSession，调用点 81/159/199；按关键写路径对待，不把 UNKNOWN 当安全 |
| `Method:scripts/claude-to-im-bridge/store.ts:JsonFileBridgeStore.load#0` | LOW | constructor | 加可选字段读取，保持旧数据和损坏恢复规则 |
| `Method:scripts/claude-to-im-bridge/store.ts:JsonFileBridgeStore.save#0` | CRITICAL | flush | 8 条持久化流程，包括消息、bindings、sessions、SDK/模型和 outbox；只加快照字段，不修改原子写顺序 |
| `Function:scripts/claude-to-im-bridge/store.ts:parsePersistedData` | LOW | load | 新字段缺省兼容；字段存在时必须结构校验 |
| `Function:src/lib/bridge/internal/bridge-help.ts:buildBridgeCommandHelp` | CRITICAL | handleCommand | 图报告 5 条流程；仅当更新会话命令帮助时修改 |

图中部分间接项包括 codex-jsonrpc 的 handleLine/request，系同名调用歧义，不能据此声称补发会改 JSON-RPC；实际边界以当前源码补证。`riskSharedAxes: LOW` 不抵消报告的 CRITICAL。最初不带 class/#arity 的三个 store UID 查询失败，已改用上表完整 UID 重查；不是未查即修改。

若实施者改 `handleMessage`、`updateChannelBinding`、`attempt`、接口/新 helper 的现有调用边界，需补对应 impact。本方案刻意不用 router 修改，也无需改变 delivery-layer 的网络超时实现。

## 文件与最小验证范围

实现：

- `src/lib/bridge/bridge-manager.ts`：补发独立生命周期与当前聊天历史命令。
- `src/lib/bridge/response-delivery.ts`：透传可选有效性谓词，沿用进度与互斥。
- `src/lib/bridge/host.ts`：可选历史条目与列表能力契约。
- `scripts/claude-to-im-bridge/store.ts`：绑定历史索引与同快照持久化。
- 可选 `src/lib/bridge/internal/bridge-help.ts`：中文准确说明历史范围/使用法。

测试：

- `src/__tests__/unit/bridge-lifecycle-regression.test.ts`：fake 挂起 retry 时另一聊天 stop/权限仍被消费；重复 retry；stop/new/bind/bridge stop 取消剩余块；旧 completion 不发送、不删除新context；LLM 次数0。
- `src/__tests__/unit/bridge-delivery-reliability.test.ts`：第1块成功、第2块等待期间取消，解除等待后不发第3块；下次只补未确认块；保留原有宿主 fallback 与重复抑制。
- `src/__tests__/unit/bridge-json-store.test.ts`：new A→new B→bind A 去重排序；flush/close/reload 后历史保留；旧文件无历史字段、损坏字段、另一 chat/渠道隔离、返回副本。
- `src/__tests__/unit/bridge-manager-ctx.test.ts` 或专用窄测试：会话列表完整ID可传 `/bind`；切换后找回；旧宿主只当前chat；HTML字符转义；不公开孤立session。
- 如改帮助则 `bridge-help.test.ts`；保留 `bridge-channel-router.test.ts` 既有继承模型偏好回归，不为方案新增无关 router 改动。

测试只用 fake 模型/adapter 与独立临时 JSON，后台总超时≤60秒。此研究阶段未跑业务测试；实施后根负责范围回归、typecheck/build及整体验收。

## Related specs

- `.trellis/workflow.md`：研究持久化、先规划后实现。
- `.trellis/spec/backend/reliability-contracts.md`：代际与取消、待发记录、受跟踪任务、有界 shutdown、宿主持久化错误处理。
- `.trellis/spec/backend/module-boundaries.md`：manager 控制流程、投递模块保留进度、宿主负责具体存储。
- `.agents/skills/gitnexus/gitnexus-impact-analysis/SKILL.md`：上游影响与 UNKNOWN 补证。
- 当前 task `prd.md` 的 AC1/AC2/AC4/AC5。

## External references

没有外部 API 或版本变更；本题只改当前已确认内部契约，未访问生产飞书或模型。

## Caveats / Not Found

- 旧孤立 session 没有可靠归属证据，不能自动恢复到某个聊天的列表；仅能安全补当前绑定和今后切换记录。
- 已发送而平台响应超时的块仍是结果未知，本次不承诺平台消息级 exactly-once。
- 研究期间无业务文件、测试文件或 Git 状态写操作，仅创建本研究文档；实施影响若扩出上述符号必须补查。
