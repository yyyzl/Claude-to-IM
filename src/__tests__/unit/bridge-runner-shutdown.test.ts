import { it } from 'node:test';
import assert from 'node:assert/strict';
import { drainAndFlush } from '../../../scripts/claude-to-im-bridge/shutdown.js';

it('桥接停止挂起时仍在有界时间内关闭模型和保存存储', async () => {
  const calls: string[] = [];
  const failures = await drainAndFlush({
    stopBridge: () => new Promise(() => {}),
    stopRuntime: () => { calls.push('runtime'); },
    closeStore: async () => { calls.push('store'); },
  }, 5);
  assert.deepEqual(calls, ['runtime', 'store']);
  assert.match(failures[0], /bridge stop timeout/);
});

it('保存失败和保存挂起都返回可观测的失败结果', async () => {
  for (const closeStore of [async () => { throw new Error('synthetic disk failure'); }, () => new Promise<void>(() => {})]) {
    const failures = await drainAndFlush({ stopBridge: async () => {}, stopRuntime: () => {}, closeStore }, 5);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^store:/);
  }
});
