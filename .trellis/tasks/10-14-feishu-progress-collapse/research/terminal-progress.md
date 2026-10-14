# Research: 任务完成后最近三条进度残留

- Query: 最新动态卡在任务完成后能否残留最近三条；区分正常终态、平台部分失败、本地收尾超时、最终分段回退、错误常显与已展开历史。
- Scope: internal（当前源码、精确图上下文、既有测试与隔离内存平台复现；未调用真实飞书/模型）。
- Date: 2026-10-14
- Task: `.trellis/tasks/10-14-feishu-progress-collapse`
- Basis: 主会话确认19:30:27已重启最新构建；GitNexus索引时间 `2026-10-14T11:12:31.846Z`，分支 `feat/feishu-progress-collapse`，indexedCommit `41a698387a148d87b8c569708027e39e8a120bac`。本研究读取的是S4冻结后当前源码。

## Findings

### 1. 已证实结论与现场尚未证实部分

1. **正常收尾成功会清空完成工具的最近三条摘要**。`fitProgressView` 在 input.status 存在时 recent=[]，不再把running加入visible，也不再显示progress（`src/lib/bridge/markdown/feishu-progress.ts:74-94`）。finalizeCard传入明确status（`src/lib/bridge/adapters/feishu-adapter.ts:917,920`）。全部batch成功的内存对照：最终正文和“已完成”正常写入，tool_progress行数=0。
2. **终态仍显示最多两个失败工具摘要是现有行为**。errors.slice(0,2)不受input.status影响，即使整体completed，失败工具也仍显示；这不是“最近三个完成步骤”分支（`feishu-progress.ts:76,79,93`）。运行工具在终态只保留历史/数量，不继续外显运行摘要。
3. **已实际复现一个源码缺陷边界**：运行batch部分执行后返回非零业务码，本地sentView不更新；下一次终态batch依据旧sentView计算差异，可能不发tool_progress清空。最终正文/已完成成功、finalize返回true，但原卡的三个完成步骤仍在外面。该结果已由下面的顺序前缀故障注入复现。
4. **尚不能将第3项认定为用户当前现场根因**。没有当前原卡的真实batch错误/回执证据；用户尚未区分最终卡内摘要、独立消息、展开历史。不得因现象匹配就宣称平台发生了200860或部分失败。

### 2. 正常渲染与保留内容的精确区分

当前固定元素为正文streaming_content、状态task_status、外部工具摘要tool_progress、历史数量history_summary、固定折叠面板内history_content、追加append_notice、最终task_footer（`feishu-progress.ts:34-49`）。

| 场景 | tool_progress | history_content / 面板 |
| --- | --- | --- |
| 无status的运行视图 | 最新progress、最多2个error、最多2个running、最近3个工具，按ID去重 | 有界历史始终存在 |
| completed终态 | progress/running/recent都消失；最多2个历史error仍外显 | 历史内容保留；不改expanded |
| interrupted/error终态 | 同上，错误摘要保留 | 历史保留，状态标中断/出错 |
| 用户原先展开面板后收尾 | 外部完成摘要应清空 | **继续保持展开是用户明确选择的阅读状态合同**，所以仍看到面板内的步骤不等于外部最近三条残留 |

工具名称经过空白折成单行，终态visible只有errors.slice(0,2)，因此正常终态渲染自身不会输出三行成功工具；也不会借用progress补成三行（`feishu-progress.ts:27-30,78-79,93`）。

最终“回答已显示”还不一定代表远端turn完成：Codexcollector只在精确turn/completed通知时resolve（`scripts/claude-to-im-bridge/codex-llm.ts:617-631`）；manager在engine返回后执行finalize（`bridge-manager.ts:1694-1720`）。排查现场应核对task_footer/任务完成通知及任务状态，而不是仅凭正文语气判断。

### 3. 已实际复现：部分batch失败使sentView与平台不一致

源码机制：

