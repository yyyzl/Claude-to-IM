# 飞书 Codex 即时追加执行清单

## 输入与责任

- 需求：prd.md；技术设计：design.md；实施范围和限制：implement.md。
- 规范：implement.jsonl 中的目录、模块、类型、可靠性、测试、集成及跨层合同。
- 研究：父任务 research/live-append.md。
- 用户于 2026-10-14 审阅最终范围后明确要求“你准备好的话就开始实施呗”；本清单拆分已批准的设计，不增加范围。
- 业务和测试由一个 trellis-implement 串行负责；主会话负责任务记录、使用说明及 spec；独立 trellis-check 负责审查并修正必要问题。

## 文件责任

- 修改 `src/lib/bridge/host.ts`：每次 stream 的可选当前输入能力及安全结果类型。
- 修改 `scripts/claude-to-im-bridge/codex-llm.ts`：原回合输入 closure、ready/closed 与 turn/steer 白名单。
- 修改 `src/lib/bridge/conversation-engine.ts`：同步登记、串行提交、原会话 user 记录与 assistant 前收尾栅栏。
- 修改 `src/lib/bridge/bridge-manager.ts`：原任务/发送者归属、源消息唯一所有权、异步工作追踪、原卡提示及后轮边界。
- 测试 `src/__tests__/unit/bridge-codex-llm.test.ts`、`bridge-conversation-engine.test.ts`、`bridge-lifecycle-regression.test.ts`；组合回归可新增 `bridge-feishu-live-append.test.ts`。复用 codex-test-transport，不做无关测试重构。
- 主会话在实现后只更新现有一处追加说明及 `.trellis/spec/backend/reliability-contracts.md`。

## S1 当前回合输入与 Codex 终态

- [x] RED：在 bridge-codex-llm.test.ts 添加内存 transport 测试，现有 provider 缺当前输入能力时产生明确失败。
- [x] 运行 `node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-codex-llm.test.ts`，记录行为失败证据，不接受仅语法/导入失败。
- [x] 修改前对 streamChat、collectTurnText 等确切既有符号运行 upstream impact；UNKNOWN 用 engine 动态调用及源代码补证。
- [x] GREEN：host 可选句柄；provider 在初始化前提供本 stream closure，等待精确 turn 与 collector/backlog ready；匹配完成、错误、取消与 epoch 变化立即封闭准入。
- [x] 请求仅为 turn/steer，使用原 thread/expectedTurnId/text 输入；正确同 ID 回执 accepted，调用 RPC 前明确未发为 not-submitted，调用后的错误/超时/断连/错 ID 为 unknown。无新增 turn/start/resume，无 JSON-RPC 修改。
- [x] 重跑同一测试，增加 early completed、初始化取消、成功回执晚于 completed、未知结果及旧 closure 隔离。

## S2 原会话记录与收尾

- [x] RED：bridge-conversation-engine.test.ts 覆盖补充回执晚于 stream EOF、连续两条补充顺序和 accepted 后记录失败，证明当前缺少登记/结算栅栏。
- [x] 运行 `node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-conversation-engine.test.ts`，记录预期失败。
- [x] processMessage、consumeStream 逐符号 upstream impact；CRITICAL 已告知用户，仍按实际调用链核对。
- [x] GREEN：engine.submit 同步登记 pending，串行提交；accepted user 保存原 session。正常/错误/取消 assistant 保存前统一 seal/settle，结算有界，不在 catch 重复提交或重复记录。
- [x] 明确 backend 接收与本地保存的不同结果；存储失败不得变为未提交或自动重送。
- [x] 重跑同一测试及 S1，断言消息顺序 user/user/user/assistant，旧归属不写入新会话。

## S3 manager 与同一飞书卡片

- [x] RED：bridge-feishu-live-append.test.ts 或现有 lifecycle 中使用真实 manager + engine + Codex provider + 内存 JSON-RPC/飞书 transport 重现忙时补充，证明旧实现会开启第二轮。
- [x] 运行 `node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-feishu-live-append.test.ts src/__tests__/unit/bridge-lifecycle-regression.test.ts`；若无新增文件，命令去掉不存在文件，保留实际覆盖证据。
- [x] registerActiveTask、enqueueRegularMessage、handleMessage 及实际改动 helper 逐符号 upstream impact；不顺手改 scheduleMessages 共用调度。
- [x] GREEN：同 owner、原 backend/绑定/代际、追加开启、无附件普通文本才即时准入；复用 sanitizeInput 与截断审计，命令/透传/按钮原路处理。
- [x] 在短准入边界内同步登记并调用 engine.submit，不等待网络；连续输入归 engine tail；来源不能同时存在于可 flush 的 pendingAppends。确认未提交且未取消才转原会话后轮；unknown 不重送。
- [x] accepted 后更新原卡追加提示，只有一次 onMessageStart 和一张过程卡；原来源与补充最终统一确认，后轮来源交后轮确认。
- [x] 验证控制/其他聊天不阻塞；stop/new/bind/stop-restart 与 initializing/submitting/late receipt 隔离；模型完成但 card finalize 挂起时正常后轮；sender、开关、附件和其他 provider/channel 原路径。
- [x] 重跑 S1/S2/S3 以及飞书 streaming/reliability、生成图及 delivery/retry 最小相关回归。

