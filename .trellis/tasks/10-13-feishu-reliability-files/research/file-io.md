# Research: 飞书文件双向收发

- Query: 如何最小接入当前回合明确指定的普通文件回传、文本/CSV 输入，并复用待发、取消和补发合同？
- Scope: mixed；只读本地源码、既有离线协议 schema 与公开官方文档。
- Date: 2026-10-13
- 基线: `main c651157`；GitNexus 1.6.12，`status` 确认索引对应此提交，105 个已覆盖文件内容一致。FTS 不可用，使用 `context`、上游 `impact` 与 `rg` 补证；未安装扩展、刷新索引或运行真实模型/飞书。
- 阶段: Phase 1.2；只写本研究文件，不实施、不 `task.py start`。用户尚未选择回传入口，以下推荐不代表已批准产品决定。

## Findings

### 1. 推荐与唯一首要产品决定

推荐交互是用户说“生成 CSV 并把文件发给我”，模型完成脚本后**显式调用受限声明工具**，宿主登记本轮文件快照，回合结束统一进入 outbox。创建/修改文件事件本身不触发上传。只说路径、返回 Markdown 链接、扫描目录或解析普通回复中的路径，都不满足 F1。

| 入口 | 实现成本与覆盖 | 结论 |
| --- | --- | --- |
| 自然语言 + 受限宿主声明工具 | 中等；共享注册/快照模块，Claude 进程内 MCP 与 Codex 动态工具两套接线；Bash/脚本产物可显式登记 | 推荐 UX；**旧 Codex thread 的接入仍是设计阻塞，不能先承诺全部会话支持** |
| 桥接 `/sendfile <相对路径>` | 较低；复用命令投递任务、归属/取消与 outbox，不调用模型 | 需要用户额外操作；须用户明确选择，不能默认用它缩减自然语言目标。仅“路径在当前工作目录”不能证明属于上一模型回合；应限制为当前会话已登记产物，或明确将用户指定现有文件作为另一种授权语义 |
| 两后端共用本地 MCP 服务 | 较高；新增连接/子进程、回合租约、调用归属、关闭和错误恢复 | 已有 MCP SDK，无须新依赖；但须验证旧 thread 在锁定版本的运行时配置恢复语义，不作为已验证捷径 |

待用户决定：首版采用自然语言声明，还是接受额外显式命令。若自然语言必须覆盖已有 Codex 会话，先解决第 3 节的兼容验证；不得悄悄 `/new`、丢历史或降成只发路径。

### 2. 精确现状、文件与执行链

