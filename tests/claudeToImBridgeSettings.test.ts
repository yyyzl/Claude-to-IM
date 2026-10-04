import assert from "node:assert/strict";
import test from "node:test";

import { resolveBridgeSetting } from "../scripts/claude-to-im-bridge/settings.ts";

test("resolveBridgeSetting: bridge_default_work_dir 回退到 bridge_default_cwd 再回退到项目目录", () => {
  const projectRoot = "G:\\RustProject\\push-2-talk";

  assert.equal(resolveBridgeSetting("bridge_default_work_dir", projectRoot, {}), projectRoot);
  assert.equal(
    resolveBridgeSetting("bridge_default_work_dir", projectRoot, { bridge_default_cwd: "C:\\x" }),
    "C:\\x",
  );
  assert.equal(
    resolveBridgeSetting("bridge_default_work_dir", projectRoot, { bridge_default_work_dir: "D:\\y" }),
    "D:\\y",
  );
});

test("resolveBridgeSetting: remote_bridge_enabled / bridge_feishu_enabled 默认启用", () => {
  const projectRoot = "G:\\RustProject\\push-2-talk";
  assert.equal(resolveBridgeSetting("remote_bridge_enabled", projectRoot, {}), "true");
  assert.equal(resolveBridgeSetting("bridge_feishu_enabled", projectRoot, {}), "true");
});

test("resolveBridgeSetting: default_model 回退到 bridge_default_model / bridge_model", () => {
  const projectRoot = "G:\\RustProject\\push-2-talk";
  assert.equal(resolveBridgeSetting("default_model", projectRoot, { bridge_default_model: "claude-x" }), "claude-x");
  assert.equal(resolveBridgeSetting("default_model", projectRoot, { bridge_model: "claude-y" }), "claude-y");
});

test("Codex 的默认模型不继承 Claude 设置，但保留显式通用覆盖", () => {
  const env = { bridge_llm_backend: 'codex', bridge_default_model: 'claude-x', bridge_model: 'claude-y' };
  assert.equal(resolveBridgeSetting('default_model', 'G:/target', env), null);
  assert.equal(resolveBridgeSetting('default_model', 'G:/target', { ...env, bridge_codex_model_hint: 'codex-x high' }), 'codex-x high');
  assert.equal(resolveBridgeSetting('default_model', 'G:/target', { ...env, bridge_codex_model_id: 'codex-y' }), 'codex-y');
  assert.equal(resolveBridgeSetting('default_model', 'G:/target', { ...env, default_model: 'explicit-model' }), 'explicit-model');
});

