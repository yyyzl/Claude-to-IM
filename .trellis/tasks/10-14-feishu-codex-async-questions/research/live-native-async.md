# Research: 真实 Codex 原生非阻塞提问入口

- Query: 真实 request_user_input_async 为什么只进入飞书过程卡，如何补齐原生题目卡及答案准入？
- Scope: mixed（当前源码、两版官方生成 schema、仅指定当前会话的测试题白名单、官方文档）
- Date: 2026-10-14

## Findings

### 1. 真实证据及边界

本次研究不调用模型、飞书接口或 thread/start/resume，不读取全局配置或凭据，不重启进程。仅查看主会话明确指定的 rollout 文件，并按 `QA_FEISHU_20261014` 筛选本次测试题，再输出 type/phase/delivery/questions 等安全字段。

文件：`C:/Users/10455/.codex/sessions/2026/10/13/rollout-2026-10-13T13-46-14-01a133cc-1278-71f3-8964-1c0f3e30e3ca.jsonl`。

- 第 3817 行为 `response_item.function_call`，name 为 `request_user_input_async`，arguments 有两道题。
- 第 3818 行为 `event_msg.item_completed`，时间 `2026-10-14T07:03:41.515Z`，thread 为该文件指定 UUID，turn 为 `01a13933-338e-7fa0-b22a-d8cf5af9ef13`；内部 item 如下。

```json
{
  "type": "AgentMessage",
  "id": "call_1c7ef798336149ce8b1cd38346cfbd43",
  "phase": "final_answer",
  "delivery": "async",
  "questions": [
    {
      "title": "本轮真实联调的报告格式用哪一种？这也是选择题卡片的验收项。",
      "options": ["简短报告", "详细报告"]
    },
    {
      "title": "请填写本轮验收标记，便于核对自由文字答案是否确实回到当前 Codex 回合。测试值使用 QA_FEISHU_20261014。",
      "options": null
    }
  ]
}
```

这是**真实持久内部事件**，不是捕获的 app-server stdout。内部类型 `AgentMessage`、content 数组与 app-server `agentMessage`、text 字段要按当前官方 schema 区分，不能声称直接抓到了 wire notification。飞书另一个通知 bot 的“Codex 正在等你回答”也不能当作本桥接原生表单证据。

### 2. 两版原生消息协议相同

比较以下本地官方生成 schema 的解析 JSON 子树：

- 0.160.0：`.trellis/tasks/archive/2026-10/10-05-codex-model-picker/research/codex-0.160.0-schema/`。
- 0.162.1：`.ccg/codex-user-input/0.162.1/schema/`（此前已核对官方发行包版本与完整性，本研究未重下载或升级）。

`v2/ItemStartedNotification.json` 和 `v2/ItemCompletedNotification.json` 的 `AsyncUserInputQuestion` 定义及 `ThreadItem.agentMessage` 分支在两版中分别完全相同：

```ts
type AsyncUserInputQuestion = {
  title: string;
  options?: string[] | null;
};
// ThreadItem 的一个分支
type NativeAsyncAgentMessage = {
  type: 'agentMessage';
  id: string;
  text: string;
  phase?: 'commentary' | 'final_answer' | null;
  delivery?: 'async' | null;
  questions?: AsyncUserInputQuestion[] | null;
};
```

定位：0.162.1 ItemStartedNotification 第 8 行 AgentMessageDelivery 仅有 async，第 14 行 AsyncUserInputQuestion，第 844 行附近 agentMessage；0.160.0 分别第 8、14、837 行附近。这是以前仅比较三份问答 RPC schema 时遗漏的生产者入口，不需要升级固定 Codex 依赖。

### 3. 答案通道结论

原 `item/tool/requestUserInput` 是双向 JSON-RPC 服务端请求，有原 request ID，答案必须回原 RPC。原生 async questions 则属于 item notification，没有与其对应的 server request ID，不能把 `item.id`/工具 call ID 当成 JSON-RPC response ID。

