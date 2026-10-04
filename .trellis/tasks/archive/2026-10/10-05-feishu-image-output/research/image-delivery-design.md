# Research: 本回合生成图片自动投递飞书

- Query: 在现有回答投递、补发与停止机制上，自动回传当前 Codex 回合的 PNG，同时保留文字。
- Scope: mixed；当前源码和本地 SDK schema 为主，飞书官方文档只读核查。
- Date: 2026-10-05
- 范围：投递设计，不重复 Codex 协议研究，不修改业务或测试，不调用真实模型/IM。

## Findings

### 结论与最小结构

可用现有 `ResponseDeliveryRecord` 扩展文字/图片分块完成，无需新数据库或通用媒体框架。推荐链路：本回合可信 `generated_image` 事件 → `ConversationResult.generatedImages` → 同一回答 outbox 的文字块与 PNG 块 → 飞书上传 → 保存 image_key → 图片消息发送 → 保存 sent/messageId。

协议来源见父任务 [image-output-protocol.md](../../10-05-audit-priority-fixes/research/image-output-protocol.md)：固定 Codex 0.160.0，精确 threadId/turnId/item.id、completed + 非空 result、原始 PNG Base64。只消费该结果，不使用 savedPath、Markdown 路径或磁盘扫描。无需依赖升级。

### 1. 当前实现会遗漏图片的三个边界

| 当前位置 | 当前行为 | 必要调整 |
| --- | --- | --- |
| `host.ts:29–51`、`conversation-engine.ts:74–104,273,505–523` | SSE、result 只有文字/工具结果；assistant 历史会保存 contentBlocks | 新增窄 `GeneratedImage` 类型和独立事件；消费到独立数组，按生成事件ID去重，不把 Base64 放入 contentBlocks、模型历史或工具状态文本 |
| `bridge-manager.ts:1567–1584` | 空文字只收尾卡片；仅 `responseText` 非空才创建待发记录 | 判断改为文字或有效图片；纯图也必须进入 outbox。没有任何产物时才走现有空回答收尾分支 |
| `response-delivery.ts:63–67` | finalize 成功把全部 chunks 标 sent | 只确认文字块；立即保存该进度，然后继续图片块。不能让文字流卡完成代表图片送达 |

生成图成功而后续回合正常报错时，可以保留已经完成、校验通过的图片与文字，只要该回合仍属于原聊天；错误信息与图片投递结果分别说明。用户停止、超时取消或换绑后不自动发送。最小方案在回合结束、创建 outbox 后提供持久重试；停止发生在 outbox 建立前的内存产物不会自动恢复，不能宣称保存了这些未入箱数据。若产品要求生图事件一完成就抗进程崩溃，须另设计渐进 outbox 更新，不建议默默扩入本轮。

### 2. 数据契约：同一 outbox、分块独立进度

`host.ts:139–150` 当前 chunks 仅有 text/parseMode/sent/messageId；`types.ts:64–75` 的 `OutboundMessage` 也只有文字。

推荐最小类型：

```ts
type GeneratedImage = {
  id: string; // 编码或摘要(threadId, turnId, item.id)，不是模型给出的文件名
  mimeType: 'image/png';
  data: string; // 已校验的原始 Base64
  byteLength: number;
  sha256: string;
};

// 旧文本 record 无 kind，按 text 解释；新写入显式 kind。
type ResponseChunk =
  | { kind?: 'text'; text: string; parseMode: 'HTML' | 'Markdown' | 'plain'; plainFallback?: string; sent: boolean; messageId?: string }
  | { kind: 'image'; image: GeneratedImage; imageKey?: string; sendUuid: string; sent: boolean; messageId?: string };
```

