import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { AutoFixer } from '../../lib/workflow/auto-fixer.js';
import { DiffReader } from '../../lib/workflow/diff-reader.js';
import { WorkflowStore } from '../../lib/workflow/workflow-store.js';
import { WorkflowEngine } from '../../lib/workflow/workflow-engine.js';
import { acquireRunLock } from '../../lib/workflow/run-lock.js';
import { DEFAULT_CONFIG } from '../../lib/workflow/types.js';
import type { WorkflowMeta, ReviewSnapshot } from '../../lib/workflow/types.js';
import type { ModelInvokerOptions } from '../../lib/workflow/model-invoker.js';
import { ModelInvoker } from '../../lib/workflow/model-invoker.js';
import { PackBuilder } from '../../lib/workflow/pack-builder.js';
import { ContextCompressor } from '../../lib/workflow/context-compressor.js';
import { PromptAssembler } from '../../lib/workflow/prompt-assembler.js';
import { TerminationJudge } from '../../lib/workflow/termination-judge.js';
import { JsonParser } from '../../lib/workflow/json-parser.js';
import { IssueMatcher } from '../../lib/workflow/issue-matcher.js';
import { PatchApplier } from '../../lib/workflow/patch-applier.js';
import { DecisionValidator } from '../../lib/workflow/decision-validator.js';
import { TimeoutError } from '../../lib/workflow/types.js';

const BASE = 'a'.repeat(40), TREE = 'b'.repeat(40), NEXT = 'c'.repeat(40);
const snapshot: ReviewSnapshot = {
  created_at: '2026-01-01', head_commit: BASE, head_tree: TREE, base_ref: BASE,
  scope: { type: 'staged' }, diff: 'synthetic', changed_files: [], excluded_files: [],
  files: [{ path: 'src/a.ts', blob_sha: TREE, change_type: 'modified', language: 'typescript' },
    { path: 'src/b.ts', blob_sha: TREE, change_type: 'modified', language: 'typescript' }],
};

