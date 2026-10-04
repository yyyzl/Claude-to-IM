# 图片自动回传独立检查报告

## 结论

按 `check.jsonl`、PRD 与设计先做规格审查，再检查实现质量与故障路径。A/B 稳定后核对了实际 provider → conversation → manager → outbox → 飞书 SDK/JSON Store 调用链及对应测试，没有只采信实施报告。

发现并修复两处会回显媒体内容的错误边界；定向回归 **83/83 通过**。当前没有未解决的本任务规格或实现缺陷。业务稳定后，主会话回报 typecheck/build 通过、完整单测 **748/748 通过**；最终索引范围检查和发布由主会话负责。

## Findings (fixed)

### 1. Codex 服务端错误可能进入普通日志和历史

- 文件：`scripts/claude-to-im-bridge/codex-llm.ts`。
- 问题：`collectTurnText` 从 `error` 通知或失败 `turn/completed` 透传服务端 message，或序列化整个 error。服务端错误可能含图片 Base64 和请求字段，后续 SSE error、会话日志及 manager 的失败说明都会接收原文。
- 修复：仅这两个服务端分支改为固定“Codex 回合执行失败，请稍后重试。”；不改变本地配置异常、普通错误分类或已完成合法图片的保留逻辑。
- 回归：三种服务端错误夹带合成 PNG 与私有字段的测试在旧逻辑全部失败，修复后普通 SSE 不含这些字段，图片事件仍保留且 result 明确为 error。同步更新既有协议失败断言和 manager 模拟错误语义。
- 修改前影响分析：`collectTurnText` 精确命中方法 UID，upstream **LOW**，直接入口为 `streamChat` 的异步收集流程，1 个直接调用方、1 条执行流。

### 2. 损坏 JSON 的 SyntaxError cause 可能回显媒体片段

- 文件：`scripts/claude-to-im-bridge/store.ts`。
- 问题：`JSON.parse` 的 SyntaxError 带有原始数据片段；`load` 将该错误保留为 cause，即使外层说明安全，打印完整 Error 仍可能出现图片 Base64 前缀。
- 修复：`parsePersistedData` 将解析失败转为固定 `Invalid store JSON syntax`，不保留原始异常 cause；外层错误明确说明“主存储损坏且没有有效备份”。有效备份恢复、保留损坏原件和拒绝空载覆盖行为不变。
- 回归：使用图片数据作为损坏 JSON，直接捕获并 inspect 完整 Error，旧逻辑断言失败，修复后只有安全类别及文件角色，磁盘原件不变。既有 JSON Store 备份/恢复测试同批通过。
- 修改前影响分析：`parsePersistedData` upstream **LOW**，直接 `load`、间接 constructor；`load` upstream **LOW**，直接 constructor。均结合当前源码确认，未把缺少 process 图当成无调用证明。

### 3. 收敛无关换行差异

- 文件：`src/lib/bridge/conversation-engine.ts`。
- 原 HEAD 混合 CRLF/LF，实施后的整体 LF 造成接近全文差异。按文本行匹配保留所有未修改行的原换行，仅新增/变化行使用当前内容；逐行内容断言不变。
- 最终该文件为 28 行新增、1 行删除，只有本任务图片事件与结果行为变化。

## 规格与质量核对

