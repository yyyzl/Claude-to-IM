# 工具升级独立质量检查

日期：2026-10-04。检查者：`upgrade_quality_check`。结论：本轮项目工具配置与兼容改动通过；没有开放的 P1/P2 功能问题。提交、推送和提交后索引刷新由根代理完成，不能用本报告的提交前索引状态代替最终刷新结果。

## 检查范围与来源

已读取本任务 PRD、check.jsonl、质量/测试/跨层规范，并使用项目 `trellis-check` 与 `gitnexus-cli` 指引。检查者只新增本任务的隔离验证脚本与报告；模板、Fusion 和 GitNexus 文档问题均交还对应所有者修正后复核，没有覆盖并行修改。

独立核查全局 npm 包、CLI 和项目版本：Trellis `0.6.17`，GitNexus `1.6.12`，Node `22.18.0`。全局包目录是用户 npm 标准安装目录；GitNexus 的 Node 版本要求已满足。Trellis 从项目 `0.5.0-beta.15` 迁往稳定版，未把较新的 `0.7.0-beta.4` 当作本次稳定升级目标。

官方固定版本依据：[Trellis 0.6.17 迁移说明](https://github.com/mindfold-ai/Trellis/blob/v0.6.17/packages/cli/src/migrations/manifests/0.6.17.json)、[Codex 生成器](https://github.com/mindfold-ai/Trellis/blob/v0.6.17/packages/cli/src/configurators/codex.ts)、[GitNexus 1.6.12 更新记录](https://github.com/abhigyanpatwari/GitNexus/blob/v1.6.12/gitnexus/CHANGELOG.md)。本机安装包源码另用于核对实际模板、CLI 参数、MCP 环境约束及回退实现。

## Findings（已修复或确认）

- **旧模板收据与平台识别**：旧 flat receipt 不能被新平台检测直接使用。实施者已按上游规范包装 v2；独立读取完整旧备份确认原始 121 键归一为 104 路径，其中 17 组重复、12 组 hash 不同。选择原顺序后值，与官方归一规则一致；没有用当前文件重算 hash 掩盖定制，完整旧值仍在本地备份。最终平台检测返回原有 `claude-code`、`codex`、`gemini` 三平台。
- **Fusion 会话绑定**：共享 helper 和三处 hook 已使用上游会话解析并传递平台、stdin 身份。无身份或陌生身份不会恢复其他窗口任务。独立复跑 5 项临时夹具测试通过，包含 checkpoint/resume 环境身份与非法输入；外层额外阻断网络，测试内部阻断子进程。
- **Codex 初始化链路**：新版官方核心注册是 `UserPromptSubmit` 和 `SubagentStart`，项目额外保留 Fusion `SessionStart`。无任务的每轮入口会提示读取 `trellis-start`，后者完整加载工作流、身份与规范；有任务时注入当前状态。独立新增的 4 项临时项目测试覆盖 bootstrap、子目录任务定位、无身份/陌生身份隔离、skip keyword，全部通过。删除旧核心 SessionStart 注册符合官方生成器，不是遗漏。
- **验证脚本归档路径**：根代理复核发现 `check-codex-bootstrap.py` 使用固定祖先层数，归档后会指向错误目录。已改为向上同时查找 `.trellis/scripts/common` 和 `.codex/hooks` 两个仓库锚点；当前 4 项回归重新通过，同一定位表达式对当前路径、模拟 `tasks/archive/2026-10/…` 路径的两项检查均正确。修改前 impact 对研究目录的测试符号返回 UNKNOWN，已用源码确认只有测试 fixture 读取该常量，风险为 LOW，没有业务调用。
- **定制保留**：实际解析的原 `update.skip` 为 **14 条**，与 HEAD 原段逐字一致；此前沟通中的“13 条”是记录数字错误。AGENTS 自定义前缀、CLAUDE Fusion 前缀保留；规范、身份、工作区及受保护技能没有本轮非预期改动。Codex config 与官方模板一致，`agents.max_depth=1` 未引入模型或 effort 覆盖。新增 `trellis-local` 共享定制索引及 Claude 入口链接可解析。
- **GitNexus 启动回退说明**：自动生成的 `.gitnexus/run.cjs` 内部含 `gitnexus@latest` 下载回退，不能把存在 launcher 等同于固定版本。已要求所有者修正两管理块、两套共 12 个技能及研究说明：先确认已选中本机 `1.6.12`；全局不可用时直接使用固定版 `npx --yes gitnexus@1.6.12`。复核镜像与管理块一致，launcher 本身未修改；实际全局与 launcher `--version` 均为 `1.6.12`。
- **GitNexus 指引准确性**：单次 analyze 示例使用 `--index-only`，watch 单独说明且不带该冲突参数；新版本默认保留既有 embeddings，仅显式 `--drop-embeddings` 删除。六对技能逐字相同、frontmatter 名称和管理块本地链接有效，无额外平铺重复布局。未知、过期或不完整图结果没有被写成安全通过。

## Verification

| 检查 | 实际结果 |
| --- | --- |
| 独立 `npm run typecheck` | 通过，exit 0，约 6.8 秒 |
| Lint | package.json 没有独立 lint 命令；`git diff --check` 通过 |
| Python / JSON / TOML | 独立解析当前变更的 36 个 Python 文件及相关 5 份 JSON、6 份 TOML，通过；实施者另覆盖全部相关 46 个 Python 文件 |
| YAML / hooks | 官方配置解析器确认 14 条 skip；注册、无模型覆盖、官方 Codex config 比对通过 |
| Fusion 临时夹具 | 5/5，通过，约 0.084 秒；没有读取真实会话或运行真实桥接 |
| Codex bootstrap 临时项目 | 4/4，通过，归档定位修复后复跑约 1.28 秒；当前/模拟归档路径定位 2/2。单个子进程 5 秒超时，网络和嵌套子进程阻断 |
| MCP 离线握手 | 项目现有 SDK 启动已安装全局 CLI，initialize / list_tools 通过，服务版本 `1.6.12`，13 个只读工具；包含 query/context/impact/detect_changes/list_repos |
| 升级后干运行与最终格式差异 | 第二次干运行无新增、自动更新或待迁移，显示三项配置定制；随后暂存区校验修正四份上游 Markdown 的纯格式问题且未改 receipt，最终已知预期差异为 **3 项配置 + 4 项文档 = 7 项**。详见 [Trellis 升级记录](trellis-upgrade.md) 的最终复查说明；运行目录无 `.new` |
| 改动范围 | `src/`、桥接 runner、package.json/package-lock.json 没有本轮 diff；未更改全局 MCP、模型配置或凭据 |

离线 MCP 验证通过 `gitnexus-mcp-handshake.mjs` 和 `gitnexus-offline-preload.mjs` 进行，只运行临时 stdio 实例。没有读取业务环境变量，关闭更新提示并阻断网络；完成后关闭自己的子进程。早期测试脚本曾使用 Windows 文件路径作为 `--import` 导致 ESM 路径错误，已改为 file URL 后通过，属于验证脚本问题。

根代理提供的 CLI 验收证据单独记录：FTS 扩展安装及 `analyze --repair-fts --index-only` 成功；query 返回 5 个执行流并有 BM25 计时；context `WorkflowEngine` 返回 found/exact；用完整 UID 对 `processMessage` 做 upstream impact 返回 14 个受影响项、CRITICAL；status 为 up-to-date，doctor 确认 Graph 与 Full-text 可用，97 个覆盖文件匹配提交 `478483c`。这些是根代理实际执行的 CLI 结果，不是本次 MCP 握手测试替代执行。

## Findings（未修复）与验证边界

没有需要留给用户决定的实现缺口。以下是明确的验收边界：

- 未运行真实模型、IM、生产会话或真实用户 hook。Codex 宿主是否已启用用户级 hooks、是否完成 `/hooks` 首次批准，仍取决于原有宿主设置；本轮没有擅自修改。未声明临时 MCP 握手已经重连用户原有 MCP 进程。
- GitNexus 索引原有 embeddings 为 0，本轮没有新增 VECTOR/语义向量依赖；图与全文检索已恢复，不把未安装的可选向量扩展当成回归。
- 隐藏目录内 Fusion 符号不在 GitNexus 当前图中，实施者已记录 impact 查不到及源码调用关系补证，并在编辑前告知 HIGH 工作流风险。
- 最终提交后根代理仍需执行 `analyze --index-only` 并核对最终 lastCommit；备份、任务 `.fusion` 和原始 `trellis-*.txt` 命令日志不进入提交。

## 工具调用简报

使用 PowerShell/Python/Git/npm 读取最小项目范围并执行类型、格式、配置及隔离回归检查；使用项目 MCP SDK 对本地 GitNexus 做离线握手；用官方固定版本源码校验发布与接口合同；通过协作消息把文档准确性问题交还所有者并复核修复。没有调用生产接口或更改用户全局配置。
