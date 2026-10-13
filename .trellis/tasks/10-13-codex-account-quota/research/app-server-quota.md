# app-server 额度查询研究

研究日期 2026-10-13，项目基线 d859c57，固定 CLI codex-cli 0.160.0。

## 官方来源

- [app-server 协议](https://learn.chatgpt.com/docs/app-server)：account/rateLimits/read、account/rateLimits/updated、单/多额度桶，已用比例、周期分钟数和 Unix 秒重置时间。
- [套餐与额度说明](https://learn.chatgpt.com/docs/pricing)：窗口依账号/套餐而定，部分套餐没有固定 5 小时窗口；本地 Token 汇总不能推算账号额度。

## 固定版本证据

通过项目包入口核验 `node node_modules/@openai/codex/bin/codex.js --version` 为 0.160.0，离线运行 app-server generate-json-schema；没有运行真实 app-server 或查询账号。

本次临时 schema 目录为 C:/Users/10455/AppData/Local/Temp/claude-im-quota-schema-ba690acf314b447a8c5e1f9c87faa55f。后续测试不得依赖临时目录存在。

- ClientRequest.json 包含 account/rateLimits/read，params 可空或为 GetAccountRateLimitsParams。
- v2/NullableGetAccountRateLimitsParams.json 有 excludeResetCreditDetails、supportsLunaReserve；仅使用前者，不声明未实现的自动降级能力。
- v2/GetAccountRateLimitsResponse.json 有 rateLimits 和可空的 rateLimitsByLimitId。窗口 usedPercent 为必需整数，windowDurationMins/resetsAt 可空。
- 其它账号、credits、重置券及许可字段不进入本任务展示白名单，不能仅凭比例/时间宣告使用资格恢复。

以下依 schema 构造合成样例，不是用户账号真实数据：

```json
{"rateLimits":{"limitId":"codex","limitName":null,"primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1791900000},"secondary":{"usedPercent":60,"windowDurationMins":10080,"resetsAt":1792300000}},"rateLimitsByLimitId":null}
```

## 当前源码和影响

- codex-llm.ts:89 的唯一 provider 已持有 client、ensureInitialized、connectionEpoch。
- host.ts:272 的 LLMProvider 已有可选 getModelCatalog，额度能力沿用可选契约模式。
- bridge-manager.ts:1031 已将网络模型命令异步登记 taskPromises，quota 同样需要保持后续控制消息消费。
- bridge-manager.ts:1660 的 handleCommand 可取得 store/llm；usage-command.ts:1 是独立本地 Token 报表。

GitNexus upstream impact：handleCommand 和 buildBridgeCommandHelp 为 CRITICAL，runAdapterLoop 为 LOW，CodexAppServerLLMProvider 为 LOW 下界。调用关系与执行流记录于 design.md，并已告知用户。FTS 扩展不能加载，关键词空结果不作为安全证据；符号图和源码补证可用，不为本任务修改系统运行库。

实施前追加检查共享 LLMProvider 接口：CRITICAL，51 个相关符号、29 个直接依赖、6 条执行流；涉及 Codex/Claude/Echo 实现、handleMessage、handleCommand、模型卡、Git LLM。root 已补充向用户告知；新增额度方法保持可选，并要求核对直接引用及相关回归。

实施中发现多桶文本分块的停止边界需要将可选 isCurrent 接到 deliver；sendWithRetry 已有该能力。deliver upstream impact 为 CRITICAL，27 个相关符号、7 个直接调用方、16 条执行流，root 已告知用户并授权最小接线。已进入平台的发送无法撤回，检查只阻止后续未发起的块或重试。

独立审查追加影响：boundedSend CRITICAL，13 个相关符号、2 个直接调用方、13 条执行流；sendWithRetry CRITICAL，30 个相关符号、3 个直接调用方、19 条执行流。纯内存测试复现了检查与实际 adapter.send 之间的微任务间隙；修复只把可选归属检查延伸到真实发送调用前，并覆盖非法 quota 参数回执。root 已告知用户后授权审查代理自修。

## 未联调事项

当前真实登录账号、第三方提供商及运行中的飞书是否能返回额度尚未验证。接口/schema 存在不证明账号权益，离线测试先覆盖错误展示、数据诚实和连接隔离；真实联调需单独授权。

## 最终离线验证

- 实施代理相关回归 166 条通过；独立检查修复两处停机边界后，13 个文件、203 条相关回归通过，typecheck 通过。
- root 完整 `npm run test:unit` 790 条、140 个 suite 通过，约 17.86 秒；每批外层硬超时 60 秒。`npm run build` 和 `git diff --check` 通过。
- `gitnexus analyze --index-only` 刷新成功，107 个索引文件、4587 个节点、12157 条边；新 `parseCodexAccountQuota` context 命中当前源码，直接调用者为 getAccountQuota。
- `detect-changes --scope all --repo .` 的人类输出固定只显示前 15 个符号/10 条流；通过同版 LocalBackend 获取并核对完整结果，tracked diff 为 12 个文件、44 个符号、63 条流，partial/truncated 均为 false，风险 CRITICAL，符合已告知的共享投递影响范围。
- 图检测不涵盖未跟踪文件，另以实际 diff、27 文件提交清单和源码核对。FTS 仍降级，基础执行流发现有分支/入口预算截断；不能把缺失图边当作无影响。共享接口/投递直接引用已人工核对，相关回归与完整单测补证，不修改系统运行库或全局配置。
- 使用说明、七节合同和 14 条 implement/check 清单有效；无无关改动。2026-10-13 用户已确认提交并要求推送；按当前功能分支完成提交、归档及会话记录，再推送 origin。不自动重启或真实联调。
