# Research: 飞书终态卡片版式与改动影响

- Query: 完成后仅保留完整正文、一个过程入口和一条状态/耗时，如何消除重复完成标签、零值统计、追加标签、ctx 与空白行；核对修改符号的上游影响和合法 JSON2 布局。
- Scope: mixed（当前检出源码、任务与规范、GitNexus 1.6.12、本地 SDK 1.74.0、飞书官方文档）
- Date: 2026-10-14
- Active task: `.trellis/tasks/10-14-feishu-progress-collapse`
- 本角色只调研；未修改业务、测试、规范、配置，不调用真实飞书 API/模型，不重启、不删除、不提交。仅写本文件。

## Findings

### 1. 版式根因与产品判断

当前卡片固定有 7 个 Markdown 叶子。`buildProgressCardJson` 把正文、状态、近期进展、历史说明、追加和页脚分别铺在正文纵向布局中，另有固定折叠容器。终态只是把近期进展内容写成空格；这个行为可以清文本，却不保证该组件行高消失。

`fitProgressView` 同时给 `task_status` 写“已完成”、给 `task_footer` 写“已完成 · 耗时 · ctx”，还把运行统计与历史邀请留在 `history_summary`，把追加保留在 `append_notice`。截图中的重复、过多行与留白均能由该布局直接解释，不能只改措辞或再换一种空白字符。

成功终态是用户阅读结果的界面。常显信息应只有完整回答、一个低权重过程入口（有真实过程时）和一条完成/耗时。ctx、追加、步骤统计服务于追溯，应进入展开后的历史；零值不需外显。错误/中断仍需显露必要原因；完整回答分段或投递未完成等影响用户判断的信息不得藏到历史里。

### 2. 推荐收敛到 3 个 Markdown 叶子

推荐新卡初始化仅创建：

1. `streaming_content`：原完整正文，运行时可为预览，最终正文完整投递合同不变。
2. `task_status`：运行时合并当前状态、真实耗时、必要错误、近期步骤和追加提醒；成功终态复用该区域显示唯一一行 `✅ 已完成 · <耗时>`，不再清成空格。
3. 原 `progress_history` 内的 `history_content`：过程统计、ctx、追加摘要及有界工具历史。

正文 → 唯一状态 → 过程入口，与当前顺序接近且减少改动。无需保留旧 `tool_progress/history_summary/append_notice/task_footer` 死键来迁就旧测试；本地视图、差分、预算和测试应一起调整。运行时仍按实际字段变化保留最近 3 条，不能为了终态简洁删掉实时进度。

比起“7 叶子加终态逐个删除”，3 叶子减少需要可靠清理的状态，没有多处空 Markdown 占位，正常有历史时仍只需原有局部更新，不增加请求。

### 3. 官方合法字段与空白高度边界

2026-10-14 通过官方同 canonical 路径 `.md` 获取正文并核对：

| 组件/层级 | 可用字段 | 边界 |
| --- | --- | --- |
| Markdown | `margin`，默认 0，范围 -99…99px；`text_size` | 未发现 `padding/height/visibility/show_when` 的字段合同；不能用这些字段隐藏空白行。 |
| body | `padding`、`vertical_spacing`、`horizontal_spacing` | 间距允许 0…99px；可显式选 `vertical_spacing:'8px'`。 |
| collapsible_panel | `margin/padding/vertical_spacing/horizontal_spacing` | 标题及原生展开状态属于父容器；初建设置即可，不在运行/收尾改父容器。 |
| column_set/column | 真实分栏与列内间距/内边距/外边距 | 未发现隐藏空列或空 Markdown 高度为 0 的保证；本任务无需为压缩留白增加分栏。 |

初建建议设置 body 的 8px 纵向间距、Markdown 的 0px margin，保持正文 normal、辅助区 notation。不能使用负 margin 抵消未知行高；只减 spacing 无法消掉 7 个空白组件自身高度。

来源：[JSON2 结构](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure)、[JSON2 富文本](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text)、[折叠面板](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/collapsible-panel)、[分栏](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/column-set)。未执行平台 schema/客户端实际验收，不把官方字段合法性推为视觉效果已通过。

### 4. 无真实历史时的空面板处理

先以真实数据判断：没有工具步骤、ctx、追加等任何追溯信息，且本卡从未有可读历史，才属于空面板。不能用预算删光历史后当前内容为空作为删除条件，否则会破坏用户已经展开过的有效过程区。即使所有工具被预算压缩，也应保留统计及明确省略提示，视为有过程。

官方提供删除组件接口，删除容器会连带删除子组件。现有 batch_update 也明确支持：

```json
{"action":"delete_elements","params":{"element_ids":["progress_history"]}}
```