- 先生成完整的文字块和图片块，在任何上传/发送前 `save + flush`。文字块在前，图片按生成顺序排列，不因图片失败撤销已送文字。
- `deliverResponse` 的 options 增加 `images`，记录 ID 的稳定材料包含产物 ID/摘要，防止同文字的不同产物混用已有记录；Base64 不进入日志或可见 ID。
- 同一 record 继续使用既有 `running` 互斥；图片的重复事件先按生成ID去重，不按图片内容去重（两个独立生图调用可能故意生成相同内容）。
- 分块状态只有确认平台消息成功才 sent；仅上传成功不算 sent。`imageKey` 是单块中间检查点，必须在 send 前 flush。重试优先复用已有 key，避免“上传成功、发送失败”再上传。
- 图片块的稳定 `sendUuid` 在首次 outbox 写入时生成并持久化，重试复用；可使用现成 UUID，或固定规范的摘要。SDK create/reply 均支持 uuid。平台去重窗口不可当永久保证，仍沿现有“不声称 exactly-once”的合同。
- 全部成功仍清空 responseText/chunks；部分失败保留未完成图片数据与已确认进度。不要在成功消息已发出但保存失败后清除内存 sent 标志。
- `store.ts:547–556` 的 parsePersistedData 必须区分 text/image 校验；旧纯文字记录继续可加载，错误/过大图片字段不能让存储静默空载。不要用强制类型断言跳过校验。

### 3. 飞书 SDK 1.74.0：上传返回值与消息返回值不同

本地 `package.json:57` 锁定 `@larksuiteoapi/node-sdk:1.74.0`。以已安装源码为准：

```ts
const uploaded = await client.im.image.create({
  data: { image_type: 'message', image: pngBuffer },
});
// uploaded: { image_key?: string } | null，必须检查非空 key。

const response = await client.im.message.create({
  params: { receive_id_type: 'chat_id' },
  data: {
    receive_id: originalAddress.chatId,
    msg_type: 'image',
    content: JSON.stringify({ image_key: imageKey }),
    uuid: persistedSendUuid,
  },
});
// 校验 code，并要求 response.data.message_id 才确认成功。
```

- `node_modules/@larksuiteoapi/node-sdk/types/index.d.ts:266231–266238`：image.create 接受 `Buffer | fs.ReadStream`，返回扁平 key 或 null。
- SDK `lib/index.js:67445–67460`：multipart POST `/open-apis/im/v1/images`，最终 return `res.data || null`。不可写成 `uploaded.data.image_key`；不能仅靠本地 `assertFeishuSuccess` 判断上传成功。
- 类型 `:264220–264238`：message.create 接受 receive_id、msg_type、content、uuid，返回 code/msg/data.message_id。
- 类型 `:263904–263918`：如选择回复原始消息，message.reply 也支持 msg_type/content/uuid，目标为 `replyToMessageId`。最小需求是原聊天 create；可以保持当前文字出站的聊天语义，不必为图片新增 thread 策略。
- 上传必须 `image_type:'message'`，不能用 avatar；与原始 `record.address` 绑定，不能读取当前 binding 再改地址。

适配器最小接口可选为 `uploadImage(image): Promise<UploadImageResult>`（默认明确 unsupported），出站消息增加仅包含已上传 key 与稳定 uuid 的窄图片字段；飞书 `send` 在 HTML/Markdown 处理前分派 image。也可用 `sendImage` 窄能力，但要让投递层仍统一负责限流、截止时间与结果。避免在一个 `adapter.send` 内串联“上传后立即发送”，否则上层超时/取消后，迟到上传可能继续发送图片。

### 4. 上传、发送必须分阶段检查归属

推荐每个图片块的顺序：

1. checkCurrent；若无 imageKey，执行有界 upload。
2. 上传返回 key 后更新该原始 outbox 块并 flush；即使此时被取消，保存这个原 record 的上传进度也不会污染新聊天。
3. 再 checkCurrent；若过时则停止，不发送 image 消息。
4. 通过 `deliverSingle` 的既有限流/重试/本地截止时间发送已上传 image key；只发一次稳定 uuid。
5. 平台确认成功后先记录 sent/messageId 并 flush，再 checkCurrent；不能先因取消抛弃成功进度，导致后续重发。

`/retry` 复用父任务刚实现的独立补发 context、generation/epoch 和 taskPromises，无需修改新的控制调度。stop/new/bind/bridge stop 使后续上传/发送失效；已开始的 HTTP 请求无法保证外部撤销，应诚实保留结果未知语义。