0.162.1 `ClientRequest.json` 有 170 个方法，input/answer/question/steer 相关匹配只有 turn/start 和 turn/steer。`v2/TurnSteerParams.json` 要求 threadId/expectedTurnId/input；其 UserInput 分支包括 `{type:'text',text}`，没有原生 question-answer DTO。`ServerRequest.json` 仍有原 RPC `item/tool/requestUserInput`，不能与原生消息混用。

官方 [app-server 文档](https://learn.chatgpt.com/docs/app-server) 明确支持通过 turn/steer 给当前回合追加 text 输入，要求 expectedTurnId 精确一致，且不创建新 turn；已无 active turn 时该调用失败。因此基于**真实生产者形态、当前可用请求 schema 与官方普通输入合同**，本桥接应把原生题目答案作为携带原题的普通 user 文本，进入现有即时追加/后轮路径。公开文档尚未给出原生 questions 专属回答示例；这是可用合同的实现推论，不冒充官方专用 answer API。

### 4. 当前漏点与最小接线

| 文件 | 作用及定位 |
| --- | --- |
| `scripts/claude-to-im-bridge/codex-llm.ts:244` | streamChat 调 collectTurnText，已有单回合输入 closure 和 collector-ready。 |
| `scripts/claude-to-im-bridge/codex-llm.ts:485` | collector 精确匹配 thread/turn，处理 early backlog；第 553 行 agentMessage 仅处理 phase/text，丢失 delivery/questions。 |
| `src/lib/bridge/host.ts:342` | UserInputRequest 只有 requestId/questions/isBlocking，不能说明答案通道。 |
| `src/lib/bridge/conversation-engine.ts:418` | 原 JSON request 完整透传给 onUserInputRequest，不需要为 metadata 新加 engine 事件。 |
| `src/lib/bridge/user-input-broker.ts:76` | forward 当前一律观察 PermissionGateway，原生消息不能创建假的待回答权限请求。 |
| `src/lib/bridge/user-input-broker.ts:129` | resolveAnswer 只回权限网关；原生 pending 答案需要走消息准入。 |
| `src/lib/bridge/user-input-broker.ts:154` | prepareUserInputSupplement 已有原题校验及同步一次 claim，可收敛为共享消息准备器。 |
| `src/lib/bridge/user-input-broker.ts:205` | clear 当前把 pending 一律取消；正常结束需将 native pending 转 closed。 |
| `src/lib/bridge/bridge-manager.ts:1130` | typed 问答动作已经纳入 tracked task，绕过普通模型锁。 |
| `src/lib/bridge/bridge-manager.ts:1214` | 显式补充在 admissionGate 下准备、sanitize、claim、enqueue；原生 pending 回答可复用。 |
| `src/lib/bridge/bridge-manager.ts:1590` | 问答原归属/可补充谓词；第 1609 与 1771 行正常 clear 已传 preserveClosed/owner。 |
| `src/lib/bridge/markdown/feishu.ts:413` | 既有原生表单和 phase 更新能力，输入和选择控件无需重建。 |
| `src/lib/bridge/adapters/feishu-adapter.ts:604` | 回调已分 original answer 与 explicit supplement，真实 user/chat/card 从 context 提取。 |

建议保持既定业务文件范围：

1. `UserInputRequest.answerChannel?: 'rpc' | 'message'`，缺省 rpc，不根据 isBlocking 猜通道。显式 message 只给当前 Feishu/Codex 原生题使用。
2. provider 在**当前 collector**内识别严格匹配原 threadId/turnId 的 `agentMessage + delivery:'async' + 非空有效 questions`，从 title/options 映射 UserInputQuestion，缺少原 ID 时使用本组 q0/q1 等稳定本地 ID；一次生成 opaque requestId。按 item.id 在 collector 内去重 item/started、item/completed、early backlog 的重复。不要从 text 正则猜题，不读 resume 历史，不用 phase=final_answer 误判回合结束。
3. 通过现有 `user_input_request` SSE 转发，isBlocking=false、answerChannel=message。题目格式异常不制造可提交表单；原文字显示保持。其他渠道维持现有文字展示，不引入不存在的原生 RPC 等待。
4. broker 对 message 不 waitFor/onResolution/resolvePendingPermission；保留安全题目、卡 ID 和原 ownership。原生 pending 提交仍用 `userInputResponse`，准备带原题的文字；RPC 原答案合同完全不改。native pending 与 rpc/原生 closed 可共享 validate + message prepare + claim，但参数必须区分 action，不能让 pending original submit 在竞态关闭后自动变补充。
5. manager 在 admissionGate 内检查原 guard、sanitize/大小、一次 claim，并 enqueueRegularMessage；沿用追加开关、未知结果、来源 ack 与旧卡不得 steer 新任务合同。查询/反馈为 tracked task，不在锁内等待模型/平台。
6. **不需要新增 engine 闭合事件**：manager 已在成功结果及 finally 调 clear(...preserveClosed:true,owner)。broker 在正常 clear 把 message pending 通过 `turn_completed` 明确转 closed，再应用既有 closed 保留；出错、主动取消、停止/换绑/新会话或停机一律撤销。不能调用一个假 PermissionGateway RPC 来模拟闭合。
7. 原生 pending 卡可以说明“回答会作为当前任务补充”；正常闭合后仍更新同一张卡成“作为任务补充发送”，终态去表单。claim 代表本地准入，不能把卡已接收宣称为远端确定接收；unknown 仍用既有事实通知且不重发。

### 5. GitNexus 影响与源码补证

绑定 repo `Claude-to-IM` / CLI `--repo .`，索引时间 2026-10-14T05:20:48.195Z，索引 lastCommit 0485f50。未刷新索引。FTS 缺 DLL，query 概念空结果不能当作未影响。context/impact 可用；同名 handleMessage 需精确 UID，否则 UNKNOWN。

| 符号 | upstream 结果 | 直接调用/流程 |
| --- | --- | --- |
| collectTurnText | LOW，d1=1 | provider.streamChat.start；模型初始化、collector ready、文字/媒体通知流。 |
| forwardUserInputRequest | LOW，d1=1 | manager.handleMessage.onUserInputRequest；卡发送、问答观察与生命周期。 |
| resolveAnswer | HIGH，d1=2 | handleUserInputResponse、handleUserInputText；卡片/文本答案校验。 |
| prepareUserInputSupplement | CRITICAL，d1=1，6 flows | handleMessage，向上控制消费和模型调度。 |
| handleUserInputResponse | CRITICAL，d1=1，6 flows | handleMessage，向上控制消费和模型调度。 |
| clearUserInputRequests | CRITICAL，d1=1，6 flows | handleMessage 正常/异常收尾。 |
| buildUserInputCard | LOW，d1=2 | FeishuAdapter.sendUserInputRequest/updateUserInputRequest。 |
| handleMessage（精确 Function UID） | CRITICAL，d1=4，5 flows | 真正源码调用为 runAdapterLoop、scheduleMessages、同函数 workflow 递归；图另有 JsonRpc.handleLine 同名方法误边，不能当真实跨模块调用。 |

上述 HIGH/CRITICAL 须由主会话告知用户后实施；共享轴 LOW 不能抵消风险。当前源码和现有测试补证动态回调链。新的 provider nested handle、broker 新准备函数仍须实施代理按实际变更补影响分析。

### 6. 有意义的 RED 与复测

以下 app-server fixture 是**官方 schema 合法、由真实内部事件字段映射的合成通知**，不是原始 wire dump；text 使用测试文字：

```ts
client.publish('item/completed', {
  threadId: 'thread', turnId: 'turn',
  item: {
    type: 'agentMessage', id: 'native-item', phase: 'final_answer',
    delivery: 'async', text: '本轮测试题',
    questions: [
      { title: '报告格式', options: ['简短报告', '详细报告'] },
      { title: '填写 QA_FEISHU_20261014', options: null },
    ],
  },
});
```

必要 RED：

- 用现有真实 provider fake transport 发该 fixture，期待一个 message 通道 user_input_request、两题正确选择/自由输入、无 waiting_for_input、继续后续模型输出；当前不会发事件，是真实生产者遗漏的失败锚点。
- started+completed+重复 backlog 只发一次；只有 completed 也工作；错 thread、错 turn、普通 delivery、空/畸形 questions、已取消/已完成旧通知不建卡。phase final_answer 本身不能结束输入。
- 真实 provider→engine→manager→broker→fake Feishu：原生 pending 提交含原题与两项答案，精确原 thread/expectedTurnId steer 一次；不写 JSON-RPC response、不造 PermissionGateway pending、不另开过程卡；重复点击不再次准入。
- 模型正常结束时原生 pending 自动转 closed（含卡发送晚到）；只接受显式补充，回合已无 active 时后轮一次；错误/取消/停机/stop/new/bind 永不闭合复活，owner 清理不伤同 session 其他 chat。
- 正常结束与 pending 原提交竞态：锁内 phase 已 closed 时原动作拒绝，不能无声变补充。已有另一 active turn 时旧题拒绝，无法 steer 新回合。
- 挂起 steer/平台反馈时控制消费可处理 stop/别的 chat；unknown 不重发不另轮；追加关闭按现有后轮规则，回复 DTO 清空后不再次处理。
- 原 RPC 非阻塞问题仍只回原 RPC，native message 不会因相同 item.id/requestId 混进原 RPC 记录。

真实复测由主会话执行（研究代理不调用外部）：更新版本并按用户已有授权安排必要重启后，从**当前 bridge 正在运行的原线程**调用一次 request_user_input_async 两题，主 bot 必须新发带选择/输入控件的问答表单；用户选择并填写新标记，核对回传到原回合且过程卡数不增加；随后专门验证模型已结束后的显式补充。同名其他通知 bot、仅有问题文字或 fake 测试通过都不能作为生产验收。

## Related Specs

- `.trellis/spec/backend/reliability-contracts.md`：原 turn ownership、即时追加结果分类、问答闭合、消息准入与卡更新串行。
- `.trellis/spec/backend/type-safety.md`：外部 unknown 校验、显式 DTO，不信任按钮中的来源/原题。
- `.trellis/spec/backend/testing-guidelines.md`：真实源码+fake boundary，网络/模型硬阻断，单测 15 秒、外层进程树 60 秒。
- `.trellis/tasks/10-14-feishu-codex-async-questions/design.md`：当前仅 RPC 的设计需增加 native-message 生产者及通道边界。

## Caveats / Not Found

- 未捕获当前进程 stdout；内部持久事件与 schema 能证明原生题存在及字段合同，不能证明 wire 每条通知的精确时间或是否 started 也含 questions。实现兼容两种 item 生命周期通知且去重，真实复测确认。
- 经主会话确认的流式取舍：未知 metadata 的 delta 先缓存，已知 async 等 completed；普通 started 已明确 phase 且无 async 时仍实时显示。若已投递普通片段后 completed 才改变同 item 的 delivery/questions，旧片段不可撤回，正文隔离不对该片段作承诺；已新增回归。普通 async 缺 completed 及 phase 缺省也须在 turn 完成保存其正文。该取舍不是 wire metadata 始终一致的官方保证。
- 公开 app-server 文档没有检索到 AsyncUserInputQuestion 或 request_user_input_async 专属 answer 方法；不得编造 dedicated answer RPC。回答用普通输入是对当前可用协议的明确推论。
- 本研究未读取任何其他 session 正文、未输出测试题以外的历史内容、未发送模型/平台请求、未改变代码/配置/依赖、未运行 git 操作。
- schema questions 没有秘密、是否多选、自由其他选项等原 RPC 字段；不能擅自赋予多选/秘密或所有平台权益。options 为 null/缺省的题使用文字输入，存在选项的题先按单选既有能力。
- 实施前主会话补充核对了本轮实际调用的 `functions.request_user_input_async` 运行时工具说明：`The UI always allows a free-text answer, including when suggested options are provided.` 因此选择题在桥接中采用单选加 allowOther:true，无选项题自由输入；依据是该工具 UI 合同，不是 schema 存在 isOther 字段，也不扩展多选或秘密能力。
- 旧 872 单测只验证了 RPC 生产者及其生命周期；新 native fixture 回归和真实验收完成前不再沿用“完整支持实际非阻塞问答”的结论。

## 第二次真实验收调查

- Query: S5 构建重启后原生提问仍没有新表单，检查首次卡发送的 JSON 2.0、SDK 和平台校验边界。
- Scope: 当前渲染器/adapter/broker 只读，指定当前 rollout 中 `QA_FEISHU_20261014_2` 两题白名单，飞书官方组件/API 文档；禁止本研究代理调用模型或真实平台。
- Date: 2026-10-14

### A. 再次确认实际生产者存在，但未据此声称抓到 wire

指定 rollout 第 4563 行在 `2026-10-14T08:48:26.404Z` 记录 `request_user_input_async` 函数调用；第 4564 行在 `08:48:26.414Z` 记录 `event_msg.item_completed`：

- thread：`01a133cc-1278-71f3-8964-1c0f3e30e3ca`。
- turn：`01a13997-dd3f-7b60-8737-977b66716719`。
- item：`call_a73de243b2b940529b1cef8a439f4f87`。
- 内部 item.type 为 AgentMessage，phase=final_answer，delivery=async。
- questions：报告格式单选（简短报告/详细报告）与输入 `QA_FEISHU_20261014_2` 的自由文本题，后者 options=null。

仍只是内部持久事件证据。没有 stdout 与 HTTP 收据时，不能从“没卡/没文字”断言 provider 没产生事件。S5 的 `codex-llm.ts:573` 一旦识别 native questions 就置 state.question，第 578 行左右直接返回，delta 路径也忽略 question；因此原过程卡不显示题目文字与新实现一致，发送失败之后文字也不会回来。

### B. 首次卡 JSON 的明确规范冲突

当前 `markdown/feishu.ts:442` 与 `:444` 对 other/free input 均设置 `max_length: 4_000`。第二次真实题有自由输入，必然携带这个字段。

官方 [JSON 2.0 输入框规范](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/input) 的字段表明确：max_length 为可选整数，默认 1000，范围 **1…1000**。4000 与此合同冲突。这是已确认的非法配置，不是基于 GUI 的猜测；但尚未取得本次平台拒绝收据，不能称为已经证明唯一实际原因。

其他已核对项：

- [表单容器规范](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/form-container) 支持顶层 body.elements 中的 form；本卡 form/name、input/name、button/name 均存在且本卡唯一；提交按钮设置 submit 和 callback，与文档相符。官方示例也在 form 内使用 markdown，不能猜测 markdown 不许嵌入。
- [单选下拉规范](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/single-select-dropdown-menu) 确认 width=fill 合法、options.text/value 合法、required 可在 form 内使用。
- 同一单选文档将 **behaviors 标为必填**；当前 select_static 没有 behaviors。官方完整 JSON 示例有 callback behaviors，但本研究未找到表单内豁免的明确文字。须用平台返回判断，不能仅根据字段表擅自给全部选择框增加即时回调或空数组，改变一次提交合同。
- 当前 config.wide_screen_mode 属旧式命名；[JSON 2.0 总体结构](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure) 文档给的是 width_mode。但没有找到其导致本次拒绝的收据或明确必然拒绝说明，不作为已证明原因。
- 当前测试题只有两题，卡体较小，没有证据指向 30KB/200 元素/嵌套层数上限。已有过程卡可显示也不能替代交互表单的平台验收。

文档通过公开 .md URL 内存读取。web.open 对 text/markdown 报 unsupported content-type，改用 urllib 只读合理替代；不落其他文件、不调用鉴权 API。

### C. SDK 不校验内层卡 JSON，错误被 broker 静默收尾

`@larksuiteoapi/node-sdk/types/index.d.ts:263906` 的 im.message.reply 接受 content:string/msg_type:string；`:65780` 附近 SDK 实现将 data 原样 POST 到 `/open-apis/im/v1/messages/:message_id/reply`，不会为输入框 max_length 做本地 schema 校验。

`FeishuAdapter.sendUserInputRequest:1053` 的首发边界：

1. buildUserInputCard → UTF8 小于 MAX_CARD_BYTES。
2. 有原用户消息 ID 则 im.message.reply，没有则 im.message.create；msg_type=interactive/content 是字符串，SDK 传法正确。
3. assertFeishuSuccess 检查非零业务 code，再要求 message_id。
4. catch 转为 SendResult `{ok:false,error}`。

`user-input-broker.ts:143` 附近 catch 会 removeInput('failed')；native message 没有 rpcPermissions，既无原权限请求待解决，也没有用户反馈或固定错误日志。于是 API 拒绝、超时、缺 message_id 都可能只表现为“不出卡”；目前不能把这些情形与 producer 漏发区分。既有 SDK logger 只输出 code/HTTP status，业务 code 在 HTTP200 返回时还可能不经过 SDK error logger。

`bridge-feishu-streaming.test.ts:22` 的 fake SDK 对任意 content 一律返回 code0+message_id，故现有“发送成功”测试未验证飞书平台卡 schema；其通过不能证明 max_length=4000 可接受。

### D. 主会话最小真实校验方案与输出白名单

研究代理不实际执行。由主会话在已有真实 QA 授权内、使用原项目 app 身份执行，先捕获 **原 buildUserInputCard 两题的原样内容** 的平台结果，避免先改几个字段再猜原因。

可先调用 [创建卡片实体](https://open.feishu.cn/document/cardkit-v1/card/create)：

```ts
client.cardkit.v1.card.create({
  data: { type: 'card_json', data: buildUserInputCard(testRequest) },
});
```

该官方 API 要求 cardkit:card:write，只支持 schema2.0，可将 card_json 验证与聊天投递分开；现有项目已用该能力发过程卡，但实际权限仍以收据为准。它只新建测试卡实体，不发送聊天消息。然后只将输入框 max_length 改为1000做第二次 probe；收到新的字段错误才继续逐字段验证。实体校验成功后，仍需按原 im.message.reply 路径发一张可操作测试卡验证真实原 chat/card 回调；CardKit 成功不证明 IM 或回调一定成功。

若主会话选择直接原 SDK reply，则只发一张带明确 QA 标记的卡；参数与生产路径一致，不伪造请求到另一 app/另一 chat。不能在生产日志打印凭据、原 Axios 错误对象、headers/config/body。

安全收据白名单：

- probe 名称、输入框 max_length 数值、UTF8 字节数、schema 版本、组件 tag/name 列表（不输出实际答案）。
- 数值业务 code、HTTP status、是否取得 message_id/card_id，以及本次测试消息/卡片 ID。
- 平台 msg **只保留验证原因、组件字段路径与安全测试字段相关的短摘录**；不要完整 JSON.stringify(err/response)，更不要展开 Axios config/header/request。
- 原始题目全文已经是本次公开 QA 内容；仍只在研究内保留上述两题白名单，不输出其他聊天历史或账号信息。

CardKit 官方错误表说明可出现 10002 参数错误、200220 卡片内容生成失败、200860 体积超限、300305 元素超限；不能预设本次就是哪个 code，必须按真实返回记录。缺权限时停止把该结果当 schema 结论，继续使用主会话已可用的原 IM 路径。

有意义的新增 RED：实际 builder 输出的所有 input（含 other）max_length 必须在1…1000内；fake 平台显式返回业务非零/HTTP拒绝时 native 问答不得继续静默、不得假称模型已接收。反馈需要固定安全文案、原归属与有界 tracked 投递，不能输出未知外部错误正文或造假 RPC，也不能自动重试到另一回合。最终仍须真实选择+输入并回传当前回合验收。

### E. 未验证与限制

- 本研究未调用真实平台/模型、未抓 stdout/HTTP、未修改任何业务代码/配置/依赖、未重启、未运行 git。
- 已证实 max_length 违反官方范围；尚未证实它是本次实际平台拒绝的唯一原因。select behaviors 的 form 豁免及旧 config 接受性仍需收据。
- GitNexus context(sendUserInputRequest,file,repo .) 找到实际方法及 buildUserInputCard/assertFeishuSuccess 调用；图没显示 broker→adapter 动态边，已用源码补证。无需刷新索引。

### F. 主会话取得的真实格式收据

研究结束后，主会话使用当前应用的既有权限，运行忽略目录中的 live-schema-probe.ts；只创建非敏感测试卡实体，不发聊天、不启动模型或 bridge。SDK 使用15秒请求超时，外层60秒进程树截止，不输出认证配置。

| 探针 | 唯一差异 | 平台结果 |
| --- | --- | --- |
| 原样 dist buildUserInputCard 两题 | other/free input max_length=4000 | code=11310，card_id为空；`ErrPath: ROOT -> elements -> [0](tag: form); ErrMsg: max_length exceed the default maximum 1000; ErrorValue: max_length;` |
| 同一 JSON | 两处 input max_length=1000 | code=0，取得 card_id |

真实平台确认原卡格式非法且只修该字段即可通过本测试的实体校验；这不是 SDK 字符串传递或选择框 behaviors 的问题。该收据没有捕获原生题的实际 HTTP 请求，不证明该次 native 发送确实到达此端点，也不代替 IM/回调端到端验收。原 chat 真正的选择/输入答题仍待 S6 构建加载后复测。

GitNexus upstream buildUserInputCard 结果 LOW、direct=2，直接方法 sendUserInputRequest/updateUserInputRequest；source/adapter测试补证发卡和状态更新两出口。S6生产修改限定该 renderer 与必要测试，不扩张核心生命周期。

### G. 复盘与预防（trellis-break-loop）

1. 根因类别 B/D/E：跨平台字段合同遗漏、fake SDK总返回成功的覆盖缺口、沿用渲染器历史4000值而未核对飞书输入组件可用范围。4000不是当前broker答案校验上限，不把两层范围混为一谈。
2. S5修复原生入口确有独立协议证据，但未走真实卡格式校验；入口修复不能消除下游非法JSON。首轮旧进程与第二轮平台字段拒绝是不同证据，不能继续归因于没重启。
3. 预防：输入组件值遵守平台1…1000，覆盖other/free与pending/closed，并在实际adapter出口断言合同；fake传输成功、类型检查、CardKit实体验证、IM可见表单、原回合收到答案是不同验收证据。
4. 同类范围：只核对本任务卡片的输入组件与状态更新，不顺手重构审批/模型选择或扩权限。SDKcontent:string本身不提供内层schema校验。
5. 知识归入现有backend可靠性合同与飞书卡片文档；本库没有src/templates/markdown/spec镜像，不新建无关模板。规范随本任务既定提交材料收集，实际提交仍待本批授权及真实验收。
