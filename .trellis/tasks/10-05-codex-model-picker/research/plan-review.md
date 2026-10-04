# Research: Codex 模型选择方案一致性审核

- Query: 检查 PRD、design、implement 的内部矛盾、最小实现缺口与验收遗漏；重点为 Fast、正常速度清除、目录并发、聊天继承、保存失败及回调归属。
- Scope: internal；仅审核任务规划与已存研究，不执行业务修改、Git 操作、生产请求或图索引冷启动。
- Date: 2026-10-05

## Findings

结论：通过。当前材料没有需要用户再决定的产品问题，也未发现阻塞最终方案审核的内部矛盾。

### Files Found

- `prd.md`：Codex 专属需求、聊天级偏好和 AC1–AC8。
- `design.md`：两步卡片、唯一偏好来源、运行时目录、请求快照及回调隔离。
- `implement.md`：按共享契约、状态链、卡片、独立验证的顺序实施。
- `research/codex-protocol.md`：锁定 CLI 0.160.0 的离线模型与速度协议证据。
- `research/integration.md`：已有实现缺口、调用链和预查风险记录。

### 边界核对

- Fast 只在目录明确提供时开放；正常速度显式发送 `serviceTierForTurn: default`，不存在用省略字段取消 Fast 的矛盾（`design.md:50`）。`fast_mode` 是否必需已作为实现前核实项，且仅允许桥接子进程覆盖（`implement.md:20`）。
- 初始化和目录刷新使用独立并发状态，完整分页后才替换缓存；刷新失败不重置正在使用的连接（`design.md:46`）。
- 新偏好是唯一显式选择来源；`/new` 与 `/bind` 保留当前聊天选择，跟随默认不被上次实际模型覆盖（`design.md:34`，PRD R8/R9）。尚未设置新偏好的旧数据保留原有优先级，不等同于显式 default。
- 完整偏好一次更新并等待 flush；失败恢复本次内存修改且避免回退别人的更新，不报告持久化成功（`design.md:39`）。执行清单包含故障测试（`implement.md:29`）。
- 回调草稿拥有用户、聊天、会话、binding、epoch/generation、原卡和 revision；消息准入与应用/new/bind/stop 必须串行，await 后再验，避免检查后竞态（`design.md:58`、`:62`、`:64`）。
- 卡片 patch 失败与偏好保存失败分别处理；后台执行不受设置变更影响，忙碌时仅拒绝应用。文字入口沿用相同校验与保存合同。

### Code Patterns（来自已存集成研究，未重复读取业务源码）

- `src/lib/bridge/conversation-engine.ts:417`：已有实际模型回写是偏好与状态分离的修改依据。
- `src/lib/bridge/channel-router.ts:43`、`:185`：new/bind 是偏好继承必须覆盖的入口。
- `src/lib/bridge/adapters/feishu-adapter.ts:524`：回调使用真实来源并快速入队，目录网络读取不能留在同步响应路径。
- `scripts/claude-to-im-bridge/codex-llm.ts:218`、`:257`：目录发现与 turn/start 是能力读取和参数传递两端。

### Related Specs

- `.trellis/spec/backend/module-boundaries.md`：模型选择协调留在核心内部模块，宿主通过正式接口接入，平台回调由适配器负责。
- `.trellis/spec/backend/reliability-contracts.md`：归属快照、异步再验、并发 flush、持久化失败和平台投递结果区分。
- `.trellis/workflow.md` 与 `.agents/skills/trellis-brainstorm/SKILL.md`：当前只审核规划，不以研究通过代替最终方案审核或 task start。

### External References

沿用已存 `research/codex-protocol.md` 中的 0.160.0 离线 schema 证据，以及 `research/integration.md` 记录的官方 App Server、速度及飞书组件文档。本次没有重复浏览，也没有读取原始大型 schema 缓存。

## Caveats / Not Found

- 这是规划一致性审核，不证明业务实现已经正确；逐符号影响分析、离线竞态与故障测试仍须在实现阶段完成。
- 未核验真实账号 Fast 授权或生产飞书卡片渲染；规划已明确这两项的验证边界，不能以离线 schema 或测试通过替代。
- 未读取 implement.jsonl/check.jsonl，遵守研究角色隔离；其合法性由主会话独立校验。
