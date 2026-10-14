# S7：终态卡片的信息层级与结构收敛

2026-10-14。按主会话确认的 `design-S7.md` 直接实现，仅修改飞书展示层及原任务5个测试，不改模型、manager、问答、存储或生产进程。

## 影响与RED

修改前已由主会话完成新鲜影响分析并告知用户：`buildProgressCardJson`、`fitProgressView`、`progressActions`、`fits` 和 `flushCardUpdate` 的关键调用流为 CRITICAL；`_doCreateStreamingCard` 为 HIGH；`finalizeCard`、`updateCardContent` 为 LOW。证据见 `research/terminal-design-impact.md` 与 `.fusion/terminal-design-impact*.json`。新 `updateCardContent` 修改只拆分长正文预览与追加提示，保留原 `onStreamText` 和延迟建卡generation校验。

- `.fusion/s7-red-layout.*`：完成态信息层级5条全部预期失败，0取消，0.282秒。
- `.fusion/s7-red-empty.*`：真实Adapter的无历史入口、辅助删除失败、上下文/追加归档、长预览提示独立4条全部预期失败，0取消，1秒。
- 未调用真实网络、模型或重启；内存平台在逐action应用后检查实体预算。

## 实现

- `ProgressView` 从7个叶子收敛为正文、唯一状态、历史内容3个；初建body间距8px，Markdown零margin。移除旧 `tool_progress/history_summary/append_notice/task_footer` 死槽，原生入口标题为“执行过程”。
- 运行状态合并真实耗时、近期3条、必要运行/错误和刚接收的追加；成功态只剩“已完成 · 耗时”。统计、已恢复错误、ctx和追加移进原历史，错误/中断仍外显必要失败。
- 原 `footer` 的状态重复输入移除，耗时和ctx独立传入。最终完整回答不变；只有超限回退才外显完整分段说明。
- 当前正文预览的 `textOverflow` 独立于 `appendNotice`，追加不会覆盖长正文提示；正文变短立即撤提示，最终全文可容纳时不误报分段。
- 不确定运行写入后的恢复仍串行两批：动态取实际非正文叶子（当前状态、历史），先清空并保留正文，ACK及原generation有效后正文首条恢复目标。正常可靠缓存按缩减先行，不再保留已移除ID的强制清理。
- 真正无可读历史时，在正文/状态确认后单独辅助 `delete_elements` 删除空历史入口；动作不参与全文确认事务。辅助请求测实际序列化预算，失败保留全文ACK，换代后不继续旧删除。
- 有工具、ctx或追加时原父面板不删除、替换或重发expanded；运行/终态不写config、不使用打字机接口。

## 保留并重建的可达预算反例

统计移到历史后，旧“初始1工具→最终9工具”历史字符串不再可能相等，未删除该验证。以实际Adapter重新构造：初始正文19,500字节、9个累计工具、900字进度和追加信息，使缓存历史压缩为1条；运行正文增长至19,600字节，最新进度变短，平台历史实际增长；严格按请求顺序应用前缀后返回非零/频控或异常，缓存仍停在此前已确认视图。最终完整正文25,200字节，目标历史恰等于旧缓存。

三种失败结果均保留严格相等断言；真实平台历史增长已被断言，收尾必须校准而不能用旧缓存相等推断无需修改。逐请求/逐action实体预算、较短终态历史恢复、恢复失败false、两批之间取消/换代、后续普通diff成功不撤销不确定性均保留。原3条进展测试继续覆盖实际部分前缀已写入但后续叶子未完整确认的情况。

## GREEN与交接

- 首次相关81条中77通过，4个旧结构断言失败；迁移历史统计及空面板辅助批的精确协议/序号后全部通过。
- `.fusion/s7-green-final.*`：指定5个飞书测试 **82/82**，0失败、0取消，6.407秒。含无历史辅助删除失败不重复正文、正文确认晚到换代不发旧删除。
- `.fusion/s7-typecheck-final.*`：`npm run typecheck` 通过，6.516秒。
- 所有单测Node15秒、外层60秒进程树硬截止。无lint脚本，未声称运行lint。
- 业务冻结SHA见 `.fusion/s7-freeze.json`。主会话接力独立检查、扩展相关回归、最终build和GitNexus/diff复核，不重复执行。

本片段未提交、推送、归档、重启服务或调用真实飞书接口。主会话已有实际JSON的本地排版预览；这不等于真实飞书现场渲染验收。
