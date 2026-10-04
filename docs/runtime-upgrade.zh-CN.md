# 运行时版本与升级说明

2026-10-04 本轮更新固定了项目依赖：Claude Agent SDK `0.3.289`、Anthropic SDK `0.131.0`、Codex CLI `0.160.0`、飞书 Node SDK `1.74.0`；SDK 所需 MCP `1.32.0` 和 Zod `4.6.5` 一并锁定。Node.js 要求仍为 20 及以上。

质量复核又升级了现有同主版本依赖 Discord SDK `14.27.0` 和 tsx `4.23.15`，同步消除了旧 undici / esbuild 传递依赖漏洞。最终 `npm audit` 报告为 0 项；没有使用强制修复或 overrides。

## 安装与验证

在项目目录执行 `npm ci`、`npm run typecheck`、`npm run build`。类型检查现在覆盖核心、宿主脚本与顶层测试，构建产物仍为原来的 `dist/lib/` 布局。`npm run test:unit` 包含 `tests/*.test.ts`。

运行中的桥接不会自动切换依赖。代码与 mock 回归检查完成后，再安排重启桥接并在授权聊天中验证模型目录、权限卡、问答、图片、中断和历史会话恢复。本说明中的 Claude 与 workflow 回归使用 fake query/spawn，不发送飞书消息；真实账号行为仍需单独联调。

## 模型与权限

- Claude 工作流默认使用运行时 `sonnet` 别名，也可用 `--model` 或 `claude_model` 指定模型。移除了已退役的 `claude-sonnet-4-20250514` 默认值。
- Claude 聊天的 `/model <id> <effort>` 会传入 SDK 的 effort，目前协议支持 low、medium、high、xhigh、max，其它值明确拒绝；选定模型的实际支持情况由运行时校验。
- Claude 聊天会加载 user/project/local 设置；工作流裁决仍禁用工具、使用独立会话及空设置来源。`claude_max_output_tokens` 通过官方 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 环境变量传递，只影响该 SDK 子进程，实际上限由模型决定。
- Codex 聊天由 app-server 的模型目录选择默认模型，不再强选 `gpt-5.5 xhigh`。显式模型和权限设置仍需后端支持；模型出现在目录中不代表账号一定有调用权限。
- 宿主入口不再默认强制 `danger-full-access` 和 `never`，会话权限由 provider 映射。已有显式配置仍须自行检查是否符合预期。
- Claude 图片支持 PNG、JPEG、GIF、WebP；其它附件会明确报错。AskUserQuestion 使用独立问答事件并回传真实答案。
- “本会话允许”只应用会话内权限，不会把 SDK 建议写入用户或项目设置。

## 版本边界

Claude 聊天与工作流通过 SDK 公共包入口使用其内置运行时。Codex 聊天优先使用固定的项目 CLI。工作流的 Codex 审查与自动修复仍经外部 `codeagent-wrapper`，修复调用已明确传入隔离 worktree 目录。wrapper 的帮助未暴露可执行文件选择选项，内部如何解析 Codex 版本未经生产调用验证。

Codex CLI 从桥接安装目录解析，`bridge_default_work_dir` 只决定任务工作目录；不要求每个目标业务项目安装 Codex。Codex 模型只读取自己的配置项，避免把 Claude 的 `bridge_default_model` 当作 Codex 型号。

本机全局 CLI 已另行更新并核验为 `codex-cli 0.160.0` 与 `Claude Code 2.1.289`。桌面 Codex 的 Windows Store 更新资格检查不可用，因此不能据此确认桌面应用已经是最新版。

Claude SDK 的 `usage` 是主代理本轮用量；`total_cost_usd` 和 `modelUsage` 在恢复会话时可能累计历史调用。桥接独立传递累计成本，避免把它当成本轮费用重复汇总。上下文占用取最近一次主代理调用和 SDK 返回的模型窗口。

参考：[Claude 环境变量](https://code.claude.com/docs/en/env-vars)、[Claude 用户输入](https://code.claude.com/docs/en/agent-sdk/user-input)、[Codex app-server](https://learn.chatgpt.com/docs/app-server)。
