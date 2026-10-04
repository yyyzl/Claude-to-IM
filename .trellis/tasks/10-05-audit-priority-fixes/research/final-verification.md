# 三项修复最终验证

基线：`9a0bcb5`；实现分支 `codex/audit-priority-fixes`，用户要求正常推送到 `origin/main`。

## 验收

- R1：补发从控制消费循环移出，受 taskPromises 与 chat generation/epoch 跟踪；stop/new/bind/shutdown取消后续块，已确认sent保留，不调用模型。
- R3：当前channel/chat历史持久化；完整 `/bind` ID、分页、当前标记、转义、旧JSON及无历史能力宿主覆盖；没有依据的旧孤立session不猜归属。
- R2：稳定基线、完整application、固定目标版本和ledger重放；失败不升级成功；首次/恢复提交冲突、损坏记录及暂停边界均经过真实临时Store与fake模型故障验证。
- 独立检查：桥接未发现剩余缺陷；工作流检查额外修复暂停提交和首次提交冲突保护，补充14项回归。

## 执行结果

- `npm run typecheck`：通过（包括scripts）；初次检查发现2处新测试类型错误，已按真实字段和明确参数修复，独立复核通过。
- `npm run build`：最终版本通过。
- 完整单测使用与 `test:unit` 相同的三个文件glob，Node `--test --import tsx --test-timeout=15000`，Python外层timeout=60秒：**701/701通过，140 suites，0失败/跳过，约12秒**。
- 桥接定向：77/77；工作流定向：122/122。相对原基线648，新增53项回归。
- `git diff --check`：通过；工作区line-ending提示不是空白错误，未批量改换行符。
- GitNexus：以1.6.12、`--index-only`刷新当前实现（原embeddings=0）。staged检测为26文件、93符号、49相关流程、CRITICAL；完整结构化结果见 `final-detect-changes.json`，无partial/truncated，符号涉及文件均符合三项修复范围。CLI展示层固定只展示15个符号，所以额外调用同一LocalBackend取得完整结果；最初Python打印受Windows GBK影响，不是检测失败。
- 索引构建明确提示全仓流程抽样有上限、部分跨语言字段不连边，不能把不存在的图边当作不存在的调用；本次结合逐符号影响研究、源码调用方与故障测试补证，未把图查询当作全覆盖证明。

## 边界

没有发送真实模型/飞书请求，没有读取真实会话或凭据，没有重启服务。平台发送结果未知时仍不能保证exactly-once；无可验证旧补丁基线时保守暂停；事件日志允许恢复时重复。代码在桥接加载新构建后生效。

侧聊随后新增“生成图片自动回传飞书”需求，当前仅并行只读研究。它作为后续独立实现批次，不混入本次三项修复代码与验证结论。
