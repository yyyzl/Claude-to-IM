/**
 * Workflow Path Resolver — Decouples template assets from run artifacts.
 *
 * Problem: WorkflowStore's single `basePath` conflates three concerns:
 *   1. Template lookup (read-only, tool-bundled)
 *   2. Schema lookup  (read-only, tool-bundled)
 *   3. Run artifacts  (read-write, per-target-repo)
 *
 * When the user reviews an external repo via IM `/workflow`, the `cwd`
 * points to the external repo which has no `.claude-workflows/templates/`.
 * Templates must come from the tool's own asset root instead.
 *
 * This module provides:
 *   - {@link WorkflowPaths} — resolved path tuple
 *   - {@link resolveWorkflowPaths} — one-call resolver with sane defaults
 *   - {@link resolveBuiltinAssetRoot} — locates tool-bundled assets
 *
 * @module workflow/path-resolver
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── Public Types ──────────────────────────────────────────────

/**
 * Resolved workflow path set.
 *
 * Each field serves a distinct, non-overlapping purpose:
 *   - `repoCwd`          — target repository root (for DiffReader / git)
 *   - `runBasePath`      — run artifact storage root (`{dir}/runs/`)
 *   - `templateBasePath` — template lookup root (`{dir}/templates/`)
 *   - `schemaBasePath`   — schema lookup root (`{dir}/schemas/`)
 */
export interface WorkflowPaths {
  /** Target repository root — used by DiffReader and git commands. */
  repoCwd: string;
  /** Run artifact root — stores `runs/{runId}/` subdirectories. */
  runBasePath: string;
  /** Template lookup root — contains `templates/` with prompt .md files. */
  templateBasePath: string;
  /** Schema lookup root — contains `schemas/` with JSON schema files. */
  schemaBasePath: string;
}

/** Options for {@link resolveWorkflowPaths}. */
export interface ResolveWorkflowPathsOptions {
  /** Target repository root (required). */
  repoCwd: string;
  /**
   * Explicit run artifact root.
   * @default `path.join(repoCwd, '.claude-workflows')`
   */
  runBasePath?: string;
  /**
   * Explicit template root — overrides built-in asset resolution.
   * When omitted, falls back to {@link resolveBuiltinAssetRoot}.
   */
  templateBasePath?: string;
  /**
   * Explicit schema root.
   * When omitted, follows the same resolution as templateBasePath.
   */
  schemaBasePath?: string;
}

// ── Core Resolver ─────────────────────────────────────────────

/**
 * Resolve a complete {@link WorkflowPaths} from partial options.
 *
 * Default strategy:
 *   - `runBasePath`      = `repoCwd/.claude-workflows`  (per-repo isolation)
 *   - `templateBasePath` = built-in asset root           (tool-bundled)
 *   - `schemaBasePath`   = same as templateBasePath      (tool-bundled)
 *
 * @throws if built-in asset root cannot be located and no explicit
 *         template path is provided.
 */
export function resolveWorkflowPaths(opts: ResolveWorkflowPathsOptions): WorkflowPaths {
  const repoCwd = path.resolve(opts.repoCwd);
  const runBasePath = opts.runBasePath
    ? path.resolve(opts.runBasePath)
    : path.join(repoCwd, '.claude-workflows');

  const builtinAsset = resolveBuiltinAssetRoot();
  const templateBasePath = opts.templateBasePath
    ? path.resolve(opts.templateBasePath)
    : builtinAsset;
  const schemaBasePath = opts.schemaBasePath
    ? path.resolve(opts.schemaBasePath)
    : templateBasePath;

  return { repoCwd, runBasePath, templateBasePath, schemaBasePath };
}

// ── Built-in Asset Root ───────────────────────────────────────

/** Cached result to avoid repeated FS probes. */
let _builtinAssetRoot: string | null = null;

/**
 * Locate the tool's built-in `.claude-workflows` directory.
 *
 * Resolution order (first hit wins):
 *   1. `$WORKFLOW_ASSET_ROOT` environment variable (explicit override)
 *   2. `dist/lib/workflow/assets` relative to package root
 *      (npm-published / bundled artefact — Phase 2)
 *   3. Walk up from this source file to find the nearest directory
 *      containing `.claude-workflows/templates/` (dev-time fallback)
 *
 * @returns Absolute path to the asset root (the directory that directly
 *          contains `templates/` and `schemas/`).
 * @throws if no asset root can be found.
 */
export function resolveBuiltinAssetRoot(): string {
  if (_builtinAssetRoot) return _builtinAssetRoot;

  // 1. Explicit environment variable
  const envRoot = process.env['WORKFLOW_ASSET_ROOT'];
  if (envRoot) {
    const resolved = path.resolve(envRoot);
    if (hasTemplates(resolved)) {
      _builtinAssetRoot = resolved;
      return resolved;
    }
    // Env var set but invalid — warn and continue
    console.warn(
      `[path-resolver] $WORKFLOW_ASSET_ROOT="${envRoot}" does not contain templates/. Falling back.`,
    );
  }

  // 2. Dist assets (npm publish artefact — Phase 2)
  const packageRoot = findPackageRoot();
  if (packageRoot) {
    const distAssets = path.join(packageRoot, 'dist', 'lib', 'workflow', 'assets');
    if (hasTemplates(distAssets)) {
      _builtinAssetRoot = distAssets;
      return distAssets;
    }
  }

  // 3. Walk up from this file to find .claude-workflows/templates/
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = thisDir;
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, '.claude-workflows');
    if (hasTemplates(candidate)) {
      _builtinAssetRoot = candidate;
      return candidate;
    }
    dir = path.dirname(dir);
  }

  throw new Error(
    '[path-resolver] Cannot locate built-in workflow templates.\n' +
    '  Tried:\n' +
    (envRoot ? `    - $WORKFLOW_ASSET_ROOT = ${envRoot}\n` : '') +
    (packageRoot ? `    - dist assets = ${path.join(packageRoot, 'dist/lib/workflow/assets')}\n` : '') +
    `    - Walk-up from ${thisDir}\n` +
    '  Fix: set $WORKFLOW_ASSET_ROOT or ensure .claude-workflows/templates/ exists in project root.',
  );
}

/**
 * Reset the cached asset root.
 * Primarily for testing — allows re-resolution after env changes.
 */
export function _resetBuiltinAssetRootCache(): void {
  _builtinAssetRoot = null;
}

// ── Private helpers ───────────────────────────────────────────

/** Check whether `dir/templates/` exists and is a directory. */
function hasTemplates(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'templates')).isDirectory();
  } catch {
    return false;
  }
}

/** Find the nearest ancestor directory containing `package.json`. */
function findPackageRoot(): string | null {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = thisDir;
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}
