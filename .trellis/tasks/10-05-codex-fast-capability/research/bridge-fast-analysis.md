# 本仓库 Fast 数据流与测试缺口

日期：2026-10-05。只读研究范围：当前桥接源码、已归档的本地公开协议 schema、现有 mock 和 GitNexus 图。仅新增本研究文件；未改业务或测试、未读取用户 auth/config/cache、未调用真实模型或 IM。

## 结论

当前直接缺陷是把聊天选项 `speed: fast` 与服务端档位 ID `fast` 混为一谈。解析器可以正确保留 `serviceTiers: [{ id: priority, name: Fast }]`，但卡片、保存校验、草稿切型号和运行时四处只认可 `tier.id === fast`，因此都会把该目录误判为没有 Fast。

根代理报告其只读白名单检查中，本机模型缓存的 10 个模型均提供 `service_tiers: [{ id: priority, name: Fast }]`，另有旧 `additional_speed_tiers: [fast]`。这是根代理提供的观察，不是本研究直接读取，也不能把缓存 snake_case 字段直接冒充已捕获的 RPC camelCase 响应。上游如何从缓存构造 `model/list`，由另一路协议研究补证。

本研究已使用保留上述档位形状的最小合成输入，通过真实解析器、真实 renderer 和真实保存验证函数复现错误。它不依赖真实账号或模型请求。

另一个独立问题：缺失 `serviceTiers` 与显式空数组被解析成相同结果，之后统一显示“当前仅支持正常速度”。这丢失了“未提供元数据”和“明确返回空集合”的区别。两者应如何对用户开放选项，需依据当前锁定版本的上游语义确定，不能仅凭字段可选就宣布不支持，也不能反过来默认为支持。

## 当前数据流

| 环节 | 源码位置 | 当前行为及影响 |
| --- | --- | --- |
| 请求目录 | `scripts/claude-to-im-bridge/codex-llm.ts:298` `refreshModelCatalog` | 请求 `model/list`，参数 limit=100、includeHidden=false，并完整读取分页；不存在把 Fast 从响应主动删掉的逻辑。 |
| 解析原始页 | `scripts/claude-to-im-bridge/codex-utils.ts:30` `parseCodexModelPage` | `:51` 将缺失 serviceTiers 变成 []；`:54–59` 原样保留 id/name/description。priority 能通过验证；没有把它归一成 fast。defaultServiceTier 只保留/校验。 |
| 公共目录快照 | `src/lib/bridge/types.ts:104`、`codex-llm.ts:128` | ModelCatalogEntry 强制 serviceTiers 为数组，不能表达原字段是否缺失；getModelCatalog 深复制全部 tier，priority 没有在这一层丢失。 |
| 卡片选项 | `src/lib/bridge/markdown/feishu.ts:500` | 只有 id===fast 才添加 speed=fast；`:511` 无选项时断言当前仅支持正常速度。priority/name=Fast 会走错误分支。 |
| 保存校验 | `src/lib/bridge/internal/model-selection.ts:35` `resolveModelPreference` | 显式 Fast 只有 id===fast 才通过；影响卡片 apply 与文字命令保存。单改卡片不足以修复。 |
| 草稿切型号 | `model-selection.ts:264` `respond` | 当前 Fast 遇到没有 id===fast 的模型显示“原 Fast 档位已不可用”，即使模型提供 priority。保留草稿而不自动降档这一行为应继续保留。 |
| 执行前校验 | `codex-llm.ts:232` `selectModel` | 再次只找 id===fast；不满足即报错，尚未发起新回合。单改 UI/保存也不足以修复。 |
| 实际参数 | `codex-llm.ts:234,345` | 匹配成功后传选中 tier.id 到 `turn/start.serviceTierForTurn`。正常固定 default；这条按目录 ID 传值的结构可以保留。 |

聊天偏好 `CodexModelPreferences.speed` 是用户意图枚举 normal/fast。运行协议档位是目录中的实际 ID，当前上游观察为 priority。应明确分开，避免把持久偏好改成协议 ID、引入不必要的数据迁移；如何识别目录中的 Fast 条目应沿用锁定版本的上游逻辑。

研究结束前，根代理补充其官方 0.160 TUI 源码核对结果：忽略大小写比较 tier.name 与 Fast，启用后传该条目的原始 tier.id，正常传 default。此结论由根的上游研究负责出处；据此共享 helper 应复用名称识别规则，不硬编码 priority/fast ID，不增加未经证明的别名或旧字段 fallback。

## 本地 schema 能证明与不能证明的内容

既有材料：`.trellis/tasks/archive/2026-10/10-05-codex-model-picker/research/codex-0.160.0-schema/v2/ModelListResponse.json`。

- `ModelServiceTier.id` 是普通 string，没有枚举为 fast；name 同样是 string。
- `serviceTiers` 默认 []；`additionalSpeedTiers` 标为 Deprecated。
- 既有 `TurnStartParams.json` 说明正常速度显式传 default；目录选中的实际 ID 可用于逐回合覆盖。
- 这些类型信息没有证明 Fast 的 ID 是 fast。前次协议研究本来说明要使用实际目录 ID，末尾及实施规范却进一步收窄成“只接受目录 fast”；这一步没有 fixture 或上游映射证据支持。
- 本轮不建议为了这个缺陷临时读取旧 additionalSpeedTiers，也不凭 id 是否等于旧 fast 决定支持；按根已核实的正式名称识别规则返回原始 ID，可避免额外兼容分支。

