# 实施证据

本代理负责飞书适配器、渲染器及计划列明的受影响测试；主会话负责设计、任务清单与规范。未提交、推送、重启或调用真实接口。

## TDD

所有命令经 `.fusion/run-implement-check.py` 执行：外层 `Popen.communicate(timeout=60)`，超时时 `taskkill /T /F` 终止进程树；Node 单测 `--test-timeout=15000`。完整输出与 JSON 收据保存在同目录。

| 片 | RED | GREEN |
| --- | --- | --- |
| S1 固定折叠/最近真实变化/预算 | 19条，14通过、5失败：无面板、全历史外显、超限停更、建卡期丢工具。 | 19/19，3.563秒。 |
| S2 耗时/生命周期 | 46条，43通过、3失败：缺耗时及5秒刷新、频控恢复无耗时。已有在途/清理隔离测试先行通过。 | 46/46，3.625秒。 |
| S3 局部收尾/投递 | 52条，48通过、4失败：旧整卡收尾无法满足固定树、完整正文、局部失败确认。页脚迁移6条1通过5失败；旧协议迁移17条12通过5失败。 | 52/52，4.391秒。 |
| 相关整合 | 全飞书、追加/问答、生命周期、投递。 | 136/136，5.063秒。 |

`npm run typecheck` 通过，6.578秒。未重复运行全量和 build，业务冻结后交主会话与独立检查执行。

首次 S1 RED 的控制台 GBK 输出失败，但测试进程已退出并保存原始日志与 exitCode=1；wrapper 增加 stdout UTF-8 后正常显示，原始19条统计已逐项核对。没有将 wrapper 输出异常当作预期测试失败。

## 行为与范围

- 新增纯展示 `markdown/feishu-progress.ts`：固定7个 Markdown 与一个原生折叠父面板；仅初建写 expanded=false。动态请求只更新 Markdown content。
- 本地工具快照立即复制字段；最近3条按真实名称/状态变化排序，运行/失败数量外显，长命令仅展示有说明的摘要。最新模型进度不计为工具完成数量。
- 建卡期间 `onToolEvent` 通过既有 create promise、原 generation 和立即快照复制重放；可达性由 manager 每个工具事件调用、onMessageStart 异步建卡证实。没有共享缓存或核心接口变更。
- 历史先让出实际 UTF-8 序列化预算，包含 JSON 字符串再次转义。正文增长先更新详情、正文缩小先写正文；详情 action 按缩减优先排序。fake 平台逐 action / content / settings 核验完整实体与实际请求，不假设批量操作具备事务原子性。
- 5秒 unref 耗时复用原节流、退避与实际在途操作。finalize 在等待 operation 前清理；cleanup、换代、stop 同样清理。
- 收尾局部更新原正文、页脚和历史后关闭 streaming_mode。完成步骤留在历史，错误保留外显；移除不用的 buildFinalCardJson/buildToolProgressMarkdown，不为旧测试留死入口。
- 完整最终正文超限返回 false；仅将原卡预览标终态并提示下方分段，完整回答继续由原 response-delivery/outbox/retry 处理。完整正文 batch 已确认时，辅助 settings 失败不返回 false，避免重复回答。
- bridge-feishu-live-append 额外两处协议 fixture/断言经主会话批准迁移为最终 batch，保持“模型已完、投递收尾仍挂起时补充走后轮”覆盖。

补充 `_doCreateStreamingCard` upstream HIGH（直接 createStreamingCard）已由主会话告知用户后修改；cleanupCard LOW（onMessageStart/onMessageEnd）取证在 `.fusion/impact-implement.json`。其余既有函数影响来自 research/impact-before.json 与动态边界补证。

## 待验收

未进行真实客户端“展开→正文/历史更新→结束”视觉验收。单测只证明服务端不替换面板或重发展开状态，不能证明飞书客户端实际保留展开/滚动位置。全量、build、独立检查和最新 GitNexus diff 由主会话负责。

## S4：真实验收反馈后的最终收敛

主会话在原会话实测发现：子元素局部更新能保留展开，但settings或batch配置切换会收起面板。用户明确选择“保留展开状态，使用动态局部刷新（推荐）”，接受取消逐字动画。最终实现以本节为准，替代S1–S3的打字机正文与配置关闭路径。

修改前精确upstream再次执行，2个业务文件SHA与10:51:12索引一致：buildProgressCardJson、fits、progressActions、flushCardUpdate为CRITICAL；_doCreateStreamingCard为HIGH；finalizeCard为LOW。全部partial/truncated=false。主会话明确向用户告知新增风险后才修改业务。

- 初始streaming_mode:false；删除streaming_config，固定中性摘要“任务回复”。
- 正文、状态、历史、提示统一为一次partial_update_element batch，按实际序列化体积缩减先于增长；不依赖事务原子性。
- 删除冗余sentText及旧content双阶段路径；移除progressActions的includeBody分支。
- 终态只更新内容并清理本地卡片，不调用settings、不改配置。最终正文超限仍false，预览明确提示完整分段；正文确认由真实batch回执决定。
- 删除已无必要的动态summary预留，仍核对完整实体、实际请求、ID与sequence保守封装，保持30,000字节上限；逐步实体预算测试继续通过。
- 保留5秒真实耗时、串行/频控/退避、原回合归属、完整投递及独立问答。

S4正式RED `s4-red-clean`：62条47通过、15预期失败、0cancelled，4.141秒；失败原因均为旧streaming=true、旧正文content入口、终态settings和配置重置。第一次`s4-red`同时有未释放fixture导致15秒截止，保留作诊断，不当作功能RED证据；已给deferred测试增加finally释放与卡片清理，再重新观察完整RED。

S4 GREEN：62/62，4.438秒。完整相关集136/136，4.968秒。typecheck通过，6.813秒；全部外层60秒硬截止。未执行全量/build、真实API或重启，交主会话独立增量检查与最终验证。

S4额外修改范围：2业务（feishu-adapter.ts、feishu-progress.ts）、3测试（progress、streaming、card-notify）；final-card/live-append没有再改，reliability无须迁移。新的冻结证据见`.fusion/implement-freeze-s4.json`。

主会话已完成旧方案及普通动态卡的真实对照，详见research/live-collapse.md；当前实现与对照操作的最终一致性由主会话核对，不能推广为所有客户端或滚动位置保证。
