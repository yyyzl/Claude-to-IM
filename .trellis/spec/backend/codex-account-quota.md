# Codex 账号额度合同

## 1. 范围与触发条件

修改 `/quota`、宿主账号额度能力、app-server 额度协议或报告投递时使用本合同。额度属于桥接登录的 Codex 账号，由其它项目和客户端共享；`/usage` 仍表示本地模型 Token 汇总。

## 2. 接口

```ts
interface LLMProvider {
  getAccountQuota?(): Promise<AccountQuota>;
}
interface AccountQuota {
  queriedAt: number;
  buckets: AccountQuotaBucket[];
}
interface AccountQuotaBucket {
  limitId: string | null;
  limitName: string | null;
  primary: AccountQuotaWindow | null;
  secondary: AccountQuotaWindow | null;
}
interface AccountQuotaWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}
```

- `/quota` 与 `/quota@bot`：无需参数；命令通过现有渠道授权后处理。
- `parseCodexAccountQuota(value: unknown, queriedAt = Date.now()): AccountQuota`：宿主协议到共享 DTO 的唯一投影边界。
- `buildQuotaCommandResponse(llm: LLMProvider, backend: string, args: string): Promise<string>`：返回 HTML 报告或固定脱敏说明。
- `deliver(adapter, message, opts?)`：可选 `opts.isCurrent?: () => boolean` 检查当前归属；未传入时沿用原有行为。

## 3. 请求、数据与生命周期合同

复用 `CodexAppServerLLMProvider` 的现有 client、`initialize/initialized` 握手及 `initPromise`，发送 JSON-RPC `account/rateLimits/read`，参数 `{ excludeResetCreditDetails: true }`、超时 `15000` 毫秒。协议基于固定依赖 Codex `0.160.0`；不读取认证文件，不增加账号 HTTP 客户端或环境变量。

正式响应要求 `rateLimits` 为对象；`rateLimitsByLimitId` 可缺失或为空。多桶非空时仅投影多桶，否则投影单桶，避免镜像重复。桶名称与 ID 去掉首尾空白，缺失/空白为 `null`，多桶可用键补全缺失 ID。只保留上述 DTO 字段，丢弃账号标识、邮箱、credits、广告和重置券等原始字段。

`usedPercent` 为非负安全整数，允许大于 100；剩余比例为 `Math.max(0, 100 - usedPercent)`。周期为正安全整数分钟或 `null`，300 标为 5 小时、10080 标为周，其它按实际天/小时/分钟显示；缺失周期只能标注主/次窗口与“周期未知”。缺失窗口不能推断无限额度。

`queriedAt` 是本机 Unix **毫秒**，`resetsAt` 是服务端 Unix **秒**；后者必须为非负安全整数且乘以 1000 后能生成有效日期，或为 `null`。时间统一使用 `Asia/Shanghai`，报告明确标注北京时间；时间已到只提示重新查询，不能声称额度恢复。HTML 桶名称使用现有 `escapeHtml`。

每次命令主动读取，无自动轮询和跨账号缓存。查询与回执发送登记为 manager 的异步任务，不占用渠道消费循环、会话锁或长期消息准入门。读取前后验证 provider 的 `connectionEpoch`，回执使用 bridge `runEpoch` 检查归属。额度是账号级数据，`new` 不必取消有效查询，但停机/重启后的旧回执必须丢弃。

`deliver` 在开始、各后续块、发送重试及返回后的边界检查 `isCurrent`；`boundedSend` 必须在微任务中的实际 `adapter.send` 调用前复验，不能只在创建 Promise 前检查。非法 `/quota` 参数的拒绝回执复用相同 bridge 归属谓词。只能阻止尚未发起的发送；已进入平台的请求仍可能完成，不承诺撤回。额度读取/校验失败不能 stop/reset 已建立的共享连接；初次握手失败仍遵循原握手清理行为。不创建会话、不调用 thread/turn、不修改模型、权限、绑定和 Token 统计。

## 4. 校验与错误矩阵

| 条件 | 必须行为 |
| --- | --- |
| 命令有普通参数 | 提示 `/quota` 用法，不读取额度 |
| 参数命中共享危险输入校验 | 沿用安全拒绝说明，不读取额度；拒绝回执仍检查 bridge 归属 |
| 非 Codex 后端或宿主缺能力 | 固定不支持说明，不启动模型 |
| 空桶或缺失窗口 | 说明服务端未提供，无法判断剩余 |
| 负数、小数、非数值比例；非法周期或时间 | 拒绝响应，不能变成 0% 或无限额度 |
| 未登录、不支持、超时、断连、格式错误 | 返回固定通用错误，不回显原始错误/cause/响应 |
| 额度读取失败而模型正在运行 | 不重置共享连接，模型回合继续 |
| 断开重连后旧 RPC 晚到 | 拒绝旧连接结果，保留新连接 |
| 查询/发送等待期间 stop/new/审批 | 后续控制事件继续消费 |
| bridge 停机/重启后旧报告或后续块晚到 | 不发起旧回执、后续块或重试；已进入平台的发送可能完成 |

## 5. 正常、边界与失败示例

- 正常：300 分钟窗口已用 20%，显示“5 小时额度：已用 20% · 剩余 80%”，同时提供北京时间。
- 边界：10080 分钟窗口已用 120%，显示周额度剩余 0%；不能压低服务端的已用比例。
- 边界：只有周期未知的主窗口，显示实际比例并说明缺失次窗口，不猜它是 5 小时额度。
- 边界：多桶响应包含单桶镜像，报告只出现多桶；名字中的 `<>&` 正确转义。
- 失败：RPC 错误携带私有账号字段，正文与新增日志均只出现固定脱敏说明。
- 失败：查询挂起后桥接重启，旧结果不发送，新运行实例可正常接收控制命令。

## 6. 必需测试断言

使用纯内存 JSON-RPC、provider、manager 和平台传输，不调用真实模型、账号或 IM；每批后台单测外层硬超时最多 60 秒。

- `bridge-codex-quota.test.ts`：锁定协议参数/超时、握手复用、单多桶白名单、损坏字段拒绝、连接复用与 epoch 隔离；请求中没有 thread/turn 或配置写入。
- `bridge-quota-command.test.ts`：窗口按时长命名，0/100/超额比例、秒与毫秒、未知/到期时间、缺失说明及 HTML 转义。
- `bridge-quota-manager.test.ts`：验证参数、安全拒绝、能力不支持与错误脱敏；真正运行消费循环，挂起查询/发送/重试，验证 stop/new/审批继续，停机重启后旧结果和后续块停止，绑定、模型和 Token 统计不变。
- 回归 `deliver` 的既有直接调用路径：manager、工作流、权限和用户输入转发；没有 `isCurrent` 的调用保持原行为。相关回归通过后运行 typecheck/build 和完整单测。

## 7. 错误与正确做法

- 错：用窗口位置推断 `primary = 5h`、`secondary = week`。正确：按 `windowDurationMins` 识别，未知就明确说明。
- 错：`new Date(resetsAt)` 或空窗口显示剩余 100%。正确：先校验秒值，再乘以 1000；缺失数据不能推导比例。
- 错：额度失败后 reset 共享 client，或在消费循环中等待查询和发送。正确：隔离只读失败并登记异步任务，在连接和桥接 epoch 边界验证归属。

来源：`10-13-codex-account-quota` 的固定协议研究、实现和离线回归。
