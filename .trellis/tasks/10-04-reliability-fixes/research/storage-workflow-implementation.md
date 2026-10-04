# 存储与工作流修复交付

## 已实施

- `scripts/claude-to-im-bridge/store.ts`：异步串行 flush、临时文件 fsync 后同目录替换、上一代有效备份、损坏原件保留、无有效数据时拒绝空载启动；失败可见并可重试。close 开始即禁止持久化新变更，拒绝发生在修改内存前。投递记录复制写入/读取、重启恢复、字段校验，已送达元数据上限 100，失败/待发记录保留。
- `scripts/claude-to-im-bridge/shutdown.ts`、`scripts/feishu-claude-bridge.ts`：桥接、模型、存储各有 5 秒排空上限，一个步骤挂起仍尝试后续落盘；fatal、排空/保存失败退出非零，不再按通用 socket 错误码吞掉进程级异常。测试只导入纯 helper，没有运行 runner。
- `workflow-store.ts`、`atomic-file.ts`：meta、ledger、快照和产物原子写；同进程跨 Store 对象的 meta 更新串行；所有 run ID 在路径拼接前校验。
- `run-lock.ts`、`workflow-engine.ts`：单机独占执行者锁，存活 PID/其他主机/损坏归属一律保守拒绝；只恢复可确认退出的 owner。恢复者自身退出留下的 guard 使用固定长度的分代名字继续争抢，不移动新的 owner 锁。暂停等待原执行排空，并在持锁时保存 paused 状态。
- `diff-reader.ts`：commit/range/branch 先解析不可变 Git 对象；staged 使用 index tree，unstaged 用独立临时索引捕获已跟踪文件。diff、正文 blob 和元数据引用相同 tree；删除文件从 diff 基线读取。测试环境默认 Git 入口拒绝，必须显式 fake。
- `auto-fixer.ts`、`types.ts`：消费冻结 tree；需要时用独立基线提交重建未提交审查状态；每次 attempt 都创建唯一分支/工作树，不删除旧产物。删除代码块覆盖整个文件的兜底。限制目标为已审查文件，校验真实路径、变更范围、模型/验证后的 HEAD；提交后核对 parent、路径和 tree，拒绝 hooks 夹带。失败停止后续组、保留现场。精确记录 base/head/实际提交、完整 patch、manifest。默认标记候选，只有显式验证通过才计入 fixed。
- CLI 和飞书 `workflow-command.ts`：展示候选与验证通过数量；只提示应用实际候选提交，提醒先保存并提交原审查改动、确认目标包含审查基线且干净，不再提示 `git diff | git apply` 或合并包含原基线的整条分支。
- SW-6 最小修复：步骤内部重试耗尽后保存同一轮、同一步并暂停；恢复 Claude 决策不重新调用已经成功的 Codex 审查，不再通过进入新轮次重复整段超时调用。

## 影响分析

记录：`storage-impact.json`、`storage-impact-extra.jsonl`、`storage-path-impact.json`。

- 存储 save LOW、scheduleSave MEDIUM；影响会话/绑定/消息/offset 保存链。
- snapshot/blob/scope 解析 CRITICAL，CLI 与 IM 两个审查入口共 5 条流程。
- applyFixes/createWorktree/buildFixPrompt/删除兜底 HIGH，CLI 与 IM review-fix 共 4 条流程。
- resume/pause/runLoop CRITICAL，CLI 与 IM 的恢复/停止流程。
- runDir CRITICAL，17 个直接调用方、15 条流程；仅收紧合法 run ID，不修改正常路径布局。
- 均先执行工具并向用户预告 HIGH/CRITICAL，图中缺失/歧义用精确 UID 与当前源码补证。索引不包含当前未提交差异，最终范围由根统一 detect_changes。

## 验证

- 新增 `bridge-json-store.test.ts` 7 项、`bridge-runner-shutdown.test.ts` 2 项、`workflow-reliability.test.ts` 17 项：共 26 项隔离回归通过。
- 全部 `workflow-*.test.ts` + 上述两个 bridge 测试通过，单次约 3 秒；单项 timeout 15 秒，总运行未超过 60 秒。
- `npm run typecheck` 通过。
- 本负责人涉及文件 `git diff --check` 通过。全仓最终检查由根整合。
- 未调用真实模型或飞书；Git/worktree/commit 分支均 fake，没有执行用户仓库真实删除/提交。文件成功路径仅用专用临时目录与合成数据；写故障、进程退出和卡住情况显式 mock。

## 诚实边界

- 旧版 `running` 若没有执行者锁协议标记，无法确认旧进程是否仍活着，保持拒绝；先确认旧进程退出，再人工将其置 paused 才可恢复。损坏/归属未知锁保留材料并明确人工处理方式。PID 复用按仍活跃保守拒绝。
- 旧快照没有 `head_tree` 时拒绝自动修复，需重新审查；没有猜测从当前 HEAD 修复。
- 验证回调是显式宿主入口，CLI/IM 尚未配置具体项目检查，正常输出会诚实标记“候选、验证通过 0”，不会假报已修好。
- 自动修复一组失败后停止后续组；成功候选提交仍可审阅，失败现场保留，未尝试的问题单独列出。没有增加默认清理机制。
- JSON 宿主依然是单进程存储，未做 SQLite/多 runner 事务迁移、历史归档或自动删除聊天记录。文件原子替换不等于跨多个产物的数据库事务。
- 总费用/token 预算、总 deadline、提示词所有区块的预算重构属 P2，本轮仅消除了重复轮次重试；不虚构调用费用或预算能力。