## S4 独立检查与交付

- [x] 主会话更新追加说明与可靠性合同，记录实际实现和任何经核实的边界；不修改未批准的其他能力。
- [x] 由独立 trellis-check 检查 R1–R6、A1–A6、源消息确认、记录顺序、卡片代际及全部改动；需要自修时继续遵循影响分析和原范围。
- [x] `npm run typecheck`、`npm run build`，然后必要的 `npm run test:unit`；每批单测外层硬超时 60 秒，fake 先注入并阻断真实子进程/fetch。
- [x] `gitnexus detect-changes --scope all --repo .`，处理 partial/truncated 与 UNKNOWN；核对完整 git diff、未跟踪文件及 d1/d2/d3 真实影响。
- [x] 记录构建/测试结果及实现限制到任务；本轮不自动连接生产飞书或重启运行中的桥接进程。
- [x] 按用户于 2026-10-14 确认的清单完成两笔本地工作提交：3093711（规划资料）与 638aa8b（即时追加功能）；截图排除。当前子任务进入归档收尾，父任务及去重/文件目标保留。

## 执行要求与风险

每片先证实真实行为失败，再改最小代码。测试外层使用 subprocess timeout=60 或等价硬超时；不把失败导入/真实凭据调用当作 RED。不读用户实际聊天或认证。共用生命周期为 CRITICAL；超时/断连的接收结果无法确认时不自动重试。无需新依赖、全局设置、新持久队列或出站格式。

首片为 S1；无阻塞依赖。开始实施以 task.py start 成功为准。

## 实施证据（2026-10-14，交独立检查前）

- S1 RED：首次新增 3 项明确失败于“初始化前必须发布输入能力”；既有 4 项通过。GREEN：最终 provider 文件 9 项通过；精确原 thread/expectedTurnId、collector drain 后 ready、early completed、初始化取消、同 ID 旧 closure 隔离、晚成功收据、错 ID/异常/断连/3 秒超时 unknown 均覆盖。
- S2 RED：缺 engine 包装/发布输入造成 2 项行为失败。追加 RED 证实正常 ready 等待不应在 3 秒提前 unknown，及 accepted 记录失败遇到 stream error 时不能被模型错误掩盖。GREEN：engine 文件 6 项通过；同步登记、串行提交、user/user/user/assistant 顺序、3500ms 收尾上限和封口后迟到成功不再写历史均覆盖。运行中初始化不计 RPC 超时，RPC deadline 只在 provider request 调用后开始。
- S3 RED：真实 manager + engine + Codex provider + FeishuAdapter/fake cardkit 链路忙时未出现 steer（500ms 行为断言失败）；既有 lifecycle 23 项通过。追加 RED 证实初始化中未提交 A 来源被后来的 B 来源超车（实际下一轮 input 为 B）。GREEN：组合 20 项通过，含连续补充/晚收据/unknown/初始化/backlog/收尾后轮、stop/new/bind/停机重启、其他聊天与控制消费、开关/发送者/附件/透传/post 清理审计。不同发送者和附件先进入后轮后，后来 A 文本不能再 steer 原回合；实际 RPC/turn 输入断言覆盖，后轮仍按 sender 分组。
- 最终核心 4 文件测试合计 58 项通过（约 7 秒）；飞书卡片/投递/生成图/额度最小批 49 项通过，协议/目录/媒体/补发/审批/manager 相关批 123 项通过。新增测试均使用 fake，并硬阻断真实子进程/fetch；组合测试额外阻断 socket.connect。每批外层 60 秒硬限，单测试 15 秒。
- npm run test:unit：819/819 通过，0 fail/cancelled/skipped，约 16.9 秒；外层采用独立 subprocess 和 60 秒进程树终止边界。随后只增补测试入口硬阻断，相关 provider/engine 15 项再次通过。
- npm run typecheck、npm run build 均通过；git diff --check 通过。无新增依赖、JSON-RPC 客户端变更、scheduleMessages 共用逻辑变更、持久格式或平台适配器签名变更。
- 修改前 upstream impact：processMessage/consumeStream/registerActiveTask/handleMessage 为既有已告知 CRITICAL，enqueueRegularMessage 为 LOW，collectTurnText 为 LOW；provider streamChat 为 UNKNOWN lower-bound，以 engine 的动态 llm.streamChat 和脚本装配源码补证。仓库/工作区 G:/project/Claude-to-IM，HEAD 与索引 commit 均为 c65115771e4fc7b6b241c55c46f9165b9f33ba47。
- GitNexus detect-changes --scope all --repo . 已执行；另读取已安装 1.6.12 的同一 LocalBackend 完整结构化结果：69 个图映射符号、35 个流程、9 个已跟踪文件，risk_level=critical，无 error/partial/truncated 标记，数组数量与汇总一致。旧索引行区间有重叠误报（如 selectModel/clearActiveTask），不把这些当实际修改；完整 diff 已核对。新增未跟踪组合测试由 git status 和全文人工补证，截图目录及其他任务未混入修改。
- 已冻结业务代码，等待主会话派独立 trellis-check。未提交、推送、归档、重启生产桥接或连接真实模型/飞书。内存回归验证协议和生命周期，真实模型对补充的回答质量仍需后续用户联调。

