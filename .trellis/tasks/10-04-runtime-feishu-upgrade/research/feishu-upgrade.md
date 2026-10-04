# Research: 飞书 CardKit 流式卡片与审批交互升级

- Query: 现有飞书接入在新版 SDK / CardKit 下应升级什么，哪些卡片能力能以最小改动改善体验？
- Scope: mixed；本地适配器、Markdown 构造器、卡片测试、官方 CardKit / 回调规范。
- Date: 2026-10-04

## Findings

### 结论与实施顺序

项目已经使用 JSON schema 2.0、CardKit v1 的元素流式更新，不能描述为“从旧卡片迁移到新版”。建议本轮优先完成：

1. 卡片操作严格串行、收尾屏障、业务错误码检查、关闭流式与摘要更新；修复实际可靠性问题。
2. 将正文与工具状态、追加通知拆成独立组件，保持正文前缀，恢复真正的打字机体验。
3. 审批交互检查现有 allowlist，并提供明确的有效 / 已处理 / 过期反馈；修正不实的 5 分钟超时文案。
4. SDK 升级到根任务确认的 1.74.0，保留仍必要的 WS card 类型补丁，使用 SDK 已有的 CardKit 类型消除相关 any。

上述改动不需要更换桥接架构，不需要新建 CardKit 模板、不需要调用真实租户 API 或修改应用权限。

### Files found

| 文件 | 作用 |
| --- | --- |
| `src/lib/bridge/adapters/feishu-adapter.ts` | WS 入站、CardKit 实体创建、流式更新、结束、审批卡发送 |
| `src/lib/bridge/markdown/feishu.ts` | 流式正文、工具进度、最终卡、审批卡 JSON 构建 |
| `src/lib/bridge/permission-broker.ts` | 审批来源验证、原子去重、调用权限网关 |
| `src/lib/bridge/bridge-manager.ts` | 审批 callback 编排与卡片失败后的最终响应投递 |
| `src/lib/bridge/channel-adapter.ts` | 适配器抽象契约 |
| `scripts/claude-to-im-bridge/permissions.ts` | 宿主审批等待、默认 10 分钟超时 |
| `src/__tests__/unit/bridge-feishu-card-notify.test.ts` | 完成通知三条正常路径，使用手工 CardKit mock |
| `src/__tests__/unit/bridge-feishu-final-card.test.ts` | 最终卡 footer / ctx 构造六条测试 |
| `node_modules/@larksuiteoapi/node-sdk/types/index.d.ts` | 本地 1.60.0 已包含 cardkit.v1.card / cardElement 完整类型 |

### 已确认的代码模式与缺口

#### A. 收尾有异步竞态，失败可能假成功

- `feishu-adapter.ts:529` 创建 schema 2.0 流式卡，只有一个 `streaming_content` markdown 元素。
- `feishu-adapter.ts:681` 的 `flushCardUpdate` 以 `inFlight` 限制并发，调用 `cardElement.content` 后 fire-and-forget。`finally` 在 `needsFlush` 时再次调度（`:743`）。
- `feishu-adapter.ts:771` 的 `finalizeCard` 清除当下 timer 后最多轮询等待 3 秒（`:792`），没有 `closing/finalizing` 状态。旧请求完成后可能安排新流式操作，与全量最终卡交错；等待超过 3 秒也直接继续。
- `feishu-adapter.ts:712`、`:834`、`:1050` 等只依赖 Promise 拒绝，没有检查解析成功但 `code !== 0` 的业务失败。官方响应明确要求检查 code；本地 SDK `lib/index.js:123` 默认响应拦截器只 `return resp.data`，不会自动抛业务错误。
- `feishu-adapter.ts:853` 全量更新失败后用 `content` 清除工具进度，源码明确保留 streaming_mode。用户会看到无法转发 / 生成中状态直到平台超时。
- `feishu-adapter.ts:539` 创建时设置了摘要“思考中...”；`markdown/feishu.ts:174` 最终卡没有明确设置摘要。官方 FAQ 明确关闭 streaming 不会自动修改自定义 summary，应显式提交最终摘要，不依赖全量替换未声明字段的行为。
- `bridge-manager.ts:1396` 依赖 `onStreamEnd` 返回值，false 会另行投递最终回答。不要把仅“关闭流式”或仅“发送完成通知”当作最终正文已投递成功。

