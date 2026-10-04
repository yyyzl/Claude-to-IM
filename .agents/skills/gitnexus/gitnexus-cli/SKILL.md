---
name: gitnexus-cli
description: "Use when the user needs to run GitNexus CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: \"Index this repo\", \"Reanalyze the codebase\", \"Generate a wiki\""
---

# GitNexus CLI Commands

## 本项目运行约定（GitNexus 1.6.12）

本技能基于官方 1.6.12 模板，保留项目现有嵌套目录。仓库名为 `Claude-to-IM`；MCP 调用显式传 `repo: "Claude-to-IM"`，CLI 在目标工作区根目录运行；`query`、`context`、`impact`、`detect-changes` 等支持仓库选择的命令用 `--repo .` 绑定当前检出。

以下 CLI 示例使用已安装的 `gitnexus`。若 `.gitnexus/run.cjs` 存在，可将命令前缀替换为 `node .gitnexus/run.cjs`；文件不存在时直接使用全局 CLI，不执行缺失的脚本。官方 launcher 的下载回退使用浮动 `gitnexus@latest`；使用前先确认它选中已安装的 1.6.12。全局 CLI 不可用时，直接用 `npx --yes gitnexus@1.6.12 <command>`，避免进入 launcher 的 latest 分支。先用 `--version` 确认实际版本，升级需遵循用户授权范围。

日常单次索引刷新统一使用 `gitnexus analyze --index-only`，保留自定义 AGENTS、CLAUDE、Fusion 和两套技能布局。不要为单次刷新索引运行 `setup` 或省略 `--index-only`；持续 watch 的独立约定见 CLI 技能。MCP 不可用时用 CLI 的 `query`、`context`、`impact`、`detect-changes` 继续检查；图查询失败、`UNKNOWN` 或过期结果必须结合当前源码补证，不能作为检查通过的依据。

## Commands

### analyze — Build or refresh the index

```bash
gitnexus analyze --index-only
```

Run from the project root. This parses all source files, builds the knowledge graph, writes it to `.gitnexus/`, and leaves CLAUDE.md / AGENTS.md and skills unchanged in this project because `--index-only` is set.

| Flag           | Effect                                                           |
| -------------- | ---------------------------------------------------------------- |
| `--index-only` | Skip all AGENTS.md / CLAUDE.md / skill injection; required for this project's normal one-shot refresh. |
| `--no-parse-cache` | Re-parse every source file; combine with `--force` for a schema/tooling upgrade. |
| `--watch`      | Keep a Git repository index current with serialized refreshes    |
| `--debounce <ms>` | Watch quiet period before refresh (default: 300 ms)            |
| `--force`      | Force full re-index even if up to date                           |
| `--embeddings` | Enable embedding generation for semantic search (off by default) |
| `--drop-embeddings` | Drop existing embeddings on rebuild. By default, an `analyze` without `--embeddings` preserves them. |
| `--pdg` | Build the program-dependence layers used by `explain` and `pdg_query` (taint, CDG, and REACHING_DEF). |
| `--spring-actuator <path>` | Import opt-in Spring Boot Actuator mappings, beans, conditions, configprops, and env snapshots. Forces a full rebuild; unsupported with `--watch`. |
| `--asyncapi-spec <path>` | Read opt-in AsyncAPI 3.x documents (directory or single file) and mint `Destination` nodes from their operations. 2.x is refused, not mapped. Unsupported with `--watch`. |

**When to run:** First time in a project, after major code changes, or when `gitnexus://repo/{name}/context` reports the index is stale. If the GitNexus Claude Code PostToolUse hook is installed, it detects staleness after `git commit` and `git merge` and notifies the agent to run `analyze` — the hook does not run analyze itself, to avoid blocking the agent for up to 120s and risking KuzuDB corruption on timeout.

For Spring runtime enrichment, pass a JSON bundle, one endpoint JSON file, or a directory containing endpoint files. Route evidence is authoritative only when `runtimeConfirmed === true`; `runtimeSource` records provenance and may also accompany `handler-conflict`. Env/configprops values are never persisted.

## Index storage and retention

Default location is `<repo>/.gitnexus/`. Override with environment variables (also documented in README):

