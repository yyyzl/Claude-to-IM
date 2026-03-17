import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getGitCommitMessageExamples,
  generateAutoConventionalCommitMessage,
  parseGitSlashCommandArgs,
  validateAndNormalizeConventionalCommitMessage,
} from '../../lib/bridge/internal/git-command';

describe('internal/git-command', () => {
  it('parseGitSlashCommandArgs returns auto when empty', () => {
    assert.deepStrictEqual(parseGitSlashCommandArgs(''), { kind: 'auto' });
    assert.deepStrictEqual(parseGitSlashCommandArgs('   '), { kind: 'auto' });
  });

  it('parseGitSlashCommandArgs returns help when args is help', () => {
    assert.deepStrictEqual(parseGitSlashCommandArgs('help'), { kind: 'help' });
    assert.deepStrictEqual(parseGitSlashCommandArgs('--help'), { kind: 'help' });
    assert.deepStrictEqual(parseGitSlashCommandArgs('-h'), { kind: 'help' });
  });

  it('parseGitSlashCommandArgs returns push when args is push', () => {
    assert.deepStrictEqual(parseGitSlashCommandArgs('push'), { kind: 'push' });
  });

  it('parseGitSlashCommandArgs returns commit otherwise', () => {
    assert.deepStrictEqual(parseGitSlashCommandArgs('feat: 增加测试'), { kind: 'commit', message: 'feat: 增加测试' });
  });

  it('getGitCommitMessageExamples provides conventional examples', () => {
    const examples = getGitCommitMessageExamples();
    assert.ok(examples.length >= 2);
    assert.ok(examples.some(e => e.startsWith('feat(') || e.startsWith('feat:')));
  });

  it('validateAndNormalizeConventionalCommitMessage accepts standard format', () => {
    const v = validateAndNormalizeConventionalCommitMessage('feat(bridge): 增加 /git 命令用于提交');
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.type, 'feat');
      assert.equal(v.scope, 'bridge');
      assert.equal(v.normalized, 'feat(bridge): 增加 /git 命令用于提交');
    }
  });

  it('validateAndNormalizeConventionalCommitMessage lowercases type and normalizes colon space', () => {
    const v = validateAndNormalizeConventionalCommitMessage('FEAT(bridge):增加 /git 命令');
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.normalized, 'feat(bridge): 增加 /git 命令');
    }
  });

  it('validateAndNormalizeConventionalCommitMessage accepts tolerant format type(scope) subject', () => {
    const v = validateAndNormalizeConventionalCommitMessage('fix(bridge) 修复 turn 超时');
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.normalized, 'fix(bridge): 修复 turn 超时');
    }
  });

  it('validateAndNormalizeConventionalCommitMessage rejects unknown type', () => {
    const v = validateAndNormalizeConventionalCommitMessage('feature: 增加 /git 命令');
    assert.equal(v.ok, false);
  });

  it('validateAndNormalizeConventionalCommitMessage rejects non-chinese subject', () => {
    const v = validateAndNormalizeConventionalCommitMessage('fix: align output');
    assert.equal(v.ok, false);
  });

  it('validateAndNormalizeConventionalCommitMessage rejects filler prefix', () => {
    const v = validateAndNormalizeConventionalCommitMessage('fix: 我修复了一个问题');
    assert.equal(v.ok, false);
  });

  it('validateAndNormalizeConventionalCommitMessage rejects past tense filler', () => {
    const v = validateAndNormalizeConventionalCommitMessage('fix: 修复了权限按钮');
    assert.equal(v.ok, false);
  });

  it('validateAndNormalizeConventionalCommitMessage rejects invalid scope', () => {
    const v = validateAndNormalizeConventionalCommitMessage('feat(bridge ui): 增加命令');
    assert.equal(v.ok, false);
  });

  it('generateAutoConventionalCommitMessage returns a valid message', () => {
    const msg = generateAutoConventionalCommitMessage(['src/lib/bridge/bridge-manager.ts']);
    const v = validateAndNormalizeConventionalCommitMessage(msg);
    assert.equal(v.ok, true);
  });

  it('generateAutoConventionalCommitMessage infers docs type for markdown-only changes', () => {
    const msg = generateAutoConventionalCommitMessage(['README.md', 'docs/development.zh-CN.md']);
    assert.ok(msg.startsWith('docs'));
  });

  it('generateAutoConventionalCommitMessage infers test type for test-only changes', () => {
    const msg = generateAutoConventionalCommitMessage(['src/__tests__/unit/bridge-manager.test.ts']);
    assert.ok(msg.startsWith('test'));
  });
});
