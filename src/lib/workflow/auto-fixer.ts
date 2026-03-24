/**
 * AutoFixer — Review-and-Fix module (P1b-CR-1).
 *
 * After a code-review workflow completes, AutoFixer:
 * 1. Collects all accepted issues with `fix_instruction` from the ledger.
 * 2. Creates an isolated git worktree to avoid modifying the working tree.
 * 3. Invokes Codex CLI for each fix (grouped by file for efficiency).
 * 4. Generates a diff of all changes for user review.
 *
 * Key design decisions:
 * - **Worktree isolation**: fixes are applied in a separate git worktree,
 *   so the user's working tree is never modified without consent.
 * - **Sequential by default**: fixes are applied one-by-one for safety.
 *   Each fix is committed in the worktree for easy rollback.
 * - **Codex-driven**: the fix_instruction is sent as a prompt to Codex,
 *   which has access to the file context and can apply changes intelligently.
 * - **Non-destructive**: if any fix fails, others can still succeed.
 *   The worktree is preserved for manual inspection.
 *
 * @module workflow/auto-fixer
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ModelInvoker } from './model-invoker.js';
import { WorkflowStore } from './workflow-store.js';
import type { WorkflowEngine } from './workflow-engine.js';
import type { Issue, FixResult, AutoFixOptions } from './types.js';

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────────────────────

/** Default timeout per fix call (5 minutes). */
const DEFAULT_FIX_TIMEOUT_MS = 300_000;

/** Max diff preview length in chars. */
const MAX_DIFF_PREVIEW = 5000;

/** Worktree branch prefix. */
const WORKTREE_BRANCH_PREFIX = 'auto-fix';

// ── AutoFixer ─────────────────────────────────────────────────

export class AutoFixer {
  private readonly store: WorkflowStore;
  private readonly modelInvoker: ModelInvoker;

