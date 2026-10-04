# Codex Fast 能力与真实请求值

核实日期：2026-10-05。版本锚点：项目依赖 `@openai/codex@0.160.0`，上游官方源码 tag `rust-v0.160.0`。本次读取项目 PRD、前任务离线 schema 记录与 OpenAI 官方源码，没有读取用户 auth/config，没有调用真实 `account/read`、`model/list` 或模型 turn。

## 根因

当前实现把 Fast 的服务档位 ID 写死为 `fast`。锁定版本真正区分用户名称、兼容别名和请求 ID：**Fast 对应的标准请求 ID 是 `priority`**。当目录提供 `{ id: "priority", name: "Fast" }` 时，现有的 `tier.id === 'fast'` 会在卡片、保存验证和发起请求前全部判错。

这一结论由上游源码独立证实；根会话另外仅采集本机 `models_cache.json` 的模型 slug 和速度字段白名单（未提取或输出 identity、etag，未访问 auth），观察到 10 个模型均有 `id: priority / name: Fast`，与上游吻合。但缓存不等同于本次实际运行的桥接 `model/list` 响应，不能据此声称完成生产验证。

## 上游完整证据链

1. [protocol/src/config_types.rs，第 487—511 行](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/config_types.rs#L487)：`ServiceTier::Fast.request_value()` 返回 `priority`。`from_request_value` 接受 `fast` 或 `priority` 为同一枚举的别名。这不代表每个字符串请求入口都会执行别名转换。
2. [tui/src/chatwidget/service_tiers.rs，第 67—112 行](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/chatwidget/service_tiers.rs#L67)：TUI 从模型 `service_tiers` 构建命令，以不区分大小写的 `name == fast` 识别 Fast。其切换逻辑（第 42—50 行）在开启时发送该条目的原始 `id`，关闭时发送 `default`。
3. [app-server/src/models.rs，第 40—50 行](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/models.rs#L40)：转换为 app-server 模型目录时逐项原样保留档位的 `id`、`name`、`description`，不会把 `priority` 改成 `fast`。
4. [protocol/src/openai_models.rs，第 927—950 行](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/openai_models.rs#L927)：`supports_fast_mode()` 检查标准请求 ID（即 `priority`），还认旧 `additional_speed_tiers` 的 `fast`。真正的 `supports_service_tier()` 与 `service_tier_for_request()` 按目录原始 ID 精确匹配；`default` 会被转为不指定服务档位，不支持的请求值也会被过滤。
5. [core/src/client.rs，第 927—952 行](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/client.rs#L927)：模型请求实际调用上述 `service_tier_for_request`，将结果写入 Responses 请求的 `service_tier`。因此不能只修 UI 文案；保存验证与 `turn/start.serviceTierForTurn` 必须使用同一档位解析器，否则可能继续错误拒绝，或被底层过滤成普通速度。
6. 前任务从本地锁定 CLI 生成的 `TurnStartParams.json` 证实 `serviceTierForTurn` 是 `string | null`：新回合可覆盖为目录 ID；`default` 明确选正常速度；省略或 `null` 继承线程配置。与上述源码合并，Fast 应传 `priority`，正常应传 `default`。

## feature flag、旧字段与账号边界

- [features/src/lib.rs，第 1746—1751 行](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/features/src/lib.rs#L1746) 将 `fast_mode` 标为 stable、默认 true。TUI 会检查该 flag；[tui/src/service_tier_resolution.rs，第 20—38 行](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/service_tier_resolution.rs#L20) 也同时检查当前模型提供的精确 ID。默认已启用不证明用户的有效配置必然启用，但本次明确 ID 错误的修复不需要更改任何全局配置。
- `supports_fast_mode` 是上游内部计算方法，不是现有 app-server `Model` schema 可直接读取的布尔字段。不能虚构同名 JSON 字段。
- 上游内部存在旧 `additional_speed_tiers` 的兼容判断；但本次已有完整 `serviceTiers` 正确数据，并不需要在桥接新增旧字段兼容路径。优先修正 Fast 名称与真实 ID 的映射。
- 目录、feature flag 和服务端账户授权是不同层次。本次没有读取账户或调用生产接口，不推断某计划必然有/无 Fast，不以模型名称或订阅名称硬编码能力。
- 目录缺失、空数组或没有能识别的 Fast 档位时，应表达“当前目录未提供可用 Fast 档位”，不能扩大为模型/账号永久不支持。也不能凭未知状态构造 `priority` 并发起请求；底层可能过滤不支持的值，导致静默正常速度。

## 最小正确修复

1. 提供一个共享的 Fast 档位解析函数，遵循官方 TUI 的 `name.eq_ignore_ascii_case("fast")`；返回目录中的原始条目，不返回硬编码 `fast`，也不把 UI 名称与请求 ID 混用。
2. 卡片展示、保存验证、模型切换校验和 provider 发起请求全部复用该解析结果。聊天偏好继续保存产品语义 `speed: normal | fast`，运行时再解析该模型实际 ID。
3. Fast 发起新回合使用解析出的原始 ID（本次为 `priority`）；正常始终为 `default`。不把正常升级、不把无法解析的 Fast 静默降级。
4. 不为这次问题升级 Codex、修改全局 flag 或加入账号方案判断。保持真实错误与能力信息不足提示。

## 回归 fixture 与断言

公开上游自己的测试也使用 `name: "Fast"` 与 `id: ServiceTier::Fast.request_value()`：[openai_models.rs，第 1839—1849 行](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/openai_models.rs#L1839)。可用以下无用户信息的档位片段构造模型目录测试，替换此前虚构的 `id: fast`：

```json
{
  "serviceTiers": [
    { "id": "priority", "name": "Fast", "description": "Priority processing." }
  ]
}
```

测试至少覆盖：卡片显示 Fast；保存成功；实际 `turn/start.serviceTierForTurn === 'priority'`；Fast→正常变为 `default`；无能力信息不虚构可用；过期草稿/刷新后能力变化仍重新验证。纯离线断言可证实桥接协议行为，不等于验证实际账号延迟或付费请求。
