# Codex 0.160.0 模型与速度协议核实

核实时间：2026-10-05。仅使用项目锁定版本的离线 CLI 生成协议 schema；没有初始化 app-server、访问账号或模型目录，没有发起模型请求。

## 证据与命令

`package.json` 锁定 `@openai/codex` 为 `0.160.0`；下列版本命令实际返回 `codex-cli 0.160.0`。

```powershell
node node_modules/@openai/codex/bin/codex.js --version
node node_modules/@openai/codex/bin/codex.js app-server generate-json-schema --help
node node_modules/@openai/codex/bin/codex.js app-server generate-json-schema --experimental --out .trellis/tasks/10-05-codex-model-picker/research/codex-0.160.0-schema
```

原始生成物位于本研究目录下的 `codex-0.160.0-schema/`，共 440 个文件、约 4.3 MB。它们是本地核实材料，不应提交。以下路径相对该目录。使用 `--experimental` 与现有 provider 初始化的 `experimentalApi: true` 一致。

## 模型目录提供的能力

`v2/ModelListResponse.json` 的 `definitions.Model.properties`：

| 字段 | 协议类型与含义 |
| --- | --- |
| `serviceTiers` | `ModelServiceTier[]`，默认 `[]`。每项必需 `id`、`name`、`description`，均为字符串。 |
| `defaultServiceTier` | `string \| null`，默认 `null`；目录为该模型配置的默认服务档位 ID。 |
| `additionalSpeedTiers` | `string[]`，已标记 Deprecated，明确要求使用 `serviceTiers`。 |
| `supportedReasoningEfforts` | `ReasoningEffortOption[]`；每项含 `reasoningEffort` 和 `description`。 |
| `defaultReasoningEffort` | `ReasoningEffort`；与速度字段独立。 |

`serviceTiers` 位于生成文件约第 128 行，`defaultServiceTier` 约第 74 行。目录可以没有速度能力数据；没有条目不代表 Fast 可用。卡片只能按运行时目录提供的服务档位暴露对应选择，不能按模型名猜测支持范围。本次没有调用真实 `model/list`，不声称当前账号可用哪些档位。

## 开始回合与线程的字段

`v2/TurnStartParams.json`：

- `serviceTier: string | null`（约第 924 行）：文档为 “Override the service tier for this turn and subsequent turns.”，影响本回合及后续回合。
- `serviceTierForTurn: string | null`（约第 931 行）：仅在该请求开始新回合时覆盖档位；**`"default"` 明确表示正常速度**。省略或 `null` 都继承线程档位，不改变线程档位，也不改变正在被 steer 的回合。

因此，面向“每个新回合应用聊天选择”的实现，可给 `serviceTierForTurn` 显式传目录中选中的 ID；正常速度显式传 `"default"`。从 Fast 切到正常时不能省略该字段或传 `null`，否则可能继续继承线程的 Fast。不要把未经协议或目录证实的 `"auto"` 当正常值。`"fast"` 是可选择 ID 的情形仍须由实际目录支持验证。

`v2/ThreadStartParams.json`、`v2/ThreadResumeParams.json` 都提供 `serviceTier: string | null`，但 schema 没有说明这里省略与 `null` 的具体区别，不应仅从可空类型推导“清除 Fast”。

`v2/ThreadStartResponse.json`、`v2/ThreadResumeResponse.json` 也有 `serviceTier: string | null`，可用于读取线程实际档位。

## 显式清除线程设置的协议

`v2/ThreadSettingsUpdateParams.json` 的 `serviceTier`（约第 393 行）明确说明：覆盖后续回合档位；`null` 清除当前档位，省略保持不变。

`v2/TurnSettingsUpdateParams.json` 的 `serviceTier` 同样说明：`null` 清除请求档位，省略保持不变。

这些是不同方法的语义，不能直接套用到 `thread/start`、`thread/resume` 或 `turn/start.serviceTierForTurn`。当前需求可以沿用新回合时选择的路径，不必引入修改正在运行回合的操作。

## 限制与实施边界

- schema 证明锁定版本存在这些字段，不能证明当前账号、具体模型和服务端实际可用 Fast。
- schema 本身没有说明 `features.fast_mode` 默认值；已由下述锁定 CLI 离线检查补证。
- 现有桥接初始化会拉取模型目录，但本地 `CodexModelListItem` 类型尚未声明 `serviceTiers/defaultServiceTier`，`turn/start` 也没有传递速度字段；应在原目录与传参链路补齐。
- 模型和强度可复用现有目录验证；速度验证使用目录 ID，正常速度使用协议明确的 `"default"`，不新增旧 `additionalSpeedTiers` 兼容路径。

## Fast 开关核实（实现阶段）

2026-10-05，使用项目锁定的 `@openai/codex@0.160.0` 执行只读 `features list`，仅提取 `fast_mode` 行。为避免读取用户账号与配置，独立子进程的 `CODEX_HOME` 指向临时空目录；没有更改 shell、用户或系统环境变量，也没有修改全局配置或启动 app-server。

实际输出：

```text
fast_mode                                stable             true
```

据此，无需为桥接额外强制覆盖此开关。官方 [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic) 也将其默认值列为 `true`。这仅证明锁定 CLI 的默认功能开关；账号授权、具体模型能力与服务端接收仍以运行时目录及请求结果为准。桥接只接受目录明确提供的 `fast`，服务拒绝时报告真实错误，不降级或替换型号。
