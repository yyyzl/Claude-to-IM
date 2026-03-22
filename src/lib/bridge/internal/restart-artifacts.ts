import fs from "node:fs";
import path from "node:path";

export type RestartArtifactPaths = {
  restartNotifyFile: string;
  restartStatusFile: string;
  restartDebugFile: string;
  stdoutLog: string;
  stderrLog: string;
};

export type RestartNotifyPayload = {
  channelType: string;
  chatId: string;
  ts?: string;
};

export type RestartStatusPayload = {
  status: "failed";
  stage: string;
  message: string;
  ts: string;
  debugLog?: string;
  stdoutLog?: string;
  stderrLog?: string;
  details?: string[];
};

export type RestartArtifacts = {
  notify: RestartNotifyPayload | null;
  status: RestartStatusPayload | null;
  paths: RestartArtifactPaths;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJsonFile(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return list.length > 0 ? list : undefined;
}

export function getRestartArtifactPaths(controlDir: string): RestartArtifactPaths {
  return {
    restartNotifyFile: path.join(controlDir, "restart-notify.json"),
    restartStatusFile: path.join(controlDir, "restart-status.json"),
    restartDebugFile: path.join(controlDir, "restart-debug.log"),
    stdoutLog: path.join(controlDir, "stdout.log"),
    stderrLog: path.join(controlDir, "stderr.log"),
  };
}

export function parseRestartNotifyPayload(raw: unknown): RestartNotifyPayload | null {
  if (!isRecord(raw)) return null;
  const channelType = readOptionalString(raw.channelType);
  const chatId = readOptionalString(raw.chatId);
  if (!channelType || !chatId) return null;

  return {
    channelType,
    chatId,
    ts: readOptionalString(raw.ts),
  };
}

export function parseRestartStatusPayload(raw: unknown): RestartStatusPayload | null {
  if (!isRecord(raw)) return null;
  if (raw.status !== "failed") return null;

  const stage = readOptionalString(raw.stage);
  const message = readOptionalString(raw.message);
  const ts = readOptionalString(raw.ts);
  if (!stage || !message || !ts) return null;

  return {
    status: "failed",
    stage,
    message,
    ts,
    debugLog: readOptionalString(raw.debugLog),
    stdoutLog: readOptionalString(raw.stdoutLog),
    stderrLog: readOptionalString(raw.stderrLog),
    details: readOptionalStringArray(raw.details),
  };
}

export function loadRestartArtifacts(controlDir: string): RestartArtifacts {
  const paths = getRestartArtifactPaths(controlDir);
  return {
    notify: parseRestartNotifyPayload(readJsonFile(paths.restartNotifyFile)),
    status: parseRestartStatusPayload(readJsonFile(paths.restartStatusFile)),
    paths,
  };
}

export function formatRestartStatusNotification(opts: {
  backend: string;
  pid: number;
  status: RestartStatusPayload | null;
}): string {
  const { backend, pid, status } = opts;
  if (!status) {
    return `✅ Bridge 已重启成功（backend=${backend}, pid=${pid}）`;
  }

  const lines = [
    `⚠️ 上一次 /restart 未完成，当前 Bridge 已恢复运行（backend=${backend}, pid=${pid}）`,
    `失败阶段：${status.stage}`,
    `错误：${status.message}`,
  ];

  if (status.debugLog) {
    lines.push(`调试日志：${path.basename(status.debugLog)}`);
  }
  if (status.stdoutLog) {
    lines.push(`stdout：${path.basename(status.stdoutLog)}`);
  }
  if (status.stderrLog) {
    lines.push(`stderr：${path.basename(status.stderrLog)}`);
  }
  if (status.details && status.details.length > 0) {
    lines.push(`线索：${status.details.join(" | ")}`);
  }

  return lines.join("\n");
}
