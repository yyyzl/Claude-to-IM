import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatRestartStatusNotification,
  getRestartArtifactPaths,
  loadRestartArtifacts,
  type RestartStatusPayload,
} from "../../lib/bridge/internal/restart-artifacts";

describe("restart-artifacts", () => {
  let controlDir = "";

  beforeEach(() => {
    controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-restart-"));
  });

  it("loads restart notify and failure status from control dir", () => {
    const paths = getRestartArtifactPaths(controlDir);
    fs.writeFileSync(paths.restartNotifyFile, JSON.stringify({
      channelType: "feishu",
      chatId: "chat-1",
      ts: "2026-03-22T05:01:02.224Z",
    }), "utf8");
    fs.writeFileSync(paths.restartStatusFile, JSON.stringify({
      status: "failed",
      stage: "start_process",
      message: "未检测到新进程 PID",
      ts: "2026-03-22T05:01:40.000Z",
      debugLog: paths.restartDebugFile,
      stdoutLog: paths.stdoutLog,
      stderrLog: paths.stderrLog,
    }), "utf8");

    const artifacts = loadRestartArtifacts(controlDir);

    assert.equal(artifacts.notify?.channelType, "feishu");
    assert.equal(artifacts.notify?.chatId, "chat-1");
    assert.equal(artifacts.status?.status, "failed");
    assert.equal(artifacts.status?.stage, "start_process");
    assert.equal(artifacts.status?.debugLog, paths.restartDebugFile);
  });

  it("formats failure notification with debug file hints", () => {
    const status: RestartStatusPayload = {
      status: "failed",
      stage: "start_process",
      message: "未检测到新进程 PID",
      ts: "2026-03-22T05:01:40.000Z",
      debugLog: "G:\\project\\Claude-to-IM\\.ccg\\bridge-claude\\restart-debug.log",
      stdoutLog: "G:\\project\\Claude-to-IM\\.ccg\\bridge-claude\\stdout.log",
      stderrLog: "G:\\project\\Claude-to-IM\\.ccg\\bridge-claude\\stderr.log",
    };

    const text = formatRestartStatusNotification({
      backend: "claude",
      pid: 12345,
      status,
    });

    assert.match(text, /上一次 \/restart 未完成/);
    assert.match(text, /backend=claude, pid=12345/);
    assert.match(text, /失败阶段：start_process/);
    assert.match(text, /错误：未检测到新进程 PID/);
    assert.match(text, /restart-debug\.log/);
    assert.match(text, /stdout\.log/);
    assert.match(text, /stderr\.log/);
  });

  it("formats success notification when no failure status exists", () => {
    const text = formatRestartStatusNotification({
      backend: "claude",
      pid: 54321,
      status: null,
    });

    assert.equal(text, "✅ Bridge 已重启成功（backend=claude, pid=54321）");
  });
});
