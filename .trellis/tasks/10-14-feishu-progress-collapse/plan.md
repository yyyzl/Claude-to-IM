# 飞书实时进度与历史折叠：执行计划

## 当前增量 S8：成功结束移除执行过程

- [x] 用户明确新决定；精确finalizeCard upstream impact LOW，d1 onStreamEnd，已向用户报告。
- [x] 新合同RED2/2→相关84/84 GREEN，最小调整已有辅助删除：成功一律移除过程，错误/中断仅空过程移除；保留正文ACK与generation/串行/预算恢复。
- [x] 相关84/84、独立158/158、typecheck及主会话build通过；规范和恢复状态同步。不自动提交或重启，S8真实客户端效果待加载复验。

## 已交付 S7：完成卡信息层级

- [x] 根据用户截图确认真实占位来源、运行与终态内容矩阵，记录design-S7.md；新鲜upstream impact并提前告知CRITICAL。
- [x] 先观察终态去重/历史收纳/无过程入口/必要异常与分段提示的RED，再收敛为3叶子并保留S6b恢复和预算。
- [x] 用真实Adapter回归包含辅助删除失败不撤销全文确认，保留有内容父面板、追加后轮隔离和单在途；相关82/82、typecheck通过。
- [x] 独立trellis-check本任务全范围复查PASS，相关156/156、typecheck通过；主会话build通过，真实JSON本地预览已查看桌面/窄屏/展开状态。
- [x] 沉淀终态信息层级及结构性占位原则到规范；更新任务和恢复状态。build通过，索引刷新成功，完整detect30变化/41受影响且partial/truncated均false，实际diff与冻结SHA核对；不自动提交推送/重启/真实API。

## 输入与文件责任

- 需求：prd.md；设计：design.md（info.md 指向同一设计）。
- 规范：implement.jsonl 中 backend/module-boundaries、type-safety、reliability-contracts、testing、quality、integration。
- 业务：src/lib/bridge/adapters/feishu-adapter.ts；src/lib/bridge/markdown/feishu.ts；必要时新增 src/lib/bridge/markdown/feishu-progress.ts 承担纯展示预算。
- 测试：src/__tests__/unit/bridge-feishu-streaming.test.ts、bridge-feishu-final-card.test.ts；允许新增 bridge-feishu-progress.test.ts。因收尾从整卡改局部更新而受影响的 bridge-feishu-card-notify.test.ts、bridge-feishu-reliability.test.ts、bridge-feishu-live-append.test.ts 仅同步真实合同断言，不弱化覆盖。追加测试的最终投递挂起点迁移到终态batch，保留原收尾边界验证。
- 主会话负责任务文档、规范与最终整合；implement/check 子代理负责上述业务和必要测试，互不回退他人改动。

## S1 固定折叠面板、有限实时进度与预算

- [x] 先加测试：初始面板关闭、子元素稳定；最近3条按实际状态变化排序；原地修改快照仍能识别；重复快照不新增；运行/失败外显；中文/emoji/引号/反斜线的巨大历史下实时状态仍发出，卡片/请求在预算内。
- [x] 运行并记录预期 RED：node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-feishu-streaming.test.ts src/__tests__/unit/bridge-feishu-progress.test.ts（新增文件存在后），外层60秒进程树硬截止。
- [x] 最小实现：不可变本地快照、纯展示预算与固定组件；只更新子 Markdown，历史省略有提示；不增加日志收集、模型事件或宿主接口。
- [x] 重跑上述测试至 GREEN，保存失败原因及通过统计。

## S2 动态耗时与生命周期

- [x] 先加虚拟定时/可控时间测试：等待真实经过时间持续变化但完成数不变；使用原串行调度/退避；finalize/cleanup/stop/换代后无新请求，旧卡异步完成不影响新卡。
- [x] 跑 streaming/progress/lifecycle 最小集确认 RED，再实现5秒 unref 定时器及清理，重跑至 GREEN。
- [x] 不使用一次性 processingNoticeTimers，不新增旁路平台调用。

## S3 局部收尾与投递回归

