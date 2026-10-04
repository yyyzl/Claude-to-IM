---
name: gitnexus-exploring
description: "Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: \"How does X work?\", \"What calls this function?\", \"Show me the auth flow\""
---

# Exploring Codebases with GitNexus

## 本项目运行约定（GitNexus 1.6.12）

本技能基于官方 1.6.12 模板，保留项目现有嵌套目录。仓库名为 `Claude-to-IM`；MCP 调用显式传 `repo: "Claude-to-IM"`，CLI 在目标工作区根目录运行；`query`、`context`、`impact`、`detect-changes` 等支持仓库选择的命令用 `--repo .` 绑定当前检出。

以下 CLI 示例使用已安装的 `gitnexus`。若 `.gitnexus/run.cjs` 存在，可将命令前缀替换为 `node .gitnexus/run.cjs`；文件不存在时直接使用全局 CLI，不执行缺失的脚本。官方 launcher 的下载回退使用浮动 `gitnexus@latest`；使用前先确认它选中已安装的 1.6.12。全局 CLI 不可用时，直接用 `npx --yes gitnexus@1.6.12 <command>`，避免进入 launcher 的 latest 分支。先用 `--version` 确认实际版本，升级需遵循用户授权范围。

日常单次索引刷新统一使用 `gitnexus analyze --index-only`，保留自定义 AGENTS、CLAUDE、Fusion 和两套技能布局。不要为单次刷新索引运行 `setup` 或省略 `--index-only`；持续 watch 的独立约定见 CLI 技能。MCP 不可用时用 CLI 的 `query`、`context`、`impact`、`detect-changes` 继续检查；图查询失败、`UNKNOWN` 或过期结果必须结合当前源码补证，不能作为检查通过的依据。

## When to Use

- "How does authentication work?"
- "What's the project structure?"
- "Show me the main components"
- "Where is the database logic?"
- Understanding code you haven't seen before

## Bind the repository first

Step 1 discovers what is indexed; every call after it must say which of those
it means. With one indexed repository, use the examples below as written. With
more than one, pass `repo` on every call: an omitted `repo` normally errors,
but under an MCP policy with a configured default it resolves to that default
silently. If you cannot tell which repository is meant, stop and ask. Report
the bound repository and index freshness alongside your explanation.

`list_repos` is paginated, so page with `offset: pagination.nextOffset` until
`hasMore` is false before concluding a repository is absent.

## Workflow

```
1. list_repos {} or READ gitnexus://repos                          → Discover indexed repos
2. READ gitnexus://repo/{name}/context             → Codebase overview, check staleness
3. query({search_query: "<what you want to understand>"})  → Find related execution flows
4. context({name: "<symbol>"})            → Deep dive on specific symbol
5. READ gitnexus://repo/{name}/process/{name}      → Trace full execution flow
```

> If step 2 says "Index is stale" → run `gitnexus analyze --index-only` in terminal.

## Checklist

```
- [ ] list_repos {} — bind repo; explicit repo when >1 indexed, ask if ambiguous
- [ ] READ gitnexus://repo/{name}/context
- [ ] query for the concept you want to understand
- [ ] Review returned processes (execution flows)
- [ ] context on key symbols for callers/callees
- [ ] READ process resource for full execution traces
- [ ] Read source files for implementation details
- [ ] State the repository and index freshness with the explanation
```

## Resources

| Resource                                | What you get                                            |
| --------------------------------------- | ------------------------------------------------------- |
| `gitnexus://repo/{name}/context`        | Stats, staleness warning (~150 tokens)                  |
| `gitnexus://repo/{name}/clusters`       | All functional areas with cohesion scores (~300 tokens) |
| `gitnexus://repo/{name}/cluster/{name}` | Area members with file paths (~500 tokens)              |
| `gitnexus://repo/{name}/process/{name}` | Step-by-step execution trace (~200 tokens)              |

## Tools

**query** — find execution flows related to a concept:

```
query({search_query: "payment processing", repo: "my-app"})
→ Processes: CheckoutFlow, RefundFlow, WebhookHandler
→ Symbols grouped by flow with file locations
```

**context** — 360-degree view of a symbol:

```
context({name: "validateUser", repo: "my-app"})
→ Incoming calls: loginHandler, apiMiddleware
→ Outgoing calls: checkToken, getUserById
→ Processes: LoginFlow (step 2/5), TokenRefresh (step 1/3)
```

`repo` is required once more than one repository is indexed, and may be omitted
with a single one.

## Example: "How does payment processing work?"

```
1. list_repos {}                             → total: 1 (my-app) — bind it
   READ gitnexus://repo/my-app/context       → 918 symbols, 45 processes
2. query({search_query: "payment processing"})
   → CheckoutFlow: processPayment → validateCard → chargeStripe
   → RefundFlow: initiateRefund → calculateRefund → processRefund
3. context({name: "processPayment"})
   → Incoming: checkoutHandler, webhookHandler
   → Outgoing: validateCard, chargeStripe, saveTransaction
4. Read src/payments/processor.ts for implementation details
5. Answer, noting: Repository my-app, index current
```

Had step 1 returned two repositories, every call above would carry
`repo: "my-app"`.
