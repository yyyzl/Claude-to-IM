# S6 完成态进度残留修复

## 依据与范围

完整读取 `research/terminal-progress.md`、`research/terminal-platform.md` 和更新PRD/计划。研究证明：运行batch按顺序部分应用后返回错误，可以使平台已有三条进度、本地sentView仍空；终态差异因相等而漏发清空。该证据是硬阻断网络/模型的内存复现，不证明用户现场曾发生200860或部分写入。单空格被平台忽略也未获证实，本批不更换空白字符或删除节点试错。

主会话在业务修改前告知CRITICAL展示/差异路径风险；沿用当前索引与源匹配的精确impact：fitProgressView的d1为_doCreateStreamingCard/finalizeCard/flushCardUpdate，finalizeCard的d1为onStreamEnd。实际只修改这两个函数。未修改progressActions/flushCardUpdate、manager/provider/投递契约。

## TDD证据

测试使用现有内存卡片树，新增故障控制：严格应用实际SDK请求的顺序前缀，到tool_progress后返回200860或99991400；每个已应用action继续测实体体积，完整实际请求也测JSON再次转义的体积。

| 验证 | 结果 | 外层耗时 |
| --- | --- | --- |
| `s6-red`：progress定向 | 17条，13通过、4预期失败，0取消。失败均为真实旧内容残留或completed仍显示早期失败。 | 5.312秒 |
| `s6-green`：同一定向集 | 17/17 | 5.360秒 |
| `s6-affected-green`：所有飞书、生命周期、投递 | 140/140 | 6.094秒 |
| `s6-typecheck`：npm run typecheck | 通过 | 6.797秒 |

完整原始输出与命令/exitCode/超时收据位于 `.fusion/s6-*.log/json`。每批外层`Popen.communicate(timeout=60)`，超时则`taskkill /T /F`终止进程树；Node单测15秒。本批无超时或fixture悬挂。

## 最终改动

- `markdown/feishu-progress.ts`：completed不再选择外部工具明细，历史里保留真实失败；error/interrupted仍显示必要失败摘要。
- `adapters/feishu-adapter.ts`：completed终态首条明确更新tool_progress为目标空白，过滤原差异内同元素动作。即使旧sentView为空也不省略清空。动作只一次，先让出空间；未强制全部7字段或重建卡片树。
- `bridge-feishu-progress.test.ts`：新增部分应用后非零/频控、completed早期失败归档、超限终态预览清空回归；加强正常三条归档和错误/中断提示边界。

首条清空与其余动作去重后的请求不超过现有fits按全部7叶子预估的上界；测试继续核验逐action实体及实际请求<=30,000字节。正文完整确认、超限返回false和完整分段保持；panel/config不写、不改变展开状态，历史计数按真实结果保留。

## 冻结与未完成验收

业务冻结SHA见 `.fusion/s6-freeze.json`。未提交、推送、重启、调用真实API或修改全局依赖。最终全量/build、独立增量检查、最新索引与diff由主会话执行。

本批解决已复现的外部摘要漏清空与成功终态历史失败外显；不泛化全卡部分失败恢复，也不声称永久挂起/终态平台拒绝时已经清屏。原平台收尾成功回执、真实客户端单空格呈现及用户具体可见位置仍需主会话验收；不能把内存平台通过当作现场根因或界面复验通过。

## S6b 独立复查：不确定历史的中间预算修正

独立check以实际Adapter进一步复现：正文14,500→14,700、累计1→9工具（逐事件加入、状态原地变更），运行batch前缀至tool_progress已部分写入再返回200860。平台历史比旧sentView更大；最终正文25,200字节、目标历史恰与旧缓存同文，旧差异会漏掉历史缩减。请求本身合法但写正文时实体30,797字节，finalize=false。原counter证据在`.fusion/check-s6-adapter-budget.ts/json`；只清外部进度并不足以解决这一边界。

修改前再次核对12:46:42索引，两业务源SHA匹配。精确upstream：_doCreateStreamingCard HIGH（d1=createStreamingCard）；flushCardUpdate CRITICAL（d1=scheduleCardUpdate）；finalizeCard LOW（d1=onStreamEnd），partial/truncated均false。主会话向用户告知风险和恢复时历史短暂空白取舍，补充设计/计划并给出实施信号后才修改。

最终S6b方案仅作用于未完整确认的运行更新：

1. 状态初始化viewUncertain=false；运行batch异常/非零后置true。后续普通差异ACK不证明所有旧残留同步，故不取消该标记。
2. 终态若不确定，先串行一批明确清空6个非正文Markdown，tool_progress优先、元素去重；正文保留、panel/config不动。每步只缩减或保持体积。
3. 第一批成功后再次检查原卡与generation。第二批首先明确写目标正文，再从已确认的空白基线恢复其余非空目标，逐步增长至已预算的完整实体；每个请求分别在30KB内，不依赖事务原子性或旧缓存排序。
4. 任一批失败均不确认全文；两批间取消/换代则不继续旧目标请求。超限目标只恢复已确认的预览并false交回完整投递；error/interrupted恢复必要提示。正常成功路径仍是原单批收尾。

仅额外修改adapter.ts的状态初始化、运行失败标记、终态恢复，以及progress测试；本轮不再修改feishu-progress.ts。复用内存逐action预算平台与真实Adapter接口，所有网络/模型/子进程入口硬阻断。

| S6b验证 | 结果 | 外层耗时 |
| --- | --- | --- |
| s6b-red | 29条17通过、12预期失败、0取消；三种失败运行均实际复现30,796/30,797字节终态超限，其余为缺失校准/换代协议。 | 5.859秒 |
| s6b-green | 29/29 | 5.484秒 |
| s6b-affected-green | 152/152 | 6.375秒 |
| s6b-typecheck | 通过 | 6.687秒 |

覆盖非零/频控/异常、后续普通diff成功、长短终态正文、保留旧正文清理详情、两批之一部分失败、两批间取消/换代、错误/中断提示、超限预览回退。原正常进展/追加/问答/投递/生命周期回归保持通过。所有测试外层60秒硬截止，Node15秒，无超时或fixture悬挂。

最终S6b冻结SHA见`.fusion/s6b-freeze.json`。未提交推送、重启、真实API或全局修改；独立复查、原counter重跑、最终全量/build与索引diff由主会话负责。恢复路径仍可能使已展开历史子文本在两批间短暂空白，不切换展开状态，后续恢复预算内内容；真实当前现场原因及界面仍未由本代理取证。