操作名是复数 `delete_elements`，不是猜测的 `delete_element`。可以复用现有 SDK batchUpdate，无需新增依赖。仅无可读历史的终态可删除空面板；有过程时不改/不删原面板，避免重置阅读状态。

可靠性优先建议：先完成完整正文与唯一状态的成功确认，再 best-effort 单独 batch 删除空面板；删除失败不撤销已经确认的完整正文，也不触发分段补发。仅这条少见分支多一次请求。若直接把删除拼进正文确认批，非原子批在正文已成功而删除失败后会误判全文投递失败；要避免这个重复投递风险需要另建正文确认事实，改动反而更大。

删除仍绑定原 card/state/generation、沿用严格递增 sequence、不得并行旧写。无官方保证删除缺失元素等价于成功，不能盲目重试删除或把异常伪装为成功。

来源：[局部更新卡片实体](https://open.feishu.cn/document/cardkit-v1/card/batch_update)、[删除组件](https://open.feishu.cn/document/cardkit-v1/card-element/delete)。无需真实调用即可核对操作格式；API 合法性不证明客户端展开/滚动体验。

### 5. 当前检出 GitNexus 上游影响

- 仓库/检出：`G:\project\Claude-to-IM`，`feat/feishu-progress-collapse`，HEAD `41a6983`。
- GitNexus 1.6.12；`gitnexus status` 报索引 2026-10-14 21:16:22，索引 commit 与当前一致，106 个覆盖文件全部匹配，up-to-date。
- 各命令显式 `--repo . --direction upstream`；下列为 `epistemic: exact` 的查询结果。CLI 未携带 partial/truncated 标志，未把同名候选的 LOW 当作最终风险。
- 同名 `flushCardUpdate/finalizeCard` 首次得到 ambiguous/UNKNOWN，已经用表中完整 UID 消歧重查。
- 查询告警 FTS 扩展不可加载，工具没有尝试安装；上游图查询仍成功，以源码引用补证，不改全局环境。

| 目标 | 风险 | d=1 直接调用方 | 受影响流 |
| --- | --- | --- | --- |
| `buildProgressCardJson` | CRITICAL | `fits`、`_doCreateStreamingCard` | 创建、进度/正文/工具刷新、onStreamEnd、flushCardUpdate |
| `fitProgressView` | CRITICAL | `_doCreateStreamingCard`、`finalizeCard`、`flushCardUpdate` | 同上 |
| `progressActions` | CRITICAL | `fits`、`finalizeCard`、`flushCardUpdate` | 差分、请求预算、运行刷新及收尾 |
| `fits` | CRITICAL | `fitProgressView` | 完整实体及请求预算，创建/刷新/收尾 |
| `_doCreateStreamingCard` | HIGH | `createStreamingCard` | onMessageStart/onProgress/onStreamText/onToolEvent |
| `FeishuAdapter.flushCardUpdate` | CRITICAL | `scheduleCardUpdate` | onMessageStart/onProgress/onStreamText/onToolEvent、耗时刷新 |
| `FeishuAdapter.finalizeCard` | LOW | `onStreamEnd` | 成功/错误/中断最终投递 |
| `FeishuAdapter.updateCardContent` | LOW | `onStreamText` | 已有原卡正文更新、延迟创建后的正文更新 |

精确 UID：`Method:src/lib/bridge/adapters/feishu-adapter.ts:FeishuAdapter.flushCardUpdate#1`、`Method:src/lib/bridge/adapters/feishu-adapter.ts:FeishuAdapter.finalizeCard#4`。HIGH/CRITICAL 已实时报告主会话，由主会话在放行实现前告知用户。风险SharedAxes LOW 不能抵消 CRITICAL。

补充：`updateCardContent` 用 `Method:src/lib/bridge/adapters/feishu-adapter.ts:FeishuAdapter.updateCardContent#2` 精确查询，上游风险 LOW、epistemic exact；源码 :1038、:1042 两处均由 onStreamText 调用，延迟创建分支保留 generation 检查。当前 :815 以预览超限提示覆盖 appendNotice，把两种不同事实塞进同一字段。建议新增原卡状态 `textOverflow:boolean`，每次 split 后准确赋 `parts.length>1`，真实追加字段独立保留；成功全文收尾不外显过时预览超限，全文仍须分段的 fallback 则继续外显投递去向。初始化与运行/终态调用需同步，但不扩大到 manager/model。边界测试要覆盖：追加后正文超限不吞追加；后续短文本可撤预览超限；最终全文可入卡时不保留超限提示；最终确需分段时保留明确提示。该补充风险已实时报告主会话。

### 6. 必须保留的 S6b 合同与验证范围

3 叶子结构不应改变任务语义、生命周期或模型执行。`fitProgressView` 仍按完整序列化实体、转义后请求与 30,000 字节保守上限决定能否完整展示。历史让预算给正文，完整正文放不下仍返回 null 并交原分段链路。

`viewUncertain` 仍不能因后来普通 diff 成功而撤销。不确定收尾需串行两批：先清 2 个非正文叶子（由视图键计算，不硬写原 6 个），确认 ACK 和原 generation/state，再正文优先写完整目标、从已知空基线恢复辅助内容。正常成功也必须明确写唯一运行区的终态内容，不能因旧缓存“相等”省略，从而把部分应用失败的旧三条留在卡上。这与旧 `tool_progress` 清空的语义相同，操作目标和终态值变为 `task_status` 唯一完成行。

保留单实际在途、节流/频控、5秒真实耗时、旧卡换代隔离；不切 config，不重建/patch 有内容的父 panel，不重跑模型。清基线的短暂空内容是异常恢复路径；正常终态不保留空 Markdown。

最小回归需断言：

- 初始化仅 3 叶子，无死键；唯一完成状态和耗时、ctx/追加/统计只在历史。
- 运行当前动作及近期 3 条持续可见；错误/中断必要提示常显。
- 原父 panel/config 运行和收尾不重写；真实无内容才删除空 panel。
- 部分前缀已应用后失败/非零/频控，即使旧缓存与目标相同仍覆盖运行区；动态 reset 2 叶子，各中间实体/请求 <=30KB。
- 正文成功后空 panel 删除失败不重复投递；取消/換代不操作旧卡。
- 大正文完整、超限分段、追加同卡、通知回归；相关最小检查后 typecheck/build 与必要全量验证。

## Files Found / Code Patterns

- `src/lib/bridge/markdown/feishu-progress.ts:11`：7 叶子 ProgressView 类型。
- `src/lib/bridge/markdown/feishu-progress.ts:34`：卡片初建 Markdown/折叠容器布局。
- `src/lib/bridge/markdown/feishu-progress.ts:53`：内容差分，按增长量排序局部更新。
- `src/lib/bridge/markdown/feishu-progress.ts:66`：完整实体及请求预算。
- `src/lib/bridge/markdown/feishu-progress.ts:74`：运行与终态内容分配，重复状态、外部统计与追加来源。
- `src/lib/bridge/adapters/feishu-adapter.ts:675`：初建与渲染直接调用。
- `src/lib/bridge/adapters/feishu-adapter.ts:829`：运行适配器调用与差分。
- `src/lib/bridge/adapters/feishu-adapter.ts:894`：终态生命周期、完整正文确认及通知。
- `src/lib/bridge/adapters/feishu-adapter.ts:930`：旧 tool_progress 强制清理；:932 不确定两批恢复。
- `src/lib/bridge/adapters/feishu-adapter.ts:1013`：当前回合追加提醒；应运行可见、终态归入历史。
- `src/__tests__/unit/bridge-feishu-progress.test.ts`：真实适配器故障注入与预算/进度回归。
- `src/__tests__/unit/bridge-feishu-final-card.test.ts`：最终正文及旧页脚合同，需同步终态语义。
- `src/__tests__/unit/bridge-feishu-live-append.test.ts:128`：旧 task_footer ID 作为收尾信号，需改真实终态断言。
- `node_modules/@larksuiteoapi/node-sdk/types/index.d.ts:36315`：CardKit SDK；:36448 cardElement；batchUpdate 已被当前适配器使用。

## Related Specs

- `.trellis/workflow.md`：先规划、持久化调研、执行后验证及规范沉淀。
- `.trellis/spec/backend/module-boundaries.md`：平台展示归 markdown/adapter，不扩大模型或 manager 职责。
- `.trellis/spec/backend/reliability-contracts.md`：动态过程卡阅读状态、非原子批、30KB逐步预算、完整正文确认与辅助展示分开。
- `.trellis/tasks/10-14-feishu-progress-collapse/prd.md`：动态局部刷新与保留展开，成功外部不残留进展。
- 既有 `research/terminal-platform.md` 与 `research/platform-collapse.md`：空格更新无零高度保证；原生展开无回调、配置更新重置的已知边界。

## Caveats / Not Found

- 官方 `.md` 通过 PowerShell 只读 HTTP 成功获取；web.open 对 text/markdown 返回 Unsupported content-type，已改用同官方来源，未使用第三方转载。
- 没有官方 `height:0/visible:false/show_when` 保证；不能凭 SDK 任意 string schema 宣称合法。
- 真实平台/客户端未验证本次版式，自动化通过只能证明本地内容与生命周期合同。
- 以上仅对当前源码版本；实现修改后需重新检查实际 diff 与图影响。没有写 `.fusion/`，遵循 researcher 只能写 research/ 的角色边界。
