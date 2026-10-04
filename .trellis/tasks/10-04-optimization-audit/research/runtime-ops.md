# 运行时边界、配置、测试与运维优化

日期：2026-10-04；只读当前业务代码。以下以结构性改进为主，不把尚未观测的性能或运行故障写成已发生问题。

## R1 · P2：让模型升级主要发生在 provider 边界

现有 host.ts 的 DI 接口值得保留。但 `host.ts:24–44` 虽列出事件 type，data 统一为 string；`LLMProvider.streamChat` 返回 SSE 字符串，engine 再 JSON.parse。类型系统无法保证某个事件的 data 与 type 对应，新增厂商事件往往需要同时理解 provider、engine 和 manager。

最小优化：先在内部建立带区分字段的 `RuntimeEvent` 联合类型，明确 text/progress/tool/permission/question/usage/completed/failed 各自 payload、requestId、turnId、messageId 和 usage 口径。厂商输入在 provider 边界运行时校验；桥接内部传类型化事件。公开宿主若仍依赖 SSE，则只在真实边界转换，迁移结束清理无用内部编解码。

每个 turn 的 terminal 事件至多一次，结束之后迟到事件不得更新新 turn。取消、等待输入、工具活动和最后一次真实活动时间统一约定；keep_alive 不是业务进展。与 lifecycle 报告的 TurnContext 一起实施，避免另起一套状态。

验收：同一组 provider contract 测试分别运行 Claude/Codex fake；覆盖消息分段、多次 tool call、授权、问答、异常、取消、重复终态、late event、SDK 重连。测试中的厂商样本来自本地类型或公开官方协议，不能直接复制含敏感内容的真实会话。

范围提醒：本轮观察到 Claude 累计流式文本与最后 assistant 文本的合并逻辑（llm.ts:154、182–184）值得补多消息测试，但未证实真实合法序列下丢正文，因此不作为已确认 P1 缺陷。

## R2 · P2：能力发现与配置要形成用户可见的一致结果

当前 Codex 已通过 model/list 校验模型/effort（codex-llm.ts:218–238），这是正确方向。目录在初始化时加载，运行中的进程没有显式刷新入口；`bridge-manager.ts:1654` 让用户输入精确型号，缺少浏览/选择入口。

建议把 `listModels/refreshModels/capabilities` 暴露为宿主能力；模型选择卡显示真实可用值、默认模型和有效 effort。保留“显式选的模型不可用就报错”的新行为，不默默换型号。Claude 按自己 SDK 能力适配，不能假定与 Codex 有相同目录 API。

统一一份最终解析后的配置，能显示值来自默认、环境配置还是聊天绑定；诊断输出只允许白名单字段。会话切换不能继承不适用的模型、effort、sessionId，由 generation 与 backend 共同校验。新增配置不要同时散落在 runner、settings、manager 多处推断。

聊天 provider 与 review/fix 的 ModelInvoker 可以共享运行时选择、错误/用量结果与测试传输，但 review 的只读策略、fix 的工作树约束、聊天的交互权限仍需分别明确，不能直接以一套宽权限替代。

## R3 · P2：让“进程活着”和“桥接可用”可以区分

证据：`scripts/feishu-claude-bridge.ts:453–469` 心跳包含进程、时长、backend、commit；`:563` 定时写 running，未表达 WS/接收循环/待发任务健康。`:536–558` 在进程级别吞掉带若干网络 error code 的异常，无法区分是否来自预期可恢复的飞书连接。`:546`/`:559` 的 fatal 分支最终进入 `shutdown`，而 `:522` 固定 exit(0)。

这是故障定位与监督重启的结构缺口，不证明当前连接已经假在线。按失败退出码重启的监督器可能把 fatal 当作正常退出；是否实际发生依赖部署策略。

最小优化：

1. `/doctor` 或本地 `--check` 默认只读：显示有效 backend/model、运行时可执行版本、工作目录、配置完整性、连接状态、队列/活跃任务、待投递数、最近错误类别。默认不发送模型请求/真实飞书探测。
2. 由组件上报健康与 lastActivity；日志贯穿 chat/session/turn/delivery ID，默认不记完整提示词、工具入参或附件内容。
3. 已知可恢复的连接错误由对应组件处理并标记 recovering；未知 fatal 记录故障、进行有界清理、以非零退出。正常停止仍正常退出。
4. shutdown 顺序依赖 lifecycle 的 draining 与 Store.flush，不能只靠 process.exit 清理。

验收：fake WS 失联仍有进程心跳时，健康显示 degraded；fatal 退出码非零；正常 stop 为零；诊断不启动模型、不包含密钥或聊天正文。runner 的副作用入口应与可测试的配置/健康函数分离，不能通过直接 import main 来做测试。

## R4 · P2：测试优先补时序和故障矩阵

上一轮已通过 493 项单元测试、typecheck/build，说明现有功能有可用基线。本次仍找到故障边界，重点不是再追求测试数量。

| 测试维度 | 优先新增的交叉场景 |
| --- | --- |
| 生命周期 | stop/new/bind × collecting/queued/running/waiting-input；旧结果晚到、新回合已开始 |
| 投递 | CardKit 业务失败、最终发送失败、部分分块成功、审批提示发送失败、超限降级 |
| 持久化 | 截断/写失败/替换失败/未 flush 退出/失联 run 恢复 |
| 自动修复 | 非 HEAD 基线、失败组残留、无关 diff、部分成功、重复 attempt |
| 运行时 | 只用 fake transport/query；权限/问答双向通信、目录变化、终态唯一性 |

本仓库未找到 `.github/workflows` 等常见 CI 文件。建议把已有 `npm run typecheck`、`npm run build` 与隔离单测接入版本控制的自动检查，并在 Windows + 受支持的 Linux/Node 组合上跑必要矩阵。未查看托管平台设置，不能据此断言用户完全没有外部 CI。

升级流程固定为：锁版本 → 核厂商类型/协议 → 同一套契约测试 → 构建产物校验 → 发布说明 → 受控真实联调。真实模型/租户联调单独明确执行，普通测试默认阻断网络和真实客户端启动。不要做自动全局升级与自动重启生产的隐式步骤。

## 性能优化应有数据门槛

源码足以指出全量同步 JSON 写、无限历史、重复工作流调用等候选，但本轮没有真实负载数据。优先使用合成消息和 fake clock，记录事件循环延迟、存储写耗时、排队时间、首字延迟、卡片更新次数、失败重试数。先根据测量选择归档、批写、上下文拆批或本地事务存储；没有理由直接引入 Redis、分布式队列或微服务。

## 本轮边界

这里只提出可实施的设计切口，未改配置、业务代码、全局依赖或生产服务。GitNexus FTS 缺失且图落后于未提交升级，所有关键结论都以当前源码和研究复现为依据。实施前需逐符号 impact，不能把本报告当作跨模块改造的影响分析替代品。
