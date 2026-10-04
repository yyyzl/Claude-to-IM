# Codex 原生生图输出协议核实

研究日期：2026-10-05。范围：只读当前桥接源码、项目锁定 `@openai/codex@0.160.0` 的既有离线 schema、OpenAI 官方 `rust-v0.160.0` 源码。已应用 `openai-docs` 技能。没有运行真实模型、生图、账号能力或飞书接口，没有读取 auth/config 私密内容。

## 可实现结论

可以在当前锁定版本接通“本回合生成图片自动发回原飞书聊天，同时保留文字”。**无需通过 Markdown 找图片，也无需寻找磁盘上最新图片。** Codex 原生 `item/completed` → `imageGeneration` 已给出完整 PNG Base64 和 `threadId`、`turnId`、图片调用 `id`；本项目目前遗漏该事件，后续 SSE、conversation result、出站消息和飞书适配器也没有输出图片契约。

但“当前桥接能执行原生生图”是有条件的：app-server 确实安装并向合适 provider 暴露原生 imagegen；本轮没有验证用户实际 provider、登录权限、额度或模型是否选用该工具。当前桌面会话拥有 `image_gen.imagegen` 不构成桥接能力证明。

## 锁定版本与协议

本地证据：`.trellis/tasks/archive/2026-10/10-05-codex-model-picker/research/codex-0.160.0-schema/`，先前以锁定 CLI 的 `app-server generate-json-schema --experimental` 离线生成；本轮仅复用，没有重新生成或提交大 schema。

