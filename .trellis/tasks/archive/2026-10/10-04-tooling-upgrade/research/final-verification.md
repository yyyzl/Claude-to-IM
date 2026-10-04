# 整合验收

## 已完成的更新

- 运行时与可靠性修复已提交为 `478483c`，成功推送 `origin/main`；原 `reliability-fixes` 任务按工作流归档。
- npm 全局 Trellis 从 0.5.9 更新到稳定 0.6.17，项目模板从 0.5.0-beta.15 更新到 0.6.17。Claude、Codex、Gemini 均为原有平台，未扩展新平台。
- npm 全局 GitNexus 从 1.6.4 更新到稳定 1.6.12；保留原布局更新两套六个技能与管理块，未改全局 MCP 或模型配置。
- Trellis 旧 receipt 迁移、定制冲突合并、Fusion 会话隔离、14 条保护配置和项目定制索引均完成；官方新增 Markdown 仅额外规范四处格式，未用重算 receipt 隐瞒本地差异。

## 质量门

检查者独立执行 typecheck、Fusion 5 项、Codex bootstrap 4 项、配置语法与 hook 注册校验；离线 MCP 临时实例握手通过，GitNexus 1.6.12 提供 13 个只读工具。业务 `src/`、`scripts/`、package.json/package-lock.json 本轮没有新差异，前次 564 项业务测试结果保持有效。

根执行新版 `detect-changes --scope staged --repo .` 成功。当前图只覆盖 97 个业务/入口文件，Trellis 隐藏目录符号未收录；输出 LOW、0 执行流不能解释成 hooks 无影响。Fusion 的七个既有符号均先尝试 impact 并补源码调用关系，按 HIGH 工作流路径处理和隔离验证。

暂存检查不包含 `.fusion`、升级备份、真实环境文件或原始命令日志，没有检测到凭据形态内容；四份新增上游 Markdown 的暂存空白问题已修正，显示语义保留。

## GitNexus 实际能力验证

1. `analyze --force --index-only --no-parse-cache` 完成新 schema 重建：4,145 nodes、10,808 edges、358 flows；原 embeddings=0 保持。
2. FTS 扩展默认 15 秒下载超时；包内官方独立安装器以 45 秒上限重试成功。`analyze --repair-fts --index-only` 成功。
3. `query "workflow recovery" --repo .` 返回流程与符号，有 BM25 计时；`context WorkflowEngine` 返回 found/exact。
4. 同名 `processMessage` 返回歧义，改用完整函数 UID 后 upstream impact 成功返回 14 个受影响项、CRITICAL。
5. `status` 确认当时索引与 `478483c` 一致、全部 97 个覆盖文件匹配；`doctor` 确认图与全文搜索 available。

图分析仍有流程数量/分支裁剪与跨语言字段未关联提示，不能将缺失边当成未使用。没有为原本未启用的 embeddings 增装 VECTOR 或模型。

## 提交与运行边界

工具链更新与任务归档由主会话提交推送，最后一个提交之后再执行 `analyze --index-only`，核对最终 HEAD、远端 HEAD、索引 lastCommit 及工作区状态。最终机器结果保存在任务忽略的 `.fusion/`，避免为记录索引提交号再制造新提交。

没有启动桥接、访问真实模型/飞书或业务会话；没有重启编辑器、改全局 MCP 配置或替用户批准新 hook。新会话/重连 MCP 才会加载新集成；Codex 提示 `/hooks` 审核时由用户在宿主完成。
