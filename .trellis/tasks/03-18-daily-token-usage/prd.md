# brainstorm: 每日 Token 消耗统计斜杠命令

## Goal

在 IM 侧提供一个斜杠命令（例如 `/usage`），让用户可以用中文参数快速查询「今天 / 最近 N 天」的 Token 消耗情况，并按天汇总展示。

## What I already know

- 现有桥接链路已经能拿到每轮（turn）的 Token 用量：
  - `conversation-engine.ts` 会在 SSE 的 `result` 事件中读取 `resultData.usage`，并将其作为 `usage` JSON 字符串写入 `store.addMessage(..., usage?)`。
- 现有桥接已经支持 IM 侧斜杠命令：
  - `bridge-manager.ts` 在进入 sanitize 前会检测 `rawText.startsWith('/')` 并调用 `handleCommand()`。
  - `/help`、`/status`、`/git` 等命令已存在，便于扩展 `/usage`。
- `TokenUsage` 结构已定义（`host.ts`）：`input_tokens`、`output_tokens`，可选 `cache_read_input_tokens`、`cache_creation_input_tokens`、`cost_usd`。

## Assumptions (temporary)

- “今天/最近N天”按桥接进程所在机器的本地时区划分（后续可加配置覆盖）。

## Decision (temporary)

- 数据源与存储方案：**桥接库本地按天汇总 JSON**（无需宿主 DB；每轮结束聚合写入；`/usage` 读取并汇总展示）。
- 统计范围与默认口径：**全局总量**（默认汇总所有聊天/会话的用量；后续可扩展按 chatId 过滤）。
- 汇总文件默认路径：`~/.claude-to-im/usage-summary.json`（支持 setting 覆盖：`bridge_usage_summary_path`）。
- 维度拆分：按“项目维度”拆分统计口径。
- 项目维度识别：**Git 仓库根目录（repo root）**（从 `workingDirectory` 向上查找 `.git`；找不到则降级为标准化后的 `workingDirectory`）。
- 统计口径：**展示缓存 token 拆分**（`cache_read_input_tokens`、`cache_creation_input_tokens` 会被汇总展示；`total=input+output`，避免重复计算）。

## Open Questions

- 保留策略：默认保留多少天（例如 90 天）？是否需要可配置 `bridge_usage_retention_days`？
- 输出口径：是否在输出中展示 `cost_usd`（有值时）？
- 过滤能力（后续）：是否需要支持按「项目名关键词」或「当前聊天/平台」过滤？

## Requirements (evolving)

- 新增斜杠命令：`/usage`（可选别名 `/tokens`）。
- 支持中文参数解析：
  - `今天`、`昨天`
  - `最近3天` / `近3天` / `3天`
  - `最近五天`（支持基础中文数字）
- 输出内容：
  - 最近 N 天按天汇总列表 + 总计
  - 每天至少包含：input、output、total（可选 cache/cost）
- 默认口径为全局汇总（所有聊天/会话），并支持按项目维度拆分查看。
- 无数据/不可用时给出清晰提示（例如 “暂无统计数据：上游未返回 usage”）。

## Acceptance Criteria (evolving)

- [ ] `/usage` 在默认参数下返回“今天”的全局汇总。
- [ ] `/usage 最近3天` 返回 3 天的逐日汇总 + 总计。
- [ ] 中文数字与阿拉伯数字都能正确解析（至少 1–31）。
- [ ] 输出在 Telegram/Discord/飞书不乱码、不破坏格式（HTML → Discord markdown 的转换可用）。

## Definition of Done (team quality bar)

- 单元测试覆盖核心解析与汇总逻辑（≤60s）。
- 文档更新：在 `docs/development.zh-CN.md` 或 bridge README 中补充命令说明与宿主实现示例。
- 对现有宿主实现“非破坏性”：新增接口需可选或提供兼容降级路径。

## Out of Scope (explicit)

- 实时逐事件（SSE 增量）token 统计展示。
- 精确计费/账单对账（仅做用量汇总展示）。
- 多租户/多用户隔离的完整权限与审计策略（仅在需要时扩展）。

## Technical Notes

- 关键落点：
  - `src/lib/bridge/conversation-engine.ts`：`result` 事件提取 `usage`
  - `src/lib/bridge/bridge-manager.ts`：`handleCommand()` 扩展 `/usage`
  - `src/lib/bridge/host.ts`：`TokenUsage` 类型已具备
- 宿主 SQLite 示例 schema 已包含 `messages.usage` 与 `created_at`（可用于按天汇总）。
