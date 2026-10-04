# 中央 Runner（飞书 ↔ Codex）使用姿势与经验教训

目标：只保留 **一份中央 runner**（在本仓库里），并且全局只维护一份配置文件：
`Claude-to-IM/.env.bridge.local`。

你在飞书里发消息 → 触发本机 `codex app-server` → 在目标项目目录执行/修改代码。

## 1) 你需要准备什么

1. 本机已安装 `codex`（`codex --version` 能跑通）
2. 本机已完成 Codex CLI 登录/鉴权（`codex login`），鉴权信息在 `~/.codex/*`
3. 已在本仓库执行过 `npm install` 且存在 `dist/`（桥接会 import `dist/lib/bridge/*`；脚本会在发现 dist 过期时自动执行 `npm run build`）

## 2) 唯一配置文件：`.env.bridge.local`

把下面配置写到 **本仓库根目录** 的 `.env.bridge.local`（不要提交到 Git）：

```dotenv
# 飞书 / Lark 机器人
bridge_feishu_app_id=cli_xxx
bridge_feishu_app_secret=xxx
bridge_feishu_allowed_users=ou_xxx
bridge_feishu_domain=feishu   # 或 lark

# 使用 Codex 作为 LLM 后端
bridge_llm_backend=codex

# 你真正要操作的项目根目录（关键）
bridge_default_work_dir=G:\\RustProject\\push-2-talk

# 默认使用 app-server 模型目录的 isDefault 项，不按型号字符串猜最新模型。
# 可选：填账号/网关支持、且当前 model/list 中存在的精确模型 ID。
# bridge_codex_model_id=<model-id>
# 可选：精确模型 ID 后跟目录支持的思考强度（不做模糊评分）。
# bridge_codex_model_hint=<model-id> <effort>

# /mode ask：workspace-write + on-request；/mode plan：read-only + on-request。
# /mode code 默认 workspace-write + never（沙箱外操作不会自动提权）。
# 如需覆盖 code 模式的默认策略，显式配置下列项：
# bridge_codex_sandbox_mode=workspace-write
# bridge_codex_approval_policy=never

# 可选：输入合并窗口（毫秒）。用于把“短时间内连发的多条消息”合并成一次 LLM 请求。
# 例如：你先发一句“帮我改下 X”，紧接着又补充一句“另外要兼容 Y”，希望一次性发给模型。
# 设为 0 可关闭（恢复每条消息一个 turn）。
bridge_feishu_input_debounce_ms=1200

# 可选：流式卡片刷新节流（毫秒）。
# 默认 2000；值太小会更容易触发飞书侧频控（99991400 request trigger frequency limit）。
# bridge_feishu_stream_card_throttle_ms=2000

# 可选：session 排队超时（毫秒）。
# 默认：turn 超时生效值（bridge_codex_turn_timeout_ms，未配置则默认 90 分钟）+ 10 分钟；
# 若 turn 超时关闭（=0），则回退为 5 分钟。设为 0 可关闭。
# 同一 session 正在跑 turn 时，后续消息会进入队列；排队超过该时间会提示并自动取消。
# bridge_session_queue_timeout_ms=300000

# 可选：turn 超时（毫秒）。默认 90 分钟。
# 执行会跑很久（构建/安装依赖）时建议调大，例如 120 分钟：
# bridge_codex_turn_timeout_ms=7200000

# 可选：SSE keep_alive 心跳间隔（毫秒）。默认 15 秒；设为 0 可禁用。
# bridge_sse_keep_alive_ms=15000
```

说明：

- **中央 runner 模式下**，脚本只会读取本仓库根目录的 `.env.bridge.local`。
- 你要切换目标项目，就改 `bridge_default_work_dir`（或在 IM 里用 /cwd 之类命令切换，取决于你桥接侧命令实现）。
- `bridge_feishu_input_debounce_ms` 只能合并“请求开始之前”的连发消息；如果第一条已经进入执行中，后续消息仍会排队成为下一次请求（这是 Codex app-server 的 turn 模型决定的）。

## 3) 启动

### 单实例（默认）

在本仓库根目录执行：

```bash
npx tsx scripts/feishu-claude-bridge.ts
```

默认读取 `.env.bridge.local`，运行数据落到 `.ccg/bridge-runner/`。

### 多实例并行（Claude + Codex 双桥接）

脚本支持通过命令行参数指定不同的 env 文件，配合 `BRIDGE_CONTROL_DIR` 环境变量隔离各实例的运行数据，即可同时运行多个桥接实例（分别连接不同的飞书机器人 + 不同的 LLM 后端）。

**准备工作**：在仓库根目录分别创建两份配置文件：

