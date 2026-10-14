# Research: 飞书 JSON2 折叠面板与局部更新合同

- Query: 折叠历史同时保留实时进度；原生展开状态能否在后续刷新中保留；SDK 1.74.0 的元素级操作及最小安全布局。
- Scope: mixed（飞书官方文档、当前本地 SDK 与适配器；不调用真实平台）
- Date: 2026-10-14
- Active task: `.trellis/tasks/10-14-feishu-progress-collapse`

## Findings

### 1. 结论与明确的保证边界

原生 `collapsible_panel` 可以承载 Markdown 执行历史。推荐首次创建时默认关闭，之后保留同一个面板和所有固定元素 ID，只更新面板内 Markdown 的 `content` 及外面的正文、当前动作、最近进展。**这是减少重置风险的实现策略，不是已获飞书保证的客户端阅读状态合同。**

所核对的折叠组件完整文档没有展开/收起回调配置；卡片回传交互文档也没有返回原生面板展开状态的字段。不能编造 `on_expand`、`expanded` 回调、面板 `behaviors`，也不能把“每次发送 expanded:false”当成保留用户状态的方法。官方只定义布尔属性；未说明其在用户手动操作后如何与服务端更新合并。[折叠面板](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/collapsible-panel)、[卡片回传交互](https://open.feishu.cn/document/feishu-cards/card-callback-communication)。

必须通过真实飞书客户端完成“手动展开 → 正文刷新 → 历史子内容刷新 → 收尾”的视觉验收。Fake SDK 成功、CardKit 实体创建成功，均不能证明用户展开状态得到保留。

### 2. 组件合同

官方 `.md` 正文读取结果：折叠面板 246 行，其中 89–119 行是完整字段表。

- `tag: "collapsible_panel"`；`expanded` 缺省 `false`。`header` 必须存在，标题可以用普通文本或 Markdown。
- 面板及内嵌可操作组件使用 `element_id`：同卡全局唯一，仅字母、数字、下划线，字母开头，至多 20 字符。
- `elements` 容纳子组件；禁止内嵌 `form`，因此本任务不把独立问答卡放入历史面板。
- 官方未给出原生展开动作回调或按展开动作懒加载历史的合同。历史仍在 JSON 中，折叠不减少卡片体积。
- `header.width` 的较新宽度行为要求飞书 7.32+；最小布局无需该属性，避免引入不必要版本边界。

以上来自[JSON2 折叠面板](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/collapsible-panel)。

### 3. SDK 1.74.0 与 API 映射

本地 `node_modules/@larksuiteoapi/node-sdk/package.json:1` 确认版本 1.74.0，无需升级依赖。类型定义实际存在以下方法：`node_modules/@larksuiteoapi/node-sdk/types/index.d.ts:36315` 起的 `cardkit.v1`。

| SDK 方法 | HTTP 合同 | 本任务用途与边界 |
| --- | --- | --- |
| `cardElement.content` | `PUT /cardkit/v1/cards/:card_id/elements/:element_id/content` | 全量传某个 plain_text/markdown 的文本；必须开启流式；前缀相同才追加打字机输出 |
| `cardElement.patch` | `PATCH /cardkit/v1/cards/:card_id/elements/:element_id` | `partial_element` 是 JSON 字符串；仅改变指定属性，不能改 tag；最适合历史子 Markdown 的 content |
| `cardElement.update` | `PUT /cardkit/v1/cards/:card_id/elements/:element_id` | `element` 是完整新组件字符串；会替换目标组件，不适合重建历史父面板 |
| `cardElement.create` | `POST /cardkit/v1/cards/:card_id/elements` | 新增组件；append 可指定容器 ID，不指定时放 body 末尾；固定布局无须持续新增节点 |
| `cardElement.delete` | `DELETE /cardkit/v1/cards/:card_id/elements/:element_id` | 删容器会连带删除子组件；运行中不要删历史父面板 |
| `card.batchUpdate` | `POST /cardkit/v1/cards/:card_id/batch_update` | 一次提交多条增删改配置/组件操作；目前已有使用，可用于同一帧的 live/history/notice 内容变化 |
| `card.update` | `PUT /cardkit/v1/cards/:card_id` | 全量覆盖实体所有内容，不能据同 ID 推断客户状态一定保留 |
| `card.settings` | `PATCH /cardkit/v1/cards/:card_id/settings` | 收尾关闭 streaming_mode 和改摘要，无须替换正文树 |

原始来源：[流式更新文本](https://open.feishu.cn/document/cardkit-v1/card-element/content)、[更新组件属性](https://open.feishu.cn/document/cardkit-v1/card-element/patch)、[更新组件](https://open.feishu.cn/document/cardkit-v1/card-element/update)、[新增组件](https://open.feishu.cn/document/cardkit-v1/card-element/create)、[删除组件](https://open.feishu.cn/document/cardkit-v1/card-element/delete)、[局部更新卡片实体](https://open.feishu.cn/document/cardkit-v1/card/batch_update)、[全量更新卡片实体](https://open.feishu.cn/document/cardkit-v1/card/update)、[更新卡片配置](https://open.feishu.cn/document/cardkit-v1/card/settings)。

独立组件方法的 `partial_element`/`element`/`elements` 是字符串；`batchUpdate.data.actions` 也是字符串，但**actions 内部**的 `params.partial_element`/`params.element`/`params.elements` 是对象/数组，不要多做一层 stringify。官方 batch_update.md 第 40、47 行示例明确此结构。

对面板内有独立 ID 的 Markdown 进行点更新，是由“同卡全局唯一 ID”和“按 ID 更新组件”的文档合同推得；所读接口未排除嵌套 Markdown，但该具体布局仍应进行真实平台校验。

### 4. 最小 JSON2 草案

以下使用官方支持的字段，**尚未实际调用平台验收**。ID 固定、面板初次默认关闭；图标取官方示例值。当前状态和最近进展置于面板外，最后正文可写进预留的首个区域。

```json
{
  "schema": "2.0",
  "config": {
    "streaming_mode": true,
    "wide_screen_mode": true,
    "summary": { "content": "处理中" }
  },
  "body": {
    "elements": [
      {
        "tag": "markdown",
        "element_id": "streaming_content",
        "content": " "
      },
      {
        "tag": "markdown",
        "element_id": "task_status",
        "content": "执行中 · 已用时 12 秒"
      },
      {
        "tag": "markdown",
        "element_id": "tool_progress",
        "content": "正在运行测试\n最近进展：读取配置、确认入口、启动校验"
      },
      {
        "tag": "markdown",
        "element_id": "history_summary",
        "content": "已完成 5 个步骤；较早明细可展开查看。"
      },
      {
        "tag": "collapsible_panel",
        "element_id": "progress_history",
        "expanded": false,
        "header": {
          "title": { "tag": "plain_text", "content": "执行历史" },
          "icon": {
            "tag": "standard_icon",
            "token": "down-small-ccm_outlined",
            "size": "16px 16px"
          },
          "icon_position": "right",
          "icon_expanded_angle": -180
        },
        "elements": [
          {
            "tag": "markdown",
            "element_id": "history_content",
            "content": "✅ 已读取配置\n✅ 已检查项目入口"
          }
        ]
      },
      {
        "tag": "markdown",
        "element_id": "append_notice",
        "content": " "
      }
    ]
  }
}
```

`streaming_content` 和 `tool_progress` 是当前项目既有 ID，减少改动。其他名字是建议，非已实施合同。最终布局排序由实现方案决定，关键是不要为一次状态变化重建历史父组件。

### 5. 更新同一面板内内容的最小草案

复用当前 `batchUpdate` 与单卡串行 `sequence`；只更新真正发生变化的内容。下例独立更新历史子节点、最新步骤、外部数量，不传面板本身，也不写 `expanded`：

```typescript
await client.cardkit.v1.card.batchUpdate({
  path: { card_id: state.cardId },
  data: {
    sequence: ++state.sequence,
    actions: JSON.stringify([
      {
        action: 'partial_update_element',
        params: {
          element_id: 'history_content',
          partial_element: { content: '✅ 已读取配置\n✅ 已检查项目入口\n✅ 已解析依赖' },
        },
      },
      {
        action: 'partial_update_element',
        params: {
          element_id: 'tool_progress',
          partial_element: { content: '正在运行测试\n最近进展：启动校验、通过类型检查、等待测试返回' },
        },
      },
      {
        action: 'partial_update_element',
        params: {
          element_id: 'history_summary',
          partial_element: { content: '已完成 6 个步骤；较早明细可展开查看。' },
        },
      },
    ]),
  },
});
```

如果历史 Markdown 内容发生替换而非末尾追加，使用属性更新可直接上屏；无须给历史使用打字机 API。若不得不替换一个历史子节点，`cardElement.update` 仅定位该子节点并保留其 ID；仍不替换整个 panel。**局部替换子组件也不是阅读位置/展开状态的正式保证，需单独测。**

标题建议固定“执行历史”，完成数量放外部 Markdown。这样不必在每条事件到来时触碰面板 header，进一步缩小客户端重置风险。也不要用面板 `elements` 全量替换所有子节点来更新历史。

### 6. 当前适配器映射与必须处理的收尾边界

本次只核对平台 API 使用点，不展开 manager/provider 调用链。

- `src/lib/bridge/adapters/feishu-adapter.ts:670` 创建 JSON2 流式卡，当前三个固定区域为 `streaming_content`、`tool_progress`、`append_notice`；可以在初建时预留历史父/子区域。
- `feishu-adapter.ts:836` 当前 flush 将全部工具明细合入 progress，超过本地预算直接 return。仅包一层 panel 不解决停更。
- `feishu-adapter.ts:851` 正文使用 `cardElement.content`；`feishu-adapter.ts:863` 进度/追加提示已有 `batchUpdate` 属性更新，适合扩展到固定历史子 Markdown。
- `feishu-adapter.ts:733` 至 `:759` 存在单卡 sequence、inFlight、operation、closing、已发内容缓存，必须沿用，避免两个网络写并发覆盖。
- **`feishu-adapter.ts:939` 目前 finalize 使用 `card.update` 全量换为最终卡**，历史会被当前终态布局消除。若用户展开历史后需要持续阅读，必须把这一条纳入设计，不能只修改运行中的 flush。最小方向是终态也沿固定树更新正文/状态/历史，并通过 settings 关闭流式；完整回答超限继续返回给已有最终分段投递链路。
- `feishu-adapter.ts:949` 已有 settings 关闭流式的失败收尾路径；可以借用合同，不能将更新失败伪称最终正文已送达。

“最终过程默认收起”与“尊重用户手动展开”需要区分：从首次创建开始默认关闭可以实现；若结束时再次发送 `expanded:false`，就会强制覆盖用户正在查看历史的行为。建议最终状态保持原生阅读状态，不再主动写 expanded；把通常未展开的历史继续默认关闭视为产品含义。

### 7. 容量、频控与动态状态限制

- 现有 `MAX_CARD_BYTES = 30_000`（`feishu-adapter.ts:100`）是保守字节预算，不等于“中文 30,000 字”。CardKit create 的字符串字段校验可达 3,000,000 字符，而 create/update/patch 的 `200860` 错误说明仍建议/要求卡片体积控制到 30KB；不能按字段字符上限扩大平台容量。折叠后仍需预算。[创建卡片实体](https://open.feishu.cn/document/cardkit-v1/card/create)、[更新组件属性](https://open.feishu.cn/document/cardkit-v1/card-element/patch)。
- 固定一个历史 Markdown 比每条日志新增一个组件更易保持节点数量；官方卡片最多 200 个元素/组件，其中 plain_text 也计数。固定树并不减少内容字节，但可避免组件数量不断增长。[创建卡片实体](https://open.feishu.cn/document/cardkit-v1/card/create)。
- 预算判断不能仅看“这次 patch 请求很小”：历史累积造成的**更新后实体总体积**仍可能超限。建议计算完整目标视图，加上 JSON 结构/转义，优先为当前状态、最近进展、异常/待操作、追加提示预留空间。历史明细可有界显示并明确“展示摘要/部分历史”，最终正文完整分段；不能静默丢最终回答。
- 单卡实体操作上限 10 次/秒；`streaming_mode` 在上次开启 10 分钟后自动关闭。`content` 依赖开启流式；`patch`、`batchUpdate` 等局部操作并不要求流式。现有节流与退避应沿用，本任务不顺手重构全局流式超时。[流式更新卡片](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview)。
- 自定义“展开历史”按钮触发回调会引入额外风险：流式期间服务端接到交互回调时不能立即更新卡片；官方要求关闭流式后处理回调。原生面板无需自造该回调链。[流式更新卡片](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview)。

### 8. 最小真实平台验收

研究角色没有调用真实平台；以下是实施后验收步骤，需在用户授权的原聊天内运行非敏感合成内容。

1. 用真实 SDK 创建并发送上述最小实体，分别确认业务 code、card_id、message_id 和客户端可见控件。先排除 JSON 合法但平台 schema 拒绝的问题。
2. 初始不开面板，连续更新最新状态/正文，确认历史保持收起、当前最新动作在外面实际变化。
3. 手动展开面板，分别进行：只改外部进度、只改正文、只改历史子 content、同时批量更新；每一步观察面板是否仍展开、历史是否刷新、滚动/视线是否被扰动。保存所用请求类型与客户端版本，不能只保存代码截图。
4. 手动收起，再重复同样更新，确认不会自行展开。若需求涉及多用户/多设备，单客户端取证不能推断跨端一致。
5. 在展开状态下完成任务，通过局部终态更新和 settings 关闭流式；确认原卡最终正文可读、历史仍在、没有新增过程卡或重复答案。
6. 特别做全量更新/替换父 panel 的对照（仅诊断）：若与子 content 更新行为不同，应记录差异。生产方案避免对用户当前阅读的原卡执行该对照。
7. 超长命令、大量历史及中文/emoji 内容下，验证预算不足时仍有新的 live 状态，历史摘要明确，完整最终回答走既有分段；不要把超限事件变成永久停止进度。

如果真实客户端连“父 panel 完全不动、只改外部进度”都重置展开，则该客户端上原生面板无法满足现要求。此时应回规划讨论静态历史区域/独立详情消息等替代布局，不能伪造展开回调、无限重发 expanded:true、或宣称 stable IDs 已保证成功。

## Files Found / Code Patterns

- `.trellis/tasks/10-14-feishu-progress-collapse/prd.md`：用户认可的常显进度/历史折叠/保留阅读/完整最终分段要求。
- `src/lib/bridge/adapters/feishu-adapter.ts:670`：CardKit JSON2 初始结构。
- `src/lib/bridge/adapters/feishu-adapter.ts:836`：当前累计进度与预算停更位置。
- `src/lib/bridge/adapters/feishu-adapter.ts:851`：正文流式元素更新。
- `src/lib/bridge/adapters/feishu-adapter.ts:863`：已有属性级 batch 更新模式。
- `src/lib/bridge/adapters/feishu-adapter.ts:939`：最终全量更新是阅读状态验收的关键边界。
- `node_modules/@larksuiteoapi/node-sdk/package.json:1`：真实 SDK 版本 1.74.0。
- `node_modules/@larksuiteoapi/node-sdk/types/index.d.ts:36315`：CardKit 客户端声明，组件方法从 `:36448` 起。

## Related Specs

- `.trellis/spec/backend/index.md`：该项目主体是桥接库，变更应落在渠道适配与 Markdown 层，优先复用现有 helper。
- `.trellis/spec/backend/reliability-contracts.md:26`：原回合 owner、generation、取消和停机，旧刷新不得写入新卡。
- `.trellis/spec/backend/reliability-contracts.md:60`：平台动作与真实投递结果区分；最终正文沿持久分段/补发合同。
- `.trellis/spec/backend/reliability-contracts.md:80`：SDK string 类型不校验内层 schema；必须分清真实格式校验、可见控件、端到端结果。
- `.trellis/spec/backend/reliability-contracts.md:160`：内存平台测试与真实验收隔离；单测外层 60 秒硬截止。

## External References / Versions

只采用飞书官方 `open.feishu.cn` 文档及本地官方 Node SDK 1.74.0。文档于 2026-10-14 只读获取；web open 返回空正文时，使用 canonical URL 后加 `.md` 并由 urllib 读取官方 Markdown。部分短路径的 streaming 总览返回 404，已改用完整 `uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview.md`，未使用第三方转载正文。

## Caveats / Not Found

- 未发现飞书官方承诺任意局部更新/全量覆盖在所有客户端保留原生展开状态。不能把未找到文字视为平台不存在行为，但目前没有可以依赖的保证。
- 未发现原生 panel 展开/收起事件回调及服务端查询其展开状态的文档合同。不要将普通 button/select 的回调能力套给容器。
- 未实际调用飞书 API、操作客户端或重启桥接；本文件的 JSON/请求草案不是已验证的平台收据。
- 保留展开状态与保留精确滚动位置是不同指标；即使面板仍展开，历史增长也可能导致视线移动，视觉验收需单独记录。
- 不评估整个 provider/manager 生命周期，也不设计日志持久化/新文件传输能力；另一研究主题负责内部执行流。
