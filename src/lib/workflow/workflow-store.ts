/**
 * Artifact Store for workflow runs.
 * Handles all persistence: meta, spec/plan versions, ledger, round artifacts, events, templates.
 *
 * Path responsibilities (split since external-repo support):
 *
 *   runBasePath/                 -- Run artifact storage (per-target-repo)
 *     runs/
 *       {run-id}/
 *         meta.json
 *         spec-v1.md, spec-v2.md, ...
 *         plan-v1.md, plan-v2.md, ...
 *         issue-ledger.json
 *         events.ndjson
 *         rounds/
 *           R1-pack.json, R1-codex-review.md, R1-claude-raw.md, ...
 *
 *   templateBasePath/            -- Prompt templates (tool-bundled, read-only)
 *     templates/
 *
 * Backward compatibility: passing a single string uses it for both paths.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  WorkflowMeta,
  WorkflowEvent,
  IssueLedger,
  ReviewSnapshot,
} from './types.js';

/**
 * Split-path configuration for WorkflowStore.
 *
 * Allows callers to separate run artifacts (per-target-repo)
 * from template/schema assets (tool-bundled).
 */
export interface WorkflowStorePaths {
  /** Root for run artifacts — `{runBasePath}/runs/{runId}/`. */
  runBasePath: string;
  /** Root for template lookup — `{templateBasePath}/templates/{name}`. */
  templateBasePath?: string;
  /** Root for schema lookup — defaults to templateBasePath. */
  schemaBasePath?: string;
}

export class WorkflowStore {
  /** Root for run artifacts (runs/, events, etc.). */
  private readonly runBasePath: string;
  /** Root for template lookup (templates/). */
  private readonly templateBasePath: string;
  /** Root for schema lookup (schemas/). */
  private readonly schemaBasePath: string;

  /**
   * @param basePathOrPaths  Legacy single path (backward compat) or split paths.
   *   - `string`: all directories share the same root (old behavior).
   *   - `WorkflowStorePaths`: explicit split between run artifacts and templates.
   *   - `undefined`: defaults to `.claude-workflows` for everything (old behavior).
   */
  constructor(basePathOrPaths?: string | WorkflowStorePaths) {
    if (typeof basePathOrPaths === 'object' && basePathOrPaths !== null) {
      this.runBasePath = basePathOrPaths.runBasePath;
      this.templateBasePath = basePathOrPaths.templateBasePath ?? basePathOrPaths.runBasePath;
      this.schemaBasePath = basePathOrPaths.schemaBasePath ?? this.templateBasePath;
    } else {
      const bp = basePathOrPaths ?? '.claude-workflows';
      this.runBasePath = bp;
      this.templateBasePath = bp;
      this.schemaBasePath = bp;
    }
  }

  // ── Helper: paths ────────────────────────────────────────────

  private runDir(runId: string): string {
    return path.join(this.runBasePath, 'runs', runId);
  }

  private roundsDir(runId: string): string {
    return path.join(this.runDir(runId), 'rounds');
  }

  // ── Run lifecycle ────────────────────────────────────────────

