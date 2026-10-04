import { it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowEngine } from '../../lib/workflow/workflow-engine.js';
import { WorkflowStore } from '../../lib/workflow/workflow-store.js';
import { PackBuilder } from '../../lib/workflow/pack-builder.js';
import { ContextCompressor } from '../../lib/workflow/context-compressor.js';
import { PromptAssembler } from '../../lib/workflow/prompt-assembler.js';
import type { ModelInvoker } from '../../lib/workflow/model-invoker.js';
import { TerminationJudge } from '../../lib/workflow/termination-judge.js';
import { JsonParser } from '../../lib/workflow/json-parser.js';
import { IssueMatcher } from '../../lib/workflow/issue-matcher.js';
import { PatchApplier } from '../../lib/workflow/patch-applier.js';
import { DecisionValidator } from '../../lib/workflow/decision-validator.js';
import { DEFAULT_CONFIG } from '../../lib/workflow/types.js';
import type { IssueLedger, WorkflowMeta } from '../../lib/workflow/types.js';

const RUN = 'patch-recovery';
const CRASH = 'synthetic persisted-write interruption';
type Fault = 'raw' | 'application' | 'spec' | 'plan' | 'ledger-before' | 'ledger-after' | 'checkpoint-before' | 'checkpoint-after';

async function fixture(t: TestContext, valid: boolean) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'workflow-patch-recovery-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith('workflow-patch-recovery-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = new WorkflowStore(directory);
  const meta: WorkflowMeta = {
    run_id: RUN, workflow_type: 'spec-review', execution_lock_version: 1,
    status: 'paused', current_round: 1, current_step: 'claude_decision',
    created_at: '', updated_at: '', config: { ...DEFAULT_CONFIG, max_rounds: 1 }, last_completed: null,
    termination_state: { consecutive_parse_failures: 0, zero_progress_rounds: 0 },
  };
  await store.createRun(meta);
  await store.saveSpec(RUN, '## Existing\noriginal spec', 1);
  await store.savePlan(RUN, '## Existing\noriginal plan', 1);
  const ledger: IssueLedger = { run_id: RUN, issues: [1, 2].map(n => ({
    id: `ISS-00${n}`, round: 1, raised_by: 'codex', severity: 'high',
    description: `synthetic defect ${n}`, evidence: 'section', status: 'open', repeat_count: 0,
  })) };
  await store.saveLedger(RUN, ledger);
  await store.saveRoundArtifact(RUN, 1, 'codex-review.md', JSON.stringify({
    findings: [], overall_assessment: 'major_issues', summary: 'synthetic',
  }));
  await fs.mkdir(path.join(directory, 'templates'));
  for (const name of ['claude-decision.md', 'claude-decision-system.md', 'round-summary.md']) {
    await fs.writeFile(path.join(directory, 'templates', name), '{{current_spec}} {{current_plan}} {{ledger_summary}}');
  }
  const heading = valid ? 'Existing' : 'Missing';
  const raw = JSON.stringify({
    decisions: [
      { issue_id: 'ISS-001', action: 'accept_and_resolve', reason: 'synthetic resolution' },
      { issue_id: 'ISS-002', action: 'accept', reason: 'synthetic patch' },
    ],
    spec_updated: true, plan_updated: true,
    spec_patch: `## ${heading}\nreplacement spec`, plan_patch: `## ${heading}\nreplacement plan`,
    resolves_issues: ['ISS-002'], summary: 'synthetic decision',
  });
  let calls = 0;
  const invoker = {
    invokeCodex: async () => assert.fail('恢复不得重新调用审查模型'),
    invokeClaude: async () => { calls++; return raw; },
  };
  const engine = (current: WorkflowStore) => new WorkflowEngine(current,
    new PackBuilder(current, new ContextCompressor()), new PromptAssembler(current),
    invoker as unknown as ModelInvoker, new TerminationJudge(), new JsonParser(),
    new IssueMatcher(), new PatchApplier(), new DecisionValidator());
  return { directory, store, engine, raw, calls: () => calls };
}

function interrupt(t: TestContext, store: WorkflowStore, fault: Fault) {
  const fail = (): never => { throw new Error(CRASH); };
  if (fault === 'spec' || fault === 'plan') {
    const key = fault === 'spec' ? 'saveSpec' : 'savePlan';
    const original = store[key].bind(store);
    t.mock.method(store, key, async (runId: string, content: string, version?: number) => {
      await original(runId, content, version);
      fail();
    });
  } else if (fault === 'raw' || fault === 'application') {
    const original = store.saveRoundArtifact.bind(store);
    t.mock.method(store, 'saveRoundArtifact', async (...args: Parameters<typeof original>) => {
      await original(...args);
      if (args[2] === (fault === 'raw' ? 'claude-raw.md' : 'patch-application.json')) fail();
    });
  } else if (fault.startsWith('ledger')) {
    const original = store.saveLedger.bind(store);
    t.mock.method(store, 'saveLedger', async (...args: Parameters<typeof original>) => {
      const final = args[1].issues.some(issue => issue.decided_by === 'claude');
      if (final && fault === 'ledger-before') fail();
      await original(...args);
      if (final && fault === 'ledger-after') fail();
    });
  } else {
    const original = store.updateMeta.bind(store);
    t.mock.method(store, 'updateMeta', async (...args: Parameters<typeof original>) => {
      const checkpoint = args[1].current_step === 'post_decision';
      if (checkpoint && fault === 'checkpoint-before') fail();
      await original(...args);
      if (checkpoint && fault === 'checkpoint-after') fail();
    });
  }
}

