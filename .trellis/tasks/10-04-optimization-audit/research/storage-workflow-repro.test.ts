/**
 * 审计复现：测试通过表示当前缺陷被可靠复现，并不表示这些行为正确。
 * 所有存储、Git、模型边界均显式替换成内存 fake；禁止真实进程和网络。
 */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { after, before, mock, test } from 'node:test';

const forbidden = (name: string) => (..._args: unknown[]): never => {
  throw new Error(`审计复现禁止真实外部调用：${name}`);
};

// 在加载业务模块前拦截，避免模块捕获真实 spawn/execFile 等函数。
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  mock.method(childProcess, name, forbidden(`child_process.${name}`));
}
mock.method(globalThis, 'fetch', forbidden('fetch'));
mock.method(net, 'connect', forbidden('net.connect'));
mock.method(net, 'createConnection', forbidden('net.createConnection'));
mock.method(net.Socket.prototype, 'connect', forbidden('net.Socket.connect'));
mock.method(http, 'request', forbidden('http.request'));
mock.method(http, 'get', forbidden('http.get'));
mock.method(https, 'request', forbidden('https.request'));
mock.method(https, 'get', forbidden('https.get'));
syncBuiltinESMExports();

let JsonFileBridgeStore: typeof import('../../../../scripts/claude-to-im-bridge/store.ts').JsonFileBridgeStore;
let WorkflowEngine: typeof import('../../../../src/lib/workflow/workflow-engine.ts').WorkflowEngine;
let AutoFixer: typeof import('../../../../src/lib/workflow/auto-fixer.ts').AutoFixer;
let DiffReader: typeof import('../../../../src/lib/workflow/diff-reader.ts').DiffReader;

before(async () => {
  // 确认阻断有效后才加载被测模块。
  assert.throws(() => childProcess.spawn('forbidden-model'), /禁止真实外部调用/);
  assert.throws(() => globalThis.fetch('https://invalid.example.test'), /禁止真实外部调用/);
  assert.throws(() => net.connect(1, '127.0.0.1'), /禁止真实外部调用/);
  ({ JsonFileBridgeStore } = await import('../../../../scripts/claude-to-im-bridge/store.ts'));
  ({ WorkflowEngine } = await import('../../../../src/lib/workflow/workflow-engine.ts'));
  ({ AutoFixer } = await import('../../../../src/lib/workflow/auto-fixer.ts'));
  ({ DiffReader } = await import('../../../../src/lib/workflow/diff-reader.ts'));
});

after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

test('复现 SW-1：损坏 JSON 静默空载，下一次保存覆盖唯一存储', { timeout: 5_000 }, async (t) => {
  const fakePath = 'memory-only-store.json';
  let written = '';
  t.mock.method(fs, 'existsSync', (target: unknown) => {
    assert.equal(target, fakePath);
    return true;
  });
  t.mock.method(fs, 'readFileSync', (target: unknown) => {
    assert.equal(target, fakePath);
    return '{"sessions":{"previous":{"id":"previous"}}';
  });
  t.mock.method(fs, 'writeFileSync', (target: unknown, content: unknown) => {
    assert.equal(target, fakePath);
    assert.equal(typeof content, 'string');
    written = content as string;
  });
  t.mock.method(fs, 'mkdirSync', (target: unknown) => {
    assert.equal(target, '.');
  });

  const store = new JsonFileBridgeStore({ projectRoot: '.', dataPath: fakePath });
  assert.equal(store.getSession('previous'), null);
  const session = store.createSession('synthetic', 'fake-model');
  await new Promise(resolve => setTimeout(resolve, 260));

  assert.deepEqual(Object.keys(JSON.parse(written).sessions), [session.id]);
});

test('复现 SW-2：进程失联留下 running 时，恢复入口拒绝执行', { timeout: 5_000 }, async () => {
  const fakeStore = { getMeta: async () => ({ status: 'running' }) };
  const fakeInvoker = {
    invokeCodex: forbidden('未预期的 fake Codex 调用'),
    invokeClaude: forbidden('未预期的 fake Claude 调用'),
  };
  type EngineDependencies = ConstructorParameters<typeof WorkflowEngine>;
  const dependencies = [fakeStore, {}, {}, fakeInvoker, {}, {}, {}, {}, {}] as unknown as EngineDependencies;
  const engine = new WorkflowEngine(...dependencies);
  await assert.rejects(() => engine.resume('synthetic-crash-run'), /Cannot resume.*running/);
});

