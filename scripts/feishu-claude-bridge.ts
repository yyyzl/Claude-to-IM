/**
 * Feishu ↔ Claude Code Bridge Runner (for this repo)
 *
 * 目标：在不改 Claude-to-IM 核心代码的情况下，把飞书消息接到 Claude Code SDK，
 *      让你能在 IM 里远程驱动本地项目（默认工作目录=本仓库根目录）。
 *
 * 运行：
 *   npx tsx scripts/feishu-claude-bridge.ts
 *
 * 配置（建议放到"中央 runner 目录"（本仓库根目录）下的 .env.bridge.local）：
 *   bridge_feishu_app_id=cli_xxx
 *   bridge_feishu_app_secret=xxx
 *   bridge_feishu_allowed_users=ou_xxx   # 强烈建议限制为你自己
 *   bridge_feishu_domain=feishu         # 或 lark
 *
 * 可选：
 *   bridge_default_work_dir=G:\\RustProject\\push-2-talk
 *   bridge_default_model=claude-sonnet-4-20250514
 *   bridge_codex_cli_config=model_provider=openai   # 覆盖 ~/.codex/config.toml（每行一条或用 ; 分隔）
 *   bridge_codex_turn_timeout_ms=5400000           # turn 超时（毫秒），默认 90 分钟
 *   bridge_codex_turn_idle_timeout_ms=0            # turn 无事件超时（毫秒），默认关闭；建议 10-20 分钟用于更快发现卡死
 *   bridge_sse_keep_alive_ms=15000                 # 可选：SSE 心跳间隔（毫秒），默认 15 秒
 *   CLAUDE_TO_IM_ROOT=G:\\project\\Claude-to-IM
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadDotEnvFile } from "./claude-to-im-bridge/settings.ts";
import { InMemoryPermissionGateway } from "./claude-to-im-bridge/permissions.ts";
import { ClaudeCodeLLMProvider } from "./claude-to-im-bridge/llm.ts";
import { CodexAppServerLLMProvider } from "./claude-to-im-bridge/codex-llm.ts";
import { JsonFileBridgeStore } from "./claude-to-im-bridge/store.ts";

type BridgeContextModule = {
  initBridgeContext: (ctx: { store: any; llm: any; permissions: any; lifecycle?: any }) => void;
};

type BridgeManagerModule = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getStatus: () => unknown;
};

type RunnerControlFiles = {
  controlDir: string;
  pidFile: string;
  heartbeatFile: string;
  stopFile: string;
  lastStopFile: string;
};

function redactSensitive(text: string): string {
  let out = text;
  out = out.replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-***");
  out = out.replace(/\bBearer\s+\S+/gi, "Bearer ***");
  out = out.replace(
    /(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|token|secret)\s*[:=]\s*([^\s,;]+)/gi,
    "$1=***",
  );
  return out;
}

function pickEnv(name: string): string | null {
  const v = process.env[name];
  if (!v) return null;
  const t = v.trim();
  return t ? redactSensitive(t) : null;
}

function detectPotentialSignalSourceHints(): string[] {
  const hints: string[] = [];

  // 常见"看似自动中断"的根因：watch/restart 工具会向子进程发 SIGINT/SIGTERM 来重启。
  const lifecycle = pickEnv("npm_lifecycle_script");
  if (lifecycle && /(tsx\s+watch|nodemon|concurrently|turbo|vite|webpack|rollup|watch)/i.test(lifecycle)) {
    hints.push(`npm_lifecycle_script=${lifecycle}`);
  }

  const event = pickEnv("npm_lifecycle_event");
  if (event && /(dev|watch|start)/i.test(event)) {
    hints.push(`npm_lifecycle_event=${event}`);
  }

  if (pickEnv("NODEMON")) hints.push("NODEMON=1");
  if (pickEnv("VSCODE_PID")) hints.push("VSCODE_PID=1");
  if (pickEnv("TSX_WATCH")) hints.push("TSX_WATCH=1");

  return hints;
}

function getParentProcessDiagnostics(ppid: number): string | null {
  if (!Number.isFinite(ppid) || ppid <= 0) return null;

  // Linux: /proc/<ppid>/cmdline
  if (process.platform !== "win32") {
    try {
      const cmdline = fs.readFileSync(`/proc/${ppid}/cmdline`, "utf8")
        .split("\u0000")
        .filter(Boolean)
        .join(" ")
        .trim();
      if (cmdline) return `ppid=${ppid} cmd=${redactSensitive(cmdline)}`;
    } catch {
      // ignore
    }
    return `ppid=${ppid}`;
  }

  // Windows: use PowerShell CIM (wmic 已逐步弃用且在部分环境不可用)
  try {
    const ps = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";

    const script = [
      `$p = Get-CimInstance Win32_Process -Filter \"ProcessId=${ppid}\";`,
      `if ($null -eq $p) { exit 0 }`,
      `$obj = [pscustomobject]@{`,
      `  ProcessId = $p.ProcessId;`,
      `  ParentProcessId = $p.ParentProcessId;`,
      `  Name = $p.Name;`,
      `  CommandLine = $p.CommandLine;`,
      `};`,
      `$obj | ConvertTo-Json -Compress;`,
    ].join(" ");

    const res = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 1500,
      windowsHide: true,
    });

    const stdout = (res.stdout || "").trim();
    if (!stdout) return `ppid=${ppid}`;
    return redactSensitive(stdout);
  } catch {
    return `ppid=${ppid}`;
  }
}

function parseIntSetting(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : undefined;
}

function resolveRunnerControlFiles(runnerRoot: string): RunnerControlFiles {
  const raw = (process.env.BRIDGE_CONTROL_DIR || "").trim();
  const controlDir = raw
    ? (path.isAbsolute(raw) ? raw : path.resolve(runnerRoot, raw))
    : path.join(runnerRoot, ".ccg", "bridge-runner");

  return {
    controlDir,
    pidFile: path.join(controlDir, "pid"),
    heartbeatFile: path.join(controlDir, "heartbeat.json"),
    stopFile: path.join(controlDir, "stop"),
    lastStopFile: path.join(controlDir, "last-stop.json"),
  };
}

function safeMkdirp(dir: string): void {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function safeWriteFile(filePath: string, text: string): void {
  try { fs.writeFileSync(filePath, text, "utf8"); } catch { /* ignore */ }
}

