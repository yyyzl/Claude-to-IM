# 飞书交互与消息投递优化审查

日期：2026-10-04。基线为本轮开始时的工作树，包含上一轮升级；本轮未修改业务代码。

## D1 · P1：审批提示发送失败必须结束等待

证据：`src/lib/bridge/permission-broker.ts:43` 先登记转发去重，`:121` 仅在发送成功后登记 permission link，失败没有补偿；`scripts/claude-to-im-bridge/permissions.ts:16` 默认等待 10 分钟。`bridge-manager.ts:1327` 是直接转发入口。

触发：模型需要批准工具，飞书发送卡片失败。用户没有可操作的审批消息，模型却继续等到权限超时。同一 request 再转发也会被 recentPermissionForwards 拦住；去重清理在 has 检查之后，同 ID 单独重试甚至不能靠过去 30 秒自行解锁，需要另一请求触发清理。

纯内存复现确认：fake send 返回 400，forward 正常返回，等待未结束、无 permission link、再次 forward 不再 send。研究主动 abort 收尾，没有等待实际 10 分钟。

最小改法：投递失败或 permission link 登记失败时，明确拒绝/结束本次交互，并向模型传入可识别的交互失败原因；清理本次去重。为发送过程设超时，不能无限 pending。不要在未确认请求来源时允许审批。长期可与 user-input-broker 共享请求生命周期，但保留权限批准与普通问答的不同校验规则。

验收：发送返回失败、发送抛错、写 link 失败、发送超时都能结束等待；重复点击仍只批准一次。现有 callback 成功路径测试不能代替转发失败测试。

## D2 · P1：区分模型完成与回答送达

证据：`src/lib/bridge/bridge-manager.ts:1434` await deliverResponse 但忽略 SendResult；`:1487–1495` 清 active、ack 并排出下一条请求。`conversation-engine.ts:477` 已经保存了模型回答，但没有持久的投递状态。

触发：流式卡片收尾失败，最终回答 fallback 也发送失败，或普通平台发送耗尽重试。回合按处理完成结束，用户可能只看到残缺预览，甚至完全没有回答。源码确认失败状态丢失；未调用生产 API 复现平台故障。

最小改法：保存 `{turnId, response, deliveryStatus, lastError, attempts}`，失败后允许重投已有回答，避免重新调用模型。即使本次 IM 故障导致无法送出错误提示，下一次 `/status` 或本地诊断仍能看到未送达记录。发送和持久化共同决定 ack 策略，不直接声称 IM 存在跨系统 exactly-once。

长期：使用本地待发记录管理重试和分块进度；每块有稳定 ID，重试只补缺失部分。先用现有 Store 扩展，不引入独立消息队列服务。

验收：模型只调用一次，发送失败后记录 pending/failed，重启或手工重投可送达；部分成功不重复发送已成功块。过期/永久错误不无限重试。

### D2 的两个局部缺陷（P2）

- `delivery-layer.ts:349`：deliverRendered 不论成功与否都会 insertDedup。相同 key 重试被伪装成功，纯 mock 已确认。但当前 manager 的 `deliverResponse` 没传 dedupKey，因此这是导出接口的潜在缺陷，不能声称飞书主链路已因它丢信。新增可靠投递前必须修好。
- `delivery-layer.ts:243–269`：HTML 失败后降级 plain，再遇 429/网络失败时仍按原始 parse_error 提前返回；纯 mock 已确认只有两次 send，不执行后续重试。应将当前消息格式和最近错误一起更新，再按最新错误分类。

入站也有对应缺口：`feishu-adapter.ts:1288–1290` 在解析、下载和入队前标记 seen；中途失败仍保留 seen。若相同事件再次到达，将被丢弃。这里只确认代码处理语义，不推定平台必然重推。后续可统一 received/accepted/processed 状态，并限定故障重试范围。

## D3 · P2：长回答按实际消息体预算分块

证据：`types.ts:188` 的飞书限制为 30000，delivery-layer 的 chunkText 按 JS 字符长度拆分。`feishu-adapter.ts:750`/`:840` 则按 UTF-8 字节拒绝超大流式/最终卡；`:1116–1182` 的 card → post → text 降级重复使用整段正文，没有按消息类型重新分块。

官方文档本轮公开读取确认：卡片、富文本请求体上限 30 KB；纯文本请求体上限 150 KB。CardKit content 的字符参数限制不能替代卡片总体积限制。