  /**
   * Create a new run directory and write initial meta.json.
   * Also creates the rounds/ subdirectory.
   */
  async createRun(meta: WorkflowMeta): Promise<void> {
    const dir = this.runDir(meta.run_id);
    await fs.mkdir(path.join(dir, 'rounds'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );
  }

  /**
   * Read run metadata. Returns null if the run directory or meta.json does not exist.
   */
  async getMeta(runId: string): Promise<WorkflowMeta | null> {
    const filePath = path.join(this.runDir(runId), 'meta.json');
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as WorkflowMeta;
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  /**
   * Merge partial updates into existing meta and write back.
   * Always updates `updated_at` to the current ISO timestamp.
   */
  async updateMeta(runId: string, updates: Partial<WorkflowMeta>): Promise<void> {
    const existing = await this.getMeta(runId);
    if (!existing) {
      throw new Error(`[WorkflowStore] Run not found: ${runId}`);
    }
    const merged: WorkflowMeta = {
      ...existing,
      ...updates,
      updated_at: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(this.runDir(runId), 'meta.json'),
      JSON.stringify(merged, null, 2),
      'utf-8',
    );
  }

  // ── Spec / Plan (versioned) ──────────────────────────────────

  /**
   * Save spec content. Auto-increments version if not specified.
   * Naming: spec-v1.md, spec-v2.md, etc.
   * @returns The version number that was written.
   */
  async saveSpec(runId: string, content: string, version?: number): Promise<number> {
    const ver = version ?? (await this.findLatestVersion(runId, 'spec')) + 1;
    const filePath = path.join(this.runDir(runId), `spec-v${ver}.md`);
    await fs.writeFile(filePath, content, 'utf-8');
    return ver;
  }

  /**
   * Load spec content. If version is not given, returns the latest version.
   * Returns null if no spec file exists.
   */
  async loadSpec(runId: string, version?: number): Promise<string | null> {
    const ver = version ?? (await this.findLatestVersion(runId, 'spec'));
    if (ver === 0) return null;
    const filePath = path.join(this.runDir(runId), `spec-v${ver}.md`);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  /**
   * Save plan content. Auto-increments version if not specified.
   * Naming: plan-v1.md, plan-v2.md, etc.
   * @returns The version number that was written.
   */
  async savePlan(runId: string, content: string, version?: number): Promise<number> {
    const ver = version ?? (await this.findLatestVersion(runId, 'plan')) + 1;
    const filePath = path.join(this.runDir(runId), `plan-v${ver}.md`);
    await fs.writeFile(filePath, content, 'utf-8');
    return ver;
  }

  /**
   * Load plan content. If version is not given, returns the latest version.
   * Returns null if no plan file exists.
   */
  async loadPlan(runId: string, version?: number): Promise<string | null> {
    const ver = version ?? (await this.findLatestVersion(runId, 'plan'));
    if (ver === 0) return null;
    const filePath = path.join(this.runDir(runId), `plan-v${ver}.md`);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  // ── Issue Ledger ─────────────────────────────────────────────

  /**
   * Write issue-ledger.json for the given run.
   */
  async saveLedger(runId: string, ledger: IssueLedger): Promise<void> {
    const filePath = path.join(this.runDir(runId), 'issue-ledger.json');
    await fs.writeFile(filePath, JSON.stringify(ledger, null, 2), 'utf-8');
  }

  /**
   * Load the issue ledger. Returns null if not found (first run scenario).
   */
  async loadLedger(runId: string): Promise<IssueLedger | null> {
    const filePath = path.join(this.runDir(runId), 'issue-ledger.json');
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as IssueLedger;
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  // ── Review Snapshot ─────────────────────────────────────────

  /**
   * Save a {@link ReviewSnapshot} for the given run.
   *
   * The snapshot is frozen at workflow start (by DiffReader) and read
   * by all subsequent rounds to guarantee consistent file contents.
   */
  async saveSnapshot(runId: string, snapshot: ReviewSnapshot): Promise<void> {
    const filePath = path.join(this.runDir(runId), 'snapshot.json');
    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  }

  /**
   * Load the {@link ReviewSnapshot} for the given run.
   * Returns null if no snapshot exists (e.g. spec-review workflows).
   */
  async loadSnapshot(runId: string): Promise<ReviewSnapshot | null> {
    const filePath = path.join(this.runDir(runId), 'snapshot.json');
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as ReviewSnapshot;
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  // ── Round artifacts ──────────────────────────────────────────

  /**
   * Save a round artifact.
   * File naming: R{round}-{name} (e.g. R1-pack.json, R2-codex-review.md).
   */
  async saveRoundArtifact(
    runId: string,
    round: number,
    name: string,
    content: string,
  ): Promise<void> {
    const dir = this.roundsDir(runId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `R${round}-${name}`);
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Load a round artifact. Returns null if the file does not exist.
   */
  async loadRoundArtifact(
    runId: string,
    round: number,
    name: string,
  ): Promise<string | null> {
    const filePath = path.join(this.roundsDir(runId), `R${round}-${name}`);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  // ── Run artifacts ────────────────────────────────────────────

  /**
   * Save a run-level artifact directly under the run directory.
   * Useful for final reports and other outputs that are not round-specific.
   */
  async saveRunArtifact(runId: string, name: string, content: string): Promise<void> {
    const filePath = path.join(this.runDir(runId), name);
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Load a run-level artifact from the run directory.
   * Returns null when the artifact does not exist.
   */
  async loadRunArtifact(runId: string, name: string): Promise<string | null> {
    const filePath = path.join(this.runDir(runId), name);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  // ── Events (ndjson append) ───────────────────────────────────

  /**
   * Append a single event as one JSON line to events.ndjson.
   * The file is created if it does not exist.
   */
  async appendEvent(event: WorkflowEvent): Promise<void> {
    const filePath = path.join(this.runDir(event.run_id), 'events.ndjson');
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(filePath, line, 'utf-8');
  }

  /**
   * Load all events from events.ndjson.
   * Returns an empty array if the file does not exist.
   */
  async loadEvents(runId: string): Promise<WorkflowEvent[]> {
    const filePath = path.join(this.runDir(runId), 'events.ndjson');
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if (isNotFoundError(err)) return [];
      throw err;
    }

    const events: WorkflowEvent[] = [];
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        events.push(JSON.parse(trimmed) as WorkflowEvent);
      } catch {
        // Gracefully skip malformed lines (e.g. truncated writes from a crash).
        // This is critical for resume() to work after an unclean shutdown.
        console.warn(
          `[WorkflowStore] Skipping corrupt event line: ${trimmed.substring(0, 120)}`,
        );
      }
    }
    return events;
  }

  // ── Templates ────────────────────────────────────────────────

  /**
   * Load a prompt template from the templates/ directory.
   *
   * Uses `templateBasePath` (tool-bundled assets) which may differ from
   * `runBasePath` (target-repo artifacts). This is critical for external
   * repo reviews where templates live in the tool, not the target repo.
   *
   * THROWS if the template is not found (critical error — templates must exist).
   */
  async loadTemplate(name: string): Promise<string> {
    const filePath = path.join(this.templateBasePath, 'templates', name);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        const details = [
          `[WorkflowStore] Template not found: ${name}`,
          `  Template root : ${path.resolve(this.templateBasePath, 'templates')}`,
          `  Run root      : ${path.resolve(this.runBasePath)}`,
        ];
        if (this.templateBasePath !== this.runBasePath) {
          details.push(
            '  Hint: Template and run paths are split (external repo mode).',
            '  Check that the tool\'s built-in asset root is correctly resolved.',
          );
        } else {
          details.push(
            '  Hint: Template and run paths share the same root.',
            '  If reviewing an external repo, ensure resolveWorkflowPaths() is used.',
          );
        }
        throw new Error(details.join('\n'));
      }
      throw err;
    }
  }

  // ── Private helpers ──────────────────────────────────────────

  /**
   * Find the latest version number for spec or plan files.
   * Scans the run directory for files matching pattern: {prefix}-v{N}.md
   * Returns 0 if no matching files are found.
   */
  private async findLatestVersion(runId: string, prefix: string): Promise<number> {
    const dir = this.runDir(runId);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err: unknown) {
      if (isNotFoundError(err)) return 0;
      throw err;
    }

    const pattern = new RegExp(`^${prefix}-v(\\d+)\\.md$`);
    let maxVersion = 0;

    for (const entry of entries) {
      const match = pattern.exec(entry);
      if (match) {
        const ver = parseInt(match[1], 10);
        if (ver > maxVersion) {
          maxVersion = ver;
        }
      }
    }

    return maxVersion;
  }
}

// ── File-system error detection ──────────────────────────────────

/**
 * Check whether an error is a "file not found" or "directory not found" error.
 * Works with Node.js fs errors (ENOENT).
 */
function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'ENOENT'
  );
}