function safeWriteJson(filePath: string, data: unknown): void {
  try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8"); } catch { /* ignore */ }
}

function safeUnlink(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

function pickExistingPath(candidates: Array<string | undefined>, mustContainRelative: string): string | null {
  for (const root of candidates) {
    if (!root) continue;
    const full = path.join(root, mustContainRelative);
    if (fs.existsSync(full)) return root;
  }
  return null;
}

function ensureClaudeToImBuild(claudeToImRoot: string): void {
  const distContext = path.join(claudeToImRoot, "dist/lib/bridge/context.js");
  const distBridgeManager = path.join(claudeToImRoot, "dist/lib/bridge/bridge-manager.js");
  const srcBridgeManager = path.join(claudeToImRoot, "src/lib/bridge/bridge-manager.ts");

  const distMissing = !fs.existsSync(distContext) || !fs.existsSync(distBridgeManager);

  const distOlderThanSrc = (() => {
    try {
      if (!fs.existsSync(srcBridgeManager)) return false;
      if (!fs.existsSync(distBridgeManager)) return true;
      const srcStat = fs.statSync(srcBridgeManager);
      const distStat = fs.statSync(distBridgeManager);
      return srcStat.mtimeMs > distStat.mtimeMs;
    } catch {
      return false;
    }
  })();

  const distLooksOutdated = (() => {
    try {
      if (!fs.existsSync(distBridgeManager)) return true;
      const text = fs.readFileSync(distBridgeManager, "utf8");
      // 旧版 dist 会固定用 5 分钟作为默认队列超时，导致 turn 超时改成 90 分钟也不生效。
      return text.includes("bridge_session_queue_timeout_ms')) ?? 5 * 60_000");
    } catch {
      return false;
    }
  })();

  if (!distMissing && !distOlderThanSrc && !distLooksOutdated) return;

  console.log("[bridge-runner] 检测到 Claude-to-IM dist 可能过期，正在执行 npm run build...");
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const res = spawnSync(npmCmd, ["run", "build"], { cwd: claudeToImRoot, stdio: "inherit" });
  if ((res.status ?? 1) !== 0) {
    throw new Error(
      [
        `npm run build 失败（exit=${res.status ?? "unknown"}）。`,
        "请在 CLAUDE_TO_IM_ROOT 目录手动执行：",
        "  npm install",
        "  npm run build",
      ].join("\n"),
    );
  }
}

async function main() {
  const bootAt = Date.now();
  const scriptPath = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptPath);
  const runnerRoot = path.resolve(scriptDir, "..");
  const control = resolveRunnerControlFiles(runnerRoot);
  safeMkdirp(control.controlDir);

  // Load local env file (no override)
  // 支持通过命令行参数指定 env 文件，方便同时运行多个 Bot 实例：
  //   npx tsx scripts/feishu-claude-bridge.ts .env.bridge.claude
  //   npx tsx scripts/feishu-claude-bridge.ts .env.bridge.codex
  // 未指定时回退到默认的 .env.bridge.local
  const envFileName = process.argv[2] || ".env.bridge.local";
  const envFilePath = path.isAbsolute(envFileName)
    ? envFileName
    : path.join(runnerRoot, envFileName);
  loadDotEnvFile(envFilePath);
  console.log(`[bridge-runner] Env file: ${envFilePath}`);

  // ── Prevent SDK "nested session" error ──
  // When the bridge is launched from inside a Claude Code session the CLAUDECODE
  // env var leaks into the SDK child process, causing it to refuse to start.
  if (process.env.CLAUDECODE) {
    console.log("[bridge-runner] 检测到 CLAUDECODE 环境变量（嵌套会话），已清除以避免 SDK 启动失败");
    delete process.env.CLAUDECODE;
  }

  // ── Auto-detect git-bash on Windows ──
  // SDK's built-in cli.js only searches standard Git install paths.
  // If Git is installed elsewhere (e.g. F:\Git), we need to tell it explicitly.
  if (process.platform === "win32" && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    const gitBashCandidates = [
      // Derive from git executable location
      (() => {
        try {
          const gitExecPath = spawnSync("git", ["--exec-path"], { encoding: "utf8", timeout: 3000, windowsHide: true });
          if (gitExecPath.stdout) {
            // e.g. F:\Git\mingw64\libexec\git-core → F:\Git\bin\bash.exe
            const gitRoot = path.resolve(gitExecPath.stdout.trim(), "..", "..", "..");
            const candidate = path.join(gitRoot, "bin", "bash.exe");
            if (fs.existsSync(candidate)) return candidate;
          }
        } catch { /* ignore */ }
        return null;
      })(),
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ];
    for (const c of gitBashCandidates) {
      if (c && fs.existsSync(c)) {
        process.env.CLAUDE_CODE_GIT_BASH_PATH = c;
        console.log(`[bridge-runner] 自动检测 git-bash: ${c}`);
        break;
      }
    }
  }

  const claudeToImRoot = pickExistingPath(
    [
      process.env.CLAUDE_TO_IM_ROOT,
      runnerRoot,
      path.resolve(runnerRoot, "../../project/Claude-to-IM"),
      "G:\\project\\Claude-to-IM",
    ],
    "package.json",
  );

  if (!claudeToImRoot) {
    throw new Error(
      [
        "找不到 Claude-to-IM 仓库（需要可用的 dist 输出）。",
        "请设置环境变量 CLAUDE_TO_IM_ROOT 指向 Claude-to-IM 根目录，例如：",
        "  CLAUDE_TO_IM_ROOT=G:\\project\\Claude-to-IM",
        "并确保该目录已执行过 npm run build。",
      ].join("\n"),
    );
  }

  ensureClaudeToImBuild(claudeToImRoot);

  const bridgeContextMod = (await import(
    pathToFileURL(path.join(claudeToImRoot, "dist/lib/bridge/context.js")).href
  )) as BridgeContextModule;

  const bridgeManager = (await import(
    pathToFileURL(path.join(claudeToImRoot, "dist/lib/bridge/bridge-manager.js")).href
  )) as BridgeManagerModule;

  const storePath = path.join(runnerRoot, ".ccg", "claude-to-im", "bridge-store.json");
  const store = new JsonFileBridgeStore({ projectRoot: runnerRoot, dataPath: storePath });
  const permissions = new InMemoryPermissionGateway();

  const backend = (store.getSetting("bridge_llm_backend") || "claude").trim().toLowerCase();
  const keepAliveMs = parseIntSetting(store.getSetting("bridge_sse_keep_alive_ms"));

  // Codex app-server 的工作目录（cwd）会影响其读取本地配置（如 .env）以及默认工作区。
  // 默认与 bridge_default_work_dir 对齐；若未配置/无效则回退到 runnerRoot。
  const codexProjectRoot = (() => {
    const candidate = (store.getSetting("bridge_default_work_dir") || "").trim();
    if (!candidate) return runnerRoot;
    try {
      const st = fs.statSync(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      // fall through
    }
    console.log(`[bridge-runner] 警告：bridge_default_work_dir 不是有效目录，将回退到 ${runnerRoot}`);
    return runnerRoot;
  })();

  const llm = backend === "codex"
    ? new CodexAppServerLLMProvider({
        projectRoot: codexProjectRoot,
        permissions,
        codexBin: store.getSetting("bridge_codex_bin") || undefined,
        cliConfig: store.getSetting("bridge_codex_cli_config") || undefined,
        modelId: store.getSetting("bridge_codex_model_id") || undefined,
        modelHint: store.getSetting("bridge_codex_model_hint")
          || store.getSetting("bridge_default_model")
          || "gpt-5.2 xhigh",
        sandboxMode: store.getSetting("bridge_codex_sandbox_mode") || "danger-full-access",
        approvalPolicy: store.getSetting("bridge_codex_approval_policy") || "never",
        turnTimeoutMs: parseIntSetting(store.getSetting("bridge_codex_turn_timeout_ms")),
        turnIdleTimeoutMs: parseIntSetting(store.getSetting("bridge_codex_turn_idle_timeout_ms")),
        keepAliveMs,
        debug: store.getSetting("bridge_codex_debug") === "true",
      })
    : (() => {
        // Lazy import so codex 模式下不依赖 Claude SDK
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return null as any;
      })();

  // 如果不是 codex 后端，使用 Claude Code SDK
  const llmResolved = backend === "codex"
    ? llm
    : (() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return null as any;
      })();

  // NOTE: 这里用显式 if，避免对 SDK 的无条件 import
  let llmFinal: any = llmResolved;
  if (backend !== "codex") {
    const sdk = await import(
      pathToFileURL(path.join(claudeToImRoot, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs")).href
    );
    const query = (sdk as any).query as any;
    llmFinal = new ClaudeCodeLLMProvider({ query, permissions, keepAliveMs });
  }

  const appId = store.getSetting("bridge_feishu_app_id") || "";
  const appSecret = store.getSetting("bridge_feishu_app_secret") || "";
  const allowedUsers = store.getSetting("bridge_feishu_allowed_users") || "";

  if (!appId || !appSecret) {
    console.log(
      [
        "缺少飞书配置，桥接不会启动。",
        "",
        "请在当前工作目录创建 .env.bridge.local（建议加入 .gitignore），至少包含：",
        "  bridge_feishu_app_id=cli_xxx",
        "  bridge_feishu_app_secret=xxx",
        "",
        "并强烈建议限制授权用户：",
        "  bridge_feishu_allowed_users=ou_xxx",
      ].join("\n"),
    );
    return;
  } else if (!allowedUsers) {
    console.log(
      [
        "警告：未设置 bridge_feishu_allowed_users，将允许所有人通过飞书驱动本机 Claude Code。",
        "建议立即在 .env.bridge.local 中设置你的 open_id：",
        "  bridge_feishu_allowed_users=ou_xxx",
      ].join("\n"),
    );
  }

  bridgeContextMod.initBridgeContext({
    store,
    llm: llmFinal,
    permissions,
    lifecycle: {
      onBridgeStart: () => console.log("[bridge-runner] Bridge starting..."),
      onBridgeStop: () => console.log("[bridge-runner] Bridge stopped."),
    },
  });

  await bridgeManager.start();
  console.log("[bridge-runner] Status:", bridgeManager.getStatus());
  console.log("[bridge-runner] LLM backend:", backend);
  console.log(`[bridge-runner] PID=${process.pid} PPID=${process.ppid} platform=${process.platform}`);
  console.log(`[bridge-runner] Control dir: ${control.controlDir}`);

  safeWriteFile(control.pidFile, String(process.pid));

  const heartbeatMsRaw = parseIntSetting(process.env.BRIDGE_RUNNER_HEARTBEAT_MS || null);
  const heartbeatMs = heartbeatMsRaw === undefined ? 15_000 : heartbeatMsRaw;

  const stopPollMsRaw = parseIntSetting(process.env.BRIDGE_RUNNER_STOP_POLL_MS || null);
  const stopPollMs = stopPollMsRaw === undefined ? 1_000 : stopPollMsRaw;

  let shuttingDown = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let stopPollTimer: ReturnType<typeof setInterval> | null = null;

  const writeHeartbeat = (
    status: "running" | "stopping" | "stopped",
    extra: Record<string, unknown> = {},
  ) => {
    const upSec = Math.round((Date.now() - bootAt) / 1000);
    safeWriteFile(
      control.heartbeatFile,
      JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        uptimeSec: upSec,
        status,
        backend,
        ...extra,
      }),
    );
  };

  writeHeartbeat("running");

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    const upSec = Math.round((Date.now() - bootAt) / 1000);
    console.log(`[bridge-runner] Received ${signal}, stopping... (uptime=${upSec}s)`);
    writeHeartbeat("stopping", { reason: signal });

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (stopPollTimer) {
      clearInterval(stopPollTimer);
      stopPollTimer = null;
    }
    safeUnlink(control.stopFile);

    // 诊断信息：SIGINT 多数情况下来自 Ctrl+C 或父进程（watch/restart 工具）发出的终止信号。
    // 这里尽量在不泄漏敏感信息的前提下，打印一些线索，方便定位"自动中断"的真实来源。
    const hints = detectPotentialSignalSourceHints();
    if (hints.length) {
      console.log("[bridge-runner] 诊断：检测到可能的信号来源线索：");
      for (const h of hints) console.log(`  - ${h}`);
      console.log("[bridge-runner] 建议：避免用 watch 模式启动，直接运行：");
      console.log("  npx tsx scripts/feishu-claude-bridge.ts");
    }

    const parentDiag = getParentProcessDiagnostics(process.ppid);
    if (parentDiag) {
      console.log(`[bridge-runner] 诊断：父进程信息：${parentDiag}`);
    }

    safeWriteJson(control.lastStopFile, {
      ts: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      signal,
      uptimeSec: upSec,
      backend,
      hints,
      parentProcess: parentDiag,
    });

    try { await bridgeManager.stop(); } catch { /* ignore */ }
    try { (llmFinal as any).stop?.(); } catch { /* ignore */ }
    safeUnlink(control.pidFile);
    writeHeartbeat("stopped", { reason: signal });
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => writeHeartbeat("running"), heartbeatMs);
  }

  if (stopPollMs > 0) {
    stopPollTimer = setInterval(() => {
      if (!fs.existsSync(control.stopFile)) return;

      // 防误触发：若 stop 文件早于本次启动，则视为"残留文件"，直接清理。
      try {
        const st = fs.statSync(control.stopFile);
        if (st.mtimeMs + 500 < bootAt) {
          safeUnlink(control.stopFile);
          return;
        }
      } catch {
        // ignore
      }

      safeUnlink(control.stopFile);
      void shutdown("STOP_FILE");
    }, stopPollMs);
  }

  const exitAfterMs = parseInt(process.env.BRIDGE_EXIT_AFTER_MS || "", 10);
  if (Number.isFinite(exitAfterMs) && exitAfterMs > 0) {
    console.log(`[bridge-runner] Auto exit in ${exitAfterMs}ms (BRIDGE_EXIT_AFTER_MS)`);
    setTimeout(() => { void shutdown("BRIDGE_EXIT_AFTER_MS"); }, exitAfterMs);
  }
}

main().catch((err) => {
  console.error("[bridge-runner] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