建议：状态保存当前操作 Promise；收尾先设 closing，清 pending timer/needsFlush，禁止后续 schedule；等待已发出的操作 settle（设置合理请求超时）后串行结束。旧 Promise finally 只可操作同一 state/cardId，不得调度同 chatId 的新卡片。每次卡片写入分配严格递增 sequence，操作开始时分配，不等成功才加一；sdk 返回非零 code 统一抛出可识别错误。针对频控退避，设置有上限且可测试的等待。

结束时可先应用最终 card.update（含 streaming_mode:false + summary）；若失败，独立调用 settings 关闭流式并更新摘要，确保用户不会永久看到生成中。如果实现为官方示例顺序“最终正文 content → settings 关闭 → 最终 card.update”，后续降级不能再调用依赖 streaming_mode:true 的 content，需改用 cardElement.patch/update 或交由已有最终投递 fallback。

#### B. 合并正文与工具进度破坏打字机增量

- `markdown/feishu.ts:123` 将正文和工具行拼在一个字符串里；`feishu-adapter.ts:696` 又把追加提示拼到同一个 `streaming_content`。
- 官方 content API 接受全量文本，只有旧文本是新文本的前缀时才有末尾打字机增量。`正文A + 工具行` 变成 `正文AB + 工具行` 不是前缀关系，客户端会全量上屏，工具状态变化也会打断正文输出。

建议创建固定独立元素，例如 `streaming_content`、`tool_progress`、`append_notice`（ID 均不超过 20 字符）。正文仅用 content；进度与追加提示仅在变化时用 batchUpdate 的 partial_update_element 或 patch。不要每次正文 token 都更新工具组件；不变内容不发请求。卡片创建时可明确 print_frequency_ms.default=70、print_step.default=1、print_strategy=fast，防止客户端默认差异。本轮保留默认 2s 请求节流合理，体验先靠组件拆分提升，不必盲目提频。

#### C. 审批卡真实缺口

- `feishu-adapter.ts:473` handleCardAction 直接读取 callback_data、chatId、messageId、userId 后入队，没有 `isAuthorized`；普通消息在 `:1402` 调了 `isAuthorized`。根管理器 callback 分支（`bridge-manager.ts:1012`）也不补查。应复用现有 allowlist 检查，检查 operator / callbackData 类型和存在的真实 message/chat 上下文，再入队；拒绝时返回简短 toast。
- `permission-broker.ts:154` 已验证 permission link 来源 chat / message，并在 `:183` 原子标记 resolved，不能在适配器里重新实现一套审批解析绕开这些检查。
- `handleCardAction` 立即返回“已收到，正在处理”，实际审批失败 / 过期仍留下可点击原卡。`bridge-manager.ts:1031` 成功后只发送额外文本确认，不更新原审批卡。
- `markdown/feishu.ts:324` 按钮 Allow / Allow Session / Deny，`:354` 硬编码“5 minutes”；实际宿主 `permissions.ts:22` 默认 10 分钟且可配置。建议本轮中文文案 + 去掉固定分钟数；若需要显示时限，由共享契约传真实过期时间。
- 原审批卡的异步完成态可通过现有消息 ID 调 `im.message.patch`，更新为已允许 / 已拒绝或过期并去除按钮。应在 broker 结果已确认之后更新，不能在原始回调刚入队时展示“已批准”。如果本轮不扩展公共适配器契约，至少完成授权校验与准确文案，把状态回写标记为后续跨层工作。
- 现有普通消息允许未设置 allowlist 时放行；本轮应复用既有策略，避免顺手改变默认权限语义。

### 官方 API 合同（2026-10-04 查询）

入口按技能要求依次读取 `https://open.feishu.cn/llms.txt` → `llms-feishu-card.txt` → 具体 API；`lark-cli cardkit --help` 返回 unknown command，因此转官方原生 API 文档。全部是公开资料读取。

| API | 方法与路径 | 必需 body / 说明 |
| --- | --- | --- |
| 流式文本 | `PUT /open-apis/cardkit/v1/cards/:card_id/elements/:element_id/content` | `content:string` 全量文本、`sequence:number`；仅 streaming_mode:true；普通文本/markdown |
| 更新配置 | `PATCH /open-apis/cardkit/v1/cards/:card_id/settings` | `settings:string` JSON 序列化的 `{config:{streaming_mode:false,summary:{content:"..."}}}`、`sequence` |
| 局部批量更新 | `POST /open-apis/cardkit/v1/cards/:card_id/batch_update` | `actions:string` JSON 序列化动作数组、`sequence` |
| 全量替换 | `PUT /open-apis/cardkit/v1/cards/:card_id` | `card:{type:"card_json",data:string}`、`sequence` |
| 已发审批卡更新 | `PATCH /open-apis/im/v1/messages/:message_id` | `content:string` JSON 卡片；通过 SDK im.message.patch，14 天内共享消息卡 |

