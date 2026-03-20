# brainstorm: 卡片完成后发送通知

## Goal

在飞书“卡片流式更新”模式下，当执行完成并且卡片状态进入最终态（成功/失败）后，额外发送一条新消息用于通知发起人，避免“只更新卡片但无未读/提醒”的问题。

## What I already know

* 目前完成态是通过更新同一张卡片实现（card.update），不会额外发新消息，因此通常不会产生新的未读/通知。
* feishu-adapter.ts 中存在 finalize 阶段日志 Card finalized，说明这里是落点。

## Assumptions (temporary)

* 发送“新消息”比“编辑原卡片”更容易触发未读/通知。
* MVP 先在 Feishu 适配器里实现；是否要抽象到跨平台后续再定。

## Open Questions

* （已确认）通知不使用 @ 提醒（方案 A）。
* （已实现）支持通过 setting 禁用通知，避免噪声。

## Requirements (evolving)

* 完成态（成功/失败）时，发送一条新的文本消息到同一 chat。
* 通知消息默认不 @ 任何人。
* 消息内容包含：最终状态 + 耗时（如果有）+ 可选简短摘要。
* 不影响原卡片的最终渲染（卡片仍保留完整结果）。
* 支持设置 `bridge_feishu_stream_card_notify_on_complete=false` 禁用通知。

## Acceptance Criteria (evolving)

* [ ] 卡片进入最终态后，聊天里出现一条新的“完成通知”消息。
* [ ] 失败时也会发“失败通知”，并带上简短错误信息。
* [ ] 默认不会造成重复通知（同一次会话只发一次）。
* [ ] 当 `bridge_feishu_stream_card_notify_on_complete=false` 时，不发送通知消息。

## Definition of Done (team quality bar)

* 单元/集成测试：尽可能覆盖（至少验证 Feishu adapter 的发送调用被触发一次）。
* 类型检查/构建通过。

## Out of Scope (explicit)

* 不做跨平台统一策略（Telegram/Discord 等）——除非实现成本极低。
* 不做复杂的通知订阅/开关 UI。

## Technical Notes

* 代码落点：src/lib/bridge/adapters/feishu-adapter.ts 的 finalizeCard()（CardKit v1 card.update + Card finalized）。
* 发送通知可复用现有 REST：restClient.im.message.create（msg_type: 'text'）。
* 发起人 userId 在 processIncomingEvent() 可取到（open_id > user_id > union_id）；如需 @提醒，建议按 chatId 额外缓存 lastIncomingUserId。
