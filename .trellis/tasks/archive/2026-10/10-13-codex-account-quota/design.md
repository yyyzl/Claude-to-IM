# Codex 账号额度查询设计

## 接入和数据流

复用当前 CodexAppServerLLMProvider 的 JSON-RPC client。在现有 initialize/initialized 握手后调用 `account/rateLimits/read`，params 为 `{ excludeResetCreditDetails: true }`，跳过无关的重置券详情。该参数来自固定版本 schema，不声明未实现的自动模型降级能力。

数据流：飞书控制命令 → manager → 可选 LLMProvider.getAccountQuota → 现有 app-server → 白名单 DTO → 独立报告排版 → 现有投递层。不会发送模型 thread/turn 请求，不读取认证文件，不创建第二套登录或 HTTP 客户端。

## 模块边界与拟改文件

- `src/lib/bridge/host.ts`：可选 getAccountQuota 与额度 DTO；没有能力的 Claude/外部宿主不受必需接口变化影响。
- `scripts/claude-to-im-bridge/codex-quota.ts`：校验 unknown RPC 响应、投影公开字段，Codex 协议细节留在宿主层。
- `scripts/claude-to-im-bridge/codex-llm.ts`：新增读取方法，复用 ensureInitialized、connectionEpoch 与 request；读取失败不能重置共享连接。
- `src/lib/bridge/internal/quota-command.ts`：报告排版、窗口名称、百分比、北京时间、错误说明，不访问账号文件或存储。
- `src/lib/bridge/bridge-manager.ts`：只增加 quota 命令及异步调度接线。
- `src/lib/bridge/internal/bridge-help.ts` 和中文使用文档：命令入口、账号范围与缺失数据说明。

## 契约与格式化

DTO 保留查询时间和桶数组。每桶只有 limitId/limitName 和 primary/secondary 窗口；每窗口只有 usedPercent、windowDurationMins、resetsAt。原始响应、账号标识、邮箱、广告、credits 与重置券不进入 DTO。

实施采用 `AccountQuota`、`AccountQuotaBucket`、`AccountQuotaWindow` 契约；查询时间字段 `queriedAt` 是本机 Unix 毫秒，窗口 `resetsAt` 保持服务端 Unix 秒。文档和测试必须明确这两个单位，不能混用。

多桶视图有效时以 rateLimitsByLimitId 为准，避免单桶镜像重复；单桶 rateLimits 同样是固定版本正式协议。所有边界字段进行类型和数值校验，不以 TypeScript 声明替代运行时验证。

比例允许超出 100%，剩余下限为 0；负数/非法比例不得被当作 0。周期 300/10080 分别标为 5 小时/周，其它照实际时长，缺失按主/次窗口说明周期未知。重置时间是 Unix 秒，转换前检查日期有效性；到期只说明时间已到，不能推断使用资格恢复。空窗口说明未提供，不能推断无限额度。桶名称正确转义，多桶文本分块复用现有投递层。

## 并发和生命周期

每次命令主动读取，无轮询或跨账号缓存。握手复用 initPromise，RPC 设置明确超时；读取前后校验 connectionEpoch，旧连接的结果无效。失败只给出脱敏提示，不 stop/reset 共享 app-server。

runAdapterLoop 将 `/quota` 与已有 `/model` 一样异步登记 taskPromises，查询和发送都不能占住消费循环。记录 runEpoch，网络返回后及投递前验证桥接仍运行且 epoch 一致。查询不持有会话锁或长期消息准入门，不修改 binding。由于额度是账号级数据，new 不必使其失效；停机/重启后的旧回执必须废弃。

多桶报告可能分块，投递层增加可选 `isCurrent` 并复用 sendWithRetry 已有检查能力，将归属检查延伸到分块和重试等待边界。没有 callback 的调用沿用既有行为。只阻止尚未发起的后续发送，已进入平台的请求仍可能完成；不要因此改写其它投递路径的成功记录语义。

独立审查复现了发送前的微任务间隙：boundedSend 在 Promise 回调中才调用 adapter.send，因此必须在该实际调用点再次检查可选 isCurrent。非法 `/quota` 参数的拒绝回执同样复用查询命令的 bridge runEpoch 谓词，避免停机后继续重试拒绝消息。

非 Codex 后端或宿主缺能力明确说明不支持。请求失败不能猜登录方式或当前账号权益；沿用现有 IM 授权范围，不新增账号管理入口。

## 影响与风险

工作区 G:/project/Claude-to-IM；基线和 GitNexus lastCommit 均为 d859c57。FTS 搜索降级，影响图仍可用，动态接口边界以源码补证。

| 符号 | 风险、直接调用方和执行流 |
| --- | --- |
| handleCommand | CRITICAL；handleMessage；10 个受影响符号、6 条执行流，涉及消息处理/调度及间接 RPC。 |
| buildBridgeCommandHelp | CRITICAL；handleCommand；6 个受影响符号、5 条执行流，涉及帮助和消息调度。 |
| runAdapterLoop | LOW；start；2 个受影响符号，涉及启动和控制消息消费。 |
| CodexAppServerLLMProvider | LOW 下界；宿主 main/导入；LLMProvider 动态分派不能由图完全覆盖，需源码和集成测试补证。 |
| LLMProvider | 实施前追加检查为 CRITICAL；51 个相关符号、29 个直接依赖、6 条执行流；涉及三种 provider、消息/命令、模型卡和 Git LLM。新增方法保持可选，并核对直接引用及相关回归。 |
| deliver | 实施时追加检查为 CRITICAL；27 个相关符号、7 个直接调用方、16 条执行流；涉及 manager、workflow deliverText、权限与问答转发。只增加可选归属检查，回归既有调用及多块停止边界。 |
| boundedSend | 独立审查追加检查为 CRITICAL；13 个相关符号、2 个直接调用方（sendWithRetry、deliverRendered）、13 条执行流。可选检查延伸到实际 adapter.send 前的微任务边界。 |
| sendWithRetry | 独立审查追加检查为 CRITICAL；30 个相关符号、3 个直接调用方（deliver、deliverRendered、deliverSingle）、19 条执行流；涉及审批、模型回答/补发和工作流。沿用可选 callback，并补回归。 |

CRITICAL 已告知用户，shared-axes LOW 不抵消风险提示。修改其它既有符号前补 impact，并报告新增 HIGH/CRITICAL。回归重点是共享连接、消费循环和错误隔离。

## 运维和回退

无需依赖升级、数据库或全局配置修改。离线验证之后说明真实账号/飞书尚未联调，不自动重启桥接。回退仅撤销本任务可选能力和命令接线，不影响 Token 统计、模型偏好或历史会话。