| 范围 | 实际检查与结论 |
| --- | --- |
| I1/I2：生成来源与归属 | 固定 0.160.0 fixture；当前 thread/turn 严格匹配，early backlog 归并后仅接收正确回合，item 去重。仅 completed imageGeneration 的 result 进入图片事件；started、failed、imageView、输入图和文字路径不作为图像产物。 |
| I1/I3：会话结果 | 图片独立事件和数组，不加入普通 contentBlocks/会话历史。普通失败保留已完成图并显示失败说明；abort/timeout 清空图片，manager 仍检查原回合归属。纯图和多图均进入 outbox，流卡 finalize 真假不吞图。 |
| I3：校验和预算 | 单图编码长度先限额，严格 Base64/round-trip，PNG signature、IHDR/尺寸、分块边界与 IEND；复用相同 helper 校验保存记录。10_000_000 字节/12000 像素、每轮 8 图/30_000_000 字节符合设计。错误只描述类别。 |
| I4：上传发送与恢复 | 初始 record save+flush 后才上传；key save+flush 后才用原始持久 sendUuid 发送；发送成功的 sent/messageId 先保存再检查取消。补发互斥，复用 key/uuid，仅发送未确认块；JSON 关闭重开后恢复同样进度，成功后清除 payload。 |
| I1/I4：finalize | finalize=true 仅标记文字，图片继续发送；纯图没有空文字块但仍收尾原卡。finalize 超时保持失败待发，未将图片或未知文字标为成功。 |
| I5：取消晚到 | provider 停止接受 timeout 后的晚到通知；manager 的 chat generation、epoch、取消信号继续向 deliverResponse 传 isCurrent。取消期间已返回的 key 保存到原记录，后续 send 被拦截；已确认发送进度不因取消丢失。stop/new 的真实 manager 入口与 outbox 的挂起上传/发送测试覆盖关键边界；bind/停机沿既有相同归属谓词。 |
| I3/I6：适配器 | 图片在任何文字降级之前分派；默认上传能力明确 unsupported，不能用空文字成功吞图。Feishu 上传读取扁平 image_key，发送要求 code=0 且 message_id，使用原 chat 和稳定 uuid。 |
| I3/I7：日志与错误 | SDK 实例注入固定类别/安全数值 metadata logger，真实 SDK 在 fake HTTP 上制造含媒体的 AxiosError 仍不泄漏。两处 reviewer 修复关闭服务端 error 与 JSON SyntaxError 的原始内容回显边界。 |

## Findings (not fixed)

没有遗留待修缺陷。以下是已确认的设计/验证边界，不按测试成功扩大保证：

- 没有调用真实 Codex 生图或生产飞书接口，无法据此确认具体账号、模型、权限与额度可用性。
- PNG 做最小结构校验，不解压像素或验证完整图像语义；平台仍可能拒绝，届时保留 outbox 并反馈。
- outbox 建立前只有内存图片，进程崩溃无法恢复。自定义宿主缺完整持久接口时仍只提供内存待发。
- 上传截止时间之后的成功结果不会后台竞争写回记录或链式发送，可能产生一个未发出的上传资源；手动重试可重新上传。
- 已进入平台的发送在本地超时/取消后仍可能完成。稳定 uuid 用于平台去重，但不承诺永久 exactly-once。

## 文档核对

只读核对 `docs/reliability-fixes.zh-CN.md`、可靠性 spec 和两个 README 的图片入口。接口、图文进度、取消、限额、失败补发、outbox 前崩溃边界与当前实现一致；主会话已补充服务端/JSON 错误禁止原始 cause 的合同。本 reviewer 未修改 root docs/spec，未发现须另报的接口差异。

## Verification

- Lint：项目未配置独立 lint 脚本；`git diff --check` 通过。
- TypeCheck / Build：主会话在业务稳定后统一执行，均 exit 0。
- 完整单测：主会话回报 **748/748 pass、140 suites、约 17.01 秒**；此为整合验证结果，独立 reviewer 定向结果见下一项。
- Tests：定向 **83/83 pass，0 fail**，11 个文件，Node 报告约 2.01 秒；Python 外层 `timeout=60`，Node 单测试 `--test-timeout=15000`。
- 测试文件：`bridge-codex-protocol`、`bridge-codex-image-output`、`bridge-generated-image`、`bridge-image-conversation`、`bridge-image-manager`、`bridge-media-delivery`、`bridge-media-store`、`bridge-feishu-media`、`bridge-json-store`、`bridge-delivery-reliability`、`bridge-delivery-layer`（均为 `src/__tests__/unit/*.test.ts`）。
- 新增 reviewer 回归共 4 项：3 个服务端错误场景、1 个 JSON 错误 cause 场景，均实证 RED → GREEN。第一次整合定向运行还发现旧协议断言期待原始远端错误，更新该断言后本次 83 项全部通过。
- 使用 fake transport/模型/飞书客户端与独立临时 Store；未调用真实模型、用户账号、飞书生产接口，未重启服务，未提交、推送或重建索引。

工具调用简报：GitNexus CLI 确认逐符号 upstream 影响；PowerShell/rg/git 核对最小源码和差异；apply_patch 完成局部修复与报告；Node+tsx 在 60 秒外层限时内执行定向回归。