function fakeFixer(options: { changes?: string; failModel?: boolean; noBaseline?: boolean; twoGroups?: boolean; commitFiles?: string; commitParent?: string; headTree?: string } = {}) {
  const fixer = new AutoFixer(path.resolve('synthetic-repo'), {} as WorkflowEngine);
  const commands: string[][] = [], modelCalls: ModelInvokerOptions[] = [];
  const artifacts = new Map<string, string>();
  let head = BASE, parent = BASE;
  const seams = fixer as unknown as {
    store: Pick<WorkflowStore, 'loadLedger' | 'loadSnapshot' | 'saveRunArtifact'>;
    modelInvoker: { invokeCodex(prompt: string, options: ModelInvokerOptions): Promise<string> };
    git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
    validateTarget(cwd: string, file: string): Promise<void>;
  };
  seams.store = {
    loadLedger: async () => ({ run_id: 'run', issues: (options.twoGroups ? ['a', 'b'] : ['a']).map(name => ({
      id: name, status: 'accepted', fix_instruction: 'synthetic fix', source_file: `src/${name}.ts`,
    })) } as Awaited<ReturnType<WorkflowStore['loadLedger']>>),
    loadSnapshot: async () => options.noBaseline ? { ...snapshot, head_tree: undefined } : snapshot,
    saveRunArtifact: async (_id, name, content) => { artifacts.set(name, content); },
  };
  seams.modelInvoker = { invokeCodex: async (_prompt, params) => {
    modelCalls.push(params);
    if (options.failModel) throw new Error('synthetic model failure');
    return '```ts\npartial snippet\n```';
  } };
  seams.validateTarget = async () => {};
  seams.git = async (_cwd, args) => {
    commands.push(args);
    if (args[0] === 'rev-parse') return { stdout: args[1] === 'HEAD' ? head : args[1] === `${BASE}^{tree}` ? (options.headTree ?? TREE) : TREE, stderr: '' };
    if (args[0] === 'write-tree') return { stdout: TREE, stderr: '' };
    if (args[0] === 'rev-list') return { stdout: `${NEXT} ${options.commitParent ?? parent}`, stderr: '' };
    if (args[0] === 'diff-tree') return { stdout: options.commitFiles ?? 'src/a.ts\0', stderr: '' };
    if (args[0] === 'cat-file') return { stdout: 'tree', stderr: '' };
    if (args[0] === 'commit-tree') return { stdout: 'd'.repeat(40), stderr: '' };
    if (args[0] === 'worktree') head = args.at(-1)!;
    if (args[0] === 'commit') { parent = head; head = NEXT; }
    if (args[0] === 'diff' && args.includes('--name-only')) return { stdout: options.changes ?? 'src/a.ts\0', stderr: '' };
    if (args[0] === 'diff' && args.includes('--binary')) return { stdout: head === BASE ? '' : 'synthetic exact committed patch', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { fixer, commands, modelCalls, artifacts, setHead: (value: string) => { head = value; } };
}

it('修复候选使用冻结基线和实际提交范围，不把代码块当整文件，也不假报验证成功', async () => {
  const fake = fakeFixer();
  const result = await fake.fixer.applyFixes('run');
  assert.deepEqual(result.proposedIssueIds, ['a']);
  assert.equal(result.fixedCount, 0);
  assert.deepEqual(result.commits, [NEXT]);
  assert.equal(fake.modelCalls[0].cwd, result.worktreePath);
  assert.equal(fake.commands.find(c => c[0] === 'worktree')?.at(-1), BASE);
  assert.deepEqual(fake.commands.find(c => c.includes('--binary')), ['diff', '--binary', BASE, NEXT, '--']);
  assert.ok([...fake.artifacts.keys()].some(name => name.endsWith('.patch')));
});

it('相同 run 重试创建不同 attempt，不删除既有分支或工作树', async () => {
  const one = fakeFixer(), two = fakeFixer();
  const a = await one.fixer.applyFixes('run'), b = await two.fixer.applyFixes('run');
  assert.notEqual(a.worktreePath, b.worktreePath);
  assert.notEqual(a.worktreeBranch, b.worktreeBranch);
  assert.ok([...one.commands, ...two.commands].every(c => !c.includes('--force') && !c.includes('-D') && !c.includes('remove')));
});

it('未提交审查状态通过冻结 tree 重建基线，候选范围不包含原审查改动', async () => {
  const fake = fakeFixer({ headTree: 'e'.repeat(40) });
  const result = await fake.fixer.applyFixes('run');
  assert.equal(result.fixBaseSha, 'd'.repeat(40));
  assert.deepEqual(fake.commands.find(command => command[0] === 'commit-tree')?.slice(0, 4), ['commit-tree', TREE, '-p', BASE]);
  assert.equal(fake.commands.find(command => command[0] === 'worktree')?.at(-1), result.fixBaseSha);
  assert.deepEqual(fake.commands.find(command => command.includes('--binary')), ['diff', '--binary', result.fixBaseSha, NEXT, '--']);
});

it('无法重建旧快照时，在启动模型或工作树前拒绝', async () => {
  const fake = fakeFixer({ noBaseline: true });
  await assert.rejects(fake.fixer.applyFixes('run'), /冻结 tree/);
  assert.equal(fake.modelCalls.length, 0);
  assert.equal(fake.commands.length, 0);
});

it('无关文件修改不会被算作修复候选，失败后不继续提交其他组', async () => {
  const fake = fakeFixer({ changes: 'unrelated.ts\0', twoGroups: true });
  const result = await fake.fixer.applyFixes('run');
  assert.deepEqual(result.failedIssueIds, ['a']);
  assert.deepEqual(result.skippedIssueIds, ['b']);
  assert.deepEqual(result.proposedIssueIds, []);
  assert.equal(fake.modelCalls.length, 1);
  assert.equal(fake.commands.some(c => c[0] === 'add' || c[0] === 'commit'), false);
});

it('模型仅返回代码片段但没有目标变更时不会写入文件', async () => {
  const fake = fakeFixer({ changes: '' });
  const result = await fake.fixer.applyFixes('run');
  assert.equal(result.success, false);
  assert.equal(fake.commands.some(c => c[0] === 'add'), false);
});

it('显式验证失败保留现场且不提交，验证通过才计为已验证修复', async () => {
  const fail = fakeFixer();
  const failed = await fail.fixer.applyFixes('run', { validate: async () => ({ passed: false, summary: 'synthetic failure' }) });
  assert.equal(failed.fixedCount, 0);
  assert.equal(fail.commands.some(c => c[0] === 'commit'), false);
  const pass = await fakeFixer().fixer.applyFixes('run', { validate: async () => ({ passed: true, summary: 'target regression passed' }) });
  assert.equal(pass.fixedCount, 1);
});

it('验证脚本修改 HEAD 或提交钩子夹带其他文件时，不把提交计入候选', async () => {
  const validation = fakeFixer();
  const moved = await validation.fixer.applyFixes('run', { validate: async () => {
    validation.setHead(NEXT); return { passed: true, summary: 'synthetic' };
  } });
  assert.deepEqual(moved.proposedIssueIds, []);
  assert.equal(validation.commands.some(command => command[0] === 'commit'), false);
  for (const options of [{ commitFiles: 'src/a.ts\0other.ts\0' }, { commitParent: 'd'.repeat(40) }]) {
    const result = await fakeFixer(options).fixer.applyFixes('run');
    assert.deepEqual(result.proposedIssueIds, []);
    assert.deepEqual(result.commits, []);
    assert.equal(result.fixHeadSha, BASE);
    assert.match(result.errors[0], /提交钩子/);
  }
});

it('非 HEAD 的 diff、正文和元数据使用同一冻结目标', async () => {
  const reader = new DiffReader(path.resolve('synthetic-repo'));
  const calls: string[][] = [];
  (reader as unknown as { git(args: string[]): Promise<{ stdout: string }> }).git = async args => {
    calls.push(args);
    if (args.includes('--is-inside-work-tree')) return { stdout: 'true' };
    if (args[0] === 'rev-parse') return { stdout: args.includes('REVIEW^{commit}') ? NEXT : args.includes('BASE^{commit}') ? BASE : TREE };
    if (args[0] === 'ls-tree') return { stdout: `100644 blob ${TREE}\tsrc/a.ts` };
    if (args[0] === 'show') return { stdout: 'frozen target content' };
    if (args.includes('--name-status')) return { stdout: 'M\tsrc/a.ts' };
    if (args.includes('--numstat')) return { stdout: '1\t1\tsrc/a.ts' };
    return { stdout: 'diff --git a/src/a.ts b/src/a.ts\n-old\n+target\n' };
  };
  const result = await reader.createSnapshot({ type: 'commit_range', base_ref: 'BASE', head_ref: 'REVIEW' });
  assert.equal(result.head_commit, NEXT);
  assert.equal(result.head_tree, TREE);
  assert.equal(result.base_ref, BASE);
  assert.ok(calls.filter(c => c[0] === 'diff').every(c => c.includes(BASE) && c.includes(TREE)));
  assert.ok(calls.filter(c => c[0] === 'ls-tree').every(c => c[1] === TREE));
  assert.equal(result.changed_files[0].content, 'frozen target content');
});

it('暂存与未暂存审查使用冻结 tree，删除文件从 diff 基线读取', async () => {
  for (const type of ['staged', 'unstaged'] as const) {
    const reader = new DiffReader(path.resolve('synthetic-repo'));
    const calls: string[][] = [];
    const seams = reader as unknown as { git(args: string[]): Promise<{ stdout: string }>; freezeWorkingTree(index: string): Promise<string> };
    seams.freezeWorkingTree = async index => { assert.equal(index, TREE); return NEXT; };
    seams.git = async args => {
      calls.push(args);
      if (args.includes('--is-inside-work-tree')) return { stdout: 'true' };
      if (args[0] === 'rev-parse') return { stdout: BASE };
      if (args[0] === 'write-tree') return { stdout: TREE };
      if (args[0] === 'ls-tree') return { stdout: `100644 blob ${TREE}\tsrc/deleted.ts` };
      if (args[0] === 'show') return { stdout: 'old content' };
      if (args.includes('--name-status')) return { stdout: 'D\tsrc/deleted.ts' };
      if (args.includes('--numstat')) return { stdout: '0\t1\tsrc/deleted.ts' };
      return { stdout: 'diff --git a/src/deleted.ts b/src/deleted.ts\n-old\n' };
    };
    const result = await reader.createSnapshot({ type });
    assert.equal(result.head_tree, type === 'staged' ? TREE : NEXT);
    assert.equal(result.base_ref, type === 'staged' ? BASE : TREE);
    assert.equal(calls.find(command => command[0] === 'ls-tree')?.[1], result.base_ref);
    assert.ok(calls.every(command => !command.includes('hash-object') && !command.includes('--cached')));
  }
});

async function temporaryStore() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'workflow-reliability-'));
  const store = new WorkflowStore(directory);
  const meta: WorkflowMeta = { run_id: 'run', workflow_type: 'spec-review', execution_lock_version: 1,
    status: 'running', current_round: 1, current_step: 'codex_review', created_at: '', updated_at: '',
    config: DEFAULT_CONFIG, last_completed: null, termination_state: { consecutive_parse_failures: 0, zero_progress_rounds: 0 } };
  await store.createRun(meta);
  return { directory, store, meta };
}

