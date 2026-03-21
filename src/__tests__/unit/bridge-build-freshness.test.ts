import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isClaudeToImDistStale } from '../../lib/bridge/internal/build-freshness.js';

let tmpRoot = '';

function writeFile(root: string, relativePath: string, content = ''): string {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

function setMtime(filePath: string, mtimeMs: number): void {
  const time = new Date(mtimeMs);
  fs.utimesSync(filePath, time, time);
}

describe('isClaudeToImDistStale', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-build-'));
    writeFile(tmpRoot, 'package.json', '{}');
    writeFile(tmpRoot, 'tsconfig.build.json', '{}');
    writeFile(tmpRoot, 'src/lib/workflow/model-invoker.ts', 'export const source = true;');
  });

  after(() => {
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns true when required dist files are missing', () => {
    assert.equal(isClaudeToImDistStale(tmpRoot), true);
  });

  it('returns true when src/lib is newer than dist/lib', () => {
    const srcFile = path.join(tmpRoot, 'src/lib/workflow/model-invoker.ts');
    const packageJson = path.join(tmpRoot, 'package.json');
    const tsconfigBuild = path.join(tmpRoot, 'tsconfig.build.json');
    const distContext = writeFile(tmpRoot, 'dist/lib/bridge/context.js', 'context');
    const distBridge = writeFile(tmpRoot, 'dist/lib/bridge/bridge-manager.js', 'bridge');

    setMtime(packageJson, 1_000);
    setMtime(tsconfigBuild, 1_000);
    setMtime(distContext, 1_000);
    setMtime(distBridge, 1_000);
    setMtime(srcFile, 2_000);

    assert.equal(isClaudeToImDistStale(tmpRoot), true);
  });

  it('returns false when dist/lib is up to date', () => {
    const srcFile = path.join(tmpRoot, 'src/lib/workflow/model-invoker.ts');
    const packageJson = path.join(tmpRoot, 'package.json');
    const tsconfigBuild = path.join(tmpRoot, 'tsconfig.build.json');
    const distContext = writeFile(tmpRoot, 'dist/lib/bridge/context.js', 'context');
    const distBridge = writeFile(tmpRoot, 'dist/lib/bridge/bridge-manager.js', 'bridge');

    setMtime(packageJson, 1_000);
    setMtime(tsconfigBuild, 1_000);
    setMtime(srcFile, 1_000);
    setMtime(distContext, 2_000);
    setMtime(distBridge, 2_000);

    assert.equal(isClaudeToImDistStale(tmpRoot), false);
  });

  it('returns true when dist still contains the known stale timeout marker', () => {
    const srcFile = path.join(tmpRoot, 'src/lib/workflow/model-invoker.ts');
    const packageJson = path.join(tmpRoot, 'package.json');
    const tsconfigBuild = path.join(tmpRoot, 'tsconfig.build.json');
    const distContext = writeFile(tmpRoot, 'dist/lib/bridge/context.js', 'context');
    const distBridge = writeFile(
      tmpRoot,
      'dist/lib/bridge/bridge-manager.js',
      "return (store.getSetting('bridge_session_queue_timeout_ms')) ?? 5 * 60_000;",
    );

    setMtime(packageJson, 1_000);
    setMtime(tsconfigBuild, 1_000);
    setMtime(srcFile, 1_000);
    setMtime(distContext, 2_000);
    setMtime(distBridge, 2_000);

    assert.equal(isClaudeToImDistStale(tmpRoot), true);
  });
});
