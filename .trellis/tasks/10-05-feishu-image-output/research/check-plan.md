# 图片自动回传独立检查计划

## 状态与读取范围

已读取本任务 `prd.md`、`design.md`、`check.jsonl` 及其中四项上下文：可靠性合同、测试规范、父任务 Codex 图片协议报告、本任务飞书投递设计。当前仅整理审查计划；A/B 仍在实现，尚未读取或审查本轮业务 diff、修改业务代码或运行测试。收到主会话稳定通知后才执行下列检查。

## 审查矩阵

| 验收 | 核心链路 | 必查边界与可观察断言 |
| --- | --- | --- |
| I1、I2 | Codex notification → 图片事件 | 固定 0.160.0 的 item/completed.imageGeneration，精确 threadId/turnId 且 status=completed；不是仅凭 failure=null 判成功。只用 result，不读取 savedPath，不搜索目录，不解析模型文字路径。 |
| I2 | early backlog、去重 | 通知早于 turn/start 返回时仍仅接收最终确定的当前 turn；重复 item 只接受一次，按 thread/turn/item 身份去重。不同图片调用即使字节相同仍可分别发送；错 thread/turn、历史、started、failed、imageView、输入附件不产出自动图片消息。 |
| I1、I3 | 共享校验 → 会话结果 | 类型、Base64 编码长度限额先于解码；标准 alphabet/padding 和 canonical round-trip；PNG signature、IHDR、尺寸、chunk 边界及必要终止结构按设计校验。不得把最小结构检查描述为完整解码安全证明。 |
| I3 | 图片预算与失败呈现 | 每图 ≤10_000_000 decoded bytes、宽高 1…12000；每回合最多 8 张、合计 ≤30_000_000 bytes。空、坏、超限结果有安全可见说明，保留已接受文字和图片。接收与持久加载共用校验，不因重复通知错误消耗预算。 |
| I1、I3 | 独立图片事件 → conversation result | 图片不混入文字 contentBlocks、工具结果、普通会话历史、使用量/审计摘要。纯图、文字加多图、正常错误前已完成的合法图均保留；用户取消/超时取消不自动发送。 |
| I1、I4 | manager → 图文 outbox | 即使 responseText 为空也建立图片投递记录；文字在前、图片按事件顺序。record 身份考虑图片 ID/摘要，不能把同文字但不同图片误当同一回答。建立记录前的内存产物不宣称抗崩溃恢复。 |
| I1、I4 | streaming finalize → chunks | finalize=true 只确认文字块并 flush，随后继续图片；纯图收尾原处理卡且不制造空文字块。finalize=false 保留既有文字 fallback；超时按既定 fail-fast 保留图片与未完成记录，不能把全部 chunks 标 sent 或清空。 |
| I3、I4 | 上传 → checkpoint → 发送 | 完整 record save+flush 在先；有界 upload 成功后记录 imageKey 并 flush，然后再次核对归属，使用最初已持久化的 sendUuid 发图。上传成功不能标 sent；key flush 失败不能进入 send。 |
| I4 | failed/retry → restart | 文本、图片逐块保存 sent/messageId。发送失败后重试复用 key/uuid，仅补未确认块；JSON 关闭重建后也是如此。重复 retry 互斥，不重新调用模型；成功全部清除 payload，部分失败保留必要图片数据。 |
| I5 | 取消、切换、停机 | stop/new/bind/epoch 失效阻止后续上传及消息发送。上传晚到仅保存原记录的已知进度，不链式发送；已确认 send 成功先保存 sent 再检查取消，避免遗漏确认。旧任务 finally/回执不清理新任务或更新新卡。 |
| I3、I6 | adapter/image 分派 | 图片分支先于 HTML/Markdown/卡片/文本 fallback；默认 unsupported 必须失败且可见，不能以空 text 的成功返回把图片块标 delivered。其他平台正常文字行为保留。 |
| I3、I7 | 飞书 SDK | image.create 使用 image_type=message 与 Buffer，读取扁平 image_key，null/空 key 为失败；message.create 为 msg_type=image、原 chat 地址、持久 uuid，code 成功且有 message_id 才算送达。 |
| I3、I7 | 日志与错误边界 | SDK 注入安全 logger，不输出 Axios request/config、Buffer/Base64、凭据或 raw error。服务端 failure/message 也按不可信数据处理：向用户输出安全固定说明，不能将原 item/error JSON 写入历史、audit、console 或保存错误摘要。存储 reload 的报错不得包含 image.data。 |
| I4、I7 | JSON 契约兼容 | 旧文本 chunks 缺 kind 仍可加载；text/image 判别与必填字段校验完整，imageKey/sendUuid 等检查点恢复合法。坏/超限混合记录不能静默空载启动，沿既有备份/明确失败规则。 |

## 重点故障注入

1. fake app-server 在 turn/start 返回前发送当前/其他回合图片通知，之后重放重复 completed；断言最终图片数量、身份与顺序，不启动真实 CLI。
2. 向错误的 failure/message 或 SDK error/config 放入合成 Base64 与合成凭据标记，捕获日志及普通历史；断言不存在这些标记，同时用户有不含原始数据的失败说明。
3. 上传前 flush 失败、上传 key 后 flush 失败、上传返回 null、message.create code 非零或无 message_id；分别断言网络阶段是否被调用及 outbox 保留状态。
4. 上传成功而发消息失败后关闭 JSON Store，用新实例 retry；断言 upload 不重复、sendUuid 不变、成功文字/图片不重发、模型调用不增加。
5. 分别挂起 upload/send，触发 stop/new/bind/bridge stop 后放行；核查后续发送和旧回执被拦截，及时确认成功的消息进度仍保存。
6. 真实 manager 消费循环的纯图、多图+文字、流卡 finalize 成功/失败/超时；不以仅单测 adapter.send 替代端到端接线验证。

## 执行纪律

- 收到主会话稳定通知后，先检查实际 diff、共享接口和生产调用方，再运行最小相关测试；不能只接受实施报告或复制实现逻辑作为测试。
- 修改既有符号前运行 GitNexus upstream impact；新函数图未知时核实已有调用入口和当前源码，不把 UNKNOWN/空结果视为安全。新增 HIGH/CRITICAL 先向主会话报告；明确局部问题修复并补回归，接口/产品判断先交主会话。
- 使用显式 fake transport/SDK/invoker 与合成 PNG；确认实际持有 fake，防止测试失败回退到真实模型。临时 JSON 独立，不读取用户账号、图片目录或生产运行数据。
- 每次后台测试外层总超时 60 秒，内部测试超时沿项目约定；不重复全量测试、索引、提交或推送。主会话负责最终整合、文档规范和发布。
- 本 reviewer 不改 docs/spec；发现文档和实际接口、限额、恢复边界不一致时报告主会话。根任务既有前三项修复语义仍需保持。

## 最终交付

稳定后产出独立 check 报告，分列已修问题、未修问题及理由、实际 TypeCheck/相关测试/差异检查结果。清楚区分已执行证据、仅源码判断与未经真实账号/生产飞书验证的限制；不将此计划当作检查通过证明。
