import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const scriptPath = path.resolve(process.cwd(), "scripts/restart-bridge.ps1");

describe("restart-bridge.ps1", () => {
  it("starts the bridge directly via npx.cmd instead of cmd.exe shell wrapping", () => {
    const scriptText = fs.readFileSync(scriptPath, "utf8");

    assert.match(scriptText, /-FilePath "npx\.cmd"/);
    assert.match(scriptText, /\$startArgs = @\(/);
    assert.doesNotMatch(scriptText, /-FilePath "cmd\.exe"/);
  });

  it("waits for runner heartbeat readiness before reporting startup success", () => {
    const scriptText = fs.readFileSync(scriptPath, "utf8");

    assert.match(scriptText, /\$heartbeatFile = Join-Path \$ControlDir "heartbeat\.json"/);
    assert.match(scriptText, /function Get-BridgeHeartbeatStatus/);
    assert.match(scriptText, /\$heartbeatStatus -eq "running"/);
  });

  it("clears inherited bridge_* environment variables before starting new process", () => {
    const scriptText = fs.readFileSync(scriptPath, "utf8");

    // Must clear bridge_* env vars to prevent loadDotEnvFile "no-override" policy
    // from inheriting stale values (e.g. bridge_llm_backend=codex from parent)
    assert.match(scriptText, /bridge_\*/);
    assert.match(scriptText, /clearing inherited env/);
    assert.match(scriptText, /SetEnvironmentVariable/);
  });

  it("validates heartbeat pid matches pid file (four-tuple check)", () => {
    const scriptText = fs.readFileSync(scriptPath, "utf8");

    // Must have Get-BridgeHeartbeatPid function
    assert.match(scriptText, /function Get-BridgeHeartbeatPid/);
    // Must compare heartbeat pid with pid file to detect zombie processes
    assert.match(scriptText, /heartbeatPid.*-ne.*newPid|heartbeat pid mismatch/);
  });
});
