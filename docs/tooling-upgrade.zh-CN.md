# Trellis 与 GitNexus 更新说明

2026-10-04 使用官方稳定版更新：

| 工具 | 更新前 | 更新后 |
| --- | --- | --- |
| Trellis 全局 CLI | 0.5.9 | 0.6.17 |
| Trellis 项目模板 | 0.5.0-beta.15 | 0.6.17 |
| GitNexus 全局 CLI | 1.6.4 | 1.6.12 |

版本来源：[Trellis 0.6.17 源码](https://github.com/mindfold-ai/Trellis/blob/v0.6.17/packages/cli/src/commands/update.ts)、[GitNexus 1.6.12](https://github.com/abhigyanpatwari/GitNexus/releases/tag/v1.6.12)。本机 Node 22.18.0 满足所选版本要求。

## 项目集成

- 同步原有 Claude Code、Codex、Gemini 的 Trellis 模板。旧模板登记转换到新版格式，保留原校验值，避免漏更新或误覆盖定制。
- 保留全部 14 条更新保护配置、Fusion 恢复/压缩钩子、项目开发规范和 GitNexus 指引；定制索引见 `.agents/skills/trellis-local/SKILL.md`。
- Fusion 改用新版按会话解析任务的入口，不再读取旧全局 `.current-task`，无身份时不猜测其他窗口的任务。
- Codex 按上游改用首次输入引导、`trellis-start` 技能和 `SubagentStart` 上下文注入；保留 Fusion 的 `SessionStart`。
- GitNexus 两套技能在原有嵌套目录中同步，普通索引刷新使用 `--index-only`，避免覆盖手工合并的指引与技能。

## 验证与维护

Fusion 隔离回归 5 项、Codex 引导隔离回归 4 项通过；Python/JSON/TOML/YAML、钩子注册和模板预览检查通过。GitNexus 独立离线 MCP 实例完成握手并列出 13 个只读工具；图索引、全文搜索、符号上下文及影响分析已实际验证。

全文搜索扩展首次下载超时，使用官方安装器有界重试成功后已执行 `--repair-fts`。原索引没有 embeddings，本轮保持该状态，没有新增模型下载或向量生成。

```powershell
trellis --version
trellis platforms --json
gitnexus --version
gitnexus analyze --index-only
gitnexus status
```

提交后刷新索引；无需先删除旧索引。新版默认保留已有 embeddings。全局 GitNexus 不可用时使用固定版本 `npx --yes gitnexus@1.6.12`；官方本地 launcher 内部仍可能回退浮动 latest，不能把 launcher 的存在当成版本固定。

本次没有重启桥接或用户正在运行的编辑器，也没有修改全局 MCP/模型配置。重新打开会话或重连 MCP 后才会加载新集成；Codex 若提示审核新增钩子，需在宿主中完成 `/hooks` 审核。本次隔离验证不代表替用户完成了该审核。
