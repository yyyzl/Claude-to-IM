# 飞书模型卡实现与验证

日期：2026-10-05。仅离线测试，未启动真实飞书连接或模型进程。

## 影响分析

- 修改既有 `FeishuAdapter.handleCardAction` 前执行 `gitnexus impact handleCardAction --direction upstream -r Claude-to-IM`：LOW、精确命中，1 个直接调用方 `FeishuAdapter.start`，1 个流程组（组内 4 个流程引用）。
- 新增适配器能力前执行 `gitnexus impact FeishuAdapter --direction upstream -r Claude-to-IM`：LOW，直接导入方 `adapters/index.ts`、二层 `bridge-manager.ts`；图提示接口动态派发为下界，已以当前核心调用和测试补证。
- 本次新增 `buildModelSelectionCard`、`parseModelSelectionResponse`、`sendModelSelection`、`updateModelSelection` 尚不在提交基线索引中，后续调整前查询返回 UNKNOWN/not found，未在并行写入期间重建。源码调用链为 `handleCardAction → parseModelSelectionResponse → enqueue`，以及核心协调器经可选适配器方法调用 `send/updateModelSelection → buildModelSelectionCard → im.message.create/reply/patch`。
- `gitnexus detect-changes --scope unstaged -r Claude-to-IM --limit 30` 已运行，整个并行工作树当时为 15 文件、109 符号、83 流程、CRITICAL，已向根报告。它包含其他代理的核心及运行时修改；新增代码插入也使旧索引按行定位命中未修改 helper。当前源码 diff 确認飞书范围只修改既有回调入口，其余为新函数／方法／导入；没有更改流式卡、问答卡、权限卡逻辑。

## 最终行为

- schema 2.0 原生 `form/select_static/form_action_type:submit` 两步：模型 → 思考强度与速度 → 应用。刷新、分页、返回、取消是表单外回调，不受未填必选字段阻塞。
- 目录选择值严格使用 `ModelCatalogEntry.id`；实际型号 `model` 仅用于显示。同一型号的不同目录 ID 不合并，页外当前 ID 通过已解析条目保留。
- 核心提供最多 20 项及二次转义预算的当前页；适配器不截目录或选项值，只限制选项显示标题长度。发送和更新再次检查真实外层 JSON 转义后的 30KB 预算，超限明确失败。
- 思考强度只展示默认及目录支持项；飞书非空默认哨兵 `__model_default__` 回调时转换为核心空字符串。不支持的旧强度／Fast 不填非法 `initial_option`，要求重新选择。
- 卡片说明当前聊天范围、`/new` 保留、下一轮生效和 Fast 更高用量。终态去掉表单与按钮。
- 独立 `modelSelectionResponse` 验证回调形状，来源仅从真实 `operator.open_id`、`context.open_chat_id/open_message_id` 获取；草稿归属、revision、有效期、目录与保存由核心继续验证。回调仅入队，不访问网络或查询目录。
- 发送／回复检查业务码和有效消息 ID；patch 检查业务码并返回原卡 ID，不要求 patch 响应重复返回 ID。

## 验证

- 新增 `src/__tests__/unit/bridge-model-card.test.ts`：15 项通过，覆盖卡片结构、别名 ID、初始值、能力过滤、终态、来源、独立事件、畸形输入、旧问答／权限兼容、发送／回复／patch、业务码、缺失 ID、二次转义字节预算。
- 最终卡片用例和既有 `bridge-feishu-reliability.test.ts`、`bridge-user-input-broker.test.ts` 合跑：25/25 通过，其中新增卡片用例 15 项。
- 所有测试先阻断真实 socket/fetch/子进程，只注入显式 fake REST；命令使用 `--test-timeout=15000`，每次实际进程耗时少于 3 秒（总上限 60 秒）。
- 飞书文件 `git diff --check` 通过。初次 `npm run typecheck` 仅报运行时代理尚在同步的 `tests/codexUtils.test.ts` 旧目录 fixture，不修改他人文件；该代理同步后，本层最后一次 `npm run typecheck` 已通过，根也独立确认 build/typecheck 通过。

## 外部边界

沿用项目已存在的原生表单路径和 SDK 的 `initial_option` 字符串约定。尝试读取飞书官方 [表单文档](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/form-container) 但工具未返回正文；不将离线结构断言宣称为真实客户端渲染验证。账号 Fast 授权和实际飞书渲染仍需真实环境验证。
