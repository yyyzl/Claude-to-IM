import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildTurnSandboxPolicy, resolveCodexBinary, selectCodexModel } from "../scripts/claude-to-im-bridge/codex-utils.ts";

test("buildTurnSandboxPolicy: danger-full-access", () => {
  assert.deepEqual(buildTurnSandboxPolicy("danger-full-access"), { type: "dangerFullAccess" });
});

test("buildTurnSandboxPolicy: workspace-write", () => {
  assert.deepEqual(buildTurnSandboxPolicy("workspace-write"), {
    type: "workspaceWrite",
    readOnlyAccess: { type: "fullAccess" },
  });
});

test("selectCodexModel: explicitId 优先", () => {
  const models = [
    { id: "gpt-5.2-codex", isDefault: true },
    { id: "gpt-5.2-codex-xhigh" },
  ];
  const selected = selectCodexModel(models, { explicitId: "gpt-5.2-codex-xhigh", hint: "gpt-5.2" });
  assert.equal(selected?.id, "gpt-5.2-codex-xhigh");
});

test("selectCodexModel: hint 倾向 xhigh", () => {
  const models = [
    { id: "gpt-5.2-codex", isDefault: true },
    { id: "gpt-5.2-codex-xhigh" },
    { id: "gpt-5.1-codex" },
  ];
  const selected = selectCodexModel(models, { hint: "gpt-5.2 xhigh" });
  assert.equal(selected?.id, "gpt-5.2-codex-xhigh");
});

test("selectCodexModel: hint 倾向 gpt-5.2", () => {
  const models = [
    { id: "gpt-5.2-codex", isDefault: true },
    { id: "gpt-5.1-codex" },
  ];
  const selected = selectCodexModel(models, { hint: "gpt-5.2" });
  assert.equal(selected?.id, "gpt-5.2-codex");
});

test("resolveCodexBinary: userSpecified 优先", () => {
  assert.equal(resolveCodexBinary("C:\\custom\\codex.cmd"), "C:\\custom\\codex.cmd");
});

test("resolveCodexBinary: 从 PATH 解析 (无全局依赖)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bin-"));
  const oldPath = process.env.PATH;
  try {
    if (process.platform === "win32") {
      const fake = path.join(tmp, "codex.cmd");
      fs.writeFileSync(fake, "@echo off\r\nexit /b 0\r\n", "utf8");
      process.env.PATH = tmp;
      const resolved = resolveCodexBinary();
      assert.equal(path.resolve(resolved), path.resolve(fake));
    } else {
      const fake = path.join(tmp, "codex");
      fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", "utf8");
      try { fs.chmodSync(fake, 0o755); } catch { /* ignore */ }
      process.env.PATH = tmp;
      const resolved = resolveCodexBinary();
      assert.equal(path.resolve(resolved), path.resolve(fake));
    }
  } finally {
    process.env.PATH = oldPath;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
