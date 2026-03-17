/**
 * Feishu ↔ Claude Code Bridge Runner (for this repo)
 *
 * 目标：在不改 Claude-to-IM 核心代码的情况下，把飞书消息接到 Claude Code SDK，
 *      让你能在 IM 里远程驱动本地项目（默认工作目录=本仓库根目录）。
 *
 * 运行：
 *   npx tsx scripts/feishu-claude-bridge.ts
 *
 * 配置（建议放到“中央 runner 目录”（本仓库根目录）下的 .env.bridge.local）：
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

function parseIntSetting(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : undefined;
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
  const scriptPath = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptPath);
  const runnerRoot = path.resolve(scriptDir, "..");

  // Load local env file (no override)
  // 约定：仅使用“中央 runner 目录”的 .env.bridge.local，避免多项目间互相覆盖/漂移。
  // - 配置集中：一台机器只维护一份 bot 凭据/默认模型等
  // - 目标工作目录通过 bridge_default_work_dir 指向要操作的项目
  loadDotEnvFile(path.join(runnerRoot, ".env.bridge.local"));

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

  const shutdown = async (signal: string) => {
    console.log(`[bridge-runner] Received ${signal}, stopping...`);
    try { await bridgeManager.stop(); } catch { /* ignore */ }
    try { (llmFinal as any).stop?.(); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

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
