# 独立检查报告

## 结论

对照 PRD R1–R6、A1–A5、技术设计、check.jsonl 全部规范与诊断条目，独立审查产品代码及新增未跟踪 helper/测试。发现并修复三类确定产品问题；当前没有待修复的代码阻断项。生产飞书客户端图片显示仍在本阶段范围外，fake 成功不能替代真实展示验收。

审查包括 Markdown 解析→工作目录内 PNG 快照→上传检查点→转换正文→完成卡/分块→JSON store 恢复→补发，以及取消与原生生图/其它渠道回归。没有修改原生 imageGeneration 准入、全局依赖、生产接口、服务运行状态或 `.codepilot-uploads/`，没有提交或推送。

## Findings (fixed)

### 1. 表格图片节点漏识别

- File: `src/lib/bridge/internal/inline-images.ts`。
- Issue: `markdownImageSpans` 只处理带 `inline.map` 的节点，markdown-it 表格单元格 inline 没有该字段。有效表格图片被跳过，运行态和最终正文保留本地 src，可能误确认送达，违背 R1/R2/R6。
- Fix: 在实际表格块规则中记录单元格来源字符位置，处理该规则对转义竖线的反转义，再将已识别的图片节点映射回原文。列表、引用、代码节点及普通段落保持原路径，没有全文路径替换。
- 回归: “表格图片精确映射单元格，保留代码示例、转义竖线与重复内容”先 RED（0 个节点，预期 3），修复后 GREEN；验证完成卡上传两图、重复引用复用 key、代码示例保留。

### 2. 图片说明与标题转义被破坏

- File: `src/lib/bridge/internal/inline-images.ts`。
- Issue: 表格解析去掉 `\|` 的反斜杠，重建 alt/title 或待上传说明时可能使单元格重新分列；已有效 alt 中的方括号、反斜杠又被重复转义。
- Fix: 表格 alt 从保存的原始标签范围恢复；快照保留解析器已验证的 alt 转义。标题和文字说明中的竖线保持表格安全转义。上传后只替换已识别图片节点的目的地，已转换成 key 的节点不再次重写 alt/title。
- 回归: 表格说明/标题竖线与普通 alt 既有方括号/反斜杠分别先 RED 再 GREEN；覆盖原完成卡和普通卡降级投递。

### 3. 图片上传失败后原过程卡未收尾

- File: `src/lib/bridge/response-delivery.ts`。
- Issue: 上传失败只发送独立说明预览，manager finally 清理卡片状态，但未更新原卡终态。真实 manager/provider + fake 卡诊断确认原正文仍是“等待上传”，没有终态状态区更新；待发记录虽正确保留，原卡视觉却停留在运行态。
- Fix: `showInlinePreview` 使用原 store 与既有期限，优先通过 `finalize(previewText)` 收尾原卡。返回 true 只表示说明预览已收尾，不设置 `sent` 或 `delivered`；false/无卡沿用独立预览。保留取消检查、图片快照、第一张上传 key 和 `/retry`。
- 回归: 新增真实 manager/card 回归先 RED（原卡仍显示等待上传）再 GREEN，确认完整保序待补发正文、完成状态、活动卡清理、failed/未确认记录、补发成功及模型只调用一轮。

### 4. 新测试消耗其它用例的共享限流额度

- File: `src/__tests__/unit/bridge-feishu-live-append.test.ts`。
- Issue: 新增失败卡测试的通知和补发使同文件固定 `chat` 的模块级限流桶触及 20 条/分钟，三个既有初始化取消用例等待控制确认失败。完整文件可复现，而只运行新用例与这三个用例时 4/4 通过。
- Fix: 仅让新增失败卡用例使用独立 chatId，沿用 fixture 原有聊天参数，隔离共享投递限流桶。没有改生产限流或扩大测试超时；完整文件恢复 28/28 通过。

## Findings (not fixed)

没有遗留确定的代码问题。以下为验收边界：

- 没有执行生产飞书发送、客户端展示联调或服务重启，仍需经用户授权验证真实图片显示。
- FTS 扩展不可用，概念空结果不作为安全证据；使用刷新后的精确符号 impact、当前源码和测试补证。最终索引刷新与完整 detect-changes 由主代理负责，需覆盖本检查新增小修。

## Verification

- Lint: 项目没有 lint 脚本；`git diff --check` 通过，没有空白错误。
- TypeCheck: 最终 `npm run typecheck` 通过（主库和脚本）。
- Build: 最终 `npm run build` 通过。
- 全量基线: 独立运行 64 个文件，948/948 通过；加入表格两项回归后全量 950/950 通过，19.973 秒。该快照在失败卡收尾和最后 alt 保留小修之前。
- 最终定向: 13 个文件 **167/167 通过**，9.077 秒，涵盖所有后续小修及其直接/间接回归。两批结果没有相加当作单次总数。
- 所有单测批使用 Python `subprocess.run(..., timeout=60)` 外层硬期限；Node `--test-timeout=15000`。合成临时 PNG、fake 上传/卡片/模型协议，新增 manager 测试阻断子进程、net 与 fetch。

最终定向文件为 inline-images、media-delivery、media-store、feishu-media、feishu-final-card、feishu-streaming、feishu-progress、delivery-reliability、feishu-live-append、image-manager、image-conversation、codex-image-output、generated-image。

## 修改门禁与规范同步

检查新增修改前均运行精确上游 impact：`markdownImageSpans` CRITICAL，`snapshotInlineImages`/`renderInlineImages` HIGH，`titleSuffix`/精确 UID `description` CRITICAL，`showInlinePreview` HIGH；`attempt` CRITICAL 已在既定风险范围内，再次确认直接调用方为 deliverResponse/retryResponseDelivery。新增 HIGH/CRITICAL 均通过主代理先告知用户后修改。

主代理已同步失败预览收尾设计及原生独立图/正文内嵌图确认的区别。建议正文图片合同补充表格单元格字符映射与原始 alt 转义保留这两个实际解析约束；规范、README 和任务记录由主代理维护。本检查只写本报告。

产品代码与测试在最终 167 项定向验证、typecheck/build 和 diff 检查后冻结。
