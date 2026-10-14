# 非阻塞问答实施切片

## 输入

PRD：prd.md；技术设计：design.md；执行门禁：implement.md。backend reliability/type-safety/testing/quality 合同及 research/upstream-protocol.md、research/implementation-boundaries.md、research/impact-before.json。

## 文件责任

业务：scripts/claude-to-im-bridge/codex-llm.ts；src/lib/bridge/host.ts、types.ts、user-input-broker.ts、channel-adapter.ts、bridge-manager.ts、adapters/feishu-adapter.ts、markdown/feishu.ts。主会话维护任务材料与 docs/feishu-v2-streaming-cards.md、.trellis/spec/backend/reliability-contracts.md；不修改通用审批观察器或依赖。

测试：src/__tests__/unit/bridge-codex-protocol.test.ts、bridge-user-input-broker.test.ts、bridge-feishu-streaming.test.ts；新建 bridge-feishu-async-questions.test.ts，复用现有 bridge-feishu-live-append.test.ts 的 fake 协议与真实 manager 模式，不复制生产逻辑。

所有测试命令由 Python Popen/communicate(timeout=60) 包装，超时时 taskkill /PID /T /F，退出非零；单测加 --test-timeout=15000。验证日志写任务 .fusion/（忽略目录），研究总结只保存安全统计与失败断言。

## S1：协议和真实运行状态

- [x] 在 bridge-codex-protocol.test.ts 先加非阻塞输出/回传、并发两个阻塞问题、审批与非阻塞问题交错、正常完成原因和错 thread resolved 通知测试。
- [x] 运行 `node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-codex-protocol.test.ts`，确认缺少 isBlocking/闭合原因及错误运行状态的预期 RED，禁止用 import/类型错误当行为 RED。
- [x] 修改 host.ts 和 codex-llm.ts：透传标志、原 thread/turn 绑定、阻塞集合、request_closed/turn_completed 及迟到 finally 隔离。
- [x] 重跑上述测试 GREEN；连同 bridge-codex-llm.test.ts 验证已有 turn/steer 合同。

## S2：问答闭合、来源与一次性答案

- [x] 在 bridge-user-input-broker.test.ts 增加闭合未答保留、正常结束/主动取消区别、真实原卡与用户校验、原题不可伪造、重复 claim、TTL/数量及迟到发送测试。
- [x] 运行 `node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-user-input-broker.test.ts` 确认行为 RED。
- [x] 修改 user-input-broker.ts 与 host/types/channel-adapter 契约，独立管理问答状态及有界 closed 记录，共用答案校验与题目文本生成；generic 审批逻辑不改。
- [x] 重跑 broker 测试 GREEN，保留现有其他渠道回答/秘密拒绝/投递失败测试。

## S3：飞书表单与显式补充动作

- [x] 在 bridge-feishu-streaming.test.ts 先测试阻塞与非阻塞文案、closed 卡仍有选择/输入且改用补充按钮、专用 callback DTO及拒绝伪造来源。
- [x] 运行 `node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-feishu-streaming.test.ts` 确认行为 RED。
- [x] 修改 markdown/feishu.ts、adapters/feishu-adapter.ts：复用现有原生表单，专用问答更新与补充回调；保持卡片字节预算、平台成功和 messageId 检查。
- [x] 重跑 GREEN，原审批/模型设置/过程卡测试继续通过。

## S4：真实 manager 准入、后轮与取消

- [x] 新建 bridge-feishu-async-questions.test.ts，fake transport+真实 provider/manager/broker：有效答案不追加、closed 补充即时一次/后轮一次、原按钮闭合竞态不自动补充、另一 active 回合拒绝、重复点击、其他用户/聊天/卡片、stop/new/bind/停机、网络挂起仍消费控制、unknown 不重送。
- [x] 运行 `node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-feishu-async-questions.test.ts` 确认 manager 未接线的行为 RED。
- [x] 修改 bridge-manager.ts：捕获原任务 guard/准入回调；专用控制 DTO在准入锁内同步 claim 与合成普通消息；复用已有 enqueue/live-append，不 await RPC；正常收尾与主动取消分别清理。
- [x] 重跑 GREEN；运行 `node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-feishu-live-append.test.ts src/__tests__/unit/bridge-lifecycle-regression.test.ts src/__tests__/unit/bridge-delivery-reliability.test.ts` 最小间接/传递回归。
- [x] `npm run typecheck`、`npm run build`、`npm run test:unit`，测试均按 60 秒硬截止分批；无 lint 脚本，不虚报 lint。

## 检查与完成