| 文件 | 后端 | 控制目录 |
|---|---|---|
| `.env.bridge.claude` | Claude Code | `.ccg/bridge-claude/` |
| `.env.bridge.codex` | Codex CLI | `.ccg/bridge-codex/` |

**PowerShell 启动命令**（在本仓库根目录执行）：

```powershell
# 启动 Claude 桥接
$env:BRIDGE_CONTROL_DIR=".ccg/bridge-claude"; npx tsx scripts/feishu-claude-bridge.ts .env.bridge.claude

# 启动 Codex 桥接
$env:BRIDGE_CONTROL_DIR=".ccg/bridge-codex"; npx tsx scripts/feishu-claude-bridge.ts .env.bridge.codex
```

**Git Bash 启动命令**：

```bash
# 启动 Claude 桥接
BRIDGE_CONTROL_DIR=".ccg/bridge-claude" npx tsx scripts/feishu-claude-bridge.ts .env.bridge.claude

# 启动 Codex 桥接
BRIDGE_CONTROL_DIR=".ccg/bridge-codex" npx tsx scripts/feishu-claude-bridge.ts .env.bridge.codex
```

> **注意**：两个实例需要使用不同的飞书机器人（不同的 `app_id` / `app_secret`），否则 Webhook 事件会冲突。

运行数据分别落到各自的控制目录（`.ccg/bridge-claude/`、`.ccg/bridge-codex/`），互不干扰。

**一键启动**（推荐）：自动打开两个独立窗口，分别运行 Claude 和 Codex 桥接：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-bridges.ps1
```

`start-bridges.ps1 stop` 会停止这 3 个已知实例：`.ccg/bridge-claude/`、
`.ccg/bridge-codex/`、`.ccg/bridge-runner/`；`start` 会先执行同样的定向清理，
再只启动 Claude / Codex 两个窗口，避免旧的 `.env.bridge.local` 进程与
`.env.bridge.codex` 共用同一飞书应用时继续抢消息，也不会扫描或误杀其他 bridge。

## 3.1) 推荐：用 `scripts/bridge.ps1` 管理（更适合远程/无人值守）

Runner 已内置优雅退出逻辑（`SIGINT/SIGTERM`），但在 Windows 上远程“发信号”不太方便。
因此 runner 额外支持 **stop-file**：外部创建一个文件即可触发优雅退出；同时写入 **heartbeat**
便于 watchdog 判断“是否卡死”。

在本仓库根目录执行：

```powershell
# 启动（后台）
powershell -ExecutionPolicy Bypass -File scripts/bridge.ps1 start

# 状态（pid + 心跳 + 日志位置）
powershell -ExecutionPolicy Bypass -File scripts/bridge.ps1 status

# 优雅停止（推荐）
powershell -ExecutionPolicy Bypass -File scripts/bridge.ps1 stop

# 卡死才用强制结束（结束进程树）
powershell -ExecutionPolicy Bypass -File scripts/bridge.ps1 stop -Force
```

运行时文件默认落到：`.ccg/bridge-runner/`

- `pid`：runner PID
- `heartbeat.json`：心跳（默认每 15s 更新一次）
- `last-stop.json`：最近一次优雅退出的原因（如 `SIGINT` / `STOP_FILE`）
- `stop`：触发优雅退出（由 stop 命令创建）
- `stdout.log` / `stderr.log`：runner 输出日志

可选环境变量：

- `BRIDGE_CONTROL_DIR`：覆盖控制目录（相对路径会相对仓库根目录解析）
- `BRIDGE_RUNNER_HEARTBEAT_MS`：心跳间隔（毫秒），默认 15000；设为 0 可关闭
- `BRIDGE_RUNNER_STOP_POLL_MS`：stop-file 轮询间隔（毫秒），默认 1000；设为 0 可关闭

## 3.2) 无人值守自愈：定时跑 watchdog（推荐配合 Windows 任务计划程序）

watchdog 会在“未运行”或“心跳超时（默认 120s）”时自动拉起/重启：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bridge.ps1 watchdog
```

建议在 Windows「任务计划程序」里创建一个任务：

- 触发器：登录时 + 每 1 分钟重复
- 操作：运行 `powershell.exe`，参数为 `-ExecutionPolicy Bypass -File scripts/bridge.ps1 watchdog`
- 起始于：本仓库根目录（确保能找到 `package.json` / `node_modules`）

## 3.3) 不用远程桌面也能控：远程执行命令（可选）

如果你不想“远程桌面进去手动 Ctrl+C / 杀进程”，最稳的方式是让这台 Windows 支持
远程执行 PowerShell（例如 OpenSSH Server / WinRM / 内网 VPN + 远程命令），然后直接
远程运行：

