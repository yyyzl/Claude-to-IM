---
name: gitnexus-impact-analysis
description: "Use when the user wants to know what will break if they change something, or needs safety analysis before editing code. Examples: \"Is it safe to change X?\", \"What depends on this?\", \"What will break?\""
---

# Impact Analysis with GitNexus

## 本项目运行约定（GitNexus 1.6.12）

本技能基于官方 1.6.12 模板，保留项目现有嵌套目录。仓库名为 `Claude-to-IM`；MCP 调用显式传 `repo: "Claude-to-IM"`，CLI 在目标工作区根目录运行；`query`、`context`、`impact`、`detect-changes` 等支持仓库选择的命令用 `--repo .` 绑定当前检出。

以下 CLI 示例使用已安装的 `gitnexus`。若 `.gitnexus/run.cjs` 存在，可将命令前缀替换为 `node .gitnexus/run.cjs`；文件不存在时直接使用全局 CLI，不执行缺失的脚本。官方 launcher 的下载回退使用浮动 `gitnexus@latest`；使用前先确认它选中已安装的 1.6.12。全局 CLI 不可用时，直接用 `npx --yes gitnexus@1.6.12 <command>`，避免进入 launcher 的 latest 分支。先用 `--version` 确认实际版本，升级需遵循用户授权范围。

日常单次索引刷新统一使用 `gitnexus analyze --index-only`，保留自定义 AGENTS、CLAUDE、Fusion 和两套技能布局。不要为单次刷新索引运行 `setup` 或省略 `--index-only`；持续 watch 的独立约定见 CLI 技能。MCP 不可用时用 CLI 的 `query`、`context`、`impact`、`detect-changes` 继续检查；图查询失败、`UNKNOWN` 或过期结果必须结合当前源码补证，不能作为检查通过的依据。

## When to Use

- "Is it safe to change this function?"
- "What will break if I modify X?"
- "Show me the blast radius"
- "Who uses this code?"
- Before making non-trivial code changes
- Before committing — to understand what your changes affect

## Bind the repository first

Impact analysis is the gate that authorizes an edit, so it must answer for the
repository you are about to edit.

Call `list_repos {}` before the first tool call. With one indexed repository,
use the examples below as written. With more than one, pass `repo` on every
call: an omitted `repo` normally errors, but under an MCP policy with a
configured default it resolves to that default silently. If you cannot tell
which repository is meant, stop and ask — every result below an ambiguous
identity inherits the ambiguity. `list_repos` is paginated, so page with
`offset: pagination.nextOffset` until `hasMore` is false before concluding a
repository is absent.

`detect_changes` takes `worktree` when your changes are in a linked worktree
the MCP server was not launched from. The server auto-detects a worktree only
when it was launched from inside one; otherwise `git diff` runs in the wrong
checkout and reports zero changed symbols — a false clean check that carries
none of the degradation flags described below. In the CLI fallbacks, `--repo .`
means the current checkout; pass the intended repository path instead when you
are not standing in it.

State the bound identity with your risk report:

```
Repository: <name> (<path>)   Worktree: <path>   Index: <commit>, <n> behind HEAD
```

## Workflow

```
0. list_repos {}                                           → Bind repo (and worktree)
1. impact({target: "X", direction: "upstream"}) or `gitnexus impact "X" --direction upstream --repo .`
2. READ gitnexus://repo/{name}/processes                   → Check affected execution flows
3. detect_changes({scope: "all"}) or `gitnexus detect-changes --scope all --repo .`
4. Assess risk and report to user, echoing repo/worktree/index identity
```

> If "Index is stale" → run `gitnexus analyze --index-only` in terminal.

## Checklist

```
- [ ] list_repos {} — bind repo; explicit repo when >1 indexed, ask if ambiguous
- [ ] impact({target, direction: "upstream"}) or CLI fallback to find dependents
- [ ] Review d=1 items first (these WILL BREAK)
- [ ] Check high-confidence (>0.8) dependencies
- [ ] READ processes to check affected execution flows
- [ ] detect_changes({scope: "all"}) or CLI fallback for pre-commit check
- [ ] Confirm the checkout you edited is the checkout that was diffed
- [ ] Assess risk level and report, stating repo/worktree/index identity
```