function fakeEngine(store: WorkflowStore, loop: () => Promise<void>) {
  const engine = new WorkflowEngine(store, ...Array(8).fill({}) as ConstructorParameters<typeof WorkflowEngine> extends [unknown, ...infer Rest] ? Rest : never);
  (engine as unknown as { runLoop(): Promise<void> }).runLoop = loop;
  return engine;
}

it('running 遗留任务可恢复，但并发恢复只允许一个执行者', async () => {
  const { store } = await temporaryStore();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const first = fakeEngine(store, async () => { entered(); await gate; });
  const active = first.resume('run');
  await ready;
  await assert.rejects(fakeEngine(store, async () => assert.fail('must not run')).resume('run'), /活跃执行者/);
  release(); await active;
  let resumed = false;
  await fakeEngine(store, async () => { resumed = true; }).resume('run');
  assert.equal(resumed, true);
});

it('pause 等待旧执行真正排空之后才返回', async () => {
  const { store } = await temporaryStore();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const engine = fakeEngine(store, async () => { entered(); await gate; });
  const active = engine.resume('run'); await ready;
  let paused = false;
  const stopping = engine.pause('run').then(() => { paused = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(paused, false);
  release(); await Promise.all([active, stopping]);
  assert.equal((await store.getMeta('run'))?.status, 'paused');
});

it('检查点并发更新不会丢失其他字段', async () => {
  const { store, directory } = await temporaryStore();
  await Promise.all([store.updateMeta('run', { current_round: 3 }), new WorkflowStore(directory).updateMeta('run', { current_step: 'claude_decision' })]);
  assert.equal((await store.getMeta('run'))?.current_round, 3);
  assert.equal((await store.getMeta('run'))?.current_step, 'claude_decision');
});

it('恢复者本身崩溃留下的锁可以在确认 PID 已退出后安全恢复', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'workflow-lock-'));
  const file = path.join(directory, 'executor.lock');
  const dead = { pid: 999999, host: hostname(), token: 'dead-owner' };
  await fs.writeFile(file, JSON.stringify(dead));
  await fs.writeFile(file + '.recover-dead-owner', JSON.stringify({ ...dead, token: 'dead-recoverer' }));
  const kill = process.kill;
  t.mock.method(process, 'kill', (pid: number, signal: NodeJS.Signals | number) => {
    assert.equal(signal, 0);
    if (pid === 999999) throw Object.assign(new Error('synthetic dead process'), { code: 'ESRCH' });
    return kill(pid, signal);
  });
  const release = await acquireRunLock(file);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).pid, process.pid);
  await release();
  assert.equal(JSON.parse(await fs.readFile(file + '.stale-dead-owner', 'utf8')).token, 'dead-owner');
});