- `scripts/bridge.ps1 status`
- `scripts/bridge.ps1 stop`（优雅）
- `scripts/bridge.ps1 stop -Force`（卡死才用）
- `scripts/bridge.ps1 start`

## 4) 经验教训（这次折腾最关键的几条）

### 4.1 502 / Reconnecting 不一定是网络问题，常见根因是“模型选错了”

症状：

- `codex debug app-server ...` 能跑
- 但桥接 turn 报 `Reconnecting...` / `502 Bad Gateway`

排查/解决：

1. 使用 `/model <model-id> [effort]` 或 `bridge_codex_model_id` 指定当前目录中的精确型号。无匹配项会明确报错，模型目录也不等同于账号实际调用权限。
2. 再检查账号/网关是否支持该型号及 Responses API；不要在升级后继续复制旧版本的固定型号示例。

### 4.2 先用 `codex debug` 把“上游可用性”跑通

把桥接因素先排除掉：

```bash
codex debug app-server send-message-v2 "ping"
```

这一步能快速证明：`~/.codex/config.toml` + `auth.json` + 网关是否可用。

### 4.3 Windows 的 `spawn EINVAL` 通常是 `.cmd/.bat` 直接 spawn 导致

现象：飞书侧/Node 侧报 `Error: spawn EINVAL`

根因：Windows 上 Node 不能直接 `spawn` `codex.cmd`（需要 `cmd.exe /c` 包一层）。

当前 runner 默认使用桥接工程固定的 `@openai/codex@0.160.0`，通过 Node 执行包内入口，避免 PATH 上全局版本漂移；`bridge_codex_bin` 显式配置优先。目标项目 `bridge_default_work_dir` 可以是另一仓库，无需在目标仓库安装 Codex。升级后执行 `npm install` 与 `npm run build`，运行中的旧桥接需要在方便时切换到新构建。

### 4.4 新版模型、卡片与交互

- Codex 飞书桥接输入 `/model` 打开模型选择卡片：先从运行时目录选择模型，再选择该模型支持的推理强度和正常／Fast 速度，点击应用。卡片提供刷新、返回、取消；选择过程中不会修改已保存配置。
- 模型、强度和速度按当前聊天保存，`/new` 清空上下文后继续继承，重新绑定会话和重启桥接后也保留；其他聊天互不影响。`/status` 区分选择偏好和实际使用的配置。
- 卡片中的“跟随 Codex 默认”和 `/model default` 持续跟随目录默认项，不会被上次实际使用的型号覆盖。强度也可以跟随模型默认；明确指定的型号或强度失效时会报错，不会静默换型号或降低强度。
- 仍可输入 `/model <id> [effort]`，模型与强度会在保存前校验。文字设置保留已选速度；尚未设置速度时使用正常并在回执说明。如果保留的 Fast 不适用于新模型，请打开卡片重新选择。
- Fast 是独立速度设置，用量通常更高，按当前模型目录中的 Fast 档位提供。如果提示目录未提供选项，可刷新目录；这不代表账号永久不支持。正常速度会显式覆盖上一轮 Fast；目录和账号的实际调用权限仍可能不同，服务端拒绝时会显示错误，不自动换档重试。
- 任务运行中可以查看模型卡片，应用设置需等待完成或先 `/stop`；新设置从下一次请求生效。卡片仅发起者可操作，过期、重复、切换会话或重启前的旧卡不会覆盖新配置。
- app-server 恢复会话使用 `thread/resume`；失败会保留原会话 ID 并报错，用户可通过 `/new` 明确开始新上下文。`/stop` 和执行超时会向后端发送 `turn/interrupt`。
- 命令执行和文件变更审批支持允许本次、允许会话、拒绝。模型问题通过飞书表单或 `/answer <id> <答案或JSON>` 回传真实答案。敏感问题不在聊天中收集；精细权限申请和 MCP elicitation 目前明确拒绝，并提示在本地 Codex 完成，不会悬挂等待。
- PNG/JPEG/WebP/GIF 图片按协议传入；其他附件会明确提示不支持，不再静默忽略。模型目录若声明不支持图片，也会在调用前提示。
- commentary 作为独立进度展示，不混入最终回答和会话历史。用量来自公开 `thread/tokenUsage/updated`；ctx 优先使用后端 `last.totalTokens`（包括压缩后估计），不再读取本机 rollout 文件补数。

## 5) 安全建议

- `.env.bridge.local` 只放本机，且必须被 Git 忽略
- `bridge_feishu_allowed_users` 强烈建议只填你自己的 open_id
- `danger-full-access` 很强，确保你的飞书 bot 权限隔离到位
