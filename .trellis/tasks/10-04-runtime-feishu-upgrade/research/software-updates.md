# 已安装软件更新记录

日期：2026-10-04。

用户在实施期间明确授权这些软件本身应升级即可升级。先用 Get-Command 和 npm 全局清单确认活动的 `codex`、`claude` 均来自用户目录中的 npm 安装，再按该来源更新，未另装第二种分发渠道。

执行：`npm install -g @openai/codex@0.160.0 @anthropic-ai/claude-code@2.1.289`，成功退出。

| 软件 | 更新前 | 更新后实际命令核验 |
| --- | --- | --- |
| Codex CLI | 0.156.1 | `codex --version` → codex-cli 0.160.0 |
| Claude Code | 2.1.198 | `claude --version` → 2.1.289 (Claude Code) |

`npm ls -g @openai/codex @anthropic-ai/claude-code --depth=0` 同时确认以上版本。未更改系统权限、认证配置，未重启已有桥接进程。

## Codex 桌面版

应用自带只读更新检查返回：installedVersion 26.930.31730、installedBuildVersion 12947、prod，status=unavailable。原因是 Microsoft Store 必须检查安装资格，而该检查可能下载更新，因此仅信息查询没有启动 Store 更新。

只读 Get-AppxPackage 确认安装包为 OpenAI.Codex（manifest 版本 26.930.3930.0）。manifest 与运行中的应用版本属于不同字段，不能直接比较认定升级或降级。备用 `winget list --name Codex --disable-interactivity` 和 `winget search Codex --source msstore --disable-interactivity` 都没有匹配包。

结论：命令行版本更新已确认；桌面版是否有可安装更新仍需 Microsoft Store 检查，本轮没有确认桌面版更新或重启。