- `progressActions` 只对previous[id]!==next[id]产生动作，按内容字节变化先缩减后增长（`feishu-progress.ts:52-58`）。
- `flushCardUpdate` 只有assertFeishuSuccess通过后才 `state.sentView=view`；任何非零业务码/异常均保留上一份完整sentView（`feishu-adapter.ts:834-857`）。
- `finalizeCard` 同样使用 `progressActions(state.sentView,terminalView)`（`922`）。若缓存tool_progress仍为空，而平台已有部分写入的三条，终态目标为空与缓存相等，就没有清空动作。
- 此缺陷不是“忘了status”或“onStreamEnd没有调用”：复现中确实传completed，最终batch确实成功、最终正文/状态/页脚均更新、finalize=true、activeCards已清理。

只读复现通过标准输入运行当前FeishuAdapter，未修改文件。所有net.Socket.connect、fetch与spawn/exec入口硬阻断；store/LLM/SDK均为内存fake，未start适配器。测试工具为三个complete：步骤1、步骤2、步骤3。

实际请求与平台逐action状态如下（第一批并非任意乱序应用，而是严格按现有action顺序应用一个前缀）：

```json
{
  "round1": {
    "requested": ["task_status", "history_content", "tool_progress", "history_summary"],
    "applied": ["task_status", "history_content", "tool_progress"],
    "returnedCode": 200860
  },
  "round2Terminal": {
    "requested": ["task_status", "streaming_content", "task_footer", "history_content", "history_summary"],
    "returnedCode": 0
  },
  "finalizeReturned": true,
  "platformToolProgress": "✅ `步骤3`\n✅ `步骤2`\n✅ `步骤1`",
  "platformStatus": "✅ 已完成",
  "platformBody": "最终正文"
}
```

全部成功的对照结果：第一次缓存tool_progress非空，终态包含tool_progress清空动作，finalize=true、平台摘要行数0。部分失败结果：第一次缓存tool_progress为空，终态未发送清空动作，平台摘要行数3。

200860只是受控故障注入码，不是现场日志。现有规范已经要求“不假设batch具有事务原子性”（`.trellis/spec/backend/reliability-contracts.md:88`），所以此分支是需要防御的真实契约边界；仍不证明某次真实平台请求已部分应用。

### 4. 其他可能残留的收尾路径

#### A. 收尾明确失败，完整正文另行分段投递

finalizeCard的terminal batch若非零/异常，仅记录失败并删除本地activeCards，返回false（`feishu-adapter.ts:923-949`）。旧卡在平台上的内容不会因为本地delete/closing自动改变。

`response-delivery.ts:78-105` 收到false后沿用已有分片逐条发送。因此用户可能同时看到完整回答的新投递和保留旧摘要的过程卡。单纯finalize失败测试目前只断言返回false，不证明平台旧摘要被清空；失败本身不能算正常终态成功。

#### B. 正文超限，终态预览成功与全文分段

完整final view为null时，会用此前sentView.streaming_content和“完整回答将在下方分段发送”建立terminalView；该terminalView仍传status，因此正常成功也会清空recent。仅在其batch失败或此前sentView已不可信时才可能旧摘要残留。updated=view!==null保留false，让完整回答继续分段（`feishu-adapter.ts:917-932`）。

#### C. 真实在途请求挂起，收尾先触发本地deadline

finalizeCard先closing=true，清理throttleTimer与elapsedTimer，再等待state.operation；正常路径不会让旧运行batch在最终batch之后写回（`904-912`）。

外层finalizeWithinDeadline为Promise.race，默认15秒，本地超时reject而**不取消实际平台请求**（`response-delivery.ts:57-65`）。timeout进入attempt catch，记录failed，禁止自动fallback，避免未知发送结果重复投递（`117-121`）。manager显示可/retry的明确提示，finally通过onMessageEnd清理本地卡（`bridge-manager.ts:1721-1727,1785-1790`）。

若挂起的是运行operation：manager清理generation后，晚到operation更新只会落在旧卡；finalize等待恢复时经generation检查返回false，不再发该旧卡terminal（`feishu-adapter.ts:911-912`）。平台因此可能长期留旧摘要；这属于未确认收尾，不是renderer正常completed遗漏。