| Env | Effect |
| --- | ------ |
| `GITNEXUS_STORAGE_PATH` | One complete external index directory. Wins if both storage vars are set. |
| `GITNEXUS_STORAGE_ROOT` | Absolute root; GitNexus creates an isolated `<repo-basename>-<12-hex>/` slot per repository. |
| `GITNEXUS_CONTENT_RETENTION` | `full` (default) keeps file text; `symbol` keeps snippets; `none` keeps the graph only. |

`list_repos`, `gitnexus://repo/{name}/context`, and HTTP `GET /api/repos` / `GET /api/repo` expose `storagePath`, `contentRetention`, and `sourceAvailable`. HTTP `/api/file` and `/api/grep` return 410 unless retention is `full`. MCP `include_content` may still return symbol spans when retention is `symbol`.

Use `gitnexus analyze --watch` for a long-lived local Git repository. It performs an initial analysis, queues scanner-admitted file changes, and retries intact failed batches with bounded backoff. Watch refreshes update only the graph: they skip AGENTS.md / CLAUDE.md injection and standard skill installation, so documentation/skill upgrades remain a separate reviewed merge in this project. Watch rejects one-shot or context-output flags including `--force`, embedding flags, `--skills`, `--default-branch`, `--skip-agents-md`, `--skip-skills`, `--no-stats`, `--self-commit`, `--index-only`, and `--skip-git`. It never pulls remotes. Scheduled remote clone/pull is a different command: `gitnexus auto-sync`. Bare `gitnexus watch` is reserved and does not start either job. Running MCP and `serve` processes periodically check for a published replacement and reopen it without a restart. MCP checks are throttled to once every five seconds, so a tool call before the next check can briefly use the previous index.

### status — Check index freshness

```bash
gitnexus status
```

Shows whether the current repo has a GitNexus index, when it was last updated, and symbol/relationship counts. Use this to check if re-indexing is needed.

### clean — Delete the index

```bash
gitnexus clean
```

Deletes the `.gitnexus/` directory and unregisters the repo from the global registry. This deletes files and requires the user's explicit approval under this project's rules. For an upgrade, first use a non-deleting rebuild with `analyze --force --no-parse-cache --index-only`.

| Flag      | Effect                                            |
| --------- | ------------------------------------------------- |
| `--force` | Skip confirmation prompt                          |
| `--all`   | Clean all indexed repos, not just the current one |

### wiki — Generate documentation from the graph

```bash
gitnexus wiki
```

Generates repository documentation from the knowledge graph using an LLM. HTTP providers require an API key (saved to `~/.gitnexus/config.json` on first use). Local CLI providers (`--provider cursor|claude|codex|opencode|grok`) use your existing CLI login.

| Flag                | Effect                                    |
| ------------------- | ----------------------------------------- |
| `--force`           | Force full regeneration, also required to re-generate an existing wiki in a different language |
| `--provider <name>` | LLM provider: minimax, openai, openrouter, azure, custom, cursor, claude, codex, opencode, or grok (default: minimax). Local CLIs (`cursor`, `claude`, `codex`, `opencode`, `grok`) use your existing CLI login and skip `--api-key`. |
| `--model <model>`   | LLM model (default: MiniMax-M3)           |
| `--base-url <url>`  | LLM API base URL                          |
| `--api-key <key>`   | LLM API key                               |
| `--concurrency <n>` | Parallel LLM calls (default: 3)           |
| `--timeout <seconds>` | LLM request timeout in seconds (default: disabled) |
| `--retries <n>`     | Max LLM retry attempts per request (default: 3) |
| `--lang <lang>`     | Output language for generated documentation (e.g. english, chinese, spanish, japanese) |
| `--gist`            | Publish wiki as a public GitHub Gist      |

### list — Show all indexed repos

```bash
gitnexus list
```

Lists all repositories registered in `~/.gitnexus/registry.json`. The MCP `list_repos` tool provides the same information.

## After Indexing

1. **Read `gitnexus://repo/{name}/context`** to verify the index loaded
2. Use the other GitNexus skills (`exploring`, `debugging`, `impact-analysis`, `refactoring`) for your task

## Troubleshooting

- **"Not inside a git repository"**: Run from a directory inside a git repo
- **Index is stale after re-analyzing**: Wait for the next MCP tool call to reopen the published index; this normally takes no more than five seconds
- **Embeddings slow**: Omit `--embeddings` (it's off by default) or set `OPENAI_API_KEY` for faster API-based embedding