| 文件及位置 | 现状及规划职责 |
| --- | --- |
| `src/lib/bridge/host.ts:14` | `FileAttachment` 已有 id/name/type/size/Base64/filePath，但不是已验证的通用解析接口 |
| `src/lib/bridge/host.ts:148` | `ResponseChunk` 只有 text/image；扩展明确的 file 分支及文件快照类型 |
| `src/lib/bridge/host.ts:254` | `StreamChatParams.files`；声明入口宜增加可选、绑定本回合的宿主回调，模型不传 chat/session 身份 |
| `src/lib/bridge/types.ts:63` | `OutboundMessage.image`；增加互斥 file 消息标识 `{fileKey,sendUuid}`，运行时拒绝同时带 image/file |
| `src/lib/bridge/channel-adapter.ts:58` | 上传图片与 `send` 分离；增加默认明确不支持的 `uploadFile`，只实现飞书文件传输 |
| `src/lib/bridge/adapters/feishu-adapter.ts:1217` | 原生生成图上传/发送路径；普通文件应增独立 SDK 分支，不落入文本发送 |
| `src/lib/bridge/adapters/feishu-adapter.ts:1515` | 仅 text/image/post 入站；file 当前提示不支持，须新增严格 file 消息解析 |
| `src/lib/bridge/adapters/feishu-adapter.ts:1746` | 已有 `messageResource.get` 下载；当前名字被改成 key.bin，类型为 octet-stream，不能原样成为文本输入实现 |
| `src/lib/bridge/bridge-manager.ts:702` | 多消息合并保留 attachments；输入失败清单、聚合大小/数量预算也应在最终轮次检查 |
| `src/lib/bridge/bridge-manager.ts:1456` | 调 engine 时传当前回合谓词；在同一归属下传声明能力和结果，保持原控制/补发任务框架 |
| `src/lib/bridge/bridge-manager.ts:1484` | `hasOutput` 当前只看文字/图片；须覆盖纯文件及文件失败说明 |
| `src/lib/bridge/bridge-manager.ts:1587` | 统一 `deliverResponse`；追加 files，不另建绕过跟踪的发送流程 |
| `src/lib/bridge/conversation-engine.ts:114` | 输入文件保存、调用模型、返回 ConversationResult；适合编排本轮产物注册，不承接飞书 API |
| `src/lib/bridge/conversation-engine.ts:156` | 现有保存只形成历史 `<!--files:JSON-->`，**不把实际文件路径回写到传给模型的 files**；写失败仍继续，不能据此声称文件已到模型 |
| `scripts/claude-to-im-bridge/llm.ts:41` | `buildPrompt` 仅接受图片块；文本文件需要明确转成 SDK text 内容，不能原样传 octet-stream |
| `scripts/claude-to-im-bridge/llm.ts:104` | query options；可用已有 SDK `createSdkMcpServer/tool` 注册声明工具，不修改用户/项目 MCP 配置 |
| `scripts/claude-to-im-bridge/codex-llm.ts:268` | `buildInput` 仅 text/image/localImage；文本材料须实际放入 text input |
| `scripts/claude-to-im-bridge/codex-llm.ts:349` | `thread/start`；新 thread 可带动态声明工具 |
| `scripts/claude-to-im-bridge/codex-llm.ts:369` | 服务端 RPC handler 当前没有 `item/tool/call`；不能只增加 schema 却不答工具请求 |
| `src/lib/bridge/response-delivery.ts:67` | 上传、发送、进度检查点及互斥；增加 file 分支，仍是唯一最终回答投递入口 |
| `src/lib/bridge/delivery-layer.ts:279` | 共用发送重试；核对媒体消息不会走 HTML/文本降级。通常只需要复用 `deliverSingle`，不扩张普通文本分块 |
| `scripts/claude-to-im-bridge/store.ts:524` | JSON outbox 严格运行时校验；扩展 file schema、大小/哈希/标识校验，保留旧 text/image 读取 |
| `src/lib/bridge/internal/bridge-help.ts`、`docs/bridge-runner.zh-CN.md` | 更新真实支持格式、预算、登记/补发语义；只有用户选择命令才加入命令帮助 |

现有出站链：`Codex item/completed.imageGeneration → generated_image SSE → consumeStream → ConversationResult.generatedImages → handleMessage → deliverResponse → attempt → uploadImage → save+flush → deliverSingle → FeishuAdapter.send`。

建议文件链：`当前用户要求 → 模型生成文件（包括 Bash）→ 宿主声明回调 → 当前回合注册/快照 → ConversationResult.outputFiles → handleMessage → 同条 outbox.file → uploadFile → fileKey 落盘 → file 消息发送 → sent/messageId 落盘`。声明工具只返回“已登记待交付”和安全元数据，不能回复“已发送”。无需将大文件 Base64 注入 SSE/工具日志；回调在宿主收集快照即可。

输入链：`飞书 file 消息 → 授权/群过滤 → get(message_id,file_key,type=file) 有界流下载 → 文件名/编码/预算校验 → attachments 合并 → 当前会话独立文件保存 → 实际文本附加到本轮 prompt → Claude SDK text / Codex UserInput.text`。历史注释只是展示元数据，不能替代这条输入链。

### 3. 声明工具与旧 Codex 会话兼容

**已验证的固定版本证据**：本仓库锁定 `@openai/codex=0.160.0`、Claude Agent SDK `0.3.289`。只读复用了先前离线生成物 `.trellis/tasks/archive/2026-10/10-05-codex-model-picker/research/codex-0.160.0-schema/`，未执行真实 app-server。

