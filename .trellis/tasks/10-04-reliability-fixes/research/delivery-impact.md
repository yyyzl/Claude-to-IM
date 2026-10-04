# 投递与飞书修改影响证据

编辑前使用 GitNexus CLI `impact <symbol> -r Claude-to-IM --direction upstream --depth 3 --include-tests`。索引为前一提交基线，新增模块/动态适配器调用补源码链路；没有将图中零调用当作无影响。

| symbol | 结果 | 直接调用及执行流 |
| --- | --- | --- |
| deliver | CRITICAL，22 symbols / 6 direct / 18 flows | manager commands/response、permission、workflow notification |
| sendWithRetry | CRITICAL，21 / 2 / 17 | deliver、deliverRendered |
| deliverRendered | HIGH，6 / 1 / 4 | 旧 manager deliverResponse → handleMessage → queue/loop |
| forwardPermissionRequest | HIGH，6 / 1 / 4 | handleMessage → provider permission |
| handlePermissionCallback | CRITICAL，7 / 2 / 5 | handleMessage / handleCommand |
| waitFor | LOW，1 direct | Claude streamChat；新 Codex provider 由源码补证 |
| InMemoryPermissionGateway.resolvePendingPermission#2 | LOW，0 graph | provider/broker 动态接口，由源码补证 |
| forwardUserInputRequest / resolveAnswer / clearUserInputRequests | UNKNOWN，旧图缺少 | 新 provider → engine → manager → broker，源码核对 |
| FeishuAdapter.send#1 | LOW，0 graph | delivery/response 模块通过 BaseChannelAdapter 调用 |
| handleIncomingEvent / processIncomingEvent | LOW，1 / 2 symbols | Feishu.start 事件处理 |
| createStreamingCard / _doCreateStreamingCard | LOW，2 / 3 symbols | onMessageStart / onStreamText；新增 onProgress 源码补证 |
| updateCardContent | LOW，3 symbols / 2 direct / 2 flows | onStreamText / tool progress |
| FeishuAdapter.finalizeCard#4 | LOW，1 direct | onStreamEnd |
| FeishuAdapter.onMessageStart#1 / onMessageEnd#1 / onStreamText#2 / stop#0 | LOW，0 graph | manager 动态适配器生命周期，源码核对 |
| cleanupCard | LOW，1 direct | onMessageEnd；新增 onMessageStart 共同隔离 generation |
| onProgress | UNKNOWN，旧图缺少 | manager progress → adapter → create/update |

同名 symbol 的 ambiguous 首次结果已通过完整 Method UID 重跑消歧。HIGH/CRITICAL 在编辑前已向用户与根报告，覆盖发送/审批主流程。新 response-delivery、interaction-lifecycle、UTF8 分块函数是新建，源调用方 manager/adapter 已联调。

补充：onResolution 为本轮新增，CLI impact 返回 UNKNOWN / not found；源码调用 interaction-lifecycle → permission/user-input broker。同步回放终态的 Map 顺序已由最小回归验证。
