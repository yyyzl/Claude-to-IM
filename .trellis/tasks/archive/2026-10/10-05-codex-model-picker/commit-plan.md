# 本次提交计划

状态：用户于2026-10-05明确确认本批提交，并追加授权推送。分支：`codex/model-picker`。

## 1. 功能提交

`feat(codex): 添加飞书模型配置卡片与聊天偏好继承`

范围：动态模型目录、推理强度与正常/Fast速度、聊天偏好持久化和继承、回调归属与并发保护，以及对应测试、说明、规范和任务研究记录。

文件清单：

- `.trellis/spec/backend/codex-model-selection.md`
- `.trellis/spec/backend/index.md`
- `.trellis/tasks/10-05-codex-model-picker/check.jsonl`
- `.trellis/tasks/10-05-codex-model-picker/commit-plan.md`
- `.trellis/tasks/10-05-codex-model-picker/design.md`
- `.trellis/tasks/10-05-codex-model-picker/implement.jsonl`
- `.trellis/tasks/10-05-codex-model-picker/implement.md`
- `.trellis/tasks/10-05-codex-model-picker/prd.md`
- `.trellis/tasks/10-05-codex-model-picker/research/.gitignore`
- `.trellis/tasks/10-05-codex-model-picker/research/codex-protocol.md`
- `.trellis/tasks/10-05-codex-model-picker/research/impact-core.md`
- `.trellis/tasks/10-05-codex-model-picker/research/impact-feishu.md`
- `.trellis/tasks/10-05-codex-model-picker/research/impact-runtime.md`
- `.trellis/tasks/10-05-codex-model-picker/research/integration.md`
- `.trellis/tasks/10-05-codex-model-picker/research/lifecycle-review.md`
- `.trellis/tasks/10-05-codex-model-picker/research/plan-review.md`
- `.trellis/tasks/10-05-codex-model-picker/research/quality-check.md`
- `.trellis/tasks/10-05-codex-model-picker/task.json`
- `docs/bridge-runner.zh-CN.md`
- `scripts/claude-to-im-bridge/codex-llm.ts`
- `scripts/claude-to-im-bridge/codex-utils.ts`
- `scripts/claude-to-im-bridge/store.ts`
- `src/__tests__/unit/bridge-codex-model-catalog.test.ts`
- `src/__tests__/unit/bridge-codex-protocol.test.ts`
- `src/__tests__/unit/bridge-manager-ctx.test.ts`
- `src/__tests__/unit/bridge-model-card.test.ts`
- `src/__tests__/unit/bridge-model-selection.test.ts`
- `src/lib/bridge/adapters/feishu-adapter.ts`
- `src/lib/bridge/bridge-manager.ts`
- `src/lib/bridge/channel-adapter.ts`
- `src/lib/bridge/channel-router.ts`
- `src/lib/bridge/conversation-engine.ts`
- `src/lib/bridge/host.ts`
- `src/lib/bridge/internal/bridge-help.ts`
- `src/lib/bridge/internal/model-selection.ts`
- `src/lib/bridge/markdown/feishu.ts`
- `src/lib/bridge/types.ts`
- `tests/codexUtils.test.ts`

## 提交边界与依据

- 未识别的脏文件：无；清单均为本任务修改或新建。
- 不包括已忽略的原始 schema、`.fusion/` 日志、生成产物或本地凭据。
- 确认后按清单暂存，执行 staged GitNexus detect_changes 和差异检查，再创建上述提交；不 amend、不重启服务。用户追加授权推送到 origin/codex/model-picker。
- 功能提交完成后依据 Trellis 进行任务归档及会话记录；工作流生成的归档、日志提交在功能提交之后。
- 已完成最终643/643单元测试、typecheck、build、scope=all变更检查及独立全范围审查。业务文件已冻结，真实服务验证另行说明。
- 确认要求来自 `.trellis/workflow.md` Phase 3.4：“Present the plan once, ask for one-shot confirmation”。

执行记录：功能提交 `d5db4ed` 已创建。用户随后明确要求最终合入并推送 `origin/main`，以该最新要求为准；不使用强推。
