# 已完成的 Codex 协议研究

## 版本与证据

研究时项目固定版本与本地 CLI 为 0.160.0，npm 官方发布的最新版为 0.162.1。在项目忽略目录单独提取官方 Windows 二进制、验证 npm SHA512，并通过 `app-server generate-json-schema --experimental` 离线生成 schema，没有启动模型、升级依赖或修改全局配置。

0.160.0 与 0.162.1 的 `ToolRequestUserInputParams`、`ToolRequestUserInputResponse`、`ServerRequestResolvedNotification` JSON 树完全一致。当前问题无需升级版本。

原始结果保存在忽略目录 `.ccg/codex-user-input/research-summary.json`、`schema-comparison.json`、`diagnostic-results.json`。实现以本文件的稳定合同为准，不依赖忽略目录的大型二进制。

## 锁定合同

```ts
// 原生服务端问题
{ threadId, turnId, itemId, isBlocking: boolean, questions: [
  { id, header, question, options?: [{ label, description }] | null,
    isOther?: boolean, isSecret?: boolean }
] }
// 原 JSON-RPC 请求的响应；不是 turn/steer
{ answers: { [questionId]: { answers: string[] } } }
// 原问题已回答或被服务端清除
{ method: 'serverRequest/resolved', params: { threadId, requestId } }
```

`isBlocking` 决定是否等待。`autoResolutionMs` 已标为弃用，不根据该字段新建短回答倒计时。原生 schema 没有 multiSelect 字段；桥接已有通用多选能力不能据此宣称 Codex 原生多选支持。Responses API 的 `call_id` 与此处 app-server JSON-RPC 请求 ID 不能混用。

## 当前实现与诊断

当前异步服务端请求处理已允许模型通知继续流动，且已处理 `serverRequest/resolved`。缺口是 `isBlocking` 未传入桥接、所有问题都误报 waiting_for_input，以及闭合问题没有显式迟到答案补充入口。

两个使用真实 provider/broker/card 构建器及内存传输的诊断均通过：

1. 非阻塞问题期间继续输出；选择和自由文字答案回传同一原 RPC，一次 turn/start、零次 turn/steer；但卡片丢失阻塞标志并误报等待。
2. 服务端先关闭问题，迟到答案被拒绝；没有回传原 RPC或启动新轮，但卡片仅显示通用拒绝，无法明确转换为补充。

相关 5 文件 40 项单测通过，均阻断真实子进程、模型和平台。不能把这些合成测试称作飞书实际联调。

## 官方来源

- https://learn.chatgpt.com/docs/changelog ：2026-09-08 的 iOS 说明可在 Codex 工作时回答实时问题，不能外推所有平台/模型的权限。
- https://learn.chatgpt.com/docs/app-server ：原问题响应及 resolved 通知；字段弃用语义以锁定版本 schema 为准。
- https://developers.openai.com/api/docs/guides/async-tool-calling ：异步工具答案返回原调用；项目实际使用 app-server，不直接使用该 API。

## 影响分析

`impact-before.json` 保存当前 main 索引的上游分析。handleMessage 精确 UID 为 CRITICAL；clearUserInputRequests 与 cancelChat 为 CRITICAL；resolveAnswer 为 HIGH；协议、卡片、转发及消费准入接口为 LOW。已向用户告知高风险流程及回归范围。FTS 不可用，图查询可用；名称歧义和跨模块错误边均用精确 UID及当前源码补证，不能从空查询推断安全。

实施与独立检查补充：文本/卡片答案包装入口及新 prepareUserInputSupplement 为 CRITICAL，直接调用方 handleMessage；新 validateAnswer 为 HIGH，经 resolveAnswer/prepare 进入同一主链路。provider constructor/streamChat 与 manager.stop 有动态派发的 UNKNOWN 图结果，已用当前脚本装配、engine DI、实际调用点和测试补证，并按 HIGH 告知用户。索引全局流程枚举受预算截断，必须结合当前 d=1 源码及间接/传递回归，不将空流程当作安全。

独立 fake 诊断复现了初始化期旧 turn 问题误转发。修复限定为复用本轮 ready/isInputOpen：先登记请求/网关，再等待 ready 或真实解决，确认 turnId 精确相同且原回合仍开放才转发；不改变 collector、追加或权限网关。另已用行为 RED 确认空 claim 和原型答案缺口，收敛必填准入与 own-property 校验。验证日志集中在任务 .fusion/。
