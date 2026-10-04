# Fusion Trellis — Project Instructions

## Context Compaction 行为指导

### 压缩时保留
当上下文被压缩时，务必在摘要中保留:
1. 当前活跃任务的标题和状态
2. 正在编辑的文件列表和行号范围
3. 本 session 已修改但未提交的文件
4. 关键的技术决策及其原因
5. 未解决的阻塞问题

### 压缩后恢复
Compact 完成后，你会看到 `<fusion-post-compact-guide>` 提醒。请按提醒操作:
1. 读取 `.fusion/recovery.json` 恢复执行态
2. 读取 `.fusion/handoff.md` 恢复交接摘要
3. 如果 `.fusion/` 数据已过时，运行 `/fusion:checkpoint` 更新

### 主动保存
不要等 compact 发生才保存。在以下时机**主动**运行 checkpoint:
- 上下文使用率接近 60%
- 每完成一个 plan slice
- 做出重要技术决策后
- 遇到 blocker 时

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

本项目索引名为 **Claude-to-IM**，项目技能基于 **GitNexus 1.6.12**。实时统计与索引版本以 `gitnexus status`、`gitnexus://repo/Claude-to-IM/context` 为准，不把历史计数当成当前状态。

## 运行入口与索引维护

- 从目标工作区根目录运行全局 `gitnexus`；若 `.gitnexus/run.cjs` 存在，也可用 `node .gitnexus/run.cjs`。缺少该脚本时直接用全局 CLI。官方 launcher 的下载回退使用浮动 `gitnexus@latest`；使用前先确认它选中已安装的 1.6.12。全局 CLI 不可用时，直接用 `npx --yes gitnexus@1.6.12 <command>`，避免进入 launcher 的 latest 分支。
- 日常刷新使用 `gitnexus analyze --index-only`，只更新索引，保留自定义 AGENTS、CLAUDE、Trellis、Fusion 和现有技能布局。工具/schema 升级需要完整重建时使用 `gitnexus analyze --force --no-parse-cache --index-only`，不先删除索引。
- 默认刷新保留已有 embeddings；`--embeddings` 用于生成或补齐，只有显式 `--drop-embeddings` 才主动丢弃。可从 `.gitnexus/meta.json` 的 `stats.embeddings` 检查数量。
- 提交后检查索引是否过期并刷新。GitNexus 的 Claude Code PostToolUse hook（若已安装）只提示过期，不自动执行 analyze；不能假设 Codex 或其他编辑器已配置同类 hook。
- 普通索引替换后，运行中的新版 MCP 会在后续工具调用检查并重新打开索引，检查间隔最多约 5 秒；升级 MCP 程序本身仍需重新连接。

## 修改前必须执行

1. 先确认仓库和工作区。MCP 调用显式传 `repo: "Claude-to-IM"`；CLI 传 `--repo .`。使用其他 linked worktree 时，`detect_changes` 还需正确的 `worktree` 路径，不能把另一份检出的空 diff 当作通过。
2. **修改任何函数、类或方法前，必须运行上游影响分析**：`impact({target: "symbolName", direction: "upstream", repo: "Claude-to-IM"})`，或 `gitnexus impact "symbolName" --direction upstream --repo .`。向用户报告直接调用方、受影响执行流和风险等级。
3. **HIGH / CRITICAL 必须先告知用户，再继续修改。** `riskSharedAxes` 不能抵消这一风险提示。
4. `risk: UNKNOWN`、空调用方、查询错误、过期或不完整索引均不是安全结论。先恢复图查询或刷新索引，再用当前源码、文本引用与相关测试补证；不能凭零结果跳过影响分析。
5. 探索概念与执行流先用 `query({search_query: "concept", repo: "Claude-to-IM"})`；查看已知符号用 `context({name: "symbolName", repo: "Claude-to-IM"})`。MCP 不可用时使用 `gitnexus query "concept" --repo .` / `gitnexus context "symbolName" --repo .`。

## 调试与重构

- 调试：`query` 找到相关执行流，`context` 确认调用关系，读取 `gitnexus://repo/Claude-to-IM/process/{name}`，再核对当前源码。`trace` 可查询两符号间的调用路径；动态边界或未找到路径不代表没有联系。
- 重命名：必须先 `rename({symbol_name: "old", new_name: "new", dry_run: true, repo: "Claude-to-IM"})`，核对目标文件、图修改及文本匹配，再应用。禁止用全局查找替换代替符号重命名。
- 提取、拆分：先 `context` 和上游 `impact`，再更新接口、实现、直接调用方与相关测试。
- 安全/依赖分析：`explain` 与 `pdg_query` 需要显式构建 `--pdg` 层。无 PDG 层或无发现不证明代码安全；本项目日常刷新不自动开启额外分析层。

## 提交前必须执行

- 运行 `detect_changes({scope: "all", repo: "Claude-to-IM"})`，或 `gitnexus detect-changes --scope all --repo .`，确认只涉及预期符号和执行流。比较分支时可用 `scope: "compare", base_ref: "main"`（CLI：`--scope compare --base-ref main`）。
- `partial: true` / `truncated: true` 表示检查不完整，必须排查并重新验证；空结果不能代表已通过。核对实际 diff、未跟踪文件与目标工作区，避免图索引漏报。
- d=1 直接调用方必须同步核对；d=2 间接依赖应测试；d=3 传递依赖涉及关键路径时测试。完成相关最小测试后再提交。

## 工具与资源

| 用途 | MCP 入口（均绑定 `repo: "Claude-to-IM"`） |
| --- | --- |
| 概念/执行流 | `query({search_query: "auth validation"})` |
| 符号调用关系 | `context({name: "validateUser"})` |
| 上游影响 | `impact({target: "X", direction: "upstream"})` |
| 变更范围 | `detect_changes({scope: "all"})` |
| 重命名预览 | `rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| 自定义图查询 | `cypher({statement: "MATCH ..."})`；先读取 schema |

资源：`gitnexus://repo/Claude-to-IM/context`、`clusters`、`processes`、`process/{name}`、`schema`。MCP 实际工具名可能带平台前缀，以当前连接提供的工具定义为准。

## 项目技能

保留现有嵌套布局，两套内容同步维护；升级模板时逐项合并，不用普通 analyze 覆盖定制。

| 用途 | Claude Code | Codex / Agents |
| --- | --- | --- |
| 架构探索 | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` | `.agents/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| 影响分析 | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` | `.agents/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| 调试 | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` | `.agents/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| 重构 | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` | `.agents/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| 工具/schema | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` | `.agents/skills/gitnexus/gitnexus-guide/SKILL.md` |
| 索引/CLI | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` | `.agents/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