  constructor(
    /** Git repo root (where worktree will be created). */
    private readonly repoRoot: string,
    /** Reference to the engine (for event emission, not used for fixes). */
    private readonly _engine: WorkflowEngine,
    /** Base path for workflow storage. */
    basePath?: string,
  ) {
    this.store = new WorkflowStore(basePath);
    this.modelInvoker = new ModelInvoker();
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Apply fixes for accepted issues from a completed code-review workflow.
   *
   * @param runId - The workflow run ID to read issues from.
   * @param opts  - Auto-fix options.
   * @returns FixResult with details of what was fixed.
   */
  async applyFixes(runId: string, opts: AutoFixOptions = {}): Promise<FixResult> {
    const codexBackend = opts.codexBackend ?? 'codex';
    const codexTimeoutMs = opts.codexTimeoutMs ?? DEFAULT_FIX_TIMEOUT_MS;

    // 1. Load issue ledger and collect fixable issues
    const ledger = await this.store.loadLedger(runId);
    if (!ledger) {
      throw new Error(`[AutoFixer] Ledger not found for run: ${runId}`);
    }

    const fixableIssues = ledger.issues.filter(
      (issue) => issue.status === 'accepted' && issue.fix_instruction,
    );

    if (fixableIssues.length === 0) {
      return {
        success: true,
        totalCount: 0,
        fixedCount: 0,
        fixedIssueIds: [],
        failedIssueIds: [],
        errors: [],
        worktreePath: '',
        worktreeBranch: '',
        diffPreview: '',
      };
    }

    // 2. Create isolated worktree
    const branchName = `${WORKTREE_BRANCH_PREFIX}/${runId}`;
    const worktreePath = path.join(this.repoRoot, '..', `.auto-fix-${runId}`);

    await this.createWorktree(worktreePath, branchName);

    // 3. Group issues by file for efficient fixes
    const issuesByFile = this.groupByFile(fixableIssues);

    // 4. Apply fixes sequentially
    const fixedIssueIds: string[] = [];
    const failedIssueIds: string[] = [];
    const errors: string[] = [];

    for (const [filePath, issues] of issuesByFile) {
      try {
        console.log(`[AutoFixer] Fixing ${issues.length} issue(s) in ${filePath}...`);

        const prompt = this.buildFixPrompt(filePath, issues);
        const result = await this.modelInvoker.invokeCodex(prompt, {
          timeoutMs: codexTimeoutMs,
          maxRetries: 1,
          backend: codexBackend,
        });

        // Codex runs in the worktree with file access — it modifies files directly
        // We just need to verify it made changes
        const { stdout: diffCheck } = await this.git(worktreePath, ['diff', '--stat']);

        if (diffCheck.trim()) {
          // Commit the fix
          await this.git(worktreePath, ['add', '-A']);
          const commitMsg = `fix: ${issues.map((i) => i.id).join(', ')} — auto-fix via Codex`;
          await this.git(worktreePath, ['commit', '-m', commitMsg]);

          for (const issue of issues) {
            fixedIssueIds.push(issue.id);
          }
          console.log(`[AutoFixer] ✅ Fixed: ${issues.map((i) => i.id).join(', ')}`);
        } else {
          // Codex ran but didn't produce changes — parse its output for a direct patch
          const applied = await this.tryApplyCodexOutput(worktreePath, filePath, result, issues);
          if (applied) {
            for (const issue of issues) {
              fixedIssueIds.push(issue.id);
            }
          } else {
            for (const issue of issues) {
              failedIssueIds.push(issue.id);
            }
            errors.push(`No changes produced for ${filePath} (${issues.map((i) => i.id).join(', ')})`);
          }
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        for (const issue of issues) {
          failedIssueIds.push(issue.id);
        }
        errors.push(`Failed to fix ${filePath}: ${errMsg}`);
        console.error(`[AutoFixer] ❌ Error fixing ${filePath}: ${errMsg}`);
      }
    }

    // 5. Generate diff preview
    const { stdout: fullDiff } = await this.git(worktreePath, [
      'diff', 'HEAD~' + String(Math.max(fixedIssueIds.length > 0 ? issuesByFile.size : 0, 1)), 'HEAD',
    ]).catch(() => ({ stdout: '' }));
    const diffPreview = fullDiff.length > MAX_DIFF_PREVIEW
      ? fullDiff.substring(0, MAX_DIFF_PREVIEW) + `\n... (${fullDiff.length - MAX_DIFF_PREVIEW} more chars)`
      : fullDiff;

    return {
      success: failedIssueIds.length === 0,
      totalCount: fixableIssues.length,
      fixedCount: fixedIssueIds.length,
      fixedIssueIds,
      failedIssueIds,
      errors,
      worktreePath,
      worktreeBranch: branchName,
      diffPreview,
    };
  }

  // ── Private: Worktree Management ────────────────────────────

  /** Create a new git worktree from the current HEAD. */
  private async createWorktree(worktreePath: string, branchName: string): Promise<void> {
    // Clean up if worktree already exists (from a previous failed run)
    try {
      await fs.access(worktreePath);
      console.log(`[AutoFixer] Cleaning up existing worktree: ${worktreePath}`);
      await this.git(this.repoRoot, ['worktree', 'remove', '--force', worktreePath]);
    } catch {
      // Does not exist — good
    }

    // Delete branch if it already exists (from a previous run)
    try {
      await this.git(this.repoRoot, ['branch', '-D', branchName]);
    } catch {
      // Branch doesn't exist — fine
    }

    // Create worktree with a new branch from HEAD
    console.log(`[AutoFixer] Creating worktree: ${worktreePath} (branch: ${branchName})`);
    await this.git(this.repoRoot, ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
  }

  // ── Private: Fix Prompt Building ────────────────────────────

  /** Group issues by their source_file. */
  private groupByFile(issues: Issue[]): Map<string, Issue[]> {
    const map = new Map<string, Issue[]>();
    for (const issue of issues) {
      const file = issue.source_file ?? '(unknown)';
      if (!map.has(file)) map.set(file, []);
      map.get(file)!.push(issue);
    }
    return map;
  }

  /**
   * Build a fix prompt for Codex.
   *
   * The prompt includes:
   * - The file path to modify
   * - All issues in that file with their fix_instructions
   * - Instructions to apply the fixes directly
   */
  private buildFixPrompt(filePath: string, issues: Issue[]): string {
    const issueDescriptions = issues.map((issue, idx) => {
      const lineInfo = issue.source_line_range
        ? ` (lines ${issue.source_line_range.start}-${issue.source_line_range.end})`
        : '';
      return [
        `### Issue ${idx + 1}: ${issue.id} [${issue.severity}]${lineInfo}`,
        `**Description**: ${issue.description}`,
        `**Fix instruction**: ${issue.fix_instruction}`,
      ].join('\n');
    }).join('\n\n');

    return `You are a code fixer. Apply the following fixes to the file \`${filePath}\`.

Read the file, understand the issues, and apply each fix instruction precisely.
Make ONLY the changes described — do not refactor or modify unrelated code.
After applying all fixes, write the modified file back.

## Issues to Fix

${issueDescriptions}

## Instructions

1. Read \`@${filePath}\`
2. Apply each fix instruction above
3. Write the modified file
4. Do NOT change anything else

Respond with "DONE" after applying all fixes.`;
  }

  /**
   * Try to apply Codex output as a direct file modification.
   *
   * If Codex returned a code block with the fixed file content,
   * extract and write it to the worktree.
   */
  private async tryApplyCodexOutput(
    worktreePath: string,
    filePath: string,
    codexOutput: string,
    issues: Issue[],
  ): Promise<boolean> {
    // Look for a fenced code block that might be the full file content
    const codeBlockMatch = /```(?:\w+)?\n([\s\S]+?)\n```/g;
    let lastBlock = '';
    let match: RegExpExecArray | null = null;

    // eslint-disable-next-line no-cond-assign
    while ((match = codeBlockMatch.exec(codexOutput)) !== null) {
      lastBlock = match[1];
    }

    if (!lastBlock) return false;

    // Write the extracted content to the file in the worktree
    const targetPath = path.join(worktreePath, filePath);
    try {
      await fs.writeFile(targetPath, lastBlock, 'utf-8');

      // Check if there's actually a diff
      const { stdout: diff } = await this.git(worktreePath, ['diff', '--stat']);
      if (!diff.trim()) return false;

      // Commit
      await this.git(worktreePath, ['add', filePath]);
      const commitMsg = `fix: ${issues.map((i) => i.id).join(', ')} — auto-fix (extracted output)`;
      await this.git(worktreePath, ['commit', '-m', commitMsg]);
      console.log(`[AutoFixer] ✅ Applied extracted output for ${filePath}`);
      return true;
    } catch {
      return false;
    }
  }

  // ── Private: Git Helper ─────────────────────────────────────

  /** Execute a git command in the specified directory. */
  private async git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8',
    });
  }
}
