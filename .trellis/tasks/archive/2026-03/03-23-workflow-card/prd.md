# Workflow 进度推送飞书卡片化

## Goal

将 `/workflow` 命令的进度推送从多条纯文本消息改为**单张可更新的飞书流式卡片**，解决刷屏问题，同时增加交互按钮。

## 背景

当前 `bindProgressEvents()` 订阅 WorkflowEngine 的 14 个事件，每个事件都通过 `push()` 发送一条独立文本消息。一轮审查产生 7-8 条消息，3 轮就刷 20+ 条。

项目已有完整的卡片基础设施：
- `feishu.ts`: `buildCardContent()`, `buildFinalCardJson()`
- `feishu-adapter.ts`: `startStreamingCard()`, `appendStreamingContent()`, `finalizeStreamingCard()`
- `workflow-command.ts` L427 已预留扩展点注释

## Requirements

### 核心需求

1. **单卡片进度展示**：工作流启动时创建一张卡片，后续事件更新同一张卡片（不再发多条消息）
2. **实时状态更新**：每个事件触发时更新卡片内容，展示最新进度
3. **结构化布局**：卡片内以结构化方式展示轮次、审查状态、问题统计
4. **Inline 按钮**：卡片底部添加「暂停」/「终止」按钮
5. **最终状态卡片**：工作流完成/失败/停止时，用最终卡片替换进度卡片

### 约束

- 不改变事件订阅逻辑（保持 `engine.on(...)` 结构不变）
- 仅替换 `push()` 的输出格式，改为卡片更新
- 复用已有的 `feishu-adapter.ts` 流式卡片方法
- 保持对非飞书平台的兼容（如果 adapter 不支持卡片，fallback 到纯文本）

## Acceptance Criteria

- [ ] `/workflow start` 启动后只产生一张卡片（不再刷屏多条消息）
- [ ] 卡片随事件实时更新，展示当前轮次和进度
- [ ] 卡片包含 Inline 按钮（暂停/终止）
- [ ] 工作流完成时卡片显示最终结果
- [ ] 非飞书平台 fallback 到原有纯文本推送
- [ ] TypeScript 编译通过，无类型错误

## Technical Notes

- 改动集中在 `src/lib/bridge/internal/workflow-command.ts` 的 `bindProgressEvents()` 函数
- 可能需要在 adapter 接口中补充卡片更新能力的检测方法
- 卡片 JSON schema 参考已有的 `buildCardContent()` 实现
