---
name: trellis-local
description: "维护本项目 Trellis 与 Fusion 定制、升级模板或调整上下文和 hooks 时读取。"
---

# 本项目 Trellis 定制

基线：官方 `@mindfoldhq/trellis@0.6.17`，2026-10-04。本文件是定制索引，使用新版项目内 `trellis-meta` 理解上游架构；不要修改用户全局技能来记录项目规则。

## 保留的定制

- `.agents/skills/` 下 Fusion 七项能力：brainstorm-plus、write-task-plan、execute-plan-tdd、harvest-learnings、systematic-debugging、review-with-agents、context-continuity。
- `.claude/commands/fusion/`、`.trellis/scripts/fusion/` 及 Claude Fusion SessionStart/PreCompact hooks。
- `.codex/skills/checkpoint/`、`.codex/skills/resume-context/` 和 Codex Fusion SessionStart hook。
- `.trellis/config.yaml` 的 14 条 `update.skip` 保持原值。规范、任务、工作区、身份与当前会话状态属于项目数据。
- `AGENTS.md` 只更新 `TRELLIS:START/END` 托管段，保留用户要求及 GitNexus 段。`CLAUDE.md` 的 Fusion 说明也要保留。

Fusion 的恢复数据格式保持不变。共享 `get_task_dir_from_current` 通过 `common.paths.get_current_task_abs` 解析会话；Claude/Codex hooks 传入 stdin 会话信息及平台名，checkpoint/resume 使用上游环境会话识别。不要回退读取 `.trellis/.current-task`，也不要在缺少身份时猜测唯一活跃任务。

## Hook 合并约定

Claude 保留上游 SessionStart、PreToolUse、UserPromptSubmit，并追加 Fusion SessionStart 与 PreCompact。Codex 保留新版 UserPromptSubmit、SubagentStart，并单独登记 Fusion SessionStart；不要复活上游已经移除的旧核心 SessionStart 注册。

Codex agent 模型与 effort 由用户配置或父代理继承，不新增硬编码模型。项目 `.codex/config.toml` 使用上游生成值；用户级 hooks 开关及信任设置不由本项目升级擅自修改。

## 升级方式

先固定版本并运行 `trellis update --migrate --dry-run`，审查备份后用 `--create-new`，逐项合并，禁止用 `--force` 覆盖。上游模板更新会新增文件、清理 hash 匹配的废弃文件；`.new` 未合并时版本 stamp 仍可能已更新，因此不能只看版本号判断完成。

从本项目旧 `0.5.0-beta.15` 升级时曾遇上游兼容边界：新版舍弃旧 flat receipt，但平台识别依赖 v2 receipt，导致平台列表为空。一次性修复仅把旧键规范为 POSIX 并包装 v2，依官方键归一顺序取后值，保留原 hash；完整旧值先备份。不得用当前文件重新计算 receipt 来掩盖定制。以后 v2 正常更新无需重复此步骤。

## 验证

```text
python -B .trellis/scripts/fusion/tests/test_context.py
trellis platforms --json
python .trellis/scripts/task.py current --source
python .trellis/scripts/get_context.py --mode packages
trellis update --migrate --dry-run
git diff --check
```

另外检查变动 Python AST、JSON/TOML 配置语法、Fusion hook 注册、原 skip 列表和被保护文件。测试使用临时夹具并阻断子进程，不读取真实会话或运行桥接。

本次完整依据与结果见 `.trellis/tasks/10-04-tooling-upgrade/research/trellis-upgrade.md`；归档后在对应 tasks/archive 目录查找。备份、`.new` 和命令输出不是提交内容。
