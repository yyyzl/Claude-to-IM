# 图片自动回传设计

## 端到端边界

Codex 0.160.0 原生 `item/completed.imageGeneration` → 独立图片 SSE → `ConversationResult.generatedImages` → manager 同一回答的 outbox → 飞书上传/发送。只接受精确当前 threadId/turnId/item.id 的 completed PNG；不读取 savedPath 或模型文字路径。桥接子进程局部配置 `features.omit_app_server_notification_media=false`，不改全局配置、不注入桌面工具、不升级依赖。

## 共享契约与实现所有权

- 实现者 A 负责 `host.ts/types.ts` 的窄共享类型、`internal/generated-image.ts` 校验、Codex provider、conversation-engine、manager 接线与对应测试。
- 实现者 B 负责 `channel-adapter.ts` 默认上传能力、`response-delivery.ts`、必要的delivery-layer接线、Feishu adapter、JSON store记录校验和对应测试。
- A 先落共享契约并通知 B；B 不自行编辑 A 的文件。双方按下列约定对齐，必要的小命名变化须互相通知。
- `GeneratedImage`：`id`（稳定生成事件ID）、`mimeType:'image/png'`、`data`（Base64）、`byteLength`、`sha256`；放 `host.ts`，只用于事件/内存产物/outbox，不进入普通消息历史。
- 文字块保留原字段，增加可选 `kind:'text'`（既存文本记录缺kind仍有效）；图片块为 `kind:'image', image:GeneratedImage, imageKey?:string, sendUuid:string, sent:boolean, messageId?:string`。
- `OutboundMessage.image?` 仅含已上传 `imageKey` 与稳定 `sendUuid`；BaseChannelAdapter 新增默认unsupported的 `uploadImage(image)` 能力，返回 `{ok,imageKey?,error?}`。图像消息在任何文字/卡片路径前分派，绝不能降级为空文字成功。
- `deliverResponse` options 增加 `images?:GeneratedImage[]`，消费方即使无文本也调用；原 `isCurrent/finalize` 语义沿用。

## 生命周期与失败

- 只在回合结束且归属仍当前时建立完整图文outbox；文字在前、图片按生成顺序。正常错误后仍保留已完成合法产物及明确错误说明；用户停止/超时取消/换绑后不自动发送。
- 本轮不做渐进outbox：建立记录前的内存产物不承诺进程崩溃恢复。建立后先save+flush，再上传或发消息，沿已有可选宿主持久化能力。
- 每图：校验归属 → 有界上传（已有key则复用）→ 保存key并flush → 再检查归属 → 用稳定uuid发送image → 保存sent/messageId并flush。迟到上传不得继续发送消息；已确认发送即使随后取消仍记录到原outbox。
- 图片失败不撤销已送文字；后续 `/retry` 复用key和uuid，只补未确认块，不重新生图。平台结果未知仍不声称永久exactly-once。
- 流卡finalize true仅确认文字块并flush，然后继续图片；纯图也收尾处理中卡，不生成空文字块。finalize超时沿当前fail-fast保留整条未完成记录和图片，给补发提示，不自动重复未知文字或把图片标成功。
- 其他适配器只保持文字能力，图片返回明确unsupported；无效/超限/空result给可见交付说明，不能静默丢弃或输出Base64替代。

## 图片与日志约束

- 按锁定SDK官方JSDoc：每图decoded bytes≤10_000_000，PNG宽高1…12000；本项目资源上限每回合8张、总30_000_000 bytes。超出明确说明，保留可送文字与已接受图片，不静默漏图。
- 严格标准Base64与canonical round-trip，先长度限额再解码；PNG signature、IHDR尺寸和chunk边界/IEND等最小结构校验，不解压、不自动缩放或改格式。接收和存储校验复用一个helper。
- 上传API使用 `client.im.image.create({data:{image_type:'message',image:Buffer}})`，返回扁平 `{image_key}` 或null；不同于message.create包装返回，不能误用data.image_key。
- 飞书REST client注入安全logger，仅输出固定类别和安全状态码，SDK错误中可能包含multipart数据；不得打印Buffer/Base64、完整Axios配置、令牌或原始错误对象。

## 验证与发布

真实0.160.0结构+合成PNG+fake transport/SDK/store，覆盖early通知、重复/错回合/failed/空/坏/超限、纯图与图文、流卡确认、上传key检查点、重启补发、取消晚到、其他平台、日志脱敏。每次后台测试总timeout≤60s，最后独立check、typecheck/build/全测、GitNexus范围检查，独立工作提交并推送main。不重启真实服务，不调用真实生图/飞书。