async function outcome(directory: string) {
  const store = new WorkflowStore(directory);
  const files = (await fs.readdir(path.join(directory, 'runs', RUN))).filter(name => /^(spec|plan)-v\d+\.md$/.test(name)).sort();
  return {
    spec: await store.loadSpec(RUN), plan: await store.loadPlan(RUN),
    ledger: await store.loadLedger(RUN), files,
    status: (await store.getMeta(RUN))?.status, step: (await store.getMeta(RUN))?.current_step,
  };
}

for (const valid of [false, true]) {
  for (const fault of ['raw', 'application', 'spec', 'plan', 'ledger-before', 'ledger-after', 'checkpoint-before', 'checkpoint-after'] as const) {
    it(`${valid ? '合法' : '未知标题'}补丁在 ${fault} 中断后保持判定与固定版本`, { timeout: 15000 }, async t => {
      const normal = await fixture(t, valid);
      await normal.engine(normal.store).resume(RUN);
      const expected = await outcome(normal.directory);
      assert.deepEqual(expected.ledger?.issues.map(issue => issue.status), valid ? ['resolved', 'resolved'] : ['accepted', 'accepted']);

      const interrupted = await fixture(t, valid);
      interrupt(t, interrupted.store, fault);
      await assert.rejects(interrupted.engine(interrupted.store).resume(RUN), new RegExp(CRASH));
      // 使用全新 Store/Engine；再次中断检查点前，验证重放本身也可以重放。
      if (fault !== 'checkpoint-after') {
        const secondStore = new WorkflowStore(interrupted.directory);
        interrupt(t, secondStore, 'checkpoint-before');
        await assert.rejects(interrupted.engine(secondStore).resume(RUN), new RegExp(CRASH));
      }
      await interrupted.engine(new WorkflowStore(interrupted.directory)).resume(RUN);
      assert.deepEqual(await outcome(interrupted.directory), expected);
      assert.equal(interrupted.calls(), 1);
      assert.deepEqual(expected.files, ['plan-v1.md', 'plan-v2.md', 'spec-v1.md', 'spec-v2.md']);
    });
  }
}

it('旧半完成步骤缺少准确基线时暂停，不猜测最新文档', async t => {
  const f = await fixture(t, false);
  await f.store.saveRoundArtifact(RUN, 1, 'claude-raw.md', f.raw);
  await f.store.saveSpec(RUN, '## Existing\noriginal spec\n\n## Missing\nreplacement spec', 2);
  const before = await outcome(f.directory);
  await f.engine(f.store).resume(RUN);
  const after = await outcome(f.directory);
  assert.equal(after.status, 'human_review');
  assert.equal(after.step, 'claude_decision');
  assert.equal(after.spec, before.spec);
  assert.deepEqual(after.ledger, before.ledger);
  assert.deepEqual(after.files, before.files);
  assert.equal(f.calls(), 0);
  const events = await f.store.loadEvents(RUN);
  assert.match(String(events.find(e => e.event_type === 'human_review_requested')?.data.details), /基线/);
});

for (const damage of ['baseline-json', 'application-json', 'valid-checksum-invalid-schema', 'baseline-content', 'raw-content', 'target-conflict', 'extra-version', 'ledger-change'] as const) {
  it(`恢复遇到 ${damage} 时暂停并保留全部现场`, async t => {
    const f = await fixture(t, false);
    interrupt(t, f.store, 'application');
    await assert.rejects(f.engine(f.store).resume(RUN), new RegExp(CRASH));
    const store = new WorkflowStore(f.directory);
    if (damage === 'baseline-json' || damage === 'application-json') {
      const name = damage === 'baseline-json' ? 'claude-baseline.json' : 'patch-application.json';
      await store.saveRoundArtifact(RUN, 1, name, '{broken');
    } else if (damage === 'valid-checksum-invalid-schema') {
      const data = { schema: 1, runId: RUN, round: 1 };
      const checksum = createHash('sha256').update(JSON.stringify(data)).digest('hex');
      await store.saveRoundArtifact(RUN, 1, 'patch-application.json', JSON.stringify({ data, checksum }));
    } else if (damage === 'baseline-content') {
      await store.saveSpec(RUN, 'baseline changed', 1);
    } else if (damage === 'raw-content') {
      await store.saveRoundArtifact(RUN, 1, 'claude-raw.md', f.raw + ' changed');
    } else if (damage === 'target-conflict') {
      // plan 冲突须在 spec 写入之前发现。
      await store.savePlan(RUN, 'keep this conflicting target', 2);
    } else if (damage === 'extra-version') {
      await store.saveSpec(RUN, 'keep this later version', 3);
    } else {
      const ledger = (await store.loadLedger(RUN))!;
      ledger.issues[0].decision_reason = 'manual change';
      await store.saveLedger(RUN, ledger);
    }
    const before = await outcome(f.directory);
    await f.engine(store).resume(RUN);
    const after = await outcome(f.directory);
    assert.deepEqual(after, { ...before, status: 'human_review' });
    assert.equal(f.calls(), 1);
    const details = (await store.loadEvents(RUN)).find(e => e.event_type === 'human_review_requested')?.data.details;
    assert.ok(typeof details === 'string' && details.length > 10);
  });
}

