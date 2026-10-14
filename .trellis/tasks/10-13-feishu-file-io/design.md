# 飞书文件双向收发设计草案

## 当前待确认决定

文件回传入口尚待用户选择：

- 推荐：用户自然语言明确要求发送，由本回合受限宿主工具登记指定产物；模型可通过 Bash/脚本生成文件，再登记回传。
- 较小首版：用户调用 /sendfile 并指定当前会话工作目录中的相对路径；这是显式命令模式，不能假称自然语言回传已接通。

不默认替用户选定方案。下述共用文件快照、outbox 和输入设计适用于两种入口；入口确认和固定协议核对前不实施。

## 文件快照与 outbox

核心只接受明确登记的本会话产物，不扫描目录、不从任意 Markdown 路径猜测产物。解析真实路径、归属、普通文件和大小，取得稳定的文件内容快照、名称、类型、长度与摘要。原文件后续修改不能改变重试内容；无效路径、空文件和超限明确返回原因。

普通文件扩展现有 ResponseDeliveryRecord 的文件块，保留稳定文件身份、上传 fileKey、sendUuid、sent/messageId；首次发送前 flush，上传成功先保存 key，再检查归属并发送。重试只处理未确认成功的块。底层 uploadFile 与 send 分开，不新增一体化上传/发送旁路。

文本和现有生成图片保持原合同；流卡 finalize 只能确认文本块，不能把文件块误当已发文本。模型回合归属、chat generation、run epoch、超时和 stop/new/bind 同时约束文件上传及发送。迟到上传不自动发送；已进入平台而超时的发送保留未知语义。

## 推荐自然语言入口的协议核对

拟用 bridge_declare_output({relativePath, displayName}) 一类受限工具，只登记并快照，不在工具调用中发送生产消息。工具返回准确说明“已登记，回合结束后投递”，不能声称已送达。

Claude 可接现有锁定 SDK 的进程内 MCP；Codex 固定 0.160.0 schema 已确认 thread/start 有 dynamicTools 和 item/tool/call，但 thread/resume、thread/fork 无 dynamicTools 参数。旧会话不能被假定可直接增加此工具。固定 schema 位于 `.trellis/tasks/archive/2026-10/10-05-codex-model-picker/research/codex-0.160.0-schema/`。

自然语言入口若需覆盖旧会话，仍须收敛局部 MCP 或本轮固定声明入口等兼容方案并验证；不能静默 /new、丢历史或修改全局认证/配置。现有 app-server 保留，不替换 Codex SDK。未验证的旧会话能力明确保留为实施前技术决定，不向用户承诺已经支持。

## 文件输入

飞书 file 消息通过现有 messageResource.get 下载，按传输预算保存到当前会话受控位置。文本/CSV 内容或真实保存路径必须实际进入正确模型回合；只把名字写入历史不算模型收到材料。每个附件分别记录成功或失败，多附件部分失败有可见说明。

输入仍复用上一子任务的入站去重和消息组身份。文件类型、编码、大小、路径、错误类别在边界校验；不把文件内容、Base64 或凭据放进普通日志。

PDF/Word/Excel 的解析单独验证后端已有工具，未验证能力只明确说明限制；不为首版引入全媒体解析器或批量安装依赖。普通文件回传不要求桥接解析其内容。

## 约束与升级

平台协议以锁定飞书 SDK 1.74.0 为准：im.file.create 支持文档/stream，文件大小最多 30 MB且不能为空。拟定首版用 Base64 快照复用原 JSON outbox：单文件最多 20_000_000 字节、每轮最多 5 个，文件与生成图合计最多 30_000_000 字节；预算是本地保守策略，不是平台的最大能力。

文本输入拟保证 UTF-8（可带 BOM）的 TXT/MD/CSV，每文件 64_000 字节、合并回合共 128_000 字节、最多 5 个；超限或编码错误明确拒绝，不截断后声称已读全文。PDF/Word/Excel 首版输入明确提示解析未支持，输出作为普通文件可回传。以上预算与格式随最终计划一起审阅。

新文件块是可选能力，旧文本/图片记录继续有效；旧版本不能处理新文件块时回退应保留数据并停止写入，不删除原文件或未交付内容。普通文件和原生生成 PNG 的来源/校验不得混合。

## 调用链与风险

指定入口 → 当前回合文件登记/快照 → conversation-engine/handleMessage → deliverResponse/attempt → uploadFile/send → JSON 保存。

入站 file → FeishuAdapter 下载 → conversation-engine 保存/传递 → app-server 或 Claude SDK 的本回合输入。

共享 processMessage、deliverResponse 的上游风险已确认 CRITICAL，直接依赖包含 handleMessage；相关模型、准入、排队、停止和既有图片回归必须覆盖。父任务 research/file-io.md 提供具体固定协议证据和入口取舍。
