# Fast修复提交计划

用户已授权本轮排查修复；提交/推送遵循同一功能会话中用户已明确的远端main交付方式。根已在提交前说明本次修复与验证范围，无新增产品决策。

## 功能修复

`fix(codex): 按目录真实档位识别 Fast`

只修正能力识别与请求ID映射，配套真实协议回归、文案、规范和研究记录。通过独立审查、648/648单测、typecheck/build。

- `.trellis/spec/backend/codex-model-selection.md`
- `.trellis/spec/backend/testing-guidelines.md`
- `.trellis/tasks/10-05-codex-fast-capability/check.jsonl`
- `.trellis/tasks/10-05-codex-fast-capability/commit-plan.md`
- `.trellis/tasks/10-05-codex-fast-capability/design.md`
- `.trellis/tasks/10-05-codex-fast-capability/implement.jsonl`
- `.trellis/tasks/10-05-codex-fast-capability/implement.md`
- `.trellis/tasks/10-05-codex-fast-capability/prd.md`
- `.trellis/tasks/10-05-codex-fast-capability/research/bridge-fast-analysis.md`
- `.trellis/tasks/10-05-codex-fast-capability/research/fast-protocol.md`
- `.trellis/tasks/10-05-codex-fast-capability/research/impact.md`
- `.trellis/tasks/10-05-codex-fast-capability/research/quality-check.md`
- `.trellis/tasks/10-05-codex-fast-capability/task.json`
- `docs/bridge-runner.zh-CN.md`
- `scripts/claude-to-im-bridge/codex-llm.ts`
- `src/__tests__/unit/bridge-codex-model-catalog.test.ts`
- `src/__tests__/unit/bridge-model-card.test.ts`
- `src/__tests__/unit/bridge-model-selection.test.ts`
- `src/lib/bridge/internal/model-capabilities.ts`
- `src/lib/bridge/internal/model-selection.ts`
- `src/lib/bridge/markdown/feishu.ts`

## 范围与交付

无未识别脏文件，不含模型缓存、身份信息、原始日志或产物。先提交修复，再归档任务和记录会话；提交前分别检查staged范围，最后快进main并推送origin/main，不强推、不重启桥接、不调用生产API。
