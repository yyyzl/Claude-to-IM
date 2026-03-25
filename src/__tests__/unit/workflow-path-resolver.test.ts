/**
 * Unit tests for WorkflowPathResolver — external repo template resolution.
 *
 * Covers:
 * - resolveWorkflowPaths() defaults and overrides
 * - resolveBuiltinAssetRoot() dev-time walk-up
 * - WorkflowStore split paths (templates vs run artifacts)
 * - External repo scenario: no .claude-workflows/templates/ in target repo
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  resolveWorkflowPaths,
  resolveBuiltinAssetRoot,
  _resetBuiltinAssetRootCache,
} from '../../lib/workflow/path-resolver.js';
import { WorkflowStore } from '../../lib/workflow/workflow-store.js';
import type { WorkflowMeta } from '../../lib/workflow/types.js';
import { DEFAULT_CONFIG } from '../../lib/workflow/types.js';

// ── Helpers ──────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  const prefix = path.join(os.tmpdir(), 'wf-pathres-test-');
  return fs.mkdtemp(prefix);
}

async function removeTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

function createDefaultMeta(runId: string): WorkflowMeta {
  const now = new Date().toISOString();
  return {
    run_id: runId,
    workflow_type: 'code-review',
    status: 'running',
    current_round: 1,
    current_step: 'codex_review',
    created_at: now,
    updated_at: now,
    config: { ...DEFAULT_CONFIG },
    last_completed: null,
    termination_state: { consecutive_parse_failures: 0, zero_progress_rounds: 0 },
  };
}

// ── Test Suites ──────────────────────────────────────────────────

describe('resolveBuiltinAssetRoot', () => {
  beforeEach(() => {
    _resetBuiltinAssetRootCache();
  });

  it('should find built-in asset root from project root', () => {
    const root = resolveBuiltinAssetRoot();
    assert.ok(root, 'Should return a path');
    // The resolved path should contain templates/
    const templatesDir = path.join(root, 'templates');
    // We verify it's an absolute path
    assert.ok(path.isAbsolute(root), `Should be absolute: ${root}`);
  });

  it('should return consistent results (caching)', () => {
    const first = resolveBuiltinAssetRoot();
    const second = resolveBuiltinAssetRoot();
    assert.equal(first, second);
  });

  it('should respect $WORKFLOW_ASSET_ROOT env var', async () => {
    const tmpDir = await makeTmpDir();
    try {
      // Create a valid asset structure
      await fs.mkdir(path.join(tmpDir, 'templates'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'templates', 'test.md'), 'test template');

      _resetBuiltinAssetRootCache();
      const oldEnv = process.env['WORKFLOW_ASSET_ROOT'];
      process.env['WORKFLOW_ASSET_ROOT'] = tmpDir;
      try {
        const root = resolveBuiltinAssetRoot();
        assert.equal(root, path.resolve(tmpDir));
      } finally {
        if (oldEnv === undefined) {
          delete process.env['WORKFLOW_ASSET_ROOT'];
        } else {
          process.env['WORKFLOW_ASSET_ROOT'] = oldEnv;
        }
        _resetBuiltinAssetRootCache();
      }
    } finally {
      await removeTmpDir(tmpDir);
    }
  });
});

describe('resolveWorkflowPaths', () => {
  it('should set repoCwd to resolved absolute path', () => {
    const result = resolveWorkflowPaths({ repoCwd: '/some/repo' });
    assert.equal(result.repoCwd, path.resolve('/some/repo'));
  });

  it('should default runBasePath to repoCwd/.claude-workflows', () => {
    const result = resolveWorkflowPaths({ repoCwd: '/some/repo' });
    assert.equal(result.runBasePath, path.join(path.resolve('/some/repo'), '.claude-workflows'));
  });

  it('should default templateBasePath to built-in asset root', () => {
    const result = resolveWorkflowPaths({ repoCwd: '/some/repo' });
    // templateBasePath should NOT be under /some/repo — it should be the built-in root
    assert.ok(!result.templateBasePath.includes('some/repo'.replace(/\//g, path.sep)),
      `templateBasePath should not be under repoCwd: ${result.templateBasePath}`);
  });

  it('should allow explicit overrides', () => {
    const result = resolveWorkflowPaths({
      repoCwd: '/some/repo',
      runBasePath: '/custom/runs',
      templateBasePath: '/custom/templates',
    });
    assert.equal(result.runBasePath, path.resolve('/custom/runs'));
    assert.equal(result.templateBasePath, path.resolve('/custom/templates'));
  });

  it('should default schemaBasePath to templateBasePath', () => {
    const result = resolveWorkflowPaths({ repoCwd: '/some/repo' });
    assert.equal(result.schemaBasePath, result.templateBasePath);
  });
});

describe('WorkflowStore split paths', () => {
  let tmpRunDir: string;
  let tmpTemplateDir: string;

  before(async () => {
    tmpRunDir = await makeTmpDir();
    tmpTemplateDir = await makeTmpDir();
    // Create templates in the template dir only
    await fs.mkdir(path.join(tmpTemplateDir, 'templates'), { recursive: true });
    await fs.writeFile(
      path.join(tmpTemplateDir, 'templates', 'test-template.md'),
      '# Test Template\nHello {{name}}',
    );
  });

  after(async () => {
    await removeTmpDir(tmpRunDir);
    await removeTmpDir(tmpTemplateDir);
  });

  it('should load templates from templateBasePath, not runBasePath', async () => {
    const store = new WorkflowStore({
      runBasePath: tmpRunDir,
      templateBasePath: tmpTemplateDir,
    });

    const content = await store.loadTemplate('test-template.md');
    assert.ok(content.includes('# Test Template'));
    assert.ok(content.includes('Hello {{name}}'));
  });

  it('should store run artifacts under runBasePath', async () => {
    const store = new WorkflowStore({
      runBasePath: tmpRunDir,
      templateBasePath: tmpTemplateDir,
    });

    const runId = `test-${randomUUID().slice(0, 6)}`;
    const meta = createDefaultMeta(runId);
    await store.createRun(meta);

    // Verify the run was created under tmpRunDir, not tmpTemplateDir
    const metaPath = path.join(tmpRunDir, 'runs', runId, 'meta.json');
    const exists = await fs.stat(metaPath).then(() => true).catch(() => false);
    assert.ok(exists, `meta.json should exist at ${metaPath}`);

    // Verify it was NOT created under tmpTemplateDir
    const wrongPath = path.join(tmpTemplateDir, 'runs', runId, 'meta.json');
    const wrongExists = await fs.stat(wrongPath).then(() => true).catch(() => false);
    assert.ok(!wrongExists, `meta.json should NOT exist at ${wrongPath}`);
  });

  it('should throw with detailed error when template is missing', async () => {
    const store = new WorkflowStore({
      runBasePath: tmpRunDir,
      templateBasePath: tmpTemplateDir,
    });

    await assert.rejects(
      () => store.loadTemplate('nonexistent.md'),
      (err: Error) => {
        assert.ok(err.message.includes('Template not found: nonexistent.md'));
        assert.ok(err.message.includes('Template root'));
        assert.ok(err.message.includes('Run root'));
        assert.ok(err.message.includes('Hint'));
        return true;
      },
    );
  });

  it('should maintain backward compat with string basePath', async () => {
    // Both runs and templates share the same root
    const unifiedDir = await makeTmpDir();
    try {
      await fs.mkdir(path.join(unifiedDir, 'templates'), { recursive: true });
      await fs.writeFile(
        path.join(unifiedDir, 'templates', 'compat.md'),
        'compat template',
      );

      const store = new WorkflowStore(unifiedDir);
      const content = await store.loadTemplate('compat.md');
      assert.equal(content, 'compat template');

      const runId = `compat-${randomUUID().slice(0, 6)}`;
      await store.createRun(createDefaultMeta(runId));
      const meta = await store.getMeta(runId);
      assert.ok(meta);
    } finally {
      await removeTmpDir(unifiedDir);
    }
  });
});

describe('External repo scenario (integration)', () => {
  let externalRepoDir: string;
  let toolAssetRoot: string;

  before(async () => {
    // Simulate an external repo with NO .claude-workflows/templates/
    externalRepoDir = await makeTmpDir();

    // The tool's built-in asset root (auto-detected)
    toolAssetRoot = resolveBuiltinAssetRoot();
  });

  after(async () => {
    await removeTmpDir(externalRepoDir);
  });

  it('should resolve paths correctly for external repo without templates', () => {
    const paths = resolveWorkflowPaths({ repoCwd: externalRepoDir });

    // repoCwd = external repo
    assert.equal(paths.repoCwd, path.resolve(externalRepoDir));
    // runBasePath = external repo's .claude-workflows
    assert.equal(paths.runBasePath, path.join(path.resolve(externalRepoDir), '.claude-workflows'));
    // templateBasePath = tool's built-in assets (NOT external repo)
    assert.equal(paths.templateBasePath, toolAssetRoot);
  });

  it('should load real templates via split-path WorkflowStore', async () => {
    const paths = resolveWorkflowPaths({ repoCwd: externalRepoDir });
    const store = new WorkflowStore({
      runBasePath: paths.runBasePath,
      templateBasePath: paths.templateBasePath,
    });

    // Should be able to load one of the real templates
    const template = await store.loadTemplate('code-review-pack.md');
    assert.ok(template.length > 0, 'Should load a non-empty template');
  });

  it('should store run artifacts in external repo directory', async () => {
    const paths = resolveWorkflowPaths({ repoCwd: externalRepoDir });
    const store = new WorkflowStore({
      runBasePath: paths.runBasePath,
      templateBasePath: paths.templateBasePath,
    });

    const runId = `ext-${randomUUID().slice(0, 6)}`;
    await store.createRun(createDefaultMeta(runId));

    // Run artifacts should be in the external repo's .claude-workflows/runs/
    const metaPath = path.join(paths.runBasePath, 'runs', runId, 'meta.json');
    const exists = await fs.stat(metaPath).then(() => true).catch(() => false);
    assert.ok(exists, `Run artifact should be at ${metaPath}`);
  });
});
