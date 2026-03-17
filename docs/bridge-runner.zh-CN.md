# 中央 Runner（飞书 ↔ Codex）使用姿势与经验教训

目标：只保留 **一份中央 runner**（在本仓库里），并且全局只维护一份配置文件：
`Claude-to-IM/.env.bridge.local`。

你在飞书里发消息 → 触发本机 `codex app-server` → 在目标项目目录执行/修改代码。

## 1) 你需要准备什么

1. 本机已安装 `codex`（`codex --version` 能跑通）
2. 本机已完成 Codex CLI 登录/鉴权（`codex login`），鉴权信息在 `~/.codex/*`
3. 已在本仓库执行过 `npm install` 且存在 `dist/`（桥接会 import `dist/lib/bridge/*`）

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
bridge_codex_model_id=gpt-5.2
# 或：bridge_codex_model_hint=gpt-5.2 xhigh

bridge_codex_sandbox_mode=danger-full-access
bridge_codex_approval_policy=never

# 可选：输入合并窗口（毫秒）。用于把“短时间内连发的多条消息”合并成一次 LLM 请求。
# 例如：你先发一句“帮我改下 X”，紧接着又补充一句“另外要兼容 Y”，希望一次性发给模型。
# 设为 0 可关闭（恢复每条消息一个 turn）。
bridge_feishu_input_debounce_ms=1200

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

在本仓库根目录执行：

```bash
npx tsx scripts/feishu-claude-bridge.ts
```

运行数据会落到本仓库根目录的 `.ccg/`（已建议加入忽略）。

## 4) 经验教训（这次折腾最关键的几条）

### 4.1 502 / Reconnecting 不一定是网络问题，常见根因是“模型选错了”

症状：

- `codex debug app-server ...` 能跑
- 但桥接 turn 报 `Reconnecting...` / `502 Bad Gateway`

排查/解决：

1. 先锁死模型：`bridge_codex_model_id=gpt-5.2`
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
