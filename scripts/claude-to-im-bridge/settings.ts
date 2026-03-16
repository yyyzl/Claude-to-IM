import fs from "node:fs";

function parseDotEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    const inner = trimmed.slice(1, -1);
    return inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  }
  return trimmed;
}

export function loadDotEnvFile(filePath: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const cleaned = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const eq = cleaned.indexOf("=");
    if (eq <= 0) continue;

    const key = cleaned.slice(0, eq).trim();
    const rawValue = cleaned.slice(eq + 1);
    if (!key) continue;

    if (env[key] !== undefined) continue; // 不覆盖外部传入的环境变量
    env[key] = parseDotEnvValue(rawValue);
  }
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return env[key] ?? env[key.toUpperCase()];
}

/**
 * 解析 Claude-to-IM Bridge 的设置值（用于 BridgeStore.getSetting）。
 *
 * 设计目标：
 * - 尽量兼容文档/旧 key（例如 bridge_default_cwd / bridge_model）
 * - 在 standalone runner 场景下提供合理默认值（例如默认启用 feishu）
 */
export function resolveBridgeSetting(
  key: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const direct = readEnv(env, key);
  if (direct !== undefined) return direct;

  // 兼容文档里出现但当前代码未读取的 key
  if (key === "bridge_default_work_dir") {
    const v = readEnv(env, "bridge_default_cwd");
    if (v !== undefined) return v;
    return projectRoot;
  }

  if (key === "bridge_default_model") {
    const v = readEnv(env, "bridge_model");
    if (v !== undefined) return v;
    return "";
  }

  if (key === "default_model") {
    // conversation-engine.ts 会读 default_model
    const v = readEnv(env, "default_model")
      ?? readEnv(env, "bridge_default_model")
      ?? readEnv(env, "bridge_model");
    return v !== undefined ? v : null;
  }

  if (key === "remote_bridge_enabled") {
    // runner 默认启用（用户手动运行脚本即表示启用）
    return "true";
  }

  if (key === "bridge_feishu_enabled") {
    return "true";
  }

  if (key === "bridge_feishu_domain") {
    return "feishu";
  }

  if (key === "bridge_feishu_input_debounce_ms") {
    // 默认给飞书开一个短合并窗口：用户经常会“连发两句补充说明”，
    // 合并后可以减少一次完整 turn，并让模型一次性看全上下文。
    //
    // 如需关闭：在 .env.bridge.local 显式设置为 0。
    return "1200";
  }

  return null;
}
