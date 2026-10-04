# 图片产物链路实施记录（实现者 A）

## 实现

- `host.ts` 新增 `GeneratedImage`、独立 `generated_image` SSE、`ResponseChunk` 图文联合类型；旧文本记录缺少 kind 仍按文字解释。`types.ts` 新增 `OutboundMessage.image={imageKey,sendUuid}`，不把 Base64 放到普通出站文字字段。
- `internal/generated-image.ts` 为接收、会话消费、JSON 恢复、上传提供同一校验实现。导出 create/validate/decode、数量与总量校验；数据只能是标准且 canonical round-trip 一致的 Base64，检查 PNG signature、IHDR 必需长度/尺寸/参数、chunk 边界与连续 IDAT、IEND。每图≤10,000,000字节，宽高1…12000，每回合≤8张且≤30,000,000字节。所有错误为固定类别，不带媒体或路径。
- Codex `collectTurnText` 仅消费精确本 threadId/turnId 的 `item/completed.imageGeneration`，要求 status completed 且无 failure，稳定 ID 为 thread/turn/item 的 SHA-256。支持 turn/start 返回前的 early backlog，按 item 去重；started 只显示进度；failed/空/坏/超限/未结束图片明确生成文字说明。无 savedPath 回退，不读目录。
- provider 通过 `onGeneratedImage` 发送独立 SSE，图片不经过 tool_use/tool_result。stdio 子进程参数最后追加 `-c features.omit_app_server_notification_media=false`，只覆盖该进程，不修改全局配置。
- producer 超时统一 `TimeoutError -> result.error_code=timeout`；终态失败、超时或取消后立刻停止接受通知，等待 turn/interrupt 期间的迟到图片也不会被新接纳。
- `consumeStream` 将有效图片保存在独立 generatedImages，复验摘要/大小并去重，普通 assistant 历史仅保存文字与原有工具块。畸形 JSON 不输出解析异常的原始片段。正常流错误保留已完成图与文字；abort/timeout 返回空图片数组。
- manager 以“文字或图片”判断投递；纯图也创建 outbox。普通模型错误并已有合法图片时，保留图片并附错误说明。流卡结束只交给投递层确认文字，图片继续走同一记录。投递失败向仍属当前的聊天明确反馈 `/retry`，不只写日志；取消/换绑的旧任务不发回执。

## 所有权与联调

A 修改：

- `src/lib/bridge/host.ts`
- `src/lib/bridge/types.ts`
- `src/lib/bridge/internal/generated-image.ts`（新增）
- `scripts/claude-to-im-bridge/codex-llm.ts`
- `src/lib/bridge/conversation-engine.ts`
- `src/lib/bridge/bridge-manager.ts`
- 4 个新增窄测试，见下文。

B 负责且 A 未改：response-delivery、channel-adapter、delivery-layer、Feishu adapter、JSON store。共享接口先落地后通知 B；manager 8 项集成已使用 B 的真实 outbox 实现与 fake adapter 验证。

## 修改前影响门禁

仓库/工作区：`Claude-to-IM` / `G:/project/Claude-to-IM`；GitNexus 1.6.12，基线 `ad3fb66`，主会话已刷新索引。

逐项执行 `gitnexus impact <symbol> --direction upstream --repo . --file <path> --summary-only`：

| 符号 | 图结论与源码补证 |
| --- | --- |
| CodexAppServerLLMProvider.constructor | UNKNOWN；runner `scripts/feishu-claude-bridge.ts:373` 显式构造。仅增加局部启动参数 |
| CodexAppServerLLMProvider.streamChat | UNKNOWN，图报告 DI/receiver 边界；`conversation-engine.processMessage` 与 `internal/git-llm.ts` 调用。后者只消费 text，新增独立图片 SSE 不进入提交正文 |
| CodexAppServerLLMProvider.collectTurnText | LOW，直接由 streamChat 的异步 start 调用 |
| consumeStream | CRITICAL，直接 processMessage，关联5流程。已先通报根，由根告知用户后开始修改 |
| bridge-manager.handleMessage | 最初名称有 testOnly 属性歧义，重查完整 UID `Function:src/lib/bridge/bridge-manager.ts:handleMessage` 得 CRITICAL，4直接调用、5流程。源码直接入口为 scheduleMessages/enqueueRegularMessage/runAdapterLoop 与自身回调递归；根已提前告知用户 |

没有把 UNKNOWN 或 riskSharedAxes LOW 当作安全证明。独立 helper 为新增纯函数，其调用边界由以上符号与 B 的投递/存储影响分析覆盖。

## 实际测试

新测试先 RED：

- helper 模块尚未实现时因缺模块失败；实现后3项通过。
- provider 4项关键图片协议回归在旧实现全部失败（0张图片）；实现后扩至6项。
- engine 首批5项中3项失败、既有取消不产图2项通过。
- manager 首批8项中纯图/图文/失败反馈4项失败，原取消边界4项通过。

最终相关 **56/56 通过，4.04秒**，含22项新测试：

- `bridge-generated-image.test.ts`：3项，PNG/Base64/元数据/预算。
- `bridge-codex-image-output.test.ts`：6项，真实0.160 fixture、early、重复、跨回合、失败/空/坏/未完成/第9张、普通错误保留、超时迟到隔离、局部媒体启动参数。
- `bridge-image-conversation.test.ts`：5项，纯图与多图、普通错误保留、历史/工具不含媒体、abort/timeout、不合法数据固定提示。
- `bridge-image-manager.test.ts`：8项，纯图finalize真假、图文多图错误、abort/timeout、失败可见补发入口、stop/new。
- 既有 `bridge-codex-llm.test.ts`、`bridge-conversation-engine.test.ts`、`bridge-lifecycle-regression.test.ts`、`bridge-manager-ctx.test.ts` 同批通过。

运行命令：`node --test --import tsx --test-timeout=15000 <上述8文件>`，外层 Python `subprocess.run(..., timeout=60)`。fake transport/LLM/adapter、独立临时JSON；manager测试显式禁止 child_process/fetch。启动参数测试仅构造 provider/transport 并检查 command，没有 request/start/真实进程。

相关 `git diff --check` 通过。最终统计发现 `conversation-engine.ts` 的 HEAD 原本混合 CRLF/LF，整体 LF 会扩大行差异；已通知独立 checker 保留未改行原换行、只让新行使用 LF，保持文本不变并收敛 diff。整仓 typecheck/build/full tests、detect_changes及提交推送由主会话统一执行。

独立 checker 已接管后续安全收敛：`collectTurnText` 的上游 error/turn.failed 原始 message 可能夹带媒体或凭据，将改为固定安全诊断并补对应回归。以上 56 项是实施阶段实测结果，最终以 checker 与主会话整合检查为准。

## 明确限制

- PNG 校验是必要结构校验，不解压像素、不执行完整图像解码；远端仍可能拒绝语义损坏图片，此时保留 outbox 并明确反馈。
- 只有完成回合并创建 outbox 后才承诺待发持久化；此前纯内存产物不保证进程崩溃恢复。
- 没有真实账号生图、生产飞书上传或权限联调；能力/额度由当前 Codex provider/account 决定。
- 不使用 savedPath，不扫描目录，不删除生成原件，不修改用户全局配置。
