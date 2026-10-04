# 修复验收矩阵

本文件是整合复核清单，不能用“测试命令退出 0”替代以下断言。研究任务的旧复现断言不作为本轮正确性测试。

| 路径 | 必要断言 | owner |
| --- | --- | --- |
| 模型透传与控制命令 | 回合未结束时 stop/审批/问答已被消费；另一 chat 可运行；同 session 仍串行 | lifecycle |
| 取消合并/队列/追加 | stop/new/bind 后旧消息不启动；取消数量/状态真实；不会随后回复旧SDK ID | lifecycle |
| 旧回调 | late status/result/finally 不写新binding、不结束新卡、不把新任务置idle | lifecycle |
| 核心停止 | 禁止新准入、所有运行信号取消、等待有界；stop后不 flush append | lifecycle |
| 流中断 | reader不响应abort、交互发送pending仍能本地收尾；旧事件被隔离 | lifecycle |
| JSON损坏 | 不能当首次运行并覆盖；有效备份可恢复；写/rename失败旧文件仍在 | storage |
| 停机与异常 | 待保存数据在close落盘；fatal非零；正常停止为零；不运行真实runner | storage |
| 待发回答 | 保存/flush成功才send；失败可定位ID；重试不调模型；只补未送块 | delivery+storage+lifecycle |
| 投递隔离 | 当前chat/user才可重试；已有模型任务/同记录重试互斥；旧代际不自动补发 | delivery+lifecycle |
| 投递回归 | TelegramHTML、Discord围栏、QQ分段限制、audit/outbound refs不丢 | delivery |
| 重试分类 | 失败不记成功去重；HTML转plain后以plain429/网络错误退避 | delivery |
| 审批 | 发送/登记/超时失败解开模型；真实resolution驱动卡片状态；重复点击不重复批准 | delivery |
| 飞书体积 | 序列化UTF8预算；中文/emoji/长代码无截断；card/post不重复发送同一超限块 | delivery |
| 附件 | 部分失败明确说明缺什么；全部失败不进入模型；不支持类型不假装接受 | delivery |
| 工作流恢复 | 活跃owner拒绝接管；可证实失联才恢复；并发resume仅一执行者 | storage/workflow |
| 快照 | 非HEAD diff/blob来自同一基线；修复使用该基线或明确拒绝 | storage/workflow |
| 修复产物 | 不force删除旧attempt；失败组不进入下一组提交；无关diff不标fixed | storage/workflow |
| 修复展示 | 候选与已验证分开；base/head来自真实提交；CLI/IM应用提示对应已提交patch | storage/workflow |

## 验证顺序

1. 各owner的最小正式单测；外部客户端、网络及进程明确fake。
2. 合同接线完成后全量typecheck/build/unit；每个测试进程总时长控制在60秒内。
3. 交叉检查：检查代理审生命周期/存储；另一个实施者审投递，避免只复核自己的代码。
4. 修复具体检查发现后仅重跑受影响项，最后必要的整合质量门。
5. GitNexus detect_changes + 当前源码/git状态确认范围；新文件与旧索引遗漏手工补核。

## 发布边界

用户自行提交后才执行task finish/archive。当前修复不自动重启桥接、不操作生产数据、不执行真实模型或租户联调。最终报告必须列明完成项、验证结果和未验证的真实服务边界。