it('决策超时耗尽后保留同一轮检查点，恢复不重新调用已完成的审查模型', async () => {
  const { store, directory } = await temporaryStore();
  const templates = path.join(directory, 'templates');
  await fs.mkdir(templates);
  for (const name of ['spec-review-pack.md', 'claude-decision.md', 'claude-decision-system.md', 'round-summary.md']) {
    await fs.writeFile(path.join(templates, name), '{{spec}} {{plan}} {{codex_findings_with_ids}} {{ledger_summary}}');
  }
  let reviews = 0, decisions = 0;
  const fakeInvoker = {
    invokeCodex: async () => { reviews++; return JSON.stringify({ findings: [{ issue: 'synthetic defect', severity: 'high', evidence: 'section', suggestion: 'fix' }], overall_assessment: 'major_issues', summary: 'synthetic' }); },
    invokeClaude: async () => { decisions++; throw new TimeoutError('claude', 2, 'synthetic timeout'); },
  };
  const engine = new WorkflowEngine(store, new PackBuilder(store, new ContextCompressor()), new PromptAssembler(store),
    fakeInvoker as unknown as ModelInvoker, new TerminationJudge(), new JsonParser(), new IssueMatcher(), new PatchApplier(), new DecisionValidator());
  const runId = await engine.start({ spec: 'synthetic spec', plan: 'synthetic plan' });
  assert.equal(reviews, 1);
  assert.equal(decisions, 1);
  assert.equal((await store.getMeta(runId))?.current_round, 1);
  assert.equal((await store.getMeta(runId))?.current_step, 'claude_decision');
  assert.equal((await store.getMeta(runId))?.status, 'paused');
  await engine.resume(runId);
  assert.equal(reviews, 1);
  assert.equal(decisions, 2);
});

it('旧版没有执行者记录的 running 不会被猜测性抢占', async () => {
  const { store } = await temporaryStore();
  await store.updateMeta('run', { execution_lock_version: undefined });
  await assert.rejects(fakeEngine(store, async () => assert.fail('must not run')).resume('run'), /无法确认是否失联/);
  assert.equal((await store.getMeta('run'))?.status, 'running');
});

it('工作流 ID 路径穿越在读写或创建锁之前拒绝', async () => {
  const { store, directory } = await temporaryStore();
  const before = await fs.readdir(directory);
  for (const id of ['../outside', '..\\outside', '/absolute', 'C:\\outside', '']) {
    await assert.rejects(store.acquireExecution(id), /Invalid workflow run ID/);
    await assert.rejects(store.getMeta(id), /Invalid workflow run ID/);
    await assert.rejects(fakeEngine(store, async () => assert.fail('must not run')).resume(id), /Invalid workflow run ID/);
  }
  assert.deepEqual(await fs.readdir(directory), before);
});
