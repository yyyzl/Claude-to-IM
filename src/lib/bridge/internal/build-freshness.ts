import fs from "node:fs";
import path from "node:path";

function safeStatMtimeMs(targetPath: string): number {
  try {
    return fs.statSync(targetPath).mtimeMs;
  } catch {
    return 0;
  }
}

function walkLatestMtimeMs(targetPath: string): number {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return 0;
  }

  if (!stat.isDirectory()) return stat.mtimeMs;

  let latest = 0;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    latest = Math.max(latest, walkLatestMtimeMs(path.join(targetPath, entry.name)));
  }
  return latest || stat.mtimeMs;
}

export function isClaudeToImDistStale(claudeToImRoot: string): boolean {
  const distContext = path.join(claudeToImRoot, "dist/lib/bridge/context.js");
  const distBridgeManager = path.join(claudeToImRoot, "dist/lib/bridge/bridge-manager.js");

  if (!fs.existsSync(distContext) || !fs.existsSync(distBridgeManager)) {
    return true;
  }

  const latestSrc = Math.max(
    walkLatestMtimeMs(path.join(claudeToImRoot, "src/lib")),
    safeStatMtimeMs(path.join(claudeToImRoot, "package.json")),
    safeStatMtimeMs(path.join(claudeToImRoot, "tsconfig.build.json")),
  );
  const latestDist = walkLatestMtimeMs(path.join(claudeToImRoot, "dist/lib"));

  if (latestSrc > latestDist) {
    return true;
  }

  try {
    const text = fs.readFileSync(distBridgeManager, "utf8");
    // 旧版 dist 会固定用 5 分钟作为默认队列超时，导致 turn 超时改成 90 分钟也不生效。
    return text.includes("bridge_session_queue_timeout_ms')) ?? 5 * 60_000");
  } catch {
    return true;
  }
}
