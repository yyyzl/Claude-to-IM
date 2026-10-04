import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { buildTurnSandboxPolicy, resolveCodexBinary, selectCodexEffort, selectCodexModel } from '../scripts/claude-to-im-bridge/codex-utils.ts';
import type { CodexModelListItem } from '../scripts/claude-to-im-bridge/codex-utils.ts';

function catalogModel(overrides: Partial<CodexModelListItem> = {}): CodexModelListItem {
  return { id: 'model', model: 'model', displayName: 'Model', isDefault: false,
    defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }, { reasoningEffort: 'ultra', description: '' }],
    serviceTiers: [], defaultServiceTier: null, ...overrides };
}

test('sandbox 使用0.160协议字段', () => {
  assert.deepEqual(buildTurnSandboxPolicy('danger-full-access'), { type: 'dangerFullAccess' });
  assert.deepEqual(buildTurnSandboxPolicy('workspace-write'), { type: 'workspaceWrite' });
  assert.deepEqual(buildTurnSandboxPolicy('read-only'), { type: 'readOnly' });
  assert.throws(() => buildTurnSandboxPolicy('unknown'));
});
test('目录默认优先，显式不存在的模型报错，不按型号字符串猜测', () => {
  const models = [catalogModel({ id: 'default-id', model: 'model-current', isDefault: true }), catalogModel({ id: 'gpt-99' }), catalogModel({ id: 'hidden', hidden: true })];
  assert.equal(selectCodexModel(models)?.id, 'default-id');
  assert.equal(selectCodexModel(models, { explicitId: 'model-current' })?.id, 'default-id');
  assert.throws(() => selectCodexModel(models, { explicitId: 'missing' }), /missing/);
  assert.throws(() => selectCodexModel(models, { explicitId: 'hidden' }), /hidden/);
});
test('effort来自模型能力列表而非固定枚举或型号后缀', () => {
  const model = catalogModel();
  assert.equal(selectCodexEffort(model), 'high');
  assert.equal(selectCodexEffort(model, 'model ultra'), 'ultra');
  assert.throws(() => selectCodexEffort(model, 'model xhigh'), /不支持/);
});
test('显式运行时优先，默认解析项目固定的JS入口而不是PATH全局安装', () => {
  assert.equal(resolveCodexBinary('C:\\custom\\codex.cmd'), 'C:\\custom\\codex.cmd');
  const binary = resolveCodexBinary(undefined, process.cwd());
  assert.equal(path.isAbsolute(binary), true);
  assert.match(binary.replaceAll('\\', '/'), /node_modules\/@openai\/codex\/bin\/codex\.js$/);
});
test('目标cwd没有node_modules仍使用桥接安装目录的固定运行时', () => {
  const oldCwd = process.cwd();
  const expected = resolveCodexBinary();
  try {
    process.chdir(os.tmpdir());
    assert.equal(resolveCodexBinary(), expected);
  } finally { process.chdir(oldCwd); }
});