若挂起的是已发送terminal batch：可能晚到应用终态，但本地generation已经清理，返回false不发完成通知（`938`）；结果仍不能依据本地timeout作平台结论。

#### D. 正文成功后完成通知网络挂起

finalizeCard的返回promise还包括可选IM完成通知等待（`939-947`）。terminal正文已成功而通知超时，外层仍可能报告未知；正常terminal已清除recent，此情况本身不能解释最近三条，除非合并了上述部分失败。

#### E. 本地cleanup不等于平台清屏

cleanupCard、stop、closing都只控制本地timer、generation、activeCards或后续调用，未向平台清空tool_progress（`feishu-adapter.ts:955-968`）。这是既有隔离职责，不能为了清屏而无归属地再发网络请求、整卡替换或强制收起面板。

### 5. 现有测试覆盖与漏测

| 现有测试 | 已覆盖 | 未覆盖本现象的点 |
| --- | --- | --- |
| `bridge-feishu-progress.test.ts:225-240` | 一个complete工具；全部batch成功；正文/ctx/footer/面板展开保留；tool_progress空。 | 三条、混合running/error、之前batch部分失败、响应丢失、终态被跳过的diff。 |
| 同文件`:243-252` | error/interrupted终态保留一个失败摘要。 | completed整体成功但早期工具error仍外显；不能把所有error都清掉来“修三条”。 |
| 同文件`:255-268` | 大历史让预算、可容纳正文完整；超长正文返回false。 | 超限回退前已有可见三条、回退terminal清空的实际platform content断言。 |
| 同文件`:271-284` | 最终batch全拒绝返回false；全成功返回true，无配置操作。 | 拒绝前已有live摘要；故障fake只返回code，不执行任何action，所以未模拟部分应用。 |
| 同文件`:181-196`、streaming`:137-155` | 运行batch挂起、终态等待、终态最后发送、不复活timer。 | 挂起运行batch恢复时部分apply+非零；外层deadline和真实FeishuAdapter一起运行后的旧卡状态。 |
| `bridge-delivery-reliability.test.ts:164-172` | finalize promise永久挂起，本地有界失败且不自动fallback，manual retry允许。 | 使用的是generic adapter/永不resolve finalize，未检查Feishu平台旧卡最近三条或晚到回执。 |
| `bridge-feishu-final-card.test.ts:6-11` | 生产fitProgressView的footer与空正文合同。 | tools=[]，不测试终态tool_progress和平台差异恢复。 |

当前progress fake逐action应用并检查实体预算（`bridge-feishu-progress.test.ts:58-71`），但默认总是成功；只需增加故障注入“应用前缀再返回错误/抛错”，不用引入真实平台或复制生产渲染逻辑。

### 6. 最小有意义的RED与边界建议

优先RED场景：初建card，三个complete经live batch发送；fake严格应用前缀到tool_progress，然后返回非零。立即onStreamEnd(completed,完整正文)，下一batch成功。断言最终平台tool_progress为空、final正文完整、finalize=true、历史内容保留、已展开面板未被重写、单实际在途/sequence递增。当前源码已证实最后摘要为空的断言会失败。

另加两个边界避免错误修复：

1. completed整体成功但有error工具：最近成功摘要消失、必要错误仍保留，不能无条件清空所有tool_progress。
2. 超长正文的preview终态：此前live三条已显示，terminal preview成功后最近摘要清空，onStreamEnd仍false/full fallback；不能为清摘要谎称完整正文成功。

若要修复已确认的部分失败边界，最窄候选是让终态对其正确tool_progress值显式发送，而非仅依赖可能过期的sentView差异；保持叶子content更新、先缩减再增长与单请求串行，不动面板/config。更全面的dirty视图重同步涉及flush与所有叶子预算，应由主会话判断是否必要；不能凭一个案例直接重构整个发送层。

收尾batch明确失败/永久挂起时，无法保证真实平台立刻清空摘要；必须保留未知/失败事实及原投递合同。不要用并行补发清屏、无限重试或无归属fire-and-forget消除视觉现象。

### 7. 精确图检查、d=1与风险

