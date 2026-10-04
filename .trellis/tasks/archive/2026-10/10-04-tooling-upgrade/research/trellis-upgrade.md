# Trellis 升级记录

## 来源与版本

2026-10-04 核验：项目 `.trellis/.version` 为 `0.5.0-beta.15`，全局 CLI 为 `0.5.9`，安装位于普通 npm 全局目录，非本地仓库符号链接。官方 npm `latest=0.6.17`、`beta=0.7.0-beta.4`、`rc=0.6.0-rc.0`；本次选稳定版 `0.6.17`。

- [官方 npm 包](https://www.npmjs.com/package/@mindfoldhq/trellis)
- [固定版本更新源码](https://github.com/mindfold-ai/Trellis/blob/v0.6.17/packages/cli/src/commands/update.ts)
- [Codex 生成器](https://github.com/mindfold-ai/Trellis/blob/v0.6.17/packages/cli/src/configurators/codex.ts)
- [最新版本说明](https://github.com/mindfold-ai/Trellis/blob/v0.6.17/packages/cli/src/migrations/manifests/0.6.17.json)

`trellis-meta` 技能仍描述 `0.4.0-beta.8`，仅用于理解定制记录原则，实际升级以固定版本源码和包为准。此前两项迁移任务仍为 planning，但现有技能及代理路径已采用 `trellis-` 前缀，不把任务元数据当成迁移执行证据。

## 实施前影响与保留项

这次涉及共享上下文、任务解析脚本、Claude/Codex hooks、代理及技能模板，按 HIGH 工作流变更处理；不触碰业务源码或用户全局配置。

项目的 Fusion 7 项技能、`.claude/commands/fusion/`、Fusion hooks/scripts、Codex checkpoint/resume-context 由现有 14 条 `update.skip` 保护。此前没有项目 `trellis-local` 技能，定制说明散布在 `.trellis/custom-trellis-maintenance.md` 和 `fusion-workflow*.md`。

官方更新器不会自动合并所有自定义 hook 注册；必须把 Fusion SessionStart/PreCompact 登记合并到新版配置，不能直接整份替换。Codex 新版增加 SubagentStart 注入，保留上游入口与 Fusion 入口。Codex agent 的模型与 effort 定制键由生成器保留；不硬编码新模型。

官方全部迁移 manifest 与本仓路径比对，仅发现 4 项存在且 hash 原样的旧技能清理：`.agents/skills/{before-backend-dev,before-frontend-dev,check-backend,check-frontend}/SKILL.md`，已有统一 `trellis-before-dev` / `trellis-check` 替代。无现存 rename 来源。历史 safe-file-delete 独立于版本 stamp；实际以安装完成后的 dry-run 为准。

`--create-new` 仅保护自改文件的冲突：未改模板仍自动更新、新文件仍新增、hash 安全删除仍执行，版本 stamp 仍会上升。新配置段可能按 sentinel 追加；模板 hash 会升级为 POSIX v2。不能以版本 stamp 单独认定升级完成，也不使用 `--force`。

## 执行与验证

根代理负责全局安装。项目内顺序：`trellis update --migrate --dry-run` → 记录预览/备份 → `trellis update --migrate --create-new` → 逐项合并 `.new` → 最小验证与二次 dry-run。

验证范围：CLI/项目版本、平台识别、当前任务及 JSON 输出、package/spec 发现、Python AST、JSON/TOML 配置语法、Fusion 注册/skip/自定义文件保留、用户 specs/tasks/workspace 不丢失、`git diff --check`。不运行 hooks、生产会话读取或真实桥接。

正式升级完成：官方更新器处理 83 个新增文件、51 个原样模板自动更新、6 个冲突文件，删除 4 个已确认 hash 原样的废弃技能。新增内容仅属于既有 Claude/Codex/Gemini 平台和公共 Trellis 模板；不是新增平台。

六项冲突逐一处理：workflow.md 和 Claude inject-subagent-context.py 已验证与官方 0.5.0-beta.15 包原文一致，直接接收 0.6.17；config.yaml 采用新版默认加原 14 条 skip；Claude settings 和 Codex hooks 保留 Fusion 注册；AGENTS.md 只替换 Trellis 托管段，保留同期 GitNexus 和用户段。`.new` 原件已移入任务备份，未遗留在运行路径。

原 receipt、30 项定制文件和合并前 `.new` 保存在本任务 `.fusion/trellis-before-upgrade/`；官方也生成了升级备份。备份及原始命令日志不纳入提交。

已执行 `python -B .trellis/scripts/fusion/tests/test_context.py`：5/5 通过，0.099 秒。覆盖两平台不同会话独立绑定、未知/无身份不读取全局旧指针或唯一他人会话、checkpoint/resume 环境身份、三处 hook 传递 stdin 身份和平台、非对象 hook JSON。全部数据为临时夹具，测试清空环境并阻断子进程。

最终复查：46 个 Python 文件 AST、4 份 JSON、6 份 TOML 解析通过；通过上游配置解析器核验 YAML、14 条 skip 和 worker_guard 默认值；Claude/Codex 的上游与 Fusion hook 注册断言通过；备份的其他定制文件没有非预期变化；运行目录无 `.new`。模板合并后的第二次 dry-run 已无新增、自动更新或待迁移项，只剩三份定制配置冲突：config.yaml、Claude settings、Codex hooks。

后续暂存区检查覆盖此前未跟踪的新增模板，发现四份上游 Markdown 的空白问题：`.agents/skills` 与 `.claude/skills` 两套 `trellis-channel/references/command-reference.md` 删除末尾多余空行；两套 `trellis-meta/references/local-architecture/workspace-memory.md` 第 56/57 行的双空格硬换行改成 CommonMark 反斜杠显式换行，保留显示语义。两套同步，仅格式变化，不改 receipt hash。此后 dry-run 会额外报告这四项可解释的本地格式冲突，合计七项；不能再把“三项配置冲突”当作最终总数。

`get_context.py --mode packages` 正确识别单仓库 backend/frontend 规范。无自身会话绑定的检查子代理执行 `task.py current --source/--json` 返回 none，这是新版禁止猜测其他会话任务的正确结果；根代理的已绑定会话仍返回本任务。未用读取真实会话文件来验证，隔离夹具已覆盖绑定与空身份。

## 正式预览发现的旧 receipt 边界

0.6.17 的 `loadHashes()` 会舍弃旧 flat JSON，而新版 `getConfiguredPlatforms()` 只从 v2 receipt 中的平台托管路径判断是否已安装。两者组合使本仓首次 `trellis platforms --json` 返回空列表；初始 dry-run 只列出核心 `.trellis` 模板与 AGENTS.md，漏掉已有 Claude/Codex。这是源码合同及实际命令均已确认的兼容缺口。

处理方式经根确认：先把原 receipt 备份到本任务 `.fusion`，仅规范路径分隔符并包装为 `{ "__version": 2, "hashes": { ... } }`，保留全部原 hash 值，不用当前文件内容重新计算，以免把定制误报为上游原样。旧 CRLF hash 不匹配时保守归入 modified，再通过 `.new` 人工比对；之后重新跑 platforms/dry-run 才执行模板更新。

另发现 Fusion 的共享恢复 helper 及三处 hook 仍直接读取已废弃全局 `.current-task`。本次兼容修复会统一转调 `common.paths.get_current_task_abs` 并传递 hook 输入与平台；checkpoint/resume 保持原调用与数据格式，利用上游环境会话解析。删除重复旧解析兜底，避免误恢复其他窗口任务。

## 修改前影响分析

升级前及新索引完成后均调用 GitNexus upstream impact：`recovery_io.get_task_dir_from_current`，Claude SessionStart/PreCompact 的 main 与待删除旧 helper，Codex SessionStart 的 main 与待删除旧 helper，共 7 个既有符号。新图仍返回 target not found（隐藏目录不在图中），已记录此限制，没有用缺失结果声称零影响。

源码直接调用关系：recovery helper → checkpoint.main、resume.main、Claude 两 hook.main；Codex 原私有 helper → Codex hook.main，现改为同一共享 helper。三 hook 分别由项目 settings/hooks JSON 注册。自动模板升级覆盖任务/上下文脚本和三平台 agent/skill/hook，按 HIGH 工作流风险在编辑前告知用户和根，采用原文件备份、逐冲突合并和隔离回归。未修改业务源码或全局配置。

## Receipt 重复键选择

原始 121 键归一为 104 路径，共 17 组重复：5 组同 hash、12 组不同。均采用原 JSON 中后出现的值，与上游 normalizeHashKeys 的赋值顺序一致；不计算当前文件 hash 来替代收据。完整旧键和值保留在备份中。

| 路径 | 原值关系 | 选择 |
| --- | --- | --- |
| `.trellis/scripts/__init__.py` | 相同 | 原顺序后值 |
| `.trellis/scripts/common/__init__.py` | 不同 | 原顺序后值 |
| `.trellis/scripts/common/paths.py` | 不同 | 原顺序后值 |
| `.trellis/scripts/common/developer.py` | 不同 | 原顺序后值 |
| `.trellis/scripts/common/git_context.py` | 不同 | 原顺序后值 |
| `.trellis/scripts/common/worktree.py` | 相同 | 原顺序后值 |
| `.trellis/scripts/common/task_queue.py` | 不同 | 原顺序后值 |
| `.trellis/scripts/common/task_utils.py` | 不同 | 原顺序后值 |
| `.trellis/scripts/common/registry.py` | 不同 | 原顺序后值 |
| `.trellis/scripts/common/cli_adapter.py` | 不同 | 原顺序后值 |
| `.trellis/scripts/common/config.py` | 不同 | 原顺序后值 |
| `.trellis/scripts/get_developer.py` | 相同 | 原顺序后值 |
| `.trellis/scripts/init_developer.py` | 相同 | 原顺序后值 |
| `.trellis/scripts/task.py` | 不同 | 原顺序后值 |
| `.trellis/scripts/get_context.py` | 相同 | 原顺序后值 |
| `.trellis/scripts/add_session.py` | 不同 | 原顺序后值 |
| `.trellis/config.yaml` | 不同 | 原顺序后值 |