- [x] 先加/迁移测试：收尾等待旧写入、局部更新正文/页脚/状态后关闭流式，任何请求不替换父面板或设置 expanded；保留历史；ctx/空回答/错误/取消行为合理；大正文返回 false 仍关闭流式，最终正文完整。
- [x] 运行 streaming/final-card/card-notify/delivery-reliability 确认 RED，再替换旧整卡收尾，移除死渲染入口，重跑至 GREEN。
- [x] 回归 node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-feishu-*.test.ts src/__tests__/unit/bridge-lifecycle-regression.test.ts src/__tests__/unit/bridge-delivery-reliability.test.ts（外层60秒）。

## S4 真实验收反馈：普通动态卡保留阅读状态

- [x] 用户已明确选择保留展开，接受取消逐字动画；先补失败测试：初建streaming_mode:false、中性固定summary；运行及结束/错误/取消/超限均只partial_update_element，禁止content/settings/配置更新；正文仍A→AB持续局部刷新。
- [x] 运行progress/streaming/final-card/card-notify/live-append相关集，确认因旧流式/关闭配置路径预期RED（外层60秒）。
- [x] 最小替换：固定非流式卡，全部内容同批更新按缩减先行；终态无配置操作，完整正文确认语义保留；移除双请求和冗余sentText。
- [x] 同步旧fixture到真正局部正文写入和终态batch，保留挂起在途、串行、频控与追加后轮边界断言；相关回归/typecheck至GREEN。
- [x] 实现冻结，独立增量复查及真实示例卡局部收尾证据与生产路径核对。

## S5 独立检查与交付

- [x] 固定业务改动后交独立 trellis-check；仅修复本任务局部问题，额外设计变化先向主会话说明。
- [x] npm run test:unit（外层60秒）、npm run typecheck、npm run build；无 lint 脚本，不伪称运行 lint。
- [x] 更新耐久规范、执行记录与恢复检查点；刷新 GitNexus 后 detect-changes 并核对实际 diff/未跟踪文件，排除用户截图。
- [x] 报告真实客户端展开状态验收的实际状态；未执行不能标通过。本批不自动提交推送、不重启当前服务。

## 风险与起点

共享渲染路径 CRITICAL 已提前告知；固定父组件能降低重置风险但官方未保证客户端状态，需要真实 UI 验证。先从 S1 的失败测试开始，无依赖阻塞。

## S6 用户验收反馈：完成态不得残留最近进展

- [x] 读取research/terminal-progress.md与terminal-platform.md。正常completed已有清理，但部分batch应用后返回错误会使缓存落后，终态差异可漏发清空；空格被平台忽略并未证实，不能按此猜修。
- [x] 在bridge-feishu-progress.test.ts新增真实行为RED：运行batch先写入3条tool_progress再返回非零；终态成功后正文完整、外部进展为空、历史仍在且未更新panel/config。另覆成功完成前含工具error（已恢复）也只在历史，错误/中断仍外显失败。
- [x] 运行定向测试观察预期失败，随后最小修正终态清理/不确定平台状态，避免对旧sentView做相等推断漏更新；清理优先、校验逐action预算，勿并行网络或替换父panel。必要不确定状态恢复不得破坏正常路径的历史阅读。
- [x] S6独立复查补充RED：真实Adapter正文14,500→14,700字节、累计1→9工具，运行batch前缀部分应用后200860；completed正文25,200字节，目标历史恰与旧缓存相同。必须明确缩减平台上的旧历史，逐action实体与实际请求均不超预算，不能仅校验最终view。方案先做新鲜impact并向主会话确认，避免按不可靠缓存强制全字段排序。
- [x] 采用design补充的失败路径两批有界恢复：运行更新异常/非零标记不确定；先明确清空6个非正文叶子，近期进展优先，保留正文；成功且generation仍有效后，以空白基线正文首条写目标、恢复历史/状态。正常路径不增请求。测试非零/频控、后续普通diff成功仍不撤销不确定、终态正文较短/较长、两批间取消或换代、恢复失败false及全文超限回退；逐请求/逐action预算和panel/config固定。
- [x] 加入非零/部分失败、频控与部分写入的边界验证；相关集、typecheck通过后业务冻结，交独立增量检查。主会话负责最终全量/build和刷新图/detect/实际diff。所有测试外层60秒，Node单测15秒。
- [x] 如实区分源码内存复现与用户现场原因；当前浏览器debugger不可用、只读API230027，不宣称真实界面已复验。