- [x] 主会话 freeze 后派 trellis-check，验证 PRD 与全链路、共享类型消费者、取消清理、更新顺序、来源 ack、秘密与日志；修复三个实际缺口并新增 12 项回归。
- [x] 运行 `gitnexus detect-changes --scope all --repo .`，检查 partial/truncated/error 并与 git diff/未跟踪文件对照，结构化 51 符号/53 流无不完整标记。
- [x] 主会话更新必要文档/规范及验收记录，具体提交范围见 implement.md；最终 872 全量单测与 typecheck/build 通过，待本批提交授权。

首先从 S1 开始，无实现阻塞依赖。原去重和文件入口选择不会阻塞本任务。关键风险为正常 abort 与主动取消混淆、旧 closed 卡污染新任务、未知结果重放、卡片慢 patch 覆盖终态及控制循环等待网络。

## S5：真实联调发现的原生 async 消息生产者

前置研究 research/live-native-async.md 已核对真实当前线程持久事件与 0.160/0.162 相同 schema；S1–S4 的 872 测试为旧基准，不是 S5 完成证据。业务/测试仍限定前述 8+4 文件，engine 不新增事件。主会话已再次告知 HIGH/CRITICAL 影响。

- [x] 先在 bridge-codex-protocol.test.ts 增加由真实字段映射的 schema 合法 agentMessage async/questions fixture，确认未发出 message 通道题目的 RED；覆盖 started/completed/backlog 去重、错 thread/turn、取消、普通/畸形消息，题目不混最终答案且后续输出继续。
- [x] 最小修改 host/provider：显式 answerChannel；collector metadata 驱动识别、单次 SSE 和缓冲隔离。保留 RPC 与普通媒体/文字流，不伪造 RPC ID，不触发 waiting_for_input。
- [x] broker/manager/card 新增行为 RED：native pending 答案携原题即时追加一次，无 PermissionGateway pending/原 RPC reply，正常完成 closed，旧按钮竞态拒绝，取消/换绑不复活。
- [x] 最小实现原生 message 生命周期及共享消息准备器，manager admissionGate 内同步 sanitize/claim/准入；卡片说明答案作为任务补充；保持 closed 必须显式补充、unknown 不重放和控制消费不阻塞。
- [x] 用真实 provider→engine→manager→broker 与 fake Feishu 回归原生两题入口及一次 steer/后轮，复测 S1–S4、既有 live append/lifecycle/delivery。
- [x] 独立 trellis-check 复核、全量单测（外层 60 秒硬截止）、typecheck/build；刷新索引和完整 detect_changes 对照实际 diff，更新合同与记录。全量 892/892，问答 86/86，12 哈希一致，126 符号/60 流无不完整标记。
- [x] 主会话安排加载更新后的运行进程，再在原聊天真实触发表单并回传选择/文字。S6修正平台格式后，第3轮原生两题独立问答卡、真实选择/文字回传及原回复卡追加通过。

## S6：第二次真实联调发现的飞书输入框格式拒绝

2026-10-14 16:22 用户重启确实加载 S5 构建，16:48 原生两题仍未出现问答卡。当前应用的 CardKit 平台格式验证收据：原 `buildUserInputCard` JSON 被 `code=11310` 拒绝，错误 `max_length exceed the default maximum 1000`；仅两处输入框 `max_length` 改为 1000 的同一 JSON 返回 `code=0` 和 card_id。选择框不额外增加 behaviors。该探针只证明格式原因与修正，不代表真实 native 端到端验收通过。

影响：GitNexus `buildUserInputCard` upstream 为 LOW，直接调用方 `FeishuAdapter.sendUserInputRequest` / `updateUserInputRequest`；发卡和状态更新两流程。当前切片仅 renderer、必要测试，主会话维护记录与合同。

- [x] 先补平台 input 合同回归：选择题的其他输入、自由输入、pending/closed 状态均满足官方 max_length 1…1000；通过真实 adapter 发送/更新出口检查结构，不调用生产接口做单测。
- [x] 用 60 秒进程树截止运行最小测试并记录预期 RED（实际 4000 超上限），再把 renderer 两处输入框改为 1000。
- [x] focused GREEN、独立 trellis-check、全量单测/typecheck/build；刷新图索引和 detect_changes 对照实际 diff。全量894/894，问答88/88，既有追加/生命周期/投递74/74；12冻结哈希一致，126符号/60流无不完整标记。审核补强每出口实际字段值及负面自检，生产仍只两处数值修复。
- [x] 重建后用相同 CardKit probe 验证实际 dist 原卡 JSON 合法，记录非端到端收据；按自托管进程约束安排用户加载再试原生两题卡及答案回传。

实际重建dist原卡已获code=0实体收据。第3轮用户17:53再次重启，PID53100加载新构建；真实原生选择/输入表单出现，用户提交后答案回到当前任务，原回复卡+1追加、问答卡已接收，本轮实时链路通过。当前未提交/推送/归档；后续提交仍按implement.md既定范围取得本批授权。