已执行repo根 `gitnexus query 'Feishu terminal final progress batch partial failure deadline' --repo .`：concept query空且FTS缺DLL（load-only，未安装/repair）；精确context可用。context核对fitProgressView、progressActions、finalizeCard、finalizeWithinDeadline，再读当前源码补动态边界。

使用CLI1.6.12，完整impact JSON在内存解析后输出风险/全部d1，避免CLI大文本截断被当作完整结果；解析无partial/truncated标志，epistemic=exact。所有impact显式`--direction upstream --file <准确文件> --repo .`：

| 可能修改的符号 | 当前风险 | 全部d=1 | counts(d1,d2,d3) |
| --- | --- | --- | --- |
| fitProgressView | CRITICAL | FeishuAdapter._doCreateStreamingCard、finalizeCard、flushCardUpdate | 3,3,7 |
| progressActions | CRITICAL | 同文件fits、FeishuAdapter.finalizeCard、flushCardUpdate | 3,3,5 |
| FeishuAdapter.flushCardUpdate | CRITICAL | FeishuAdapter.scheduleCardUpdate | 1,5,3 |
| FeishuAdapter.finalizeCard | LOW | FeishuAdapter.onStreamEnd | 1,0,0 |

风险与初始实现前的索引不同：flushCardUpdate在当前图已CRITICAL，不能沿用旧HIGH。若实施涉及这些CRITICAL函数，主会话必须先提示并核对各d1与相关flow；本研究未做业务修改。onStreamEnd的manager多态调用仍需源码与集成测试补证，不能把最终函数LOW当作整个链路无风险。

代表受影响flow为onMessageStart、onProgress、onStreamText、onToolEvent、onStreamEnd、flushCardUpdate。finalizeWithinDeadline的d1=context为response-delivery.attempt；其Promise.resolve的泛名resolve图边不作为真实业务关联。暂不建议改response-delivery/manager/provider，共享截止时间与未知投递合同应保留。

### 8. 文件与规范

- `src/lib/bridge/markdown/feishu-progress.ts`：实际recent/error终态规则、叶子差异动作与预算。
- `src/lib/bridge/adapters/feishu-adapter.ts`：sentView成功更新、closing/在途等待、terminal fallback与本地清理。
- `src/lib/bridge/response-delivery.ts`：finalize有界等待、false走完整分段、timeout未知不自动fallback。
- `src/lib/bridge/bridge-manager.ts`：真实结果终态、失败提示、generation所属UI清理。
- `src/__tests__/unit/bridge-feishu-progress.test.ts`：内存卡树平台、逐action预算、成功收尾/失败工具/挂起/超限回归。
- `src/__tests__/unit/bridge-feishu-streaming.test.ts`、`bridge-delivery-reliability.test.ts`、`bridge-feishu-final-card.test.ts`：串行与失败返回、deadline、footer补证。
- `.trellis/spec/backend/reliability-contracts.md:82-96`：用户阅读状态、真实事件、预算、非事务batch、正文投递确认与未知窗口。
- `.trellis/spec/backend/testing-guidelines.md`：真实网络/模型硬阻断、fake故障注入；单测15秒、外层进程树60秒。
- External references：未新检索外部资料；原官方折叠与batch研究在 `research/platform-collapse.md`，S4真实客户端阅读状态证据在 `research/live-collapse.md`。SDK1.74.0，GitNexus1.6.12。

## Caveats / Not Found

- 现场问题的具体位置及真实API回执仍未获得；主会话负责用户澄清与实际平台只读取证。
- 受控内存复现证明源码在允许部分失败的契约下能留三条，不证明用户现场曾发生所注入200860。
- 保留已展开历史是已获用户选择的S4合同；若用户现在要求结束后强制收起，应视为新偏好，不能悄悄用config/父面板更新破坏刚完成的阅读状态保证。
- tool errors终态外显属于已确认的醒目错误要求，需区分过期完成摘要；完成工具只保留历史。
- 未修改业务/测试/规范、未restart、未真实API/模型、未git操作、未依赖/环境修改。仅写本研究文件；隔离探针通过stdin内存运行，均约1.4秒结束。
