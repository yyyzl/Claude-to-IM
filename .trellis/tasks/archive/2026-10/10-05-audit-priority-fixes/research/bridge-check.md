# 桥接独立审查

## 结论

按 PRD 的 AC1、AC2、AC4、AC5 审查生产调用链及测试，未发现需要修复的桥接问题。本次审查未改业务代码或重复增加测试；工作流部分由独立审查阶段覆盖。

## 核查证据

- `runAdapterLoop → handleMessage → handleCommand(/retry)` 只等待准入门的同步登记；`startResponseRetry` 将实际投递和结果回执纳入 `taskPromises`，不在准入锁内等待网络或 flush。77 项相关测试中，真实 manager 消费循环配合挂起 fake send，验证另一个聊天 stop、权限处理仍可完成。
- 补发自己的 `TurnContext` 加入 `retryTasks`，不使用模型 `activeTasks` 或 `uiOwners`。`cancelChat` 递增聊天 generation 并 abort 匹配聊天补发，`stop` 更新 epoch 并 abort 全部补发。finally 按 context / promise 身份删除自身，没有按 chatId 清除新任务的分支。
- `retryResponseDelivery → attempt → deliverSingle` 保留已有来源过滤和记录级互斥。每次后续发送/重试检查有效性；平台已确认成功后先写 sent 和进度，再检查取消，避免取消丢掉确认记录。旧任务结果通知再次验证归属。平台超时后的结果仍属未知，代码未承诺 exactly-once。
- 同聊天新的普通模型回合使用独立 UI owner；补发没有模型收尾、卡片关闭或会话运行状态写入。普通新回合与补发并行是当前设计允许的行为；stop/new/bind 统一取消两类任务。
- 三条 router 绑定入口均经过 JSON store 的 upsert/update；旧、新 binding 历史和当前 binding 同快照保存。`load` 缺历史字段时仅补已有当前绑定，不扫描其余 sessions。列表按 channel/chat 查询并返回副本，不以其他聊天的绑定作回退。
- `/sessions [页码]` 每页 5 条，提供完整可用 `/bind` ID、当前标记、分页指引和转义后的文本；无历史能力宿主明确仅列当前会话。非法页码、坏持久字段、旧 JSON、跨聊天/渠道、重载、去重与副本均有相关测试。
- 飞书现有按钮协议为审批/工作流专用，未新增会话按钮协议；完整可复制命令符合本次 AC4 和研究结论。未改平台模板或上游协议。

## 影响与规范

没有修改既有函数，无新增影响分析需求。已核对 `research/bridge.md` 与 `research/bridge-implementation.md` 的影响记录：manager/投递/保存等 CRITICAL 已向用户通报，动态宿主 UNKNOWN 已用 router、manager 和 model-selection 调用链补证。

主会话已同步 `reliability-contracts.md` 的补发归属与历史宿主合同；实现、帮助、规范一致。

## 验证

- Lint：项目没有独立 lint script；相关 tracked diff 和新增测试的 whitespace 检查均无错误。新增文件使用 `git diff --no-index --check -- NUL ...`，其退出码 1 表示有新增差异，输出仅包含换行符提示。
- Tests：相关 6 文件 **77/77 通过**，Node 报告约 3.49 秒；外层 `subprocess.run(timeout=60)`，内部 `--test-timeout=15000`。文件为 priority-fixes、lifecycle-regression、delivery-reliability、json-store、help、channel-router。
- TypeCheck：运行 `npm run typecheck`，桥接没有诊断；整仓失败于并行工作流新测试的两处类型错误（`workflow-patch-recovery.test.ts:34` 缺 termination_state，`:81` spread tuple）。主会话已交工作流实施者修复，桥接审查不越权改其文件。最终整仓类型/构建/全测由主会话整合复验。
- 所有测试均为 fake transport/model 与独立临时 JSON；未调用真实飞书、模型、生产数据或启动服务。

## 未修问题

桥接范围没有确认的未修问题。上述两处整仓 TypeCheck 失败属于并行工作流测试，记录交接而未修改。旧孤立会话缺归属证据、平台结果未知窗口为已说明的范围限制，不作为本次实现缺陷。