- `v2/ThreadStartParams.json:362` 有 `dynamicTools`；Function spec 必需 `type:'function' / name / description / inputSchema`，可设 `deferLoading:false`。
- `DynamicToolCallParams.json` 必需 `arguments/callId/threadId/tool/turnId`；以线程、回合、请求 ID 严格匹配并对重复请求幂等响应。
- `DynamicToolCallResponse.json:70` 必需 `success/contentItems`；安全文本结果格式为 `{type:'inputText',text:'...'}`，不能套用 MCP 的 `content` 格式。
- 现有 `initialize` 已 `experimentalApi:true`（`codex-llm.ts:288`），无需全局配置变化。
- **`v2/ThreadResumeParams.json` 和 `ThreadForkParams.json` 均没有 dynamicTools。** Resume 允许 `config` 对象，但这不证明可新增动态工具；字段缺失也不能据此断言服务端一定忽略未知字段。
- 当前 handler 在 `startTurn` 返回前已注册 activeTurn，但 turnId 尚未确定（`:203`）；新文件 RPC 不能照搬现有“未确定 turnId 就放宽接受”的规则。应缓存/等待 early 请求，拿到本轮 turnId 后精确校验再读取文件；超时/取消/错回合须答失败，不能悬挂。

新 Codex 线程及 Claude 推荐同一最小工具 `bridge_declare_output({relativePath,displayName?})`；参数不含 chatId、sessionId、任意绝对路径、URL 或发送 API。宿主回调固定当前 session/turn、工作根、artifact 根和 isCurrent。Claude 使用 query-local `mcpServers` 与**单个精确** `allowedTools`，处理器仍校验归属；不要放宽全部 MCP/文件权限。SDK 本地声明 `sdk.d.ts:615`、`:9716` 已提供 `createSdkMcpServer/tool`，现有 zod 足够。[Claude 官方自定义工具文档](https://code.claude.com/docs/en/agent-sdk/custom-tools)支持该接法。

旧 Codex 线程保留历史的取舍：

1. 优先核实锁定版本的局部 MCP config 是否能随 `thread/resume` 加入声明服务并刷新工具。只验证配置构造/服务端源码和 fake 协议，不试读登录配置；离线证据不足时继续标未验证。需要服务生命周期与 turn lease，复杂度高于新 thread 的动态工具。
2. 可设计**本地声明 CLI 或固定本轮 manifest**，模型通过既有 Bash 调用；宿主只读自己预先指定的声明入口，显式登记指定文件，不扫描目录、不解析回复。可保留旧 thread，覆盖脚本产物；但须定义回合随机标识、关闭时封口、严格 schema/大小、原子提交及共享快照校验，属于额外实现方案，当前尚未验证。不能把任意用户路径 JSON 当可信产物。
3. 若上述都不纳入首版，须明示旧会话能力尚不可用并保留会话；只有用户**选择**后才创建带工具的新会话或使用显式命令。不能自动迁移、重放历史假装续接，不能承诺旧 thread 立即支持。

临时首版限制的体验影响：若仅交付“Claude + 新建 Codex thread 的自然语言声明”，现有 Codex 会话仍可继续对话/写文件，但“把文件发给我”无法完成自动附件回传，需显示能力限制。用户必须自行选择新会话（新线程没有原线程历史），或在其明确接受额外命令后手动发送；这只是待批准的临时范围，**不满足已有会话无缝回传的完整目标**。不能将“本地路径已生成”当成功交付，也不能把该限制藏在帮助页。

[OpenAI 官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)明确将动态工具标为实验 API，并描述新 thread 声明及工具调用流程；实施时以本地 0.160.0 schema 校准字段，不能用滚动文档填补恢复字段的缺口。

### 4. 文件归属、快照及预算

- 声明绑定宿主生成的本轮上下文，不相信模型提供的 session/turn。工具说明要求仅响应当前用户明确要求交付的文件；不会把所有创建文件发送出去。声明证明“此轮显式选择并冻结”的产物，**不能声称仅凭 mtime 或工作目录就证明由此轮创建**。
- 推荐将可交付产物写入宿主分配的 `.codepilot-outputs/<session>/<turn>/`，告知模型该目录；工具仅接受该本轮 artifact 根内的相对路径。源代码仍可在原工作目录修改。要交付指定旧文件时，需明确用户授权与拷入当前 artifact 根的语义，不能自动把整个项目变成可上传集合。
- 使用 `realpath/relative` 做边界判断，拒绝绝对/UNC/盘符相对路径、`..` 越界、Windows ADS、目录/设备、符号链接或 junction 越界；不要使用字符串 startsWith 判断根。每次打开仍复检父路径与句柄，覆盖路径换链竞态。
- 读取必须有界：先 stat，再从已打开句柄最多读取上限+1 字节；读取前后 fstat 核对标识、大小、mtime/ctime，复检 realpath 与文件身份；变化、空文件、缺失或不一致返回安全的明确错误，不按旧字节发送。
- 快照为 `{id,name,mimeType,data(Base64),byteLength,sha256,sessionId,turnId}` 的不可变数据；在 outbox 前内存登记，在 outbox save+flush 后才承诺可重启补发。补发读取快照，**不重读原路径**；原文件之后更改/删除不改变已登记版本。工具提示“已冻结此版本”，后续显式重新声明可在 outbox 建立前替换该文件快照，建立后不能静默换内容。
- 首版推荐 Base64 放现有 JSON outbox，省去新 blob Store/路径恢复/清理生命周期；代价是编码、structuredClone、主文件和备份的内存/磁盘放大。不能以“文件不在原路径了”为由读取另一文件。若未来改 blob，必须另立原子保存、哈希验证和保留合同。

**真实平台边界与本地政策分开**：

| 项目 | 固定协议证据 / 建议首版政策 |
| --- | --- |
| 飞书普通文件上传 | SDK 1.74.0 `types/index.d.ts:266451` 与 `lib/index.js:67696`：不得超过 **30 MB**，禁止空文件。SDK未定义 MB 的整数换算，勿把 30 MiB 当已确认边界 |
| 飞书资源下载 | 同版本 `types/index.d.ts:266477`：平台支持 **100 MB 以内**；当前桥接 `MAX_FILE_SIZE=20*1024*1024` 是本地策略，不是平台最大值 |
| 推荐输出预算（需写进最终设计） | 每文件 `1…20_000_000` 字节，最多 5 个；单轮文件+生成图合计 `30_000_000` 字节。保守低于平台上传边界，限制 JSON 快照放大；原图片自身 8张/10_000_000/30_000_000 校验仍保留 |
| 推荐文本输入预算（需写进最终设计） | 原始 UTF-8 每文件最多 `64_000` 字节、每合并轮最多 `128_000` 字节、最多 5 个；还须给现有 prompt/history 留上下文空间。该政策不是模型 token 上限；超限明确拒绝/请拆分，**不截断后假装已读全文** |

所有限额检查先限制 Base64 编码长度，再验证编码和解码长度，避免先分配无限 Buffer。跨重启校验 sha256、大小、唯一 ID、文件名长度/无路径分隔符与 fileKey/sendUuid。总体累计预算要含已接受附件，不能仅检查单次下载或每条消息。

### 5. 复用 outbox、上传/发送分离与取消

新增 `ResponseChunk.kind='file'`，持久字段含文件快照、`fileKey?`、首次生成的 `sendUuid`、`sent/messageId`。delivery ID 加入 file ID/hash，保留顺序：文字在前，随后原图片和声明文件；同一模型结果只建立一条 outbox。

1. 注册归属有效、快照校验通过后，先 save+await flush；失败禁止上传/发送。
2. 每个文件开始前检查 isCurrent；调用仅上传的 `uploadFile(snapshot)`，获得 key 后先 save+flush。
3. 再检查 isCurrent；使用已有 sendUuid 发送 `msg_type:'file',content:JSON.stringify({file_key:fileKey})` 到原 chat。
4. `code===0` 且有效 `data.message_id` 才确认发送；先保存 sent/messageId，再检查取消。上传/发送失败、重启或 `/retry` 都复用快照/fileKey/sendUuid，绝不重调模型。
5. 上传迟到不能自行触发发送；超时仅结束本地等待，保持外部结果未知。发送超时也不能记 sent；uuid 的平台去重窗口不是永久 exactly-once 保证。
6. stop/new/bind/停机取消后续未发起上传与发送；进入平台的请求不可撤回。保持当前 retry 的独立受跟踪任务、chat generation、bridge epoch；不要在适配器控制循环内等待整批文件。

**必改易漏点**：`response-delivery.ts:81` 当前 finalize 把所有 `kind!=='image'` 标 sent。新增 file 后必须改为只确认 text（含旧无 kind 文本），否则流卡完成会将文件误记为已送达。纯文件结果也要收尾原卡并继续文件块。媒体永不走卡片/空文本降级。

`/retry` 现有 channel/chat/user 来源校验和逐记录互斥保持；成功块不重发。完成后清除快照/正文，保留有限元数据。发送成功但本地进度落盘失败仍有不确定窗口，不能声称 exactly-once。

### 6. SDK 1.74.0 的具体接法

`im.file.create({data:{file_type:'stream',file_name:name,file:Buffer}})`；`file_type` 实际联合为 `opus/mp4/pdf/doc/xls/ppt/stream`，普通 CSV/TXT/ZIP 用 `stream` 即可，不把 MIME 字符串当 file_type。首版统一普通文件传输可用 stream，格式解析能力另论。

上传返回 **扁平 `{file_key?:string}|null`**（`types/index.d.ts:266463`），不是 `response.data.file_key`；空/null/key 缺失即失败。file 消息发送沿现有 message.create(chat_id) 分支，检查 code 与 message_id，稳定 uuid 不更换。[飞书上传官方入口](https://open.feishu.cn/document/server-docs/im-v1/file/create)为 SDK 对应接口；网页是动态文档，本轮正文不可提取，字段与限制由本地锁定 SDK 的类型和实现共同核实。

上传日志只输出固定错误类别/安全数值；复用现有脱敏 SDK logger，不输出 Buffer、Base64、原始 SDK error/config/fileKey。当前 downloadResource 的 raw stack/key 日志应在**此文件边界**收敛；不因此扩大其它日志重构。

### 7. 文本/CSV 输入真正到模型

- 飞书 file.content 严格解析 `{file_key,file_name}`，key 只用于当前 messageResource 下载；保留真实显示文件名，存盘名用附件随机 ID + 安全扩展，防同轮同名覆盖（当前 `Date.now()+safeName` 存在碰撞风险）。不接受凭内容返回任意路径/URL。
- 下载必须流式限额、超限/取消立即停止读取，保持总字节预算。现有“流失败→writeFile→完整 readFile 再验大小”会先写/分配未限制内容；普通文件路径不要复制这套兜底。
- 首版保证 UTF-8（可带 BOM）的 TXT/MD/CSV；CSV 是原始文本材料，不加 CSV 解析器、不运行内容、不用扩展名伪装 UTF-8。用 fatal 解码拒绝非法编码/明显二进制；空文本、编码错误、超限列入失败清单。不默默支持 GBK/UTF-16。
- 共享 helper 接受 `unknown` 附件，校验 Base64/实际大小/数量/编码；返回 accepted text + failures。单个坏文件不能让已接受文本/图片全部丢失；失败清单同时给用户可见，并放本轮模型提示，说明只读到哪些文件。
- 先在当前会话独立目录保存成功材料并确认路径；若写失败，准确报告落盘失败，明确能否继续使用已验证内存文本。不能保存失败后仍声称路径可用。
- **实际送入**：本轮 prompt 包含各附件显示名、实际路径（确实保存时）和完整已验收文本；附件正文用数据边界包装，不能作为宿主指令。向两 provider 的 `files` 仅继续传图片，或共享区分图片/text 的精确分支；不能把普通文件留在旧图片循环里导致 throw。
- Claude fake query 应观察到 SDK text 块/字符串含真实 CSV；Codex fake transport 应观察 `turn/start.input[type=text].text` 含真实 CSV。只断言 savedContent 注释或 filePath 存在不算 A4 通过。
- 合并窗口外“先单独发文件，再问一句”是否默认同轮使用，属于已有消息队列语义：只能承诺当前合并/当前绑定材料；不要未经设计创建跨聊天共享“最近文件”缓存。实现前为分开发送加入端到端验收场景。
- PDF/Word/Excel 的 SDK/MCP/外部工具解析均未验证。本轮不新增解析库；可选择接收并保存后回复“已接收，未解析”，或首版明确拒绝格式，两者须在计划中写定。发送这些二进制产物不意味着能理解其输入内容。

### 8. 影响分析、迁移与实施边界

GitNexus `impact deliverResponse --direction upstream --repo .`：**CRITICAL**，10 个受影响符号，直接调用方 `bridge-manager.handleMessage`，6 个执行流/2 个模块。`impact processMessage --file src/lib/bridge/conversation-engine.ts ...`：**CRITICAL**，14 个受影响符号，直接调用方 `handleMessage` 和 `examples/mock-host.main`，7 个执行流/3 个模块；含 admission/queue/runAdapterLoop。风险报告不能用 `riskSharedAxes=LOW` 抵消。已向主会话报告；实施前须向用户报告。模型 provider/adapter 动态调用可能未由图完全解析，继续核对两个装配点及 fake host。

最小新增模块建议：`src/lib/bridge/internal/output-files.ts`（声明/归属/快照/预算）与 `internal/text-attachments.ts`（文本校验、编码、拼接/失败清单）。共享类型进 host/types，provider 只接协议，adapter 只接飞书传输，manager 只编排。若选择 CLI/MCP 兼容方案，再明确新增脚本及其单独生命周期，不能隐式塞进 manager。

无须新增 npm 依赖或升级 SDK；Node fs/crypto/TextDecoder、现有 zod/MCP SDK 足够。query/app-server 的配置仅限桥接自身运行时，**不修改系统、环境变量、全局配置、用户 MCP 或全局依赖**。本轮未执行任何此类操作。

兼容与迁移：

- 旧无 kind 文本、现有 image outbox 正常加载/补发；新增 file 必须严格校验，未知 kind 不按 text 猜测。
- Base64 快照复用现有 JSON 主文件/备份原子协议，不引入新路径迁移；坏快照/key/hash 不能降级成直接发源文件。
- 默认其它渠道 `uploadFile` 明确不支持，不扩大 Telegram/Discord/QQ 文件实现范围；无完整 Store 能力时明确只支持进程内补发。
- 旧代码遇到新 file kind 会拒绝启动；降级前需用新版本清空/处理新格式待发，保留可恢复备份，不能静默剥离记录。已 delivered 的 chunks=[] 兼容原读取。
- `/new` 或绑定切换不继承旧未声明附件/本轮产物；旧 outbox 可按现有来源规则手动补发，不自动迁入新模型会话。

### 9. 最小测试与可执行顺序

先用户确认入口和旧 Codex 兼容方案，再分两阶段：**文件回传及恢复 → 文本/CSV 输入**。采用 node:test + fake query/transport/Feishu SDK，不运行真实模型、不读认证/聊天、不发送生产 IM。

| 测试文件（新/扩展） | 最小可观察断言 |
| --- | --- |
| 新 `src/__tests__/unit/bridge-output-files.test.ts` | 用户未要求且未声明不上传；脚本生成+声明可用；错回合/重复、越界、junction、缺失/空/超限、读取中变化明确失败；声明后原文件改/删仍补发同快照 |
| `bridge-claude-sdk-settings.test.ts` | query-local MCP/精确 allowlist；调用声明 callback 返回“已登记”，未直接发飞书；取消后工具不再读/登记 |
| `bridge-codex-protocol.test.ts`、`bridge-codex-llm.test.ts` | 固定 schema 的 dynamic spec/call/result；early 请求精确绑定；错 thread/turn/工具及重复调用；旧 resume 没工具时明确限制，不自动新建/丢历史 |
| `bridge-feishu-media.test.ts` | Buffer + file_type=stream，扁平 file_key；空 key/null、code非零/缺message_id失败；原 chat/稳定uuid；无媒体/错误敏感内容日志 |
| `bridge-media-delivery.test.ts`、`bridge-delivery-reliability.test.ts` | save/flush失败不上传；key检查点、部分成功/重启 `/retry` 不重生成；卡片 finalize 只确认文字；纯文件、图片+文件、取消后迟到不续发 |
| `bridge-manager.test.ts` | 真 manager 消费循环+挂起 fake 上传/发送；stop/new/bind/停机后禁止后续操作，已确认进度留原记录；聊天B控制不等聊天A文件网络 |
| 新 `bridge-text-attachments.test.ts`、`bridge-conversation-engine.test.ts` | UTF-8/BOM/CSV实际文本、多附件同名、不完整下载/非法编码/部分失败、聚合超限、保存失败与 session隔离 |
| 两 provider 现有测试、`bridge-feishu-reliability.test.ts` | file入站真实下载后内容出现在正确 query/turn input；图片原能力不退化；不支持二进制不被声称已解析 |

实施验证：按相关文件 `node --test --import tsx --test-timeout=15000 <明确测试列表>` 分批运行，每个后台批次硬超时不超过 60 秒；然后 `npm run typecheck`、`npm run build`，最终相关整合单测。图 `detect_changes` 与实际 diff/未跟踪文件核对由实施/检查代理在授权阶段完成。本研究没有修改功能，未跑业务测试，也未假定既有基线测试通过。

## Related Specs

- `.trellis/workflow.md`：Phase 1 研究和最终计划审阅门禁。
- `.trellis/spec/backend/reliability-contracts.md`：归属快照、独立补发、save+flush检查点、取消/结果未知、旧格式及脱敏。
- `.trellis/spec/backend/module-boundaries.md`：host契约、engine模型边界、adapter平台细节、manager编排、投递复用。
- `.trellis/spec/backend/type-safety.md`：共享类型放置、unknown运行时校验、判别联合与 import type。
- `.trellis/spec/backend/testing-guidelines.md`：fake平台/模型、真实子进程测试保护、全局上下文重建、60秒测试批次。
- `.trellis/tasks/10-13-feishu-file-io/prd.md`：F1–F6、A1–A6；上游 #31（头 `4af0dad47dc898fc4c02a88769c4834912fa626c`）的 Edit/kind=create 识别不能覆盖现代 fileChange/Bash，无整包移植。

## Caveats / Not Found

- 用户回传 UX 尚待决定；本文没有把 `/sendfile` 视为默认方案。
- 旧 Codex thread 新增动态工具没有被锁定 schema 支持；局部 MCP 重载/固定声明 CLI 是需验证的兼容选项，未承诺可用，禁止静默 `/new`。
- 当前模型是否准确识别自然语言发送意图是模型行为，声明协议只能保证本轮显式登记和冻结；不能把文件创建事件或宿主目录扫描当意图证明。
- PDF/Word/Excel 解析、非UTF-8编码、账号真实文件权限及平台实际投递均未验证；生产联调和运行服务重启另行安排。
- 官方飞书动态页面无法提取正文，采用已锁定 SDK 1.74.0 两处真实生成定义补证；30 MB 换算未明，不猜 MiB。
- 首版预算是明确标注的建议本地政策，须由最终设计锁定；Base64 JSON 大快照的内存/磁盘放大需要评估，未实现新的 blob 存储或清理。
- 工具调用简报：exec/rg 最小只读源码与规格；GitNexus status/context/impact核对基线和风险；web只读官方协议；apply_patch仅写本研究文件。未读取认证或聊天，未调用生产接口，未进行全局变更或任何 git 操作。
