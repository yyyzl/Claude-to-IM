# 混排图片诊断

## 确认的根因

本地存储中的 assistant 消息是 JSON 内容块，不应把整个序列化字符串当最终正文。提取其中 text 块后，真实回复有两个 Markdown 图片节点，src 分别是 `G:/project/feishu-notify-design/result.png` 与 `question.png`，与截图一致。

两文件都存在，通过 createGeneratedImage 的 PNG 校验。会话和绑定工作目录均为 `G:/project`。运行 preprocessFeishuMarkdown、fitProgressView、buildProgressCardJson 和 buildCardContent 后，完成卡与普通卡都仍含两个原始本地路径。诊断脚本的断言通过，无上传与网络发送。

因此问题出现在最终正文到平台内容的资源转换边界，不是图片文件缺失。普通工具制作或查看的图片没有原生 imageGeneration 事件，不会进入现有 generatedImages 分支。

## 调用与索引

- 仓库：`G:/project/Claude-to-IM`，main，HEAD `70085c4`。
- GitNexus 1.6.12 索引提交与 HEAD 一致，status 表示 106 个覆盖文件内容匹配。
- FTS 扩展加载失败，概念 query 的空结果无效；未改系统依赖。使用精确 context、impact 与源码引用补证。
- deliverResponse ← handleMessage：CRITICAL，d=1 为 handleMessage，进一步涉及入站调度和答复执行。已向用户报告。
- FeishuAdapter.finalizeCard ← onStreamEnd：LOW。
- FeishuAdapter.send 的正确 UID 为 `Method:src/lib/bridge/adapters/feishu-adapter.ts:FeishuAdapter.send#1`；其上游图分析为 LOW，直接调用方包含 processIncomingEvent。适配器抽象动态调用另由 delivery-layer 与当前源码补证，不能据该低风险图结果忽略共享投递链路。
- 计划涉及的其它符号在实现前按真实 UID 逐一分析；不将 UNKNOWN 或空调用方当安全结论。

## 外部依据

飞书官方 CLI 的图文回复示例要求先上传本地图片获取 image_key，再将 key 写入 Markdown：

https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-reply.md?plain=1

飞书卡片 2.0 富文本文档页面在当前 web 工具中只返回标题；不能以抓取空内容证明能力。实施时用 fake 断言请求结构，真实客户端显示仍须后续经授权联调验收。

## 相关合同

`.trellis/spec/backend/reliability-contracts.md` 的原生生成图合同明确禁止读取 savedPath 和扫描目录。本任务新增的是正文显式 Markdown 图片、当前工作目录限制下的交付来源，不改变原生 imageGeneration 通知的准入条件。

另一个任务 `10-13-feishu-file-io` 仍在规划普通文件入口，尚未确定自然语言工具或 /sendfile；本任务不代替其入口决策。