test('复现 SW-3：非 HEAD 范围的 diff 混入当前 HEAD 正文', { timeout: 5_000 }, async () => {
  const calls: string[][] = [];
  const reader = new DiffReader('G:/memory-only-repository');
  const fakeGit = async (args: string[]): Promise<{ stdout: string }> => {
    calls.push(args);
    if (args[0] === 'rev-parse') {
      return { stdout: args[1] === '--is-inside-work-tree' ? 'true' : 'CURRENT_HEAD' };
    }
    if (args[0] === 'diff' && args.includes('--name-status')) return { stdout: 'M\tsrc/a.ts' };
    if (args[0] === 'diff' && args.includes('--numstat')) return { stdout: '1\t1\tsrc/a.ts' };
    if (args[0] === 'diff') {
      return { stdout: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+review-target' };
    }
    if (args[0] === 'ls-tree') return { stdout: '100644 blob aaaaaaaa\tsrc/a.ts' };
    if (args[0] === 'show') return { stdout: 'CURRENT_HEAD_CONTENT' };
    throw new Error(`未预期的 fake git 参数：${args.join(' ')}`);
  };
  const seam = reader as unknown as { git: typeof fakeGit };
  seam.git = fakeGit;
  assert.equal(seam.git, fakeGit);

  const snapshot = await reader.createSnapshot({ type: 'commit_range', base_ref: 'BASE', head_ref: 'REVIEW_TARGET' });
  assert.ok(calls.some(args => args.includes('BASE..REVIEW_TARGET')));
  assert.ok(calls.some(args => args[0] === 'ls-tree' && args[1] === 'HEAD'));
  assert.equal(snapshot.changed_files[0].content, 'CURRENT_HEAD_CONTENT');
});

test('复现 SW-5：无关 diff 计为修复成功且提交预览多取一代', { timeout: 5_000 }, async () => {
  const fixer = new AutoFixer('G:/memory-only-repository', {} as InstanceType<typeof WorkflowEngine>);
  const gitCalls: string[][] = [];
  let invocation = 0;
  const fakeModel = {
    invokeCodex: async () => {
      invocation++;
      if (invocation === 1) throw new Error('synthetic model failure with dirty worktree');
      return 'DONE';
    },
  };
  const fakeCreateWorktree = async () => {};
  const fakeGit = async (_cwd: string, args: string[]) => {
    gitCalls.push(args);
    return { stdout: args[1] === '--stat' ? 'unrelated.ts | 1 +' : '' };
  };
  const seams = fixer as unknown as {
    store: { loadLedger: () => Promise<unknown> };
    modelInvoker: typeof fakeModel;
    createWorktree: typeof fakeCreateWorktree;
    git: typeof fakeGit;
  };
  seams.store = { loadLedger: async () => ({ issues: [
    { id: 'A', status: 'accepted', fix_instruction: 'synthetic', source_file: 'a.ts', description: 'a' },
    { id: 'B', status: 'accepted', fix_instruction: 'synthetic', source_file: 'b.ts', description: 'b' },
  ] }) };
  seams.modelInvoker = fakeModel;
  seams.createWorktree = fakeCreateWorktree;
  seams.git = fakeGit;
  assert.equal(seams.modelInvoker, fakeModel);
  assert.equal(seams.createWorktree, fakeCreateWorktree);
  assert.equal(seams.git, fakeGit);

  const result = await fixer.applyFixes('synthetic-run');
  assert.equal(result.fixedCount, 1);
  assert.deepEqual(result.fixedIssueIds, ['B']);
  assert.deepEqual(result.failedIssueIds, ['A']);
  assert.equal(gitCalls.filter(args => args[0] === 'commit').length, 1);
  assert.ok(gitCalls.some(args => args[0] === 'add' && args[1] === '-A'));
  assert.ok(gitCalls.some(args => args[0] === 'diff' && args[1] === 'HEAD~2'));
});