`delivery-layer.ts:29–55` 当前有两层本地截止时间；SDK `IRequestOptions:57–65` 没有 signal 字段。飞书 REST client `:305–314` 已用 httpInstance proxy 设 15s 网络 timeout。不要假装给 SDK 第二参数加 signal 就能取消。上传阶段也要有界，迟到上传仅可能产生平台资源，不得链式触发消息发送。

### 5. 流卡、部分失败与其他适配器

- finalize true 仅将 text chunks 标 sent，并在上传前 flush；finalize false 时走现有文字 fallback。纯图完成时仍收尾已有“处理中”卡，但不制造空文字分块。
- 如果 finalize 超时，平台文字状态未知。可以将该问题计入文字块错误后继续独立图片阶段，但不能盲目再发整段文字。最小实现若保留 fail-fast，则整条记录留待 `/retry`，必须保证图片仍存在于 outbox，不能被误标成功/清空。根可在实现设计中明确选择；至少正常 finalize true 必须继续发图。
- 图片失败后文字仍可见；返回简短可操作说明，例如“文字已送达，图片未完整送达，可用 /retry <id> 补发”。只在 context 仍当前时发送，避免新会话收到旧失败提示；提示本身失败不抹除 outbox。
- 其他 adapter 默认显式不支持图片投递，不能把空 text 发送成功就将图片块标 sent。保留正常文字、给能力提示，图片块保持未送达；当前 `/retry` 只尝试投递，绝不重新调用模型生图。
- 不扩展其他平台上传实现，不把图片嵌入新飞书卡模板；飞书原生 image 消息可直接预览和保存。

### 6. PNG 限额与数据校验

本地 SDK image.create JSDoc `types/index.d.ts:266229` 写明非空、≤10 MB、非 GIF 分辨率≤12000×12000。建议桥接采用保守每图 `10_000_000` decoded bytes，检查 PNG IHDR 宽高均为1…12000；这是对 SDK 文档界限的安全取值，不宣称远端按十进制计费或计量。

- Base64 长度先限额再 decode；仅接受标准 alphabet/padding 与长度，解码后重新编码比较，拒绝被 `Buffer.from` 宽松吞掉的杂字符、data URL、URL/path。
- 校验 PNG 8字节 signature、IHDR 必需头与长度、宽高；可用轻量 chunk 边界/必要 IEND 校验识别明显截断，不解压像素、不自动转格式。魔数检查不是完整图片解码安全证明，最终仍可能被平台拒绝。
- 限制单回合图片总 decoded bytes 和张数，避免 SSE/outbox 多份字符串、structuredClone 和 JSON 快照造成无界占用。推荐起点：最多8张且总30MB；这两项是本项目资源策略，需在实现文档明确，超过时给图片交付失败说明、保留可送文字，不静默漏图。
- Base64 只进入受保护的 outbox，不进入普通对话历史、audit summary、console/error。发送成功后沿现有清除 payload 规则。未完成记录仍会占磁盘；此轮不引入自动删除用户待发图政策，文档说明限额/清理语义。

**必须处理 SDK 自动错误日志：** `lib/index.js:335–348` 的 formatErrors 会包含 Axios `config.data`；image.create `:67457` 自动 `logger.error`。当前 Feishu client `:305` 没传安全 logger。新增 Buffer multipart 后应为该 client 提供只记录固定类别、code/status/经过筛选 message 的 logger，不输出原始 SDK/Axios 对象。仅在业务 catch 中删 Base64不足以阻止 SDK 提前打印。测试必须注入包含 Buffer/base64 的上传错误并断言输出中无图像数据。

## Files found / 必要改动位置

