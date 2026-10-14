# 即时追加执行计划

## 前置条件

- [x] 用户认可运行中补充当前任务并复用原卡；模型结束后正常新轮。
- [x] 根因调查完成：本次第二张卡是独立第二轮真实执行。
- [x] 研究记录、PRD 和设计完成一致性核验，采用保守未知结果处理，清除技术阻塞。
- [x] implement.jsonl、check.jsonl 包含真实上下文并通过 task.py validate。
- [x] 展示最新最终范围、边界、风险和验收；2026-10-14 用户随后明确要求开始实施。

## 顺序与责任

本子任务先于入站去重及文件收发交付，共享 manager/host 不并行修改。主会话维护需求、设计、上下文及提交收尾；批准后由 trellis-implement 实施，由独立 trellis-check 验证。代理提示以 Active task 实际路径开头，优先 native Codex 上下文注入，缺失时按清单自行读取。

## 切片（先 RED 后最小修改）

1. **每轮输入能力与 Codex 封闭状态**：host.ts、codex-llm.ts 的可选当前输入句柄；不修改现有 JSON-RPC 客户端。先验证参数精确、响应白名单、无额外 turn/start、开启前及完成后的 not-submitted、已调用后错误/错 ID 为 unknown、旧回合和 epoch 隔离。
2. **engine 历史栅栏**：conversation-engine.ts 包装本轮输入、登记待确认、结算后再写 assistant。先覆盖响应后于 turn/completed、连续补充记录顺序、记录失败不导致模型重送、停止有界退出。
3. **manager 源消息归属与飞书接线**：bridge-manager.ts 原 ActiveChatTask 与受跟踪的串行补充；控制循环不等待网络，来源只在一种调度路径中。先覆盖忙时补充、启动中补充、关闭后后轮、in-flight 与 finally 竞争、同 sender/不同 sender、开关、命令、附件及其他宿主/渠道。
4. **组合回归**：使用真实 manager、真实 Codex provider 和内存 JSON-RPC/飞书 transport，断言只有一个模型回合、一张原过程卡、一份最终答复；补充文本进入模型和消息历史。覆盖 turn/completed 先于 steer 回执、stop/new/bind/bridge stop 及其他聊天/控制消息继续消费。
5. **说明与独立检查**：仅同步一处追加使用说明与可靠性合同。派发 trellis-check，检查产品验收、类型、构建、相关回归、GitNexus 和真实 diff；必要修复后按证据重跑对应检查。用户联调另行记录，不能把内存模拟冒充生产端到端验证。

## 目标文件与限制

业务目标为 `src/lib/bridge/host.ts`、`conversation-engine.ts`、`bridge-manager.ts` 和 `scripts/claude-to-im-bridge/codex-llm.ts`。现有飞书卡片函数优先直接复用；确实需要改变适配器签名时先回到范围核验，不悄悄增加平台行为。

测试在 `src/__tests__/unit/`：复用 bridge-codex-llm、bridge-conversation-engine、bridge-lifecycle-regression 及 codex-test-transport 的内存能力；组合行为可新增一个 bridge-feishu-live-append.test.ts。不为方便而重构无关测试工厂，不读实际聊天/认证，不连接真实模型、网络或生产飞书。

只扩充当前输入契约和必要生命周期，不升级依赖、不增加持久队列、不做相似文本去重、不改 outbox 或另开补发架构。

## 验证与交付

- 每个既有符号修改前 upstream impact；UNKNOWN/空结果用当前源码及调用点補证，HIGH/CRITICAL 告知用户后实施。
- 每批后台单测外层硬超时 60 秒，单测试 15 秒；fake 注入先断言并硬阻断真实子进程/fetch。
- 新失败断言必须在修改前失败，覆盖实质行为而不是复刻实现细节。
- 每片运行相关最小回归；最终 npm run typecheck、npm run build 与必要完整单测。
- 提交前 gitnexus detect-changes --scope all --repo .，处理 partial/truncated，结合 git diff、未跟踪文件、d1/d2/d3 实际影响核对。
- 不把截图上传或其他任务未跟踪材料混入提交。提交、推送、合并仍依照用户届时授权；此前 quota 的交付授权不自动扩展到本次功能。
- 完成后记录结果并归档本子任务；父任务及其去重、文件子任务继续保留，直到各自通过验收。

## 实施结果（2026-10-14）

S1–S3 已完成；独立 trellis-check 已通过全范围检查并修复正常收尾吞掉限流中结果提示的竞态。修改仍限于 4 个业务模块、3 个测试文件、3 个使用说明与规范文件；详细 RED/GREEN、影响分析和验收证据见 plan.md。

最终全量单测 825/825 通过（17.5 秒，外层进程树硬限 60 秒），typecheck、build、diff 检查通过。GitNexus 完整结构化结果无 error/partial/truncated，实际 diff 与未跟踪组合测试已核对。没有剩余阻塞缺陷；用户于 2026-10-14 随后以“行”确认 workflow Phase 3.4 的两笔本地提交及当前子任务归档。桥接未重启，真实飞书与模型回答质量留待用户联调。