## 独立检查证据（2026-10-14）

- 完整核对 R1–R6/A1–A6：provider closure 与 thread/turn/epoch 精确归属、ready/backlog 封闭；engine 同步 pending/串行 tail/user 在 assistant 前及 3500ms 迟到封口；manager 唯一来源所有权、后轮顺序、发送者/附件/开关边界和统一确认；卡片/control/旧绑定隔离与既有渠道路径。未扩大 scheduleMessages、JSON-RPC、依赖、适配器或其他任务范围。
- 发现并修正局部缺陷：unknown/historyError 独立通知在限流等待时，原任务正常 finally 清理 uiOwner 导致提示被吞。只在 startLiveAppend 将独立 deliverSingle 的谓词改为 ownsTurn(task.context)，保留原 address/replyToMessageId 及 taskPromises 跟踪；原卡 notifyAppend 仍验证原 UI owner，不阻塞任务收尾。
- 修改前 startLiveAppend 在旧索引为 UNKNOWN/not-found；gitnexus analyze --index-only 刷新后 upstream 风险 LOW，d1 为 tryLiveAppend 与 handleMessage.onActiveTurnInput，d2 enqueueRegularMessage，d3 runAdapterLoop。当前源码补证 ownsTurn 检查 abort、runEpoch、chat generation、binding ID 与 session ID，正常 finally 不 abort 原 context。
- RED：新增 6 项限流竞态回归，其中 unknown/historyError 在原任务完成并开启新卡后缺少提示的两项失败，stop/new/bind/bridge-stop 抑制旧提示四项通过。GREEN：6/6 通过，保留原来源元数据、实际同 chat 普通消息送达、新卡无变化；取消四项仍通过。
- 检查前核心 58/58 通过；自修后 npm run test:unit 825/825 通过，0 fail/cancelled/skipped，17.5 秒，包含原核心及新增 6 项。各批外层进程树硬超时 60 秒，单测试 15 秒；新增用例延续内存模型/平台及 fetch/socket/子进程硬阻断。
- 自修后 npm run typecheck、npm run build、git diff --check 均通过。项目未配置独立 lint 脚本，不能声称另行 lint 通过。
- 最终 GitNexus detect-changes --scope all --repo . 及相同 LocalBackend 完整结构化核验：82 符号/73 流程/9 tracked 文件，risk critical，数组数量与汇总一致，无 error/partial/truncated 标记。新增组合测试及 spec/task 文件由实际 diff/status/全文补证；图索引仍有 FTS 不可用与流程预算限制，未以空结果替代源码调用链核对。
- 可靠性合同原段落补齐案例、测试断言锚点和错误/正确做法，明确原卡 UI 归属与独立事实通知代际归属的差异。既有 FeishuAdapter.send 普通消息不渲染 replyToMessageId 为平台线程回复，测试只断言核心保留元数据、平台同聊天送达；此适配器限制不在本任务修改范围。
- 检查完成并冻结上述代码/测试/spec/本 plan；无剩余阻塞缺陷。未提交、推送、重启或连接生产模型/飞书；真实模型最终回答质量及平台联调未验证。