## 为什么先前测试全部通过

1. `bridge-codex-model-catalog.test.ts:10–16` 的统一 `model()` helper 直接制造 `serviceTiers: [{ id: fast, name: Fast }]`。分页、并发刷新、执行参数、Fast→正常和服务端拒绝测试都建立在这一假设上。
2. `bridge-model-selection.test.ts:18` 的公共 next 模型也使用 id=fast；所谓不支持场景只是切换为 []，没有 priority/name=Fast 的跨层用例。
3. `bridge-model-card.test.ts:23` 的 `entry(fast)` 再次用同一形状。因此 UI 测试和运行时测试相互印证的是同一假设，没有独立验证其语义。
4. `bridge-codex-model-catalog.test.ts:46–52` 专门断言“serviceTiers 缺失 + additionalSpeedTiers=[fast]”归一后为 []。这验证了丢弃旧字段的实现，却没有验证“未知”与“明确不支持”的用户含义。
5. 协议型测试只证明序列化的值等于 mock 预期；`Fast→正常` 用例目前期望 `[fast, default]`，本身没有证据证明 fast 是服务端使用的 tier ID。

问题不是离线测试数量不足，而是全部正向 fixture 共用了未经证实的 ID。应修正 fixture 的来源和贯通断言，不需要调用真实收费请求来复现。

## 纯内存复现证据

使用 `node --import tsx --input-type=module` 从 stdin 导入三个纯函数；外层 Python subprocess 设置 60 秒上限，约 2.73 秒，exit 0。未创建 provider、客户端或 store，不涉及网络、用户目录和子进程模型。

输入合成模型提供 high 强度及 `serviceTiers: [{ id: priority, name: Fast, description: Faster generation }]`。断言输出：

```json
{"priorityPreservedByParser":true,"cardSpeedOptions":["normal"],"priorityFastRejectedAtSave":true,"missingAndEmptyCollapsed":true}
```

这证明优先修复四处语义匹配；不是刷新未生效或 parser 把合法 priority 删掉。本研究未修改/新增单元测试文件，也没有将这段复现写成修复已完成。

## 影响范围

使用 GitNexus 1.6.12，全部调用 `--repo .`。`status` 返回 main、indexed/current commit 均为 5e39918，99 个覆盖文件一致，up-to-date。

- `query "Codex model catalog serviceTiers Fast selection"` 找到目录解析链、send/updateModelSelection→renderer，以及 resolveModelPreference。
- `context parseCodexModelPage`、`resolveModelPreference`、`selectModel`、`buildModelSelectionCard` 均 found/exact；与当前源码一致。
- upstream impact：parseCodexModelPage 为 LOW，3 个上游，直接调用 refreshModelCatalog，再到 getModelCatalog/streamChat。
- upstream impact：resolveModelPreference 为 LOW，5 个上游，直接 save，再到 respond/setText，再到 manager handleMessage/handleCommand。
- upstream impact：buildModelSelectionCard 为 LOW，2 个直接调用，为 Feishu sendModelSelection/updateModelSelection。
- upstream impact：selectModel 为 LOW，1 个直接调用，为 streamChat.start。

建议变更收敛到共用的速度能力/档位解析契约，四处消费同一结果；保留原目录 ID 和来源状态。可能触及 `types.ts` 的目录表示、codex-utils/provider、协调器、renderer、三个测试文件及模型选择规范/说明。manager 调度、权限/问答、存储实现和其他平台没有必要顺手修改。正式实施前仍应对实际选择修改的符号执行影响检查。

## 建议最小回归

1. **正式 tier ID 贯通**：使用上游确认来源的 priority/Fast fixture，从 raw model/list→parser→getModelCatalog→卡片→apply→fake turn/start；断言 UI value 和持久偏好仍是 fast，出站 serviceTierForTurn 是 priority。保留目录 ID 与模型 ID 不同的现有断言。
2. **Fast→正常**：将现有协议测试改成预期 `[priority, default]`；确认没有省略/null、没有写线程持久档位、不把 normal 自动升为默认 Fast。
3. **能力缺失/显式限制**：分别使用缺字段、[]、不含正式名称 Fast（忽略大小写）的列表；断言没有选项时提示目录未提供选项/刷新，不显示账号一定不支持。补一个名称大小写变体，验证沿用上游识别逻辑而非硬编码 ID。
4. **刷新与旧草稿**：已有 priority 能力刷新后变化时，旧 revision 仍拒绝；原 Fast 草稿不静默变 normal；apply 与执行前采用同一新能力结果。复用现有用例，避免复制一套生命周期测试。
5. **服务端拒绝**：合法目录 priority 情形下 fake turn/start 拒绝，仍报告真实错误且只发送一次，不降档重试。现有用例修正 fixture 即可。

实施规范 `.trellis/spec/backend/codex-model-selection.md:23` 当前写死“目录支持的 fast”，需要改成正式能力识别与实际 tier ID 的对应关系。用户文案应区分支持、未知和明确限制；不应承诺目录支持即账号一定能调用。

## 边界

本报告定位桥接侧可复现的误判；未直接获取实际 app-server 响应，未验证账号服务端授权，也没有代替上游协议研究决定旧 ID 兼容策略。根代理提供的缓存证据已单独注明来源。下一步由主代理结合上游映射证据确定最小修复。