for (const damage of ['ledger-change', 'target-conflict', 'extra-version', 'baseline-content'] as const) {
  it(`首次提交遇到 ${damage} 也暂停保留现场，与恢复路径一致`, async t => {
    const f = await fixture(t, true);
    const original = f.store.saveRoundArtifact.bind(f.store);
    let before: Awaited<ReturnType<typeof outcome>> | undefined;
    t.mock.method(f.store, 'saveRoundArtifact', async (...args: Parameters<typeof original>) => {
      await original(...args);
      if (args[2] !== 'patch-application.json') return;
      if (damage === 'ledger-change') {
        const ledger = (await f.store.loadLedger(RUN))!;
        ledger.issues[0].decision_reason = 'manual change during model execution';
        await f.store.saveLedger(RUN, ledger);
      } else if (damage === 'target-conflict') {
        await f.store.savePlan(RUN, 'manual target', 2);
      } else if (damage === 'extra-version') {
        await f.store.savePlan(RUN, 'manual later version', 3);
      } else {
        await f.store.saveSpec(RUN, 'manual baseline edit', 1);
      }
      before = await outcome(f.directory);
    });
    await f.engine(f.store).resume(RUN);
    assert.ok(before);
    assert.deepEqual(await outcome(f.directory), { ...before, status: 'human_review' });
    assert.equal(f.calls(), 1);
  });
}

for (const savedApplication of [false, true]) {
  for (const stage of ['spec', 'plan', 'ledger', 'completion', 'checkpoint'] as const) {
  it(`${savedApplication ? '恢复' : '首次'}提交补丁在 ${stage} 暂停，排空当前写入后保留检查点`, { timeout: 15000 }, async t => {
    const f = await fixture(t, true);
    if (savedApplication) {
      interrupt(t, f.store, 'application');
      await assert.rejects(f.engine(f.store).resume(RUN), new RegExp(CRASH));
    }
    const store = new WorkflowStore(f.directory);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const waitForPause = async () => {
      entered();
      await gate;
    };
    if (stage === 'spec' || stage === 'plan') {
      const key = stage === 'spec' ? 'saveSpec' : 'savePlan';
      const original = store[key].bind(store);
      t.mock.method(store, key, async (runId: string, content: string, version?: number) => {
        const result = await original(runId, content, version);
        await waitForPause();
        return result;
      });
    } else if (stage === 'ledger') {
      const original = store.saveLedger.bind(store);
      t.mock.method(store, 'saveLedger', async (...args: Parameters<typeof original>) => {
        await original(...args);
        if (args[1].issues.some(issue => issue.decided_by === 'claude')) await waitForPause();
      });
    } else if (stage === 'completion') {
      const original = store.appendEvent.bind(store);
      t.mock.method(store, 'appendEvent', async (...args: Parameters<typeof original>) => {
        await original(...args);
        if (args[0].event_type === 'claude_decision_completed') await waitForPause();
      });
    } else {
      const original = store.updateMeta.bind(store);
      t.mock.method(store, 'updateMeta', async (...args: Parameters<typeof original>) => {
        await original(...args);
        if (args[1].current_step === 'post_decision' && args[1].status !== 'paused') await waitForPause();
      });
    }
    const engine = f.engine(store);
    const active = engine.resume(RUN);
    await ready;
    const pausing = engine.pause(RUN);
    try {
      await assert.rejects(f.engine(new WorkflowStore(f.directory)).resume(RUN), /活跃执行者/);
    } finally {
      release();
    }
    await Promise.all([active, pausing]);
    const paused = await outcome(f.directory);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.step, stage === 'checkpoint' ? 'post_decision' : 'claude_decision');
    assert.deepEqual(paused.files, stage === 'spec'
      ? ['plan-v1.md', 'spec-v1.md', 'spec-v2.md']
      : ['plan-v1.md', 'plan-v2.md', 'spec-v1.md', 'spec-v2.md']);
    assert.deepEqual(paused.ledger?.issues.map(issue => issue.status), stage === 'spec' || stage === 'plan'
      ? ['open', 'open'] : ['resolved', 'resolved']);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await outcome(f.directory), paused);

    await f.engine(new WorkflowStore(f.directory)).resume(RUN);
    const completed = await outcome(f.directory);
    assert.deepEqual(completed.files, ['plan-v1.md', 'plan-v2.md', 'spec-v1.md', 'spec-v2.md']);
    assert.deepEqual(completed.ledger?.issues.map(issue => issue.status), ['resolved', 'resolved']);
    assert.equal(f.calls(), 1);
  });
  }
}
