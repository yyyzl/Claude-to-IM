# 执行计划

## 开始条件

- 用户在最终规划摘要之后明确批准进入实现；之后才运行 task.py start。
- implement.jsonl/check.jsonl 均含真实规范与诊断条目，并通过 task.py validate。
- reliability-contracts.md 当前略超单文件注入上限；子代理必须自行从原文件补读相关完整章节（最终回答、生成图片、飞书完成卡和测试要求），不得仅依赖注入文本尾部。无需修改全局配置或压缩原规范。
- 每个实际修改函数/方法先跑 GitNexus 上游 impact；HIGH/CRITICAL 告知用户；UNKNOWN 或查询异常用正确 UID、源码与调用方补证。

## 1. 解析与受限图片快照

先补失败测试：合成两图回复、尖括号/相对/含空格路径、代码示例不读取、缺失/损坏/越界/链接逃逸、预算限制。新增最小 internal helper，复用 markdown-it 和 generated-image.ts 校验，不改 Codex 原生通知解析。

预计文件：`src/lib/bridge/internal/inline-images.ts`、`src/__tests__/unit/bridge-inline-images.test.ts`。

## 2. 图文 outbox 与恢复

先补失败测试：保存发生在上传前、key 保存发生在发送前、第二图失败、同图重复引用、重建 store 后无需原文件、取消后迟到无发送。扩展正文块内嵌图合同及严格 store 校验，接入投递快照与上传流程。

预计文件：`src/lib/bridge/host.ts`、`src/lib/bridge/response-delivery.ts`、`scripts/claude-to-im-bridge/store.ts`；测试落在已有 media-delivery/media-store 与新增 inline-images 用例。

## 3. 完成卡、普通卡与调用方

先补失败测试：原流卡收到转换后的正文、确认图文整体、收尾失败转普通卡、超限分块、运行中未上传图不渲染本地路径。bridge-manager 传工作目录并让收尾接收准备后的正文；FeishuAdapter/Markdown 层保证图文卡和 fallback 均使用转换正文。

预计文件：`src/lib/bridge/bridge-manager.ts`、`src/lib/bridge/adapters/feishu-adapter.ts`、`src/lib/bridge/markdown/feishu.ts`；测试覆盖 final-card/streaming 与会话投递连接。

## 4. 检查与收尾

- 定向单测：inline-images、media-delivery、media-store、feishu-media、feishu-final-card、feishu-streaming、delivery-reliability；每批外层总超时 60 秒，node:test 单例超时不超过该值。
- `npm run typecheck`、`npm run build`，随后必要的整合单测批次，均阻断真实模型和生产网络。
- 使用 Trellis implement/check 子代理按阶段执行；主代理汇总影响、处理规范与阶段门禁。
- 最终 GitNexus detect-changes --scope all --repo .，结合实际 diff 与未跟踪文件，排除 partial/truncated 漏报。
- 按实际实现更新 reliability-contracts.md 的正文显式图片准入与确认合同，不覆盖原生生成图限制；完成前保留生产显示验证限制。
- 未经用户授权不进行生产飞书发送或服务重启。
