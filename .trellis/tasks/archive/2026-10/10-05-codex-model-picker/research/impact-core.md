# 核心影响检查

2026-10-05。修改前使用 GitNexus 1.6.12 `impact <symbol/UID> --direction upstream --repo .`；索引基线 a12b8fc，当前任务代码在该基线上实施。图中的跨文件同名误连结合源码复核，不用未知结果作低风险结论。

| 符号 | 风险 | 直接调用方／边界 |
| --- | --- | --- |
| BaseChannelAdapter | HIGH | 四平台子类；manager、delivery、permission、user-input、response-delivery 等 15 项直接引用。本次仅新增可选方法。 |
| startNewSession | CRITICAL | handleCommand、router.resolve；影响调度／命令／会话创建流程。 |
| bindToSession | CRITICAL | handleCommand；绑定与旧代际失效。 |
| processMessage（conversation-engine 精确 UID） | CRITICAL | manager.handleMessage、mock-host.main；模型请求参数与每轮快照。 |
| consumeStream | CRITICAL | processMessage；仅分开 Codex 实际型号与显式偏好。 |
| getState | CRITICAL | manager 生命周期、调度、状态及消息处理；增加聊天准入门与配置协调器。 |
| cancelChat | CRITICAL | handleCommand、stop；新增失效配置草稿。 |
| runAdapterLoop | LOW | start；模型卡走控制消息，不进入模型队列。 |
| handleMessage（manager 精确 UID） | CRITICAL | runAdapterLoop、scheduleMessages；源码显示 JSON-RPC handleLine 是同名图误连。 |
| handleCommand | CRITICAL | handleMessage；new/bind/stop 短事务与模型命令接线。 |
| buildBridgeCommandHelp | CRITICAL | handleCommand；图含 5 个流程组，本次仅帮助文字同步，未变更控制流程。 |
| stop（manager 精确 UID） | UNKNOWN | 图未记录动态调用；源码 scripts/feishu-claude-bridge.ts:522 的 stopBridge 回调调用它，另有生命周期单测。新增清理模型草稿，原 shutdown 顺序不变。 |

HIGH／CRITICAL 已在实施前 commentary 报告并告知主代理；新增模块此前不存在于索引，其直接依赖由本次公共契约和 manager 接线显式确定。

另外查询 createBinding 为 UNKNOWN；最后没有修改该函数。runner store 只移除重复类型并引用正式 ChannelBinding，没有修改存储方法。

重点验证：模型偏好通过 new/bind/JSON 重开继承；卡片用户／聊天／消息／revision／generation／epoch／TTL；flush 故障回滚与新消息准入串行；旧目录或发送结果迟到不登记；默认偏好不被实际流状态覆盖；现有生命周期和 Claude 流行为。
