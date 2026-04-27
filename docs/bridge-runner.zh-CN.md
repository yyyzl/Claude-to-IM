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

# 强烈建议：锁死一个你网关/账号明确支持的模型，避免自动选到新版本导致 502
bridge_codex_model_id=gpt-5.5
# 或：bridge_codex_model_hint=gpt-5.5 xhigh

bridge_codex_sandbox_mode=danger-full-access
bridge_codex_approval_policy=never

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

1. 先锁死模型：`bridge_codex_model_id=gpt-5.5`
2. 再看网关是否对更高版本模型支持不完整（例如某些 `*-codex` 新模型）

### 4.2 先用 `codex debug` 把“上游可用性”跑通

把桥接因素先排除掉：

```bash
codex debug app-server send-message-v2 "ping"
```

这一步能快速证明：`~/.codex/config.toml` + `auth.json` + 网关是否可用。

### 4.3 Windows 的 `spawn EINVAL` 通常是 `.cmd/.bat` 直接 spawn 导致

现象：飞书侧/Node 侧报 `Error: spawn EINVAL`

根因：Windows 上 Node 不能直接 `spawn` `codex.cmd`（需要 `cmd.exe /c` 包一层）。

## 5) 安全建议

- `.env.bridge.local` 只放本机，且必须被 Git 忽略
- `bridge_feishu_allowed_users` 强烈建议只填你自己的 open_id
- `danger-full-access` 很强，确保你的飞书 bot 权限隔离到位
