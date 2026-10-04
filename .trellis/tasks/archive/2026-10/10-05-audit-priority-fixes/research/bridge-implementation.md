# 桥接补发与当前聊天历史实施记录

## 结果与边界

- `/retry` 仅在聊天准入门内登记独立 `TurnContext`，网络和 flush 由 `taskPromises` 跟踪；不占用模型 `activeTasks` 或流式 UI 所有权。
- `retryTasks` 保留每个任务自身身份，沿用 chat generation / run epoch / AbortController。stop/new/bind 取消后续分块，全局 stop 中止补发并使用已有有界排空。等待准入期间发生停机也不能启动旧 retry。
- 只将 `isCurrent` 透传给既有 `retryResponseDelivery -> attempt`，未改 outbox 的来源校验、记录级互斥或成功块保存顺序。已进入平台并及时返回成功的块先保存；取消只阻止后续块。平台超时仍是未知结果，不承诺 exactly-once。
- 成功/失败通知发送前及投递重试前检查归属。正常投递/flush 错误和读取列表等意外异常均给仍属当前聊天的失败反馈；取消或切换后的旧任务不再回执。
- `BridgeStore.listChannelSessionHistory?` 为可选宿主能力。JSON 宿主同步记录旧、新绑定，更新绑定时刷新最近绑定快照，和 bindings 同一 JSON 快照原子保存。读取返回独立副本，删除会话不再列出。缺字段的旧文件只导入当前绑定，不猜孤立会话归属；新字段存在但结构错误时沿既有备份/拒绝空载逻辑处理。
- `/sessions [页码]` 每页 5 个当前 channel/chat 的历史项，显示完整 `/bind ID`、当前标记、标题、最近绑定目录和更新时间；已存在 `/bind` 逻辑保持原样。历史是绑定信息快照：`/cwd` 只更新 binding，直接读 session 的目录反而会返回旧值。
- Feishu 的 inlineButtons 当前为审批专用，未扩展平台协议。本轮提供可复制命令；无历史能力的宿主只展示当前聊天当前绑定，并明确说明范围。

## 文件与符号

| 文件 | 修改 |
| --- | --- |
| `src/lib/bridge/bridge-manager.ts` | `getState/cancelChat/stop/handleCommand`，新增 `startResponseRetry` 与 retryTasks 状态 |
| `src/lib/bridge/response-delivery.ts` | `retryResponseDelivery` 可选 isCurrent 参数传递 |
| `src/lib/bridge/host.ts` | `ChannelSessionHistoryEntry` 类型及可选历史查询接口 |
| `scripts/claude-to-im-bridge/store.ts` | `upsertChannelBinding/updateChannelBinding/load/save/parsePersistedData`；新增记忆/查询历史方法与可选持久字段 |
| `src/lib/bridge/internal/bridge-help.ts` | `/sessions [页码]` 中文帮助 |
| `src/__tests__/unit/bridge-priority-fixes.test.ts` | 新增 14 项隔离回归 |
| `src/__tests__/unit/bridge-lifecycle-regression.test.ts` | 原 retry 测试改为等待可观察的后台发送，保留发送/模型次数断言 |

未改 router、adapter、工作流、启动脚本、依赖、生产数据、用户文档或规范。未提交、推送、更新索引或重启服务。

## 修改前影响分析

引用先完成的 `research/bridge.md`：

- manager `getState/cancelChat/handleCommand`、`retryResponseDelivery`、JSON `save`、`buildBridgeCommandHelp`：CRITICAL 已由根代理向用户告知；分别覆盖控制入口/代际、投递、持久化与帮助流程。
- `stop` 与宿主 `upsertChannelBinding`：图 UNKNOWN，已由源码确认动态宿主调用和 router 三条绑定路径，未将零调用方当安全结果。
- `load/parsePersistedData`：LOW，直接调用方为构造器/load。
- 追加运行 `gitnexus impact updateChannelBinding --direction upstream --repo . --file scripts/claude-to-im-bridge/store.ts --summary-only`：UNKNOWN。源码补证 `channel-router` 三条创建/切换路径及 updateBinding，manager 的 SDK/模型更新，conversation-engine result，model-selection 偏好更新。告知根代理按关键持久化路径处理，仅记录同一绑定信息，不更改其旧语义。
- 新增 helper 无既有调用图，调用入口已由上述已分析的 manager/store 符号覆盖；新测试 fixture 为独立文件，无生产调用方。

## 实际测试

1. RED：新文件首批 8 项在旧实现全部失败，3.13 秒。控制通道断言使用实际时间截止，避免 Windows 定时器精度使等待超过投递超时而误通过。
2. GREEN：新增测试扩至 14 项，涵盖控制通道 stop/审批、stop/new/bind、重复 retry、停机挂起与迟到返回、flush/list 失败、模型调用为零、JSON 关闭重开、跨 chat/channel、旧孤立数据、旧宿主退化、分页/HTML 转义、副本与目录更新、损坏字段。
3. 相关 6 文件合并 **77/77 通过，3.13 秒**：

   - `bridge-priority-fixes.test.ts`
   - `bridge-lifecycle-regression.test.ts`
   - `bridge-delivery-reliability.test.ts`
   - `bridge-json-store.test.ts`
   - `bridge-help.test.ts`
   - `bridge-channel-router.test.ts`

命令为 `node --test --import tsx --test-timeout=15000 <上述文件>`，外层 `subprocess.run(..., timeout=60)`。全部 fake transport/model、独立临时 JSON，显式阻断 child_process 与 fetch。未运行真实平台/模型。

相关文件 `git diff --check` 通过。整仓 typecheck/build/full tests 和 GitNexus detect_changes 由根代理统一运行。

## 剩余限制

- 没有确切聊天归属的旧孤立 session 不会出现在历史列表。
- 已发出但超时的请求不能确认平台最终结果；不自动撤回或声称绝不重复。
- 历史按 channel/chat 隔离，沿用群聊共享绑定和原有显式完整 ID `/bind` 语义，没有新增账户权限体系。
- 尚未在真实飞书租户或实际模型上联调，本轮回归不产生真实外部请求。