CardKit 四类写 API 都需要 `cardkit:card:write`，使用创建卡片的同一应用身份 tenant_access_token；uuid 是可选幂等 ID（1~64 字符）；sequence 是 int32 正整数，同一张卡所有操作严格递增。batchUpdate 支持 `partial_update_setting`、`add_elements`、`delete_elements`、`partial_update_element`、`update_element`；其 actions 内 params 的 settings/partial_element 等为对象，只有最外层 actions 序列化字符串。

限额与行为：

- API 页面频控 1000次/分钟、50次/秒；流式总览另明确单卡所有 CardKit 操作合计 10次/秒。拆分组件后仍受总额约束。
- `content` 字段 1~100000 字符，但错误码 200860 要求实际卡片 30KB 以内；不能把字符上限当有效可发送字节上限。中文要使用 UTF-8 字节预算；最终长回答应走已有分块/附件投递，不默默截断。
- 单卡最多 200 个元素/组件；element_id 1~20 字符；实体有效期 14 天。
- 流式模式自上次开启 10 分钟后自动关闭；错误码 200850 / 300309 表示超时/关闭，可 settings 重新开启。长任务可在真实超时错误后有限恢复重试，不能无限重开。
- 回调必须 3 秒内响应；流式卡不支持直接通过回调响应更新卡片，先关闭 streaming。审批卡本来非流式，不受此限制。
- 自定义摘要不会随关闭 streaming 自动改变。关闭后才可转发。
- content 遇前缀变化直接全量上屏。print_strategy fast 会先立即显示旧批尚未打印部分再打印新批；delay 则等待旧批完成。
- 回调 token 30 分钟最多更新 2 次，和 CardKit 操作不是同一机制；优先已有实体 API / message.patch，不引入回调 token 存储。

### SDK 升级核验

- 本地安装版本实测 1.60.0；根任务另已查 npm 最新 1.74.0。
- 当前本地 `types/index.d.ts:32484` 已有 cardkit.v1.card.create/update/settings/batchUpdate、cardElement.content/patch 等，因此相关 SDK 调用的 `(restClient as any)` 已无必要。
- 已公开读取固定版本发布包 `https://unpkg.com/@larksuiteoapi/node-sdk@1.74.0/lib/index.js`。其 WSClient.handleEventData 仍含 `if (type !== MessageType.event) return;`；不能在升级时盲删 `feishu-adapter.ts:283` 的 card→event 补丁。后续可单独封装并测试补丁，等待官方支持再删除。
- 1.74.0 发布包可见 WS 输入解析的 try/catch 与错误日志改善；本次未完整逐版本审阅 changelog，不声称所有重连问题已由 SDK 解决。

### 影响范围 / GitNexus

只读执行了 CLI context/impact，没有重建索引或进行任何 git 操作。

- `finalizeCard` 唯一 UID：`Method:src/lib/bridge/adapters/feishu-adapter.ts:FeishuAdapter.finalizeCard#4`；upstream impact LOW，直接调用 onStreamEnd，相关流 OnStreamEnd → FormatElapsed / PreprocessFeishuMarkdown / BuildToolProgressMarkdown / GetBridgeContext。
- `flushCardUpdate` 唯一 UID：`Method:src/lib/bridge/adapters/feishu-adapter.ts:FeishuAdapter.flushCardUpdate#1`；upstream impact **HIGH**，5 个符号、4 条受影响流程。直接调用 `scheduleCardUpdate`；d2 `updateCardContent`、`notifyAppend`；d3 `updateToolProgress`、`onStreamText`。实现前必须告知用户 HIGH，且对所有实际改动符号补齐 impact。
- handleCardAction context：直接由 FeishuAdapter.start 注册回调调用；下游 enqueue。buildPermissionButtonCard context：sendPermissionCard → buildPermissionButtonCard，send 流。
- 同名函数存在工作流版本；CLI impact 可直接将上述 UID 作为位置参数，避免把 workflow-command 的同名函数当目标。

### 最小验收测试