## Understanding Output

| Depth | Risk Level       | Meaning                  |
| ----- | ---------------- | ------------------------ |
| d=1   | **WILL BREAK**   | Direct callers/importers |
| d=2   | LIKELY AFFECTED  | Indirect dependencies    |
| d=3   | MAY NEED TESTING | Transitive effects       |

## Risk Assessment

| Affected                       | Risk     |
| ------------------------------ | -------- |
| <5 symbols, few processes      | LOW      |
| 5-15 symbols, 2-5 processes    | MEDIUM   |
| >15 symbols or many processes  | HIGH     |
| Critical path (auth, payments) | CRITICAL |
| **Zero callers found**         | **UNKNOWN** |

`UNKNOWN` is not a low rung on this scale — it means the walk could not answer.
An empty caller set is equally consistent with "genuinely unused" and "the
callers are not resolvable by the index" (plain-object property access, dynamic
dispatch, cross-language calls), so few-callers ⇒ LOW does **not** apply. The
result carries a `riskNote` saying so. Confirm with a text search before
treating the symbol as safe to change or delete.

`risk` is the edit gate: warn on HIGH/CRITICAL and stop on UNKNOWN until the
uncertainty is resolved. Within single-repo mode, compare File and symbol
targets with local `riskSharedAxes` (direct/total only). Within group mode,
compare only group results: their `riskSharedAxes` overlays resolved
cross-repo crossings on that local value. Never use either field to waive the
edit gate. Check `riskScale.unusedAxes` before comparing kinds: MCP File walks
omit process/module axes, while web Graph-RAG expands File targets to in-file
symbols before enrichment.

## Tools

**impact** — the primary tool for symbol blast radius. If MCP is unavailable, use `gitnexus impact <symbol> --direction upstream --repo .` instead:

```
impact({
  target: "validateUser",
  repo: "my-app",          // required once >1 repository is indexed
  direction: "upstream",
  minConfidence: 0.8,
  maxDepth: 3
})

→ d=1 (WILL BREAK):
  - loginHandler (src/auth/login.ts:42) [CALLS, 100%]
  - apiMiddleware (src/api/middleware.ts:15) [CALLS, 100%]

→ d=2 (LIKELY AFFECTED):
  - authRouter (src/routes/auth.ts:22) [CALLS, 95%]
```

**detect_changes** — git-diff based impact analysis. If MCP is unavailable, use `gitnexus detect-changes --scope all --repo .` instead:

```
detect_changes({scope: "all"})

→ Changed: 5 symbols in 3 files
→ Affected: LoginFlow, TokenRefresh, APIMiddlewarePipeline
→ Risk: MEDIUM
```

Add `repo` once more than one repository is indexed, and `worktree: "<abs
path>"` when your changes are in a linked worktree the server was not launched
from.

`partial: true` (a graph query failed) or `truncated: true` (the changed-symbol
listing was capped) means the result is short of the truth, and reads like
`UNKNOWN` above: a zero there means unseen, not unaffected. Re-run it rather
than tick the pre-commit check.

A wrong-worktree zero carries neither flag and is shape-identical to a genuine
clean result, so confirm the checkout you edited is the one that was diffed
before treating an empty change set as a passed check.

## Example: "What breaks if I change validateUser?"

```
0. list_repos {}
   → total: 2 (my-app, billing-api) — both define validateUser, so bind explicitly

1. impact({target: "validateUser", repo: "my-app", direction: "upstream"}) or `gitnexus impact "validateUser" --direction upstream --repo .`
   → d=1: loginHandler, apiMiddleware (WILL BREAK)
   → d=2: authRouter, sessionManager (LIKELY AFFECTED)

2. READ gitnexus://repo/my-app/processes
   → LoginFlow and TokenRefresh touch validateUser

3. Risk: 2 direct callers, 2 processes = MEDIUM
   Repository: my-app (/abs/path/my-app)  Worktree: same  Index: current
```

With a single indexed repository, step 0 returns `total: 1` and the `repo`
argument drops out of every call above.
