/**
 * DiffReader — reads git diff and creates frozen review snapshots.
 *
 * Encapsulates all git CLI calls. Called once at workflow start to produce
 * a {@link ReviewSnapshot} that is persisted and used by all subsequent rounds.
 *
 * Key invariant (INV-4): all file content is retrieved via `git show <blob_sha>`,
 * never via `fs.readFile`. This ensures snapshot consistency across staged/unstaged
 * modes and after resume.
 *
 * @module workflow/diff-reader
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type {
  ReviewScope,
  ReviewSnapshot,
  SnapshotFile,
  ChangedFile,
  ChangeType,
} from './types.js';

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────

/** Sensitive file patterns — excluded by default (audited in excludedFiles). */
const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.secret$/i,
  /\.key$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^credentials\./i,
  /password/i,
  /token/i,
  /^id_rsa/,
  /^id_ed25519/,
];

/** Max file lines before truncation (only diff hunks + context kept). */
const MAX_FILE_LINES = 2000;

/** Max changed files to include full content (rest get diff hunks only). */
const MAX_CHANGED_FILES_FULL_CONTENT = 20;

/** Language inference from file extension. */
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mts': 'typescript', '.mjs': 'javascript', '.cjs': 'javascript', '.cts': 'typescript',
  '.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.go': 'go',
  '.java': 'java', '.kt': 'kotlin', '.cs': 'csharp', '.cpp': 'cpp',
  '.c': 'c', '.h': 'c', '.hpp': 'cpp', '.swift': 'swift',
  '.vue': 'vue', '.svelte': 'svelte', '.php': 'php', '.sh': 'shell',
  '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.xml': 'xml', '.html': 'html', '.css': 'css', '.scss': 'scss',
  '.less': 'less', '.sql': 'sql', '.graphql': 'graphql',
  '.md': 'markdown', '.mdx': 'markdown', '.txt': 'text',
  '.dockerfile': 'dockerfile', '.proto': 'protobuf',
};

// ── DiffReader ───────────────────────────────────────────────────