| 文件 | 责任/预计函数 |
| --- | --- |
| `scripts/claude-to-im-bridge/codex-llm.ts` | 协议报告已定位 collectTurnText/SSE产出；接收当前回合原生结果，事件去重与错误说明 |
| `src/lib/bridge/host.ts` | GeneratedImage、SSE事件、ResponseChunk类型；宿主 outbox 仍用原有可选四方法 |
| `src/lib/bridge/conversation-engine.ts` | consumeStream 收集独立 generatedImages；成功/错误结果传播、禁止Base64进入历史 |
| `src/lib/bridge/bridge-manager.ts` | handleMessage 完成投递判断、纯图流卡收尾、当前context失败提示 |
| `src/lib/bridge/response-delivery.ts` | chunks/attempt/deliverResponse 的文字与图片分支、上传检查点、finalize仅文字、retry沿用 |
| `src/lib/bridge/types.ts`、`channel-adapter.ts` | 窄出站图片与上传能力契约；默认明确不支持 |
| `src/lib/bridge/adapters/feishu-adapter.ts` | uploadImage、send图片分支、稳定uuid、错误映射、安全SDK logger |
| `src/lib/bridge/delivery-layer.ts` | 仅如需要共享上传deadline/图片发送分派才改；不得把图片走text fallback |
| `scripts/claude-to-im-bridge/store.ts` | parsePersistedData 验证新块并兼容旧纯文字；save/load沿现有JSON |
| 可选 `src/lib/bridge/internal/generated-image.ts` | Base64/PNG/预算纯函数，供接收和持久数据校验复用，避免复制 |

实现前另作逐符号 impact；本研究按委派未批量 impact，不能将此文当作修改前影响门禁完成。

## 最小测试断言

全部使用协议fixture、fake SDK/adapter/LLM和临时 JSON，不调用真实服务；总时限≤60秒。

1. `bridge-codex-llm.test.ts`：现有协议报告要求的本turn、early backlog、重复item、失败/空result/非PNG/大小边界，LLM不需要真实生图。
2. `bridge-conversation-engine.test.ts`：文字+多图、纯图；工具输出与历史不含Base64；正常错误保留已完成图片；取消与迟到事件隔离。
3. `bridge-delivery-reliability.test.ts`：先flush后upload；finalize true文字sent但image未sent；upload key flush失败不能send；发送失败重试复用key+uuid，不重发成功文字/图片；错误状态不清数据；重复retry不并发同record。
4. `bridge-feishu-reliability.test.ts` 或窄新测试：upload参数使用message+Buffer；扁平key/null；create image content/原chat/uuid；消息code非0/缺message_id失败；上传错误不打印Buffer/base64；图片不得走post/card fallback。
5. `bridge-json-store.test.ts`：混合块重启恢复，包括uploaded但未sent；旧文本record可加载；畸形image结构/超限拒绝；全部成功后payload清理。
6. `bridge-lifecycle-regression.test.ts`：upload/send挂起时其他聊天stop/审批不阻塞；stop/new/bind/停机后upload晚到不send；已经确认sent进度保留；纯图自动投递；/retry模型调用次数不变。
7. 非飞书fakeadapter：文字照常送达，图片显式unsupported、无伪成功，无空文字假发送。

## Related specs

- `.trellis/spec/backend/reliability-contracts.md`：先持久化后发送、每块进度、取消与代际隔离、补发不调用模型、结果未知窗口。
- `.trellis/spec/backend/module-boundaries.md`：provider→core→adapter→host分层；图片解析不放平台消息代码。
- 父任务 `research/image-output-protocol.md`：Codex0.160.0真实完成事件、result-only、能力条件。

## External references

- [飞书上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create) 与 [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)：本轮网页抽取返回0行，具体schema/限额以锁定SDK1.74.0内附官方JSDoc及实现核实，不声称网页正文已读到。
- [飞书官方方案权限说明](https://open.feishu.cn/solutions/detail/ticket?lang=zh-CN)：`im:resource` 覆盖获取与上传图片/文件；仍需要应用机器人能力和消息发送权限。本轮未检查或修改用户应用权限，也未查看凭据。
- SDK create/reply 具备 uuid 字段已由本地类型确认；本轮未从官方网页取得精确去重时窗，不写未经核实的永久保证或具体时长。

## Caveats / Not Found

- 原生生图是否对用户当前 provider/auth/额度可用不由本投递层保证；沿协议报告能力限定，不提示“所有模型均能生图”。
- 读到的是父任务修复后的当前共享工作区，行号可能随其最终提交改变；本代理没有修改任何其他文件。
- SDK上传API扁平返回、安全日志、finalize仅文字是本地源码确认结论；未运行真实图片、上传、发消息或凭据读取。
- 本轮只落设计，未运行单测，也没有安装依赖、改全局配置或调用生产接口。
