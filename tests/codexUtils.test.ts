import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTurnSandboxPolicy, selectCodexEffort, selectCodexModel } from '../scripts/claude-to-im-bridge/codex-utils.ts';
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
