import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const runnerScriptPath = path.join(repoRoot, "scripts", "feishu-claude-bridge.ts");
const bridgeManagerScriptPath = path.join(repoRoot, "scripts", "start-bridges.ps1");
const restartScriptPath = path.join(repoRoot, "scripts", "restart-bridge.ps1");

describe("bridge runner scripts", () => {
  it("does not keep /restart wiring in the runner entry script", () => {
    const scriptText = fs.readFileSync(runnerScriptPath, "utf8");

    assert.doesNotMatch(scriptText, /onRestartRequested/);
    assert.doesNotMatch(scriptText, /sendNotification/);
    assert.doesNotMatch(scriptText, /restart-artifacts/);
    assert.doesNotMatch(scriptText, /restart-notify\.json/);
    assert.doesNotMatch(scriptText, /restart-status\.json/);
  });

  it("does not keep restart management scripts", () => {
    const managerScriptText = fs.readFileSync(bridgeManagerScriptPath, "utf8");

    assert.equal(fs.existsSync(restartScriptPath), false);
    assert.doesNotMatch(managerScriptText, /ValidateSet\("start", "stop", "restart"\)/);
    assert.doesNotMatch(managerScriptText, /\[start\|stop\|restart\]/);
  });

  it("cleans up the legacy default bridge-runner when managing dual bridges", () => {
    const managerScriptText = fs.readFileSync(bridgeManagerScriptPath, "utf8");

    assert.match(managerScriptText, /\$cleanupOnlyBridges\s*=\s*@\(/);
    assert.match(managerScriptText, /\.ccg\/bridge-runner/);
    assert.match(managerScriptText, /\$bridgesToStop\s*=\s*@\(\$managedBridges \+ \$cleanupOnlyBridges\)/);
    assert.match(managerScriptText, /function Start-AllBridges \{[\s\S]*?Stop-AllBridges/);
  });
});
