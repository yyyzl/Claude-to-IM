/**
 * Unit tests for WorkflowStore — the artifact persistence layer.
 *
 * Covers:
 * - Run lifecycle: createRun, getMeta, updateMeta
 * - Versioned docs: saveSpec/loadSpec, savePlan/loadPlan
 * - Issue ledger: saveLedger/loadLedger
 * - Round artifacts: saveRoundArtifact/loadRoundArtifact
 * - Event log (ndjson): appendEvent/loadEvents
 * - Templates: loadTemplate (success & failure)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

import { WorkflowStore } from '../../lib/workflow/workflow-store.js';
import type {
  WorkflowMeta,
  WorkflowEvent,
  IssueLedger,
  WorkflowConfig,
} from '../../lib/workflow/types.js';
import { DEFAULT_CONFIG } from '../../lib/workflow/types.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Create a unique temporary directory for test isolation. */
async function makeTmpDir(): Promise<string> {
  const prefix = path.join(os.tmpdir(), 'wf-store-test-');
  return fs.mkdtemp(prefix);
}

/** Recursively remove a directory (test cleanup). */
async function removeTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Build a valid WorkflowMeta with sensible defaults. */
function createDefaultMeta(overrides: Partial<WorkflowMeta> = {}): WorkflowMeta {
  const now = new Date().toISOString();
  return {
    run_id: overrides.run_id ?? `run-${randomUUID()}`,
    workflow_type: 'spec-review',
    status: 'running',
    current_round: 1,
    current_step: 'codex_review',
    created_at: now,
    updated_at: now,
    config: { ...DEFAULT_CONFIG },
    last_completed: null,
    termination_state: { consecutive_parse_failures: 0, zero_progress_rounds: 0 },
    ...overrides,
  };
}