保留当前通知和 footer 测试，新增 `bridge-feishu-streaming.test.ts`（或专门适配器测试），用最小 SDK mock 记录请求，不依赖真实租户：

1. 有未完成 content 请求时调用 onStreamEnd；后者等待请求，关闭后不再发送 content/延迟 timer；旧卡 Promise 不更新同 chat 新卡。
2. SDK resolve `{code:非零}` 被当失败，不能产生卡片完成成功返回；频控退避保留最新快照。
3. 完成 / 中断 / 出错均提交 streaming_mode:false 和最终摘要；完整更新失败时仍尝试关闭流式，返回 false 使已有最终响应 fallback 生效。
4. 正文与工具/追加提示独立请求，工具变化不改正文；相同文本/状态不反复请求；所有 CardKit API sequence 严格递增。
5. 超时 200850/关闭 300309 有限恢复（若纳入本轮）；30KB 溢出不谎报成功、不丢完整回答。
6. 无授权 operator 的审批点击不入队；正常点击保留 permission link 来源/去重验证；异常 value 不导致 TypeError。
7. 审批文案不虚构过期分钟；若加入状态回写，测试重复点击/过期/同消息来源和失败路径。

建议命令：`node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-feishu-*.test.ts`，再 `npm run typecheck`；由根任务合并后跑完整相关测试，所有后台单元测试上限 60 秒。

### External references

- [飞书卡片模块索引](https://open.feishu.cn/llms-docs/zh-CN/llms-feishu-card.txt)
- [流式更新文本](https://open.feishu.cn/document/cardkit-v1/card-element/content.md)
- [更新卡片配置](https://open.feishu.cn/document/cardkit-v1/card/settings.md)
- [局部更新卡片实体](https://open.feishu.cn/document/cardkit-v1/card/batch_update.md)
- [全量更新卡片实体](https://open.feishu.cn/document/cardkit-v1/card/update.md)
- [流式更新总览、超时与摘要 FAQ](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview.md)
- [卡片回传交互](https://open.feishu.cn/document/feishu-cards/card-callback-communication.md)
- [更新已发送的消息卡片](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch.md)
- [官方 Node SDK](https://github.com/larksuite/node-sdk)
- [1.74.0 发布包实现](https://unpkg.com/@larksuiteoapi/node-sdk@1.74.0/lib/index.js)

### Related specs

- `.trellis/workflow.md`：research 持久化、实现/复核阶段分派。
- `.trellis/spec/backend/index.md`：桥接库结构、测试与依赖注入。
- `.trellis/spec/backend/module-boundaries.md`：卡片渲染/平台细节留在 adapter/markdown；管理器只编排。
- `.trellis/spec/backend/type-safety.md`：外部回调 unknown、显式运行时校验；SDK 类型存在时不滥用 any。
- `.trellis/spec/backend/integration-guidelines.md`：超时配置不在多个脚本重复实现。
- `.trellis/spec/backend/testing-guidelines.md`：node:test、可观测 mock、副作用断言、重建全局上下文。

## Caveats / Not Found

- 仅写本研究文件，未修改业务代码、SDK 依赖、规格、权限、配置；未调用生产 API，也未读取环境变量或凭据。
- python3 在当前 Windows 返回 1 无输出，改用 python 成功查询 current，任务为 `.trellis/tasks/10-04-runtime-feishu-upgrade`，来源为当前 Codex session。
- GitNexus FTS 不可用背景由根任务提供，本轮使用 context/impact 加源码；行号比现索引普遍偏移 1 行，以实际文件为准。报告记录 HIGH，不应按 finalize 单一 LOW 误判全套卡片变更。
- 本研究不负责实施；需要由 trellis-implement 代理承担代码变更，不能将研究代理后续直接改为代码写入角色。
- 未跑单元测试：本轮没有业务代码变更；上述是供实现阶段使用的验收计划。
- 官方总览一处把 streaming_mode 描述成“不触发 QPS”，但同页明确单卡 10次/s、单 API 页面亦列频控；实施应按明确频率上限保守处理，不能解释为无频控。
- 官方接口字段上限与卡片 30KB 上限属于不同限制，最终有效尺寸还受飞书序列化/样式影响；应保留 API 失败回传与完整回答 fallback。
- 工具调用简报：PowerShell / Python 查询任务并读取源码与规格；GitNexus CLI 读取依赖与影响；公开 HTTP 读取官方文档和固定 SDK 发布包；apply_patch 将结论持久化；全部业务范围只读。
