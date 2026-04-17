# PRD: Context Usage Indicator for IM Bridge

**Status**: 占位 (Research 已完成，待 `product-requirements` skill 正式起草)
**Created**: 2026-04-17
**Assignee**: name=yyyzl
**Research memo**: [research/ctx-usage-indicator.md](./research/ctx-usage-indicator.md)

---

## 简述（一句话）

每次 Claude Code / Codex 回复完成后，桥接层自动在飞书卡片 footer 追加一行 `ctx {pct}% ({input_k}k/{window_k}k)`，帮助用户实时判断是否需要 `/clear` 或新开 session。

## 为什么这是一份占位文档

需求研究已完成，关键技术路径、数据源、session 隔离策略、自动压缩免疫论证均已在 `research/ctx-usage-indicator.md` 中明确。

下一步将通过 `product-requirements` skill 基于 research memo 产出完整 PRD，内容应包含：

- 功能验收标准（Acceptance Criteria）
- 边界 / 异常场景的期望行为（session 切换、压缩、Codex/CC 退出、文件读不到等）
- 测试用例矩阵
- 灰度 / 降级策略（probe 失败时应静默而非破坏卡片）
- 性能预算（probe 延迟上限、rollout 扫描行数上限）
- 面向 implementation 的接口草案最终版

## 当前已锁定的非协商项

1. 展示格式：A1 纯字 `ctx 42% (84k/200k)`
2. 零上下文污染：不通过 IM/模型侧发指令探测
3. 本任务**不**实现 `/clear` / new session 行为（已有能力）
4. 覆盖范围：Claude Code + Codex（Gemini P2，视实现后追加）

## 下一步

运行 `product-requirements` skill，基于 research memo 与上方锁定项起草正式 PRD。