/** Build a valid WorkflowEvent. */
function createEvent(
  runId: string,
  round: number,
  eventType: WorkflowEvent['event_type'],
  data: Record<string, unknown> = {},
): WorkflowEvent {
  return {
    timestamp: new Date().toISOString(),
    run_id: runId,
    round,
    event_type: eventType,
    data,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('WorkflowStore', () => {
  let tmpDir: string;
  let store: WorkflowStore;

  before(async () => {
    tmpDir = await makeTmpDir();
    store = new WorkflowStore(tmpDir);
  });

  after(async () => {
    await removeTmpDir(tmpDir);
  });

  // ── 1. createRun + getMeta ──────────────────────────────────

  describe('createRun + getMeta', () => {
    it('creates a run and reads back the same meta', async () => {
      const meta = createDefaultMeta();
      await store.createRun(meta);

      const loaded = await store.getMeta(meta.run_id);
      assert.deepStrictEqual(loaded, meta);
    });
  });

  // ── 2. getMeta returns null ─────────────────────────────────

  describe('getMeta', () => {
    it('returns null when the run does not exist', async () => {
      const result = await store.getMeta('non-existent-run-id');
      assert.equal(result, null);
    });
  });

  // ── 3. updateMeta ──────────────────────────────────────────

  describe('updateMeta', () => {
    it('merges partial updates and auto-updates updated_at', async () => {
      const meta = createDefaultMeta();
      await store.createRun(meta);

      const beforeUpdate = new Date().toISOString();

      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 10));

      await store.updateMeta(meta.run_id, {
        status: 'paused',
        current_round: 2,
      });

      const updated = await store.getMeta(meta.run_id);
      assert.ok(updated);
      assert.equal(updated.status, 'paused');
      assert.equal(updated.current_round, 2);
      // updated_at should be newer than beforeUpdate
      assert.ok(updated.updated_at >= beforeUpdate);
      // Other fields should remain unchanged
      assert.equal(updated.run_id, meta.run_id);
      assert.equal(updated.workflow_type, meta.workflow_type);
      assert.equal(updated.current_step, meta.current_step);
    });

    // ── 4. updateMeta throws for non-existent run ─────────────

    it('throws when run does not exist', async () => {
      await assert.rejects(
        () => store.updateMeta('does-not-exist', { status: 'failed' }),
        (err: Error) => {
          assert.ok(err.message.includes('Run not found'));
          assert.ok(err.message.includes('does-not-exist'));
          return true;
        },
      );
    });
  });

  // ── 5. saveSpec + loadSpec ─────────────────────────────────

  describe('saveSpec / loadSpec', () => {
    let runId: string;

    before(async () => {
      const meta = createDefaultMeta();
      runId = meta.run_id;
      await store.createRun(meta);
    });

    it('saves and loads spec v1', async () => {
      const content = '# Spec v1\nFirst version of the spec.';
      const ver = await store.saveSpec(runId, content, 1);
      assert.equal(ver, 1);

      const loaded = await store.loadSpec(runId, 1);
      assert.equal(loaded, content);
    });

    // ── 6. saveSpec auto-increments version ───────────────────

    it('auto-increments version when saving without explicit version', async () => {
      // v1 already saved above
      const v2Content = '# Spec v2\nUpdated spec.';
      const ver = await store.saveSpec(runId, v2Content);
      assert.equal(ver, 2);

      const loaded = await store.loadSpec(runId, 2);
      assert.equal(loaded, v2Content);
    });

    // ── 7. loadSpec without version loads latest ──────────────

    it('loads latest version when no version is specified', async () => {
      // v2 is the latest from previous test
      const loaded = await store.loadSpec(runId);
      assert.equal(loaded, '# Spec v2\nUpdated spec.');
    });

    // ── 8. loadSpec with specific version ─────────────────────

    it('loads a specific version when version is given', async () => {
      const v1 = await store.loadSpec(runId, 1);
      const v2 = await store.loadSpec(runId, 2);
      assert.notEqual(v1, v2);
      assert.ok(v1?.includes('v1'));
      assert.ok(v2?.includes('v2'));
    });

    // ── 9. loadSpec returns null when no file exists ──────────

    it('returns null when no spec exists for a run', async () => {
      const freshMeta = createDefaultMeta();
      await store.createRun(freshMeta);
      const result = await store.loadSpec(freshMeta.run_id);
      assert.equal(result, null);
    });
  });

  // ── 10. savePlan / loadPlan ────────────────────────────────

  describe('savePlan / loadPlan', () => {
    it('saves and loads plan with auto-increment, and loads latest', async () => {
      const meta = createDefaultMeta();
      await store.createRun(meta);
      const runId = meta.run_id;

      // Save v1
      const v1 = await store.savePlan(runId, '# Plan v1');
      assert.equal(v1, 1);

      // Save v2 (auto-increment)
      const v2 = await store.savePlan(runId, '# Plan v2');
      assert.equal(v2, 2);

      // Load latest (should be v2)
      const latest = await store.loadPlan(runId);
      assert.equal(latest, '# Plan v2');

      // Load specific v1
      const loadedV1 = await store.loadPlan(runId, 1);
      assert.equal(loadedV1, '# Plan v1');

      // Load from non-existent run
      const freshMeta = createDefaultMeta();
      await store.createRun(freshMeta);
      const noplan = await store.loadPlan(freshMeta.run_id);
      assert.equal(noplan, null);
    });
  });

  // ── 11. saveLedger + loadLedger ────────────────────────────

  describe('saveLedger / loadLedger', () => {
    it('saves and loads an issue ledger', async () => {
      const meta = createDefaultMeta();
      await store.createRun(meta);

      const ledger: IssueLedger = {
        run_id: meta.run_id,
        issues: [
          {
            id: 'ISS-001',
            round: 1,
            raised_by: 'codex',
            severity: 'high',
            description: 'Missing error handling in auth module',
            evidence: 'Line 42 in auth.ts has no try-catch',
            status: 'open',
            repeat_count: 0,
          },
        ],
      };

      await store.saveLedger(meta.run_id, ledger);
      const loaded = await store.loadLedger(meta.run_id);
      assert.deepStrictEqual(loaded, ledger);
    });

    // ── 12. loadLedger returns null ───────────────────────────

    it('returns null when ledger does not exist', async () => {
      const meta = createDefaultMeta();
      await store.createRun(meta);
      const result = await store.loadLedger(meta.run_id);
      assert.equal(result, null);
    });
  });

  // ── 13. saveRoundArtifact + loadRoundArtifact ──────────────

  describe('saveRoundArtifact / loadRoundArtifact', () => {
    it('saves and loads a round artifact', async () => {
      const meta = createDefaultMeta();
      await store.createRun(meta);

      const content = JSON.stringify({ findings: [], overall_assessment: 'lgtm', summary: 'OK' });
      await store.saveRoundArtifact(meta.run_id, 1, 'codex-review.json', content);

      const loaded = await store.loadRoundArtifact(meta.run_id, 1, 'codex-review.json');
      assert.equal(loaded, content);
    });

    // ── 14. loadRoundArtifact returns null ─────────────────────

    it('returns null when the artifact does not exist', async () => {
      const meta = createDefaultMeta();
      await store.createRun(meta);
      const result = await store.loadRoundArtifact(meta.run_id, 1, 'nonexistent.md');
      assert.equal(result, null);
    });
  });

  // ── 15. appendEvent + loadEvents ───────────────────────────

  describe('appendEvent / loadEvents', () => {
    it('appends multiple events and loads them in ndjson format', async () => {
      const meta = createDefaultMeta();
      await store.createRun(meta);

      const e1 = createEvent(meta.run_id, 1, 'workflow_started', { reason: 'init' });
      const e2 = createEvent(meta.run_id, 1, 'round_started', { round: 1 });
      const e3 = createEvent(meta.run_id, 1, 'codex_review_started', { model: 'codex' });

      await store.appendEvent(e1);
      await store.appendEvent(e2);
      await store.appendEvent(e3);

      const events = await store.loadEvents(meta.run_id);
      assert.equal(events.length, 3);
      assert.deepStrictEqual(events[0], e1);
      assert.deepStrictEqual(events[1], e2);
      assert.deepStrictEqual(events[2], e3);

      // Verify the file is actual ndjson (each line is valid JSON)
      const filePath = path.join(tmpDir, 'runs', meta.run_id, 'events.ndjson');
      const raw = await fs.readFile(filePath, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      assert.equal(lines.length, 3);
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line));
      }
    });

    // ── 16. loadEvents returns empty array ────────────────────

    it('returns an empty array when events file does not exist', async () => {
      const meta = createDefaultMeta();
      await store.createRun(meta);
      const events = await store.loadEvents(meta.run_id);
      assert.deepStrictEqual(events, []);
    });
  });

  // ── 17 & 18. loadTemplate ─────────────────────────────────

  describe('loadTemplate', () => {
    let templateStore: WorkflowStore;
    let templateDir: string;

    before(async () => {
      templateDir = await makeTmpDir();
      templateStore = new WorkflowStore(templateDir);

      // Create templates/ subdirectory with a test template
      const templatesPath = path.join(templateDir, 'templates');
      await fs.mkdir(templatesPath, { recursive: true });
      await fs.writeFile(
        path.join(templatesPath, 'spec-review-prompt.md'),
        '# Review Prompt\nPlease review the following spec:\n{{spec}}',
        'utf-8',
      );
    });

    after(async () => {
      await removeTmpDir(templateDir);
    });

    it('successfully loads an existing template', async () => {
      const content = await templateStore.loadTemplate('spec-review-prompt.md');
      assert.ok(content.includes('# Review Prompt'));
      assert.ok(content.includes('{{spec}}'));
    });

    it('throws when the template does not exist', async () => {
      await assert.rejects(
        () => templateStore.loadTemplate('nonexistent-template.md'),
        (err: Error) => {
          assert.ok(err.message.includes('Template not found'));
          assert.ok(err.message.includes('nonexistent-template.md'));
          return true;
        },
      );
    });
  });
});