复现：12000 个中文字符加代码围栏，小于 30000 字符，但封装的卡片与 post 都超过 30 KB；fake API 拒绝两者后，代码才以完整纯文本发送成功。**结论是两次无效请求和富文本体验降级，不是所有这类回答都会丢失。** 未对真实租户发送测试消息。

最小改法：飞书渲染器按序列化后的 UTF-8 体积估算，预留样式/封装余量；沿段落、代码块和表格结构分块，补齐围栏，标记页数。流式预览达到预算后提前说明后续分段发送，不突然停止更新。最终回答投递结果交给 D2。

长期：默认摘要卡 + 若干正文分段；特别长的报告提供完整 Markdown/文本附件。附件上传属于真实投递，应在正式实现和用户发起的任务流程中执行，本次没有上传。

验收：中文、emoji、转义字符、长单行、跨块代码/表格；每个最终 payload 都低于预算，拼接正文无丢字、无重复。超限失败可明确恢复，不只硬截断字数。

## D4 · P2：把卡片做成能反馈结果的操作入口

当前已具备 schema 2.0、CardKit 流式正文、独立工具进度和原生问答表单；上一轮已修复收尾竞态和回调 allowlist，不能再次列作未完成升级。以下是下一步体验机会：

| 使用时刻 | 建议 | 所依赖的可靠性约定 |
| --- | --- | --- |
| 等待工具批准 | 展示工具、目标目录、关键操作，长输入可查看完整内容；不只固定截前 300 字 | 不暴露 secret；完整信息必须经过权限/敏感字段处理 |
| 点过批准/拒绝 | 原卡更新为已允许/已拒绝，去掉按钮；超时显示已过期 | broker 确认处理完成后再更新，不能用“已收到点击”冒充已批准 |
| 等模型 | 显示正在执行、等授权、等回答、排队、正在取消及最近活动时间 | 读取统一任务状态，不由卡片独自推测 |
| 选模型 | `/models` 或设置卡列出运行时真实可用模型、思考强度、图片支持 | 复用已实现 model/list；不硬编码“最新”模型名 |
| 看长回答 | 摘要、分段、完整附件，保留复制代码的格式 | D3 的预算与 D2 的送达状态 |

原卡状态回写可以使用现有 SDK 的 `im.message.patch`，官方支持更新 14 天内已发送的卡片；不需要先引入模板平台或重做全部卡片。飞书消息更新权限和失败回退仍须在实施时核对。

## D5 · P2：附件支持范围应在入口清晰可见

证据：`feishu-adapter.ts:1375–1407` 下载 file/audio/video/media 和 post 图片；Claude 的 `llm.ts:45`、Codex 的 `codex-llm.ts:210` 目前只接受 PNG/JPEG/GIF/WebP 图片。post 中单张图片下载失败被静默忽略。

用户发 PDF/语音时，会先等待下载，然后模型入口才拒绝；含多图的消息还可能在缺图情况下继续执行。不是模型本身不具备这些能力，而是当前桥接尚未实现相应输入合同。

建议：按 backend/model 发布附件能力，能够预判不支持的类型尽早提示；不能预判时下载后明确说明。部分失败列出缺失附件，让用户知道模型实际拿到了哪些材料。后续按真实需求优先增加文本/代码文件与 PDF 提取，分别规定大小、编码、页数和错误反馈，不一次性上全媒体解析。

## 验证与边界

研究测试：`delivery-repro.test.ts` 共 4 个用例，断言当前不理想行为。全部使用内存 Store、假的 send/REST 与权限网关；测试禁止 child_process、fetch、net.Socket.connect，未调用 start，也不读取配置、凭据和真实记录。测试通过意味着复现成立，**不意味着缺陷已修复**。

本轮 GitNexus context 确认 deliverResponse → deliverRendered → sendWithRetry/send 的直接调用；图索引未反映上一轮未提交修改，实际证据以当前源码为准。未编辑业务函数，修复前仍须单独 impact。

官方来源（2026-10-04）：

- [发送消息：各消息类型体积限制](https://open.feishu.cn/document/server-docs/im-v1/message/create.md)
- [流式更新卡片文本：200860 体积错误](https://open.feishu.cn/document/cardkit-v1/card-element/content.md)
- [更新已发送卡片：体积及有效期](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch.md)

web 工具不支持这些 text/markdown 响应，改用公开 HTTP 读取官方文档，未携带认证。没有用搜索摘要推断限制。
