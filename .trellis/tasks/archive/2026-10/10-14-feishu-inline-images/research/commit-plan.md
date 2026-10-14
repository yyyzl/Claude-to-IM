# 本地提交与任务收尾计划

## 工作提交

提交消息：`fix: 修复飞书回复中本地图片混排与补发`

分支：`fix/feishu-inline-images`。只提交本任务的以下 17 个代码、测试和文档文件：

```text
.trellis/spec/backend/index.md
.trellis/spec/backend/inline-image-delivery.md
.trellis/spec/backend/reliability-contracts.md
README.md
README.zh-CN.md
docs/reliability-fixes.zh-CN.md
scripts/claude-to-im-bridge/store.ts
src/__tests__/unit/bridge-feishu-live-append.test.ts
src/__tests__/unit/bridge-feishu-media.test.ts
src/__tests__/unit/bridge-inline-images.test.ts
src/__tests__/unit/bridge-media-store.test.ts
src/lib/bridge/adapters/feishu-adapter.ts
src/lib/bridge/bridge-manager.ts
src/lib/bridge/host.ts
src/lib/bridge/internal/inline-images.ts
src/lib/bridge/markdown/feishu.ts
src/lib/bridge/response-delivery.ts
```

## Trellis 记录

工作提交完成后，按项目工作流归档当前任务：任务文档目录从 `.trellis/tasks/10-14-feishu-inline-images/` 移入 archive 的对应月份目录，仅移动本任务规划与验证材料；不归档其它任务。该脚本会产生 `chore(task): archive 10-14-feishu-inline-images` 记录提交。

随后将本次根因、修复与验证写入开发者日志，由 add_session.py 产生 `chore: record journal` 提交，并更新本地代码索引。三类提交按工作提交、任务归档、日志顺序执行。

## 保留与验收边界

已有未跟踪 `.codepilot-uploads/` 与本任务无关，排除在所有提交之外，不移动或删除。Git 中两个新增代码/测试文件仅为 intent-to-add，目前未暂存实际内容。任务目录由上述归档记录管理。

代码与独立检查已经通过，最终相关测试167/167、typecheck/build通过；先前950/950全量快照也通过，结果不相加。截图原始正文与实际PNG已用fake传输离线验证。用户已明确授权提交、推送修复分支并合回 main，当前计划包含推送 origin 的修复分支与 main；不重启服务或发送生产消息，生产客户端显示仍待联调。

## 确认来源

`.trellis/workflow.md:626`：`Present the plan once, ask for one-shot confirmation`。用户明确确认后才暂存并提交上述文件。

用户确认：“这个也去提交推送一下吧然后合回主分支”。按此授权执行，不再重复询问。
