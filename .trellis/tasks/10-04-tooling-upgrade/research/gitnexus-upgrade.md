# GitNexus 1.6.12 更新研究与项目适配

日期：2026-10-04。范围：GitNexus CLI 来源、索引兼容、项目指引与现有技能。全局安装、索引重建、Git 提交推送由主代理顺序执行；本实施者没有运行 analyze、setup、clean 或真实模型调用，也没有修改全局 MCP 配置。

## 版本与官方来源

| 项目 | 核查结果 |
| --- | --- |
| 更新前全局 CLI | npm 全局安装的 `gitnexus@1.6.4`，PowerShell 入口位于用户 npm bin 目录 |
| 本次稳定版 | `1.6.12`，npm `latest`；发布于 2026-09-12T21:39:39.080Z |
| 更新后本地包 | 根代理安装完成后，读取全局 `package.json` 确认为 `1.6.12`；六个技能均取自该包 |
| Node 要求 | `^22.18.0 || >=24.11.0`；本机 `v22.18.0` 已满足 |
| 未选择渠道 | `rc` 指向 `1.6.13-rc.74`，本任务选择稳定版 |

官方依据：[npm 版本元数据](https://registry.npmjs.org/gitnexus/1.6.12)、[v1.6.12 发布说明](https://github.com/abhigyanpatwari/GitNexus/releases/tag/v1.6.12)、[官方 CLI 参数](https://github.com/abhigyanpatwari/GitNexus/blob/v1.6.12/gitnexus/src/cli/index.ts)。本机另运行 `npm view gitnexus@1.6.12 version engines repository.url dist.tarball --json`，版本、Node 范围、官方仓库与 npm tarball 一致。

该版本发布说明涉及可迁移索引、外部存储与源码保留策略、索引状态未知处理、embedding 批次恢复、数据库 checkpoint 与 Windows 路径解析等更新。发布说明中无破坏性变更的表述相对前一版本，不能据此保证 1.6.4 的现有索引无需重建。

## 索引兼容与维护

更新前 `.gitnexus/meta.json` 记录的提交为 `7126e5741885c2e1474189dc01146866fe63fa2d`，索引时间为 2026-04-27T18:55:38.409Z，`stats.embeddings = 0`。旧版图查询曾出现 FTS 缺失、schema 属性缺失和只读 adapter 错误，旧图不能替代当前源码。

新版分析流程会比较 schema fingerprint；缺失或不同会走完整重建。默认 analyze 会保留已有 embeddings，`--embeddings` 用于生成或补齐，`--drop-embeddings` 才主动清除。因此原项目“未传 --embeddings 就删除已有向量”的说明已删除。依据：[分析流程](https://github.com/abhigyanpatwari/GitNexus/blob/v1.6.12/gitnexus/src/core/run-analyze.ts)、[analyze 实现](https://github.com/abhigyanpatwari/GitNexus/blob/v1.6.12/gitnexus/src/cli/analyze.ts)。

本次主流程使用以下不先删除索引的重建方式；实际执行结果由主代理的验收记录负责：

```powershell
gitnexus analyze --force --no-parse-cache --index-only
gitnexus status
gitnexus query "workflow recovery" --repo .
gitnexus context "WorkflowEngine" --repo .
gitnexus impact "WorkflowEngine" --direction upstream --repo .
gitnexus detect-changes --scope all --repo .
```

日常单次刷新使用 `gitnexus analyze --index-only`。若选择持续 watch，使用独立的 `gitnexus analyze --watch`；watch 自身不注入指引/技能，且不接受 `--index-only`。普通索引替换后，新版 MCP 在后续工具调用重新检查索引，最多约 5 秒一次；升级 MCP 进程本身仍需重新连接，不能把索引热重开等同于二进制热升级。

主代理实测补充：首次 LadybugDB 0.18.3 FTS 扩展安装触发默认 15 秒超时；随后使用 GitNexus 官方包内的 `installDuckDbExtensionOutOfProcess('fts', 45000)`，在独立临时数据库中有界重试，扩展安装成功。因此本次失败不是缺少 Windows 对应二进制，尚不能仅凭超时确定具体网络原因。扩展安装成功与仓库 FTS 索引可用分别验收，后续 `--repair-fts` 和实际 query 结果由主代理记录。

## MCP 接线核查（仅相关键）

更新前，在用户 Codex `config.toml` 的 `[mcp_servers.gitnexus]` 中发现：

```toml
command = "npx"
args = ["-y", "gitnexus@latest", "mcp"]
```

该段未显式设置 `enabled`，未发现该服务的 `env` 配置键。核查过项目 `.mcp.json`、项目 Codex 配置、用户 Claude/Cursor MCP 配置，未在这些已检查位置发现其他 GitNexus 接线。本会话未暴露可直接调用的 GitNexus MCP 工具，因此使用 CLI 只读帮助核对参数。

`@latest` 是浮动版本：全局 CLI 安装版本并不保证现有 MCP 进程或 npx 缓存恰好运行相同版本。若后续另行调整 MCP 配置，可固定到 `gitnexus@1.6.12` 并重连验证。本实施没有更改这些全局配置，也没有读取认证文件或输出凭据。

## 项目模板与技能适配

官方新版将标准技能直接生成到 `.claude/skills/<name>/SKILL.md`，并在 `.agents` 已存在时镜像到 `.agents/skills/<name>/SKILL.md`。对于旧嵌套目录，安装逻辑可能删除与新版模板相同且没有其他文件的旧副本；内容不同则保留并警告。`--skip-agents-md` 只跳过 AGENTS/CLAUDE，不能阻止技能安装；`--index-only` 才跳过所有此类注入。依据：[ai-context.ts](https://github.com/abhigyanpatwari/GitNexus/blob/v1.6.12/gitnexus/src/cli/ai-context.ts)、[标准技能目录定义](https://github.com/abhigyanpatwari/GitNexus/blob/v1.6.12/gitnexus/src/cli/standard-skills.ts)。

本项目因此保留既有 `.claude/skills/gitnexus/<name>/` 与 `.agents/skills/gitnexus/<name>/`，逐项合并六个标准技能，不新增另一套平铺目录。原 `.agents/skills/gitnexus/` 未跟踪；更新前已把 AGENTS、CLAUDE 与两套共十二个技能逐字节保存到本任务忽略目录 `.fusion/gitnexus-before/`，含原内容 SHA-256 清单。该快照不纳入提交。

原有五个非 CLI 技能与旧包模板相同；CLI 技能仅存在编辑器名称替换、重复 AGENTS 名称和过时的自动 hook 说明，没有发现其他未知定制。合并结果：

- 六个技能保留官方 1.6.12 工作流与参数，增加简体中文项目运行约定；两套逐字节一致。
- 仓库显式绑定，linked worktree 检查目标明确；空调用方为 UNKNOWN，partial/truncated 不能当作检查通过。
- 修正 MCP 参数名为 `search_query`、`statement` 等当前接口；补充 trace、路由/形状检查、可选 PDG 的说明，不自动启用额外分析层。
- 所有单次刷新示例带 `--index-only`；默认使用全局 `gitnexus`，仅在 `.gitnexus/run.cjs` 确实存在且确认选中已安装 1.6.12 时才使用本地 launcher。主流程生成的官方 launcher 内部仍有 `NPX_REF = 'gitnexus@latest'`，其下载回退没有锁定版本；本项目不修改生成文件，全局 CLI 不可用时直接使用 `npx --yes gitnexus@1.6.12 <command>`，避免走 launcher 的 latest 分支。检查者已验证当前 `node .gitnexus/run.cjs --version` 为 `1.6.12`。
- hook 说明改为“若已安装则通知过期”，不再声称 Claude/Codex 自动 analyze。保留 clean 的破坏性含义与项目既有确认要求。
- AGENTS 仅替换 GitNexus 管理块，保留自定义中文规范和 Trellis 块；CLAUDE 原 Fusion 全文保留，并追加相同 GitNexus 管理块。

## 最小验证

- 本地 1.6.12 `analyze/query/context/impact/detect-changes --help`：核对本文与项目示例参数，未启动索引或业务执行。
- 静态检查：十二个技能 frontmatter 名称正确；六对内容一致；管理块相同；全部本地技能链接可解析；无重复技能布局。
- 字节检查：AGENTS 自定义前缀、原 Trellis 块与 CLAUDE Fusion 前缀均保留。后续 Trellis 所有者如调整其块，属于独立合并范围。
- 检查单次刷新带 `--index-only`、watch 不带该冲突参数；旧 embeddings 删除和 hook 自动运行说明已清除。
- `git diff --check` 通过。Git 的 LF/CRLF 提示来自当前工作区换行设置，不是空白错误。
- `.fusion/gitnexus-before/manifest.json` 经 `git check-ignore` 确认忽略。本次仅文档/技能适配，无业务测试需要；索引功能验收由主代理统一完成。

## 本实施精确提交文件

```text
AGENTS.md
CLAUDE.md
.claude/skills/gitnexus/gitnexus-cli/SKILL.md
.claude/skills/gitnexus/gitnexus-debugging/SKILL.md
.claude/skills/gitnexus/gitnexus-exploring/SKILL.md
.claude/skills/gitnexus/gitnexus-guide/SKILL.md
.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md
.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md
.agents/skills/gitnexus/gitnexus-cli/SKILL.md
.agents/skills/gitnexus/gitnexus-debugging/SKILL.md
.agents/skills/gitnexus/gitnexus-exploring/SKILL.md
.agents/skills/gitnexus/gitnexus-guide/SKILL.md
.agents/skills/gitnexus/gitnexus-impact-analysis/SKILL.md
.agents/skills/gitnexus/gitnexus-refactoring/SKILL.md
.trellis/tasks/10-04-tooling-upgrade/research/gitnexus-upgrade.md
```

后续边界：最后一次提交后由主代理重新刷新索引并核对 lastCommit；MCP 运行版本须在重连后独立确认。没有把旧索引异常未经验证地宣布为已解决。
