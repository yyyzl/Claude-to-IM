# 已确认的提交计划

功能实现、独立审查、typecheck/build 和完整单测已完成。按照项目工作流 Phase 3.4 已展示文件清单；2026-10-13 用户明确要求“搞定了以后，记得提交推送一下”，授权执行提交并推送当前功能分支。

## 提议的工作提交

`feat: 支持飞书查询 Codex 账号额度`

一个完整功能提交，包含以下 27 个文件。

### 产品代码（7）

- `src/lib/bridge/host.ts`
- `scripts/claude-to-im-bridge/codex-llm.ts`
- `scripts/claude-to-im-bridge/codex-quota.ts`
- `src/lib/bridge/internal/quota-command.ts`
- `src/lib/bridge/bridge-manager.ts`
- `src/lib/bridge/delivery-layer.ts`
- `src/lib/bridge/internal/bridge-help.ts`

### 回归测试（3）

- `src/__tests__/unit/bridge-codex-quota.test.ts`
- `src/__tests__/unit/bridge-quota-command.test.ts`
- `src/__tests__/unit/bridge-quota-manager.test.ts`

### 使用与接入文档（6）

- `README.md`
- `README.zh-CN.md`
- `docs/bridge-runner.zh-CN.md`
- `docs/development.md`
- `docs/development.zh-CN.md`
- `docs/codex-quota.zh-CN.md`

### 项目规范（3）

- `.trellis/spec/backend/index.md`
- `.trellis/spec/backend/reliability-contracts.md`
- `.trellis/spec/backend/codex-account-quota.md`

### 本任务规划与验收记录（8）

- `.trellis/tasks/10-13-codex-account-quota/task.json`
- `.trellis/tasks/10-13-codex-account-quota/prd.md`
- `.trellis/tasks/10-13-codex-account-quota/design.md`
- `.trellis/tasks/10-13-codex-account-quota/implement.md`
- `.trellis/tasks/10-13-codex-account-quota/implement.jsonl`
- `.trellis/tasks/10-13-codex-account-quota/check.jsonl`
- `.trellis/tasks/10-13-codex-account-quota/research/app-server-quota.md`
- `.trellis/tasks/10-13-codex-account-quota/commit-plan.md`

## 未识别改动

无。`.fusion` 恢复数据和 GitNexus 本地索引被忽略，不进入提交。

## 验证与后续

- 独立审查：13 个文件、203 条相关测试通过；两个停机边界回归先失败后通过。
- 完整单测：790 条、140 个 suite 通过，约 17.86 秒；外层硬超时 60 秒。
- typecheck/build 通过；使用文档与执行合同同步。
- GitNexus 已刷新；完整结构化 tracked diff 检测为 44 个符号、63 条流，partial/truncated 均为 false，新增文件已另行核对。全文搜索和基础流发现预算仍有限，源码与完整回归作为补证。
- 真实账号、生产飞书未联调；运行中的桥接未重启。

按上述清单暂存并提交，不 amend；工作提交完成后按 Trellis 流程另行归档任务、记录会话，再推送 `codex/account-quota` 到 `origin`（yyyzl/Claude-to-IM）。用户的推送授权优先于此前“不推送”的阶段默认规则。部署和真实联调另行安排。