export class DiffReader {
  constructor(private readonly cwd: string) {}

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Check if cwd is inside a valid git repository.
   * Uses `git rev-parse --is-inside-work-tree` (works with worktrees).
   */
  async isGitRepo(): Promise<boolean> {
    try {
      const { stdout } = await this.git(['rev-parse', '--is-inside-work-tree']);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Create a frozen review snapshot.
   *
 * Called once at workflow start. The snapshot captures the frozen diff,
 * blob SHAs, and preloaded changed file content so later rounds / resume
 * reuse the exact same review context.
   *
   * @param scope - Review scope configuration.
   * @returns Frozen ReviewSnapshot.
   * @throws Error if cwd is not a valid git repo.
   * @throws Error if diff is empty (no changes to review).
   */
  async createSnapshot(scope: ReviewScope): Promise<ReviewSnapshot> {
    // Validate git repo
    if (!(await this.isGitRepo())) {
      throw new Error(`[DiffReader] Not a git repository: ${this.cwd}`);
    }

    // Get HEAD commit SHA
    const headCommit = await this.getHeadCommit();

    // Determine base ref
    const baseRef = this.resolveBaseRef(scope);

    // Get diff args for this scope
    const diffArgs = this.buildDiffArgs(scope);

    // Get full diff text
    const { stdout: diff } = await this.git(['diff', ...diffArgs]);

    // Get name-status for change type parsing
    const { stdout: nameStatusRaw } = await this.git([
      'diff', ...diffArgs, '--name-status',
    ]);

    if (!nameStatusRaw.trim()) {
      throw new Error('[DiffReader] No changes to review — diff is empty.');
    }

    // Get numstat for binary detection and stats
    const { stdout: numstatRaw } = await this.git([
      'diff', ...diffArgs, '--numstat',
    ]);

    // Parse changed files
    const nameStatusEntries = this.parseNameStatus(nameStatusRaw);
    const numstatEntries = this.parseNumstat(numstatRaw);
    const binaryPaths = new Set(
      numstatEntries.filter((e) => e.isBinary).map((e) => e.path),
    );

    // Get per-file diff hunks
    const perFileDiffs = this.splitDiffByFile(diff);

    // Build files + excluded list
    const files: SnapshotFile[] = [];
    const excludedFiles: Array<{ path: string; reason: string }> = [];

    for (const entry of nameStatusEntries) {
      const filePath = entry.newPath ?? entry.path;

      // Check binary
      if (binaryPaths.has(filePath)) {
        excludedFiles.push({ path: filePath, reason: 'binary' });
        continue;
      }

      // Check sensitive
      if (!scope.include_sensitive && this.isSensitiveFile(filePath)) {
        excludedFiles.push({ path: filePath, reason: 'sensitive' });
        continue;
      }

      // Check exclude patterns
      if (scope.exclude_patterns?.some((p) => this.matchGlob(filePath, p))) {
        excludedFiles.push({ path: filePath, reason: `pattern_excluded: ${filePath}` });
        continue;
      }

      // Check include patterns (if specified, only include matching files)
      if (scope.file_patterns && scope.file_patterns.length > 0) {
        if (!scope.file_patterns.some((p) => this.matchGlob(filePath, p))) {
          continue; // Not matching any include pattern — skip silently
        }
      }

      // Path traversal protection
      const resolved = path.resolve(this.cwd, filePath);
      if (!resolved.startsWith(path.resolve(this.cwd))) {
        excludedFiles.push({ path: filePath, reason: 'path_traversal' });
        continue;
      }

      // Get blob SHA based on change type and scope
      let blobSha: string;
      let baseBlobSha: string | undefined;

      try {
        if (entry.changeType === 'deleted') {
          // Deleted file: get blob from base
          blobSha = await this.getBlobSha(entry.path, baseRef, scope);
          baseBlobSha = blobSha;
        } else {
          // A/M/R/C: get blob from head side
          blobSha = await this.getBlobSha(filePath, 'HEAD', scope);
        }
      } catch {
        // Cannot resolve blob — skip file
        excludedFiles.push({ path: filePath, reason: 'blob_not_found' });
        continue;
      }

      // Get per-file stats from numstat
      const stat = numstatEntries.find((s) => s.path === filePath);

      files.push({
        path: filePath,
        old_path: entry.oldPath,
        blob_sha: blobSha,
        base_blob_sha: baseBlobSha,
        change_type: entry.changeType,
        language: DiffReader.inferLanguage(filePath),
      });
    }

    // Filter the raw diff text to remove sections belonging to excluded files.
    // Without this, snapshot.diff contains ~60% noise from excluded files,
    // inflating downstream prompts far beyond budget (P0-1).
    const filteredDiff = this.filterDiffByExcluded(diff, excludedFiles);

    const changedFiles = await this.readFileContents(files, filteredDiff);

    return {
      created_at: new Date().toISOString(),
      head_commit: headCommit,
      base_ref: baseRef,
      scope,
      diff: filteredDiff,
      files,
      changed_files: changedFiles,
      excluded_files: excludedFiles,
    };
  }

  /**
   * Read a single file's content via `git show <blob_sha>`.
   */
  async readFileContent(blobSha: string): Promise<string> {
    const { stdout } = await this.git(['show', blobSha]);
    return stdout;
  }

  /**
   * Batch-read file contents from snapshot files into ChangedFile objects.
   *
   * Respects MAX_CHANGED_FILES_FULL_CONTENT — excess files get diff hunks only.
   *
   * @param files - Snapshot files to read.
   * @param diff - Full diff text (for extracting per-file hunks).
   * @returns Array of ChangedFile with content populated.
   */
  async readFileContents(
    files: SnapshotFile[],
    diff: string,
  ): Promise<ChangedFile[]> {
    const perFileDiffs = this.splitDiffByFile(diff);
    const results: ChangedFile[] = [];

    for (const file of files) {
      const diffHunks = perFileDiffs.get(file.path) ?? '';
      let content: string;

      if (results.length >= MAX_CHANGED_FILES_FULL_CONTENT) {
        content =
          `[Full content omitted: exceeded ${MAX_CHANGED_FILES_FULL_CONTENT} changed files. ` +
          'Showing diff hunks only.]\n\n' +
          diffHunks;
      } else {
        try {
          const raw = await this.readFileContent(file.blob_sha);
          const lineCount = raw.split('\n').length;

          if (lineCount > MAX_FILE_LINES) {
            // Too large — only keep diff hunks context
            content = `[File truncated: ${lineCount} lines. Showing diff hunks only.]\n\n${diffHunks}`;
          } else {
            content = raw;
          }
        } catch {
          content = `[Unable to read file content for ${file.path}]`;
        }
      }

      // Count additions/deletions from diff hunks
      const stats = this.countDiffStats(diffHunks);

      results.push({
        path: file.path,
        old_path: file.old_path,
        content,
        diff_hunks: diffHunks,
        language: file.language,
        stats,
        change_type: file.change_type,
      });
    }

    return results;
  }

  /**
   * Infer programming language from file extension.
   */
  static inferLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    // Special case: Dockerfile
    if (path.basename(filePath).toLowerCase().startsWith('dockerfile')) {
      return 'dockerfile';
    }
    return EXTENSION_LANGUAGE_MAP[ext] ?? 'text';
  }

  // ── Private: git helpers ──────────────────────────────────────

  /** Execute a git command in this.cwd. */
  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, {
      cwd: this.cwd,
      maxBuffer: 50 * 1024 * 1024, // 50 MB for large diffs
      encoding: 'utf-8',
    });
  }

  /** Get HEAD commit SHA. */
  private async getHeadCommit(): Promise<string> {
    const { stdout } = await this.git(['rev-parse', 'HEAD']);
    return stdout.trim();
  }

  /** Resolve the base ref from scope. */
  private resolveBaseRef(scope: ReviewScope): string {
    switch (scope.type) {
      case 'staged':
        return 'HEAD';
      case 'unstaged':
        return 'HEAD';
      case 'commit':
        return `${scope.base_ref ?? 'HEAD'}~1`;
      case 'commit_range':
        return scope.base_ref ?? 'HEAD~1';
      case 'branch':
        return scope.base_ref ?? 'main';
      default:
        return 'HEAD';
    }
  }

  /** Build diff args array from scope. */
  private buildDiffArgs(scope: ReviewScope): string[] {
    switch (scope.type) {
      case 'staged':
        return ['--cached'];
      case 'unstaged':
        return [];
      case 'commit': {
        const ref = scope.base_ref ?? 'HEAD';
        return [`${ref}~1..${ref}`];
      }
      case 'commit_range':
        return [`${scope.base_ref}..${scope.head_ref}`];
      case 'branch':
        return [`${scope.base_ref}...${scope.head_ref}`];
      default:
        return ['--cached'];
    }
  }

  /** Get blob SHA for a file using appropriate strategy for the scope. */
  private async getBlobSha(
    filePath: string,
    ref: string,
    scope: ReviewScope,
  ): Promise<string> {
    if (scope.type === 'staged' && ref === 'HEAD') {
      // Staged mode: read from index (not worktree)
      return this.getBlobShaFromIndex(filePath);
    }

    if (scope.type === 'unstaged' && ref === 'HEAD') {
      // Unstaged mode: hash the working tree file into git objects
      return this.getBlobShaFromWorkTree(filePath);
    }

    // All other cases: read from the specified ref
    return this.getBlobShaFromRef(filePath, ref);
  }

  /** Get blob SHA from git index (staged files). */
  private async getBlobShaFromIndex(filePath: string): Promise<string> {
    const { stdout } = await this.git(['ls-files', '-s', filePath]);
    // Format: "100644 <blob_sha> 0\tpath"
    const match = /^\d+\s+([0-9a-f]+)\s+\d+\t/.exec(stdout.trim());
    if (!match) {
      throw new Error(`[DiffReader] Cannot resolve blob SHA from index for: ${filePath}`);
    }
    return match[1];
  }

  /** Get blob SHA from working tree (unstaged files). */
  private async getBlobShaFromWorkTree(filePath: string): Promise<string> {
    const { stdout } = await this.git(['hash-object', '-w', filePath]);
    return stdout.trim();
  }

  /** Get blob SHA from a specific ref. */
  private async getBlobShaFromRef(filePath: string, ref: string): Promise<string> {
    const { stdout } = await this.git(['ls-tree', ref, '--', filePath]);
    // Format: "100644 blob <sha>\tpath"
    const match = /\d+\s+blob\s+([0-9a-f]+)\t/.exec(stdout.trim());
    if (!match) {
      throw new Error(`[DiffReader] Cannot resolve blob SHA from ref '${ref}' for: ${filePath}`);
    }
    return match[1];
  }

  // ── Private: parsing helpers ──────────────────────────────────

  /** Parse git diff --name-status output. */
  private parseNameStatus(raw: string): Array<{
    path: string;
    oldPath?: string;
    newPath?: string;
    changeType: ChangeType;
  }> {
    const results: Array<{
      path: string;
      oldPath?: string;
      newPath?: string;
      changeType: ChangeType;
    }> = [];

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;

      const parts = line.split('\t');
      const statusCode = parts[0].charAt(0); // R100 → R, C100 → C

      switch (statusCode) {
        case 'A':
          results.push({ path: parts[1], changeType: 'added' });
          break;
        case 'M':
          results.push({ path: parts[1], changeType: 'modified' });
          break;
        case 'D':
          results.push({ path: parts[1], changeType: 'deleted' });
          break;
        case 'R':
          results.push({
            path: parts[2],    // new path is the canonical path
            oldPath: parts[1], // old path for rename tracking
            newPath: parts[2],
            changeType: 'renamed',
          });
          break;
        case 'C':
          results.push({
            path: parts[2],
            oldPath: parts[1],
            newPath: parts[2],
            changeType: 'copied',
          });
          break;
        default:
          // Unknown status — treat as modified
          if (parts[1]) {
            results.push({ path: parts[1], changeType: 'modified' });
          }
      }
    }

    return results;
  }

  /** Parse git diff --numstat output (for binary detection + stats). */
  private parseNumstat(raw: string): Array<{
    path: string;
    additions: number;
    deletions: number;
    isBinary: boolean;
  }> {
    const results: Array<{
      path: string;
      additions: number;
      deletions: number;
      isBinary: boolean;
    }> = [];

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const isBinary = parts[0] === '-' && parts[1] === '-';
      // Handle rename: "old_path => new_path" or "{old => new}/path"
      const filePath = parts[2].includes('=>')
        ? parts[2].replace(/.*=>\s*/, '').replace(/[{}]/g, '').trim()
        : parts[2];

      results.push({
        path: filePath,
        additions: isBinary ? 0 : parseInt(parts[0], 10) || 0,
        deletions: isBinary ? 0 : parseInt(parts[1], 10) || 0,
        isBinary,
      });
    }

    return results;
  }

  /**
   * Remove diff sections for excluded files from the raw diff text.
   *
   * Uses {@link splitDiffByFile} to split the diff into per-file sections,
   * then reassembles only sections whose file path is NOT in the excluded set.
   *
   * @param diff - Full unified diff text.
   * @param excludedFiles - Files excluded from review (with reasons).
   * @returns Filtered diff text with excluded file sections removed.
   */
  private filterDiffByExcluded(
    diff: string,
    excludedFiles: Array<{ path: string; reason: string }>,
  ): string {
    if (excludedFiles.length === 0 || !diff) return diff;

    const excludedPaths = new Set(excludedFiles.map((f) => f.path));
    const perFileDiffs = this.splitDiffByFile(diff);

    const kept: string[] = [];
    for (const [filePath, section] of perFileDiffs) {
      if (!excludedPaths.has(filePath)) {
        kept.push(section);
      }
    }

    return kept.join('');
  }

  /**
   * Split a unified diff into per-file sections.
   * Returns a Map from file path to its diff hunks.
   */
  private splitDiffByFile(diff: string): Map<string, string> {
    const result = new Map<string, string>();
    // Split on "diff --git a/... b/..." headers
    const sections = diff.split(/^(?=diff --git )/m);

    for (const section of sections) {
      if (!section.trim()) continue;

      // Extract file path from "diff --git a/path b/path"
      const headerMatch = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(section);
      if (!headerMatch) continue;

      const filePath = headerMatch[2]; // Use b/ path (new path)
      result.set(filePath, section);
    }

    return result;
  }

  /** Count additions/deletions from diff hunks. */
  private countDiffStats(diffHunks: string): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;

    for (const line of diffHunks.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }

    return { additions, deletions };
  }

  /** Check if a file matches any sensitive pattern. */
  private isSensitiveFile(filePath: string): boolean {
    const basename = path.basename(filePath);
    return SENSITIVE_PATTERNS.some((pattern) => pattern.test(basename));
  }

  /** Simple glob matching (supports * and ** patterns). */
  private matchGlob(filePath: string, pattern: string): boolean {
    // Convert glob to regex
    const regexStr = pattern
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/{{GLOBSTAR}}/g, '.*');
    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(filePath);
  }
}