- `v2/ItemCompletedNotification.json`：通知必填 `completedAtMs`、`item`、`threadId`、`turnId`；`ImageGenerationThreadItem` 定义在 1500–1560 行，必填 `type`、`id`、`result`、`status`。`savedPath` 可省略/null，类型为绝对路径；`revisedPrompt`、`transparentBackground`、`failure` 为可选/可空字段。
- 固定源码：[ThreadItem 映射和通知结构](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L997)，`ItemStartedNotification` 位于 1337–1343 行，`ItemCompletedNotification` 位于 1415–1421 行。
- [ImageGenerationItem 字段](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/ext/items/src/image_generation.rs#L28)：`result` 是 string；底层 request/generation 分析 ID 明确不传给客户端。`failure` 当前有 `{type:"usageLimitExceeded",limitId,resetsAt}`，其中 `resetsAt` 可空。
- [原生执行器](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/ext/image-generation/src/tool.rs#L153)：开始事件为 `status:"in_progress",result:""`；188–190 行取响应首个 `b64_json`；235–249 行发 `status:"completed",result:<原始 Base64>,failure:null`。失败在 205–220 行发 `status:"failed",result:""`，普通失败的 `failure` 也可为 null，不能仅按 `failure == null` 认定成功。
- `result` 是原始 PNG Base64，**不是** data URL、路径或远程 URL。[同一执行器 656–675 行](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/ext/image-generation/src/tool.rs#L656) 才将其包装为 `data:image/png;base64,...`。`imageGeneration` 属于独立事件；不要依赖 generic MCP 工具结果或 raw response 事件。

可用于 fake transport 的脱敏、有效 1×1 PNG fixture（不是生产记录）：

```json
{
  "method": "item/completed",
  "params": {
    "threadId": "thread-fixture",
    "turnId": "turn-fixture",
    "completedAtMs": 1791158400000,
    "item": {
      "type": "imageGeneration",
      "id": "image-call-fixture",
      "status": "completed",
      "result": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
      "revisedPrompt": "A blue whale illustration",
      "transparentBackground": false,
      "failure": null,
      "savedPath": "C:\\codex-fixture\\generated_images\\thread-fixture\\image-call-fixture.png"
    }
  }
}
```

原始内容和断言参考 [上游端到端假服务器测试](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/tests/suite/v2/imagegen_extension.rs#L142)：断言 completed、Base64 和保存的 PNG 字节；失败 fixture 参考 539–549 行。`savedPath` 缺失时，只要 `result` 有效仍可发送。

## 生图能力如何出现

- [app-server extension 安装](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/extensions.rs#L101)：app-server 自身安装 image-generation extension，保存根为 `config.codex_home`；桥接无需额外注入桌面 MCP/dynamic tool。
- [extension 可用条件](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/ext/image-generation/src/extension.rs#L41)：provider 为 OpenAI，或 `requires_openai_auth`，或使用 OpenAI actor authorization；96–109 行仅在 available 时暴露工具。普通自定义兼容 provider 不能仅因 Responses API 可用就视为原生生图可用。
- [features](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/features/src/lib.rs#L1553)：`image_generation` 为 stable/default true。已检查的 extension 安装/贡献代码无需桥接额外声明功能；不应为本需求修改全局配置。具体用户设置与额外上游工具过滤未做真实运行验证。
- 工具命名为 `image_gen.imagegen`，code-mode 暴露 `tools.image_gen__imagegen(...)`；[上游 code-mode 测试](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/tests/suite/v2/imagegen_extension.rs#L876) 证明该原生能力可以从 app-server code-mode 调用。执行器使用 `gpt-image-2`（tool.rs:58,445–451）。模型是否调用由运行时/提示词决定，桥接只须接收可信完成事件。
- `modelProvider/capabilities/read` 请求 params `{}`；schema 响应严格为 `{namespaceTools:boolean,imageGeneration:boolean,webSearch:boolean}`。其 [handler](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/request_processors/config_processor.rs#L203) 读取配置、以 `auth_manager:None` 创建 provider 并返回静态 capabilities，**不查询账号权限或额度，也不是 per-model 检测**。[ProviderCapabilities](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/model-provider/src/provider.rs#L48) 明确是上界；通用 provider 默认 image_generation=true，因此 true 还不能替代 extension 的具体可用条件。
- [上游能力测试](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/tests/suite/v2/model_provider_capabilities_read.rs#L14) 的默认 provider 返回三项 true；Bedrock 返回 imageGeneration=false。这里只报告官方 fixture，不声称本机实时返回了 true。

现行 [官方生图文档](https://learn.chatgpt.com/docs/image-generation) 说明交互会话可自然语言或 `$imagegen` 发起，内建生成计入 Codex 限额。文档是现行说明；上面的字段与实现以 0.160.0 固定源码为准。特定 Sign in with ChatGPT token-sharing 预览限制不能泛化为所有原生 Codex 登录模式的能力结论。

## 保存、生命周期与信任边界

- [路径构造](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/ext/image-generation/src/artifact.rs#L8)：app-server 保存到 `<CODEX_HOME>/generated_images/<sanitize(threadId)>/<sanitize(callId)>.png`；sanitize 只保留 ASCII 字母、数字、`-`、`_`，其余改 `_`。它不是工作项目目录的任意新文件。
- [保存流程](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/ext/image-generation/src/tool.rs#L288) 在成功完成事件前写文件；保存失败可返回无 savedPath，但原始 result 仍在。工具提示模型保留原图，且“客户端已展示”，因此要求模型再输出 Markdown 并不可靠（artifact.rs:38–45）。文件不是临时一次性传输凭据；桥接不应删除 Codex 原件。
- 一个图片调用输出首张响应图片；同一 turn 可有多个图片调用，按 `(threadId,turnId,item.id)` 去重，不能按最终文字是否为空决定是否发送图片。只接受精确本回合 `item/completed`，不要回传 thread/resume 历史、imageView 读入图、输入附件、fileChange 或模型文字中提及的文件。
- 上游默认 `features.omit_app_server_notification_media=false`（features:1559–1562）。若为 true，[通知媒体过滤器](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/notification_media.rs#L191) 会清空 imageGeneration.result，保留其余元数据。因此 result-only 实现需要桥接子进程局部明确要求 false，或对空结果给出可理解的交付失败；不要悄悄启用任意 savedPath 读盘兜底。
- 推荐最小实现直接处理非空 Base64：长度上限、严格格式/PNG 魔数校验，再传输字节。避免日志或会话文本记录整串数据。若未来确需 path-only，另建限制为精确受控根、realpath 和文件大小/类型验证的方案；不能直接信任模型文本路径或从目录找图。
- 接收 `item/completed` 后图片已生成。后续 turn 失败/取消时是否发送这些已完成图片须与产品和现有投递取消语义一致；不得在已停止或已换绑聊天后由迟到事件另起发送。自动重试只重试投递，不再调用模型重新生图。

## 本仓库缺口与最小实现面

1. `scripts/claude-to-im-bridge/codex-llm.ts:87–99` 启动 stdio app-server；`collectTurnText:421,435` 已准确匹配 thread/turn，`481–488` 已补收 early backlog，可复用。`465` 工具类型列表遗漏 imageGeneration；`194–201` generic tool_result 只取 aggregatedOutput，无法承载图片。新增独立 generated-image SSE/回调，避免把 Base64放进 tool UI。
2. `scripts/claude-to-im-bridge/codex-jsonrpc.ts:143–148,311–314` 按行解析并原样交通知；无需为正常图片协议重写 transport。大图片会扩大 JSON/base64 内存，应给图片数据上限，避免日志输出 payload。
3. `src/lib/bridge/host.ts:29–51` SSE/内容块没有图片结果；`conversation-engine.ts:273` consumeStream 返回文字与使用量，需要收集本回合已验证的生成产物。出站 `src/lib/bridge/types.ts:64–75` 没附件字段。
4. `src/lib/bridge/adapters/feishu-adapter.ts:1181–1210` 仅文字/卡片出站。需新增图片上传及 image 消息发送接口；manager 投递环节将原文字与生成图片发送到原 address，分别记录成功/失败与取消。不能把生图后端流程绑到 /upload 或要求用户第二条指令。
5. 最小受测范围：当前 turn 成功 PNG、多图+文字、纯图、跨 thread/turn 拒收、重复 item 去重、started/failed/空结果/无savedPath、错误 Base64/超大/非 PNG、imageView 不回传、通知先于 turn/start 返回、取消/迟到结果、飞书上传/发送失败保留文字，重试不重新生图。不需要真实账号或付费生图即可用协议 fixture+fake adapter覆盖。

本报告仅提出实现边界，未修改业务文件、全局配置、依赖、Git ref 或运行中的桥接。飞书具体上传限制与权限需由实现阶段的飞书专项研究核实。
