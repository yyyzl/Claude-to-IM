# 飞书流式卡片与交互问答

当前实现使用 **卡片 JSON 2.0 + CardKit v1 API**，飞书 Node SDK 为项目依赖 `1.74.0`。API 的 `v1` 与卡片 JSON 版本是两个不同概念。

## 展示与交互

- 回答正文、工具/模型进度、追加消息提示使用独立组件。工具状态变化不再覆盖回答正文，正文追加符合客户端打字机增量语义。
- 结束时展示完整正文、完成/中断/错误状态、耗时与上下文使用率，并明确关闭流式、更新摘要。
- 审批卡支持“允许一次 / 本会话允许 / 拒绝”；没有卡片能力时发送等价 `/perm` 命令。
- 交互问答使用 JSON 2.0 原生表单，支持单选、多选、自由文本与“其他答案”，一次提交全部问题。
- 被标记为敏感输入的问题不会发送到聊天，当前请求明确失败，需要在本地完成。
- 卡片回调复用飞书 allowlist，并要求真实聊天、消息、操作人上下文。核心 broker 继续验证请求所属聊天与原始消息、有效期及重复提交。

卡片点击后的即时提示仅表示已提交，实际接受/拒绝由核心处理结果决定。审批请求有效期由宿主权限网关控制，卡片不再硬编码分钟数。网关确认允许、拒绝、取消、过期或问答提交后，原卡替换为终态并移除按钮；回写失败会记录警告，不改变已成立的权限结果。未实现 `PermissionGateway.onResolution` 的其他宿主无法提供主动到期回写。

## 可靠性与限制

同一卡片的请求按顺序串行执行，每次尝试都使用递增 sequence。开始收尾后禁止新的流式更新，等待已发请求完成，避免旧正文或工具状态覆盖完成卡。工作流卡片同样串行结束。

SDK 的 HTTP 成功不等于业务成功：CardKit 创建、内容/进度更新、收尾和交互消息发送均检查业务 code。最终卡失败时独立调用 settings 关闭流式，并返回失败，让核心继续投递完整回答，不将“停止生成中”当作“回答已发送”。

- 默认刷新间隔 2,000ms；`bridge_feishu_stream_card_throttle_ms` 限制在 250～30,000ms，零值也采用 250ms 下限。一轮最多两次写入，为结束操作保留单卡频率预算。
- 频控码 `99991400` 保留最新快照，按 5 秒起、最高 60 秒的退避重试；结束时清理重试定时器。
- SDK 请求具有 15 秒 HTTP 超时。网络超时后仍可能存在服务器已处理但客户端未知的情况；递增 sequence 防止更旧序号覆盖更新状态。
- 最终卡按完整序列化请求的 UTF-8 字节检查 30KB 大小；超长回答按 28KB 预算分段（包括 content 的二次 JSON 转义），跨段代码块补齐围栏。流式预览过长时显示分段提示，完整回答在结束后发送。
- 飞书流式模式有平台时限，长任务仍可能遇到平台自动关闭；本轮不无限重新开启。最终全量更新或普通消息投递继续承担收尾。
- 完成后默认发送一条短通知触发未读提示，可通过 `bridge_feishu_stream_card_notify_on_complete=false` 禁用。

## 待发回答与附件失败

最终回答先保存待发记录并 flush，再更新最终卡或发送消息。分段成功逐块保存，失败可用 `/status` 查看、`/retry [id]` 只补未确认成功的块，不重调模型；来源校验包括聊天、渠道和原用户。已送达记录清空重复正文，并最多保留 100 条元数据。

单次发送、限流等待及最终卡更新默认 15 秒有界等待，可由宿主设置 `bridge_delivery_timeout_ms`；审批/问答投递默认 15 秒，可设置 `bridge_interaction_timeout_ms`。超时表示平台结果可能未确认，需要检查聊天后决定是否手动补发。发送成功与进度保存之间发生进程崩溃仍可能重复，不承诺跨系统 exactly-once。宿主缺少完整 outbox/flush 能力时仅内存保存，失败状态明确提示重启可能丢失。

图片部分读取失败会先提示缺失序号，只将成功材料交给模型；全部失败不启动模型。已知不支持的文件、音频、视频等类型会直接说明当前限制。支持图片类型为 PNG/JPEG/GIF/WebP。

## 飞书应用配置与部署

现有应用需要机器人收发消息权限、`cardkit:card:write`，并启用消息事件和 **卡片回传交互 `card.action.trigger`**。这些是应用配置要求，本次代码升级没有更改租户权限或发布应用。

SDK 1.74.0 的 WebSocket 分发仍仅直接处理 event 帧，代码保留 card→event 转换以接收卡片交互；升级 SDK 后不能盲目删除。

安装项目锁定依赖并构建后，由维护者切换正在运行的桥接进程。此次变更没有重启服务、发送真实飞书消息或调用生产 API。上线后需在测试聊天验证一次流式回答、允许/拒绝审批、问答提交、中断和长回答投递。

## 验证

```powershell
node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-feishu-*.test.ts
```

测试使用本地 SDK mock，覆盖未完成请求与收尾交错、业务错误、频控、正文/进度分离、来源及 allowlist、单选/多选/其他答案、敏感输入拒绝、超长回答、工作流序号与结束顺序。构建与完整类型检查由项目统一验证，mock 不能替代租户配置和真实客户端显示检查。

## 官方接口依据

- [流式更新总览](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview)
- [流式文本 content](https://open.feishu.cn/document/cardkit-v1/card-element/content)
- [局部批量更新 batch_update](https://open.feishu.cn/document/cardkit-v1/card/batch_update)
- [关闭流式与摘要 settings](https://open.feishu.cn/document/cardkit-v1/card/settings)
- [全量更新卡片 update](https://open.feishu.cn/document/cardkit-v1/card/update)
- [JSON 2.0 表单容器](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/form-container)
- [卡片回传交互](https://open.feishu.cn/document/feishu-cards/card-callback-communication)

表单提交使用 `form_action_type: "submit"` 与 `behaviors: [{type: "callback", value: ...}]`；`action.form_value` 为表单项名称到字符串/字符串数组的映射。正文使用 `cardElement.content`，其他组件使用 `card.batchUpdate` 的 `partial_update_element`；仅最外层 actions 序列化为字符串。
