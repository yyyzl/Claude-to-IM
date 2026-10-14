# Research: 飞书完成态空白 Markdown 与只读平台取证

- Query: `partial_update_element` 将 Markdown content 改为单空格是否有清空保证；机器人自发 CardKit 消息的 IM 读取参数；HTTP 400 / 230027 的精确含义与最小取证方法。
- Scope: mixed（官方文档、本地 SDK 1.74.0、当前目标渲染与收尾代码）
- Date: 2026-10-14
- Active task: `.trellis/tasks/10-14-feishu-progress-collapse`
- 本研究不调用真实 API、不发送消息、不重启、不修改业务/测试/配置/依赖。只写此文件。

## Findings

### 1. 结论：尚无证据把“单空格清空”认定为根因

官方 JSON2 富文本字段表将 `content` 定义为必填 String，未列出非空、去空白后非空或仅空格不能更新的规则。组件属性更新、局部更新接口也没有定义“空白 content 被忽略并保留旧值”的语义。**当前不能认定 `content: ' '` 已被平台拒绝/忽略，也不能仅凭 fake SDK 成功证明真实客户端已清空。**

官方字段合同允许更新指定组件的 content 属性，但对 `''`、`' '`、换行、零宽字符没有专门的“清空文本”示例或渲染保留保证。不要在缺少平台证据时改成零宽字符、特殊 HTML 或另一种空白并宣称修好。[JSON2 富文本](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text)、[更新组件属性](https://open.feishu.cn/document/cardkit-v1/card-element/patch)、[局部更新卡片实体](https://open.feishu.cn/document/cardkit-v1/card/batch_update)。

如果产品必须移除该区域而不依赖空白渲染，官方有按元素 ID 的删除操作，可在收尾删除**外部** `tool_progress` 节点；这属于真实卡片结构变化，不是本研究已批准/实施的修复，也不能在取证时替用户改卡。删容器会连带删子节点，应避免操作 `progress_history`。[删除组件](https://open.feishu.cn/document/cardkit-v1/card-element/delete)。

### 2. 当前源码里的事实与应区分的情况

只读核对 `src/lib/bridge/markdown/feishu-progress.ts`：

- `:78`：有终态 `input.status` 时，`recent` 为 `[]`，并不有意保留最后三个成功步骤在外部。
- `:79`：失败步骤仍最多两个外露；这是“异常醒目”的既有设计，不能把它们误归为最近三条成功进度。
- `:93`：终态不再拼接 `input.progress`，没有可见步骤时 `tool_progress` 为 `' '`。
- `:58`：产生 `partial_update_element`，目标为 `tool_progress`，值为单空格；无故意跳过空白更新的代码。
- `:44–47`：历史始终在 `progress_history` 下的 `history_content`。用户已经展开历史时，完成后仍看得到步骤，符合已选择的保留阅读状态，不能据此判定外部最近进度未清除。

`src/lib/bridge/adapters/feishu-adapter.ts:922` 附近的 finalize：构造 terminalView 后，对变化元素调用 batchUpdate；只有真实业务成功后更新 sentView。最终使用局部更新，不主动收起用户已展开的面板。

需要分清：

1. **原卡外部 tool_progress 仍显示成功步骤**：可能是终态未执行、未装载目标构建、更新失败/未包含该 action、平台/客户端空白行为等；尚无平台证据确定其中哪一项。
2. **原卡历史已经展开，步骤继续可见**：不是同一现象，保留展开是用户明确选择。
3. **卡片外的独立旧消息仍在会话中**：局部更新一张卡不会删除其他消息；需消息归属证据确认，不能把它算作该卡 content 清空失败。

### 3. IM 读取参数与 SDK 合同

`@larksuiteoapi/node-sdk` 1.74.0 已支持 `card_msg_content_type`，不需升级依赖。源码声明：

- `node_modules/@larksuiteoapi/node-sdk/types/index.d.ts:264022`：`im.message.list`，字段在 params 内。
- `node_modules/@larksuiteoapi/node-sdk/types/index.d.ts:264157`：`im.message.get`，path.message_id 必填；params 可选，包含 card_msg_content_type。

已知原卡 message_id 时，最小只读请求草案：

```typescript
const result = await client.im.message.get({
  path: { message_id: knownOriginalCardMessageId },
  params: { card_msg_content_type: 'user_card_content' },
});
```

`get` 返回 `data.items` 数组，正文是各 item 的 `body.content` JSON 字符串，不是 `data.message`。不必设置 with_sender_name，不请求 user_id，不额外获取人员信息。[获取指定消息](https://open.feishu.cn/document/server-docs/im-v1/message/get)。

没有已知 message_id 时，`list` 的最小定向草案：

```typescript
const result = await client.im.message.list({
  params: {
    container_id_type: 'thread',
    container_id: knownOriginalThreadId,
    sort_type: 'ByCreateTimeDesc',
    page_size: 5,
    card_msg_content_type: 'user_card_content',
  },
});
```

普通对话群的话题回复，通过 `container_id_type:'chat'` 仅能读到话题根消息；原任务卡在回复内时应以已知 `thread_id` 定位。thread 容器不支持 start_time/end_time 时段筛选。若原卡并非话题回复，才用原 `chat_id`；避免为了找卡遍历整个聊天或切换其他聊天。[获取会话历史](https://open.feishu.cn/document/server-docs/im-v1/message/list)。

### 4. card_msg_content_type 的保证边界

- 不传该参数：卡片内容采用接收消息结构，不支持原始发送 DSL。
- 传 `'user_card_content'`：官方定义为返回发送时的原始卡片 JSON；可检查 schema 识别 1.0/2.0。
- 这只改变卡片消息的返回表示，不是授权参数，不会授予读取权限。

**不要把“发送时原始 JSON”直接解释为“CardKit 所有后续局部更新的权威最新快照”。** 文档 `body` 说明为当前消息内容，但参数说明使用“发送时原始卡片 JSON”；未专门描述使用 card_id 引用发送后，实体局部更新在此接口返回体中的时点、一致性、引用解包和客户端状态。list 文档 body.content 仍残留“暂不支持原始 JSON”的旧说明，与新增参数存在文案差异，需按实际结构辨认并记录这种文档边界。

因此返回可能是可解析的 JSON2 布局、接收消息结构或实体引用；先检查结构。若只有 `{type:'card',data:{card_id:...}}`，不能凭引用推断内部 tool_progress 已清空。若拿到带元素 ID 的布局，记录该节点值及返回时间，仍结合实际终态回执与客户端观察确认，尤其不能把展开状态当作服务端 JSON 属性。

来源：[获取指定消息](https://open.feishu.cn/document/server-docs/im-v1/message/get)、[获取会话历史](https://open.feishu.cn/document/server-docs/im-v1/message/list)。本地 SDK 的 `cardkit.v1.card` 没有 get 方法；不编造 `client.cardkit.v1.card.get`，也不因 SDK 未列出就断言平台永远没有别的只读能力。

### 5. HTTP 400 / 230027 的精确解释

官方 get/list 错误表均定义 `230027` 为 **本次操作无权限**，候选原因是相应权限不足、没有找到用户授权信息，或外部群操作未开启机器人对外共享能力。**单独的数字不能确定缺的是哪个 scope，也不能证明 token 已过期、机器人不在群、原卡更新被拒绝或清空行为不合法。** 这些属于不同的错误/调用边界。[获取指定消息](https://open.feishu.cn/document/server-docs/im-v1/message/get)、[获取会话历史](https://open.feishu.cn/document/server-docs/im-v1/message/list)。

读取权限与发送/更新权限分开：

- 应用身份读单聊：官方列 im:message / im:message:readonly（list 也列历史版 im:message.history:readonly）。
- 应用身份读群聊：除基本消息读取权限，还需 im:message.group_msg，且机器人必须在所属群。
- 用户身份需要其授权及相应 p2p/group get_as_user 附加权限；不能无声切换用户身份或登录。

官方没有“只读机器人自己的消息便自动豁免上述群读取权限”的保证。已知原卡用 get 能减少读取范围，但**不保证绕过当前 230027**。cardkit:card:write 或 im:message.send_as_bot 可正常创建/更新，并不推得具备聊天读取权。

本次不修改权限或外部共享设置，不申请新 scope。主会话已遇 list 230027 时，优先读取现有错误里的安全权限字段与固定说明；不反复扫不同聊天，不靠新增消息探测，不把 get 的可能成功当作已证实结果。

### 6. 最小平台取证建议（不新增卡、不发送消息）

1. 从现有受控创建回执/日志取得**原卡** message_id、card_id，以及当前桥接实际版本和开始时间；避免只按“最新消息”选到另一轮或诊断卡。
2. 先检查原卡终态 batchUpdate 的受控记录：是否真的包含 `tool_progress` 的 `partial_update_element`；是否 `content.length===1 && trim().length===0`；业务 code 是否为 0；sequence 是否属于同 card_id 且晚于运行态写入。不能仅看 HTTP 200 或 fake receipt。
3. 有现成正确身份和权限时，仅对已知原卡调用一次 get，并传 `'user_card_content'`。若已有 list 230027 且 get 同样无权，保留错误事实就停止，不扩大读取范围/自动改权限。
4. 只对精确匹配原 chat、原 app sender、原 message_id 的结果解析 content；输出结构化摘要，区分 JSON2 DSL/接收结构/实体引用。
5. 若能取得 JSON2 元素，提取 `tool_progress` 是否存在、内容长度、trim 长度、空白判定；再确认 `history_content` 是否仍嵌在 `progress_history` 内。不要输出历史命令、最终回答或其他聊天内容。
6. 服务端结果仍无法证明客户端视觉表现。浏览器 Debugger unattached 的情况下，应明确“当前无法视觉复验”；恢复浏览器后只查看已有原卡，确认可见三条分别属于外部最新进度、已展开历史还是独立消息。读取/查看不修改原卡。
7. 若确定最新原卡 tool_progress 内容仍是旧三条，才据请求/回执定位未清空环节；若服务器返回空白而客户端仍显示旧内容，才把客户端或平台呈现作为下一假设。未取得证据前不实施字符替换或结构删除试错。

### 7. 安全可显示字段与不得直接打印的内容

建议取证摘要只含：

- 调用阶段（get/list/finalize）；固定接口名、HTTP status、业务 code。
- 原卡标识可按需哈希/缩短；受控验收内可以保留完整 message_id/card_id，但不要混入其他会话标识。
- 时间戳、sequence、msg_type、sender_type、deleted/updated；原 chat/app 匹配的布尔值。
- 返回结构类别、schema、body 字节长度、目标元素是否存在、目标 content 长度/trim 长度/isWhitespace，以及可选正文 SHA256。
- 错误中明确的 scope 名称可按白名单提取；log_id 可作为内部关联诊断号，不必输出完整原始 msg。

不要打印 SDK AxiosError 整体、request/config/headers、任何 access token/app_secret、完整 body.content、聊天记录、用户身份列表。SDK 错误可能附带鉴权请求配置，不能直接 JSON.stringify(error)。取得成功响应也不意味着可以把整条聊天正文输出给日志。

## Files Found / Code Patterns

- `.trellis/tasks/10-14-feishu-progress-collapse/prd.md`：用户最终选择非流式动态局部更新，优先保留阅读状态。
- `src/lib/bridge/markdown/feishu-progress.ts:35`：初始 Markdown 空白占位。
- `src/lib/bridge/markdown/feishu-progress.ts:53`：按固定元素 ID 的内容差分与局部动作。
- `src/lib/bridge/markdown/feishu-progress.ts:78`：终态清除 recent，错误仍外露。
- `src/lib/bridge/adapters/feishu-adapter.ts:922`：终态 batchUpdate 与 sentView 更新。
- `node_modules/@larksuiteoapi/node-sdk/types/index.d.ts:264022`：list 参数与 data.items。
- `node_modules/@larksuiteoapi/node-sdk/types/index.d.ts:264157`：get 参数与 data.items。

## Related Specs

- `.trellis/spec/backend/reliability-contracts.md:80`：fake SDK 不是平台 schema 或真实可见结果的证据。
- `.trellis/spec/backend/reliability-contracts.md:26`：原卡与原回合归属必须精确，旧响应不得误写新卡。
- `.trellis/spec/backend/reliability-contracts.md:60`：平台投递/更新与模型/权限核心事实区分。

## External References / Versions

官方文档与本地 SDK 1.74.0，2026-10-14 只读检查。官方 HTML 正文缺失时，以同 canonical 路径加 `.md` 获取：JSON2 rich-text 483 行；card-element/patch 90 行；delete 88 行；im/message/get 129 行；list 136 行。get/list 新参数文案与个别历史 body 说明存在不一致，已保留而未猜测消除。没有使用第三方转载作为合同依据。

## Caveats / Not Found

- 未发现“单空格清空必定成功”或“单空格 patch 必定被忽略”的官方专门保证；都不能当根因。
- 未找到使用 `content:''` 的官方清空示例或保证。不可把 wrapper 字符串最小长度规则误当作内部 content 的非空规则。
- 当前用户可见内容位置尚未确认；主会话的 list 230027 与浏览器未附着是已报告的取证限制，本研究没有重现该 API 调用。
- 没有执行任何真实平台读取/写入；草案只用于主会话后续最小只读取证。
- `user_card_content` 不保证客户端展开/滚动状态，也没有专门说明 CardKit 后续实体更新的同步一致性；不可用原始发送 DSL替代终态真实取证。
