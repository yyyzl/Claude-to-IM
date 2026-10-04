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
 * - 失败后停止后续组并保留现场，避免失败残留进入其他候选提交。
 * - 未配置问题回归验证时，修改只标记为候选，不宣称问题已修复。
 *
 * @module workflow/auto-fixer
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
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
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid workflow run ID');
    const ledger = await this.store.loadLedger(runId);
    if (!ledger) throw new Error(`[AutoFixer] Ledger not found for run: ${runId}`);
    const issues = ledger.issues.filter(issue => issue.status === 'accepted' && issue.fix_instruction);
    const attemptId = randomUUID();
    const result: FixResult = {
      success: true, totalCount: issues.length, fixedCount: 0, fixedIssueIds: [],
      proposedIssueIds: [], skippedIssueIds: [], failedIssueIds: [], errors: [],
      attemptId, commits: [], validation: [], fixBaseSha: '', fixHeadSha: '',
      worktreePath: '', worktreeBranch: '', diffPreview: '',
    };
    if (!issues.length) return result;
    const snapshot = await this.store.loadSnapshot(runId);
    if (!snapshot?.head_tree) throw new Error('审查快照缺少可重建的冻结 tree；请重新审查后生成修复，旧工作树不会被清理。');
    if (!/^[a-f0-9]{40,64}$/.test(snapshot.head_tree) || !/^[a-f0-9]{40,64}$/.test(snapshot.head_commit)) throw new Error('Invalid review baseline');
    const headTree = (await this.git(this.repoRoot, ['rev-parse', `${snapshot.head_commit}^{tree}`])).stdout.trim();
    const frozenTree = (await this.git(this.repoRoot, ['cat-file', '-t', snapshot.head_tree])).stdout.trim();
    if (frozenTree !== 'tree') throw new Error('冻结审查基线已不可用，请重新审查');
    // 暂存/未暂存快照使用独立基线提交；后续输出的范围只包含候选修复提交。
    const base = headTree === snapshot.head_tree ? snapshot.head_commit : (await this.git(this.repoRoot, [
      'commit-tree', snapshot.head_tree, '-p', snapshot.head_commit, '-m', `review baseline ${runId}`,
    ])).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error('无法确认修复基线 commit');
    result.fixBaseSha = base;
    result.fixHeadSha = base;
    result.worktreeBranch = `${WORKTREE_BRANCH_PREFIX}/${runId}/${attemptId}`;
    result.worktreePath = path.join(this.repoRoot, '..', `.auto-fix-${runId}-${attemptId}`);
    await this.createWorktree(result.worktreePath, result.worktreeBranch, base);
    const artifactName = `fix-${attemptId}.json`;
    await this.store.saveRunArtifact(runId, artifactName, JSON.stringify(result, null, 2));
    let stopped = false;
    for (const [filePath, group] of this.groupByFile(issues)) {
      if (stopped) { result.skippedIssueIds.push(...group.map(issue => issue.id)); continue; }
      try {
        if (!snapshot.files.some(file => file.path === filePath && file.change_type !== 'deleted')) throw new Error('目标不在已审查快照中');
        await this.validateTarget(result.worktreePath, filePath);
        if ((await this.git(result.worktreePath, ['status', '--porcelain'])).stdout.trim()) throw new Error('修复工作树并非干净状态');
        const before = result.fixHeadSha;
        await this.modelInvoker.invokeCodex(this.buildFixPrompt(filePath, group), {
          timeoutMs: opts.codexTimeoutMs ?? DEFAULT_FIX_TIMEOUT_MS,
          maxRetries: 0, backend: opts.codexBackend ?? 'codex', cwd: result.worktreePath,
        });
        if ((await this.git(result.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim() !== before) throw new Error('模型修改了提交历史，候选需人工检查');
        const tracked = (await this.git(result.worktreePath, ['diff', '--name-only', '-z', 'HEAD', '--'])).stdout;
        const untracked = (await this.git(result.worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout;
        const changed = [...new Set((tracked + untracked).split('\0').filter(Boolean))];
        if (changed.length !== 1 || changed[0] !== filePath) throw new Error('未产生目标文件修改，或修改了审查范围之外的文件');
        await this.validateTarget(result.worktreePath, filePath);
        await this.git(result.worktreePath, ['diff', '--check', 'HEAD', '--']);
        let validated = false;
        if (opts.validate) {
          const validation = await opts.validate(result.worktreePath, group.map(issue => issue.id));
          result.validation.push({ issueIds: group.map(issue => issue.id), ...validation });
          if (!validation.passed) throw new Error('配置的修复验证未通过：' + validation.summary);
          validated = true;
        } else {
          result.validation.push({ issueIds: group.map(issue => issue.id), passed: false, summary: '仅通过范围与补丁检查，未运行问题回归验证' });
        }
        if ((await this.git(result.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim() !== before) throw new Error('验证过程修改了提交历史');
        await this.validateTarget(result.worktreePath, filePath);
        const postValidation = (await this.git(result.worktreePath, ['diff', '--name-only', '-z', 'HEAD', '--'])).stdout;
        const postUntracked = (await this.git(result.worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout;
        const postPaths = [...new Set((postValidation + postUntracked).split('\0').filter(Boolean))];
        if (postPaths.length !== 1 || postPaths[0] !== filePath) throw new Error('验证过程移除了目标修改或引入范围外修改');
        await this.git(result.worktreePath, ['add', '--', filePath]);
        const expectedTree = (await this.git(result.worktreePath, ['write-tree'])).stdout.trim();
        await this.git(result.worktreePath, ['commit', '-m', `fix candidate: ${group.map(issue => issue.id).join(', ')}`]);
        const commit = (await this.git(result.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
        if (!/^[a-f0-9]{40,64}$/.test(commit) || commit === before) throw new Error('未生成可确认的候选提交');
        const parents = (await this.git(result.worktreePath, ['rev-list', '--parents', '-n', '1', commit])).stdout.trim().split(/\s+/);
        const committedPaths = (await this.git(result.worktreePath, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit])).stdout.split('\0').filter(Boolean);
        const committedTree = (await this.git(result.worktreePath, ['rev-parse', `${commit}^{tree}`])).stdout.trim();
        if (parents.length !== 2 || parents[1] !== before || committedPaths.length !== 1 || committedPaths[0] !== filePath || committedTree !== expectedTree) {
          throw new Error('提交钩子或外部操作改变了已检查的候选，保留现场供人工检查');
        }
        result.commits.push(commit);
        result.fixHeadSha = commit;
        result.proposedIssueIds.push(...group.map(issue => issue.id));
        if (validated) result.fixedIssueIds.push(...group.map(issue => issue.id));
      } catch (error) {
        result.success = false;
        result.failedIssueIds.push(...group.map(issue => issue.id));
        result.errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        // 保留失败现场并停止后续组，绝不把残留变更加入下一组提交。
        stopped = true;
      }
      result.fixedCount = result.fixedIssueIds.length;
      await this.store.saveRunArtifact(runId, artifactName, JSON.stringify(result, null, 2));
    }
    const fullDiff = (await this.git(result.worktreePath, ['diff', '--binary', result.fixBaseSha, result.fixHeadSha, '--'])).stdout;
    result.diffPreview = fullDiff.length > MAX_DIFF_PREVIEW ? fullDiff.slice(0, MAX_DIFF_PREVIEW) + '\n…（预览已截断，完整补丁保存在运行产物）' : fullDiff;
    await this.store.saveRunArtifact(runId, `fix-${attemptId}.patch`, fullDiff);
    await this.store.saveRunArtifact(runId, artifactName, JSON.stringify(result, null, 2));
    return result;
  }

  /** 每次尝试创建独立名字；存在的工作树/分支由 git 明确拒绝，不自动删除。 */
  private async createWorktree(worktreePath: string, branchName: string, base: string): Promise<void> {
    await this.git(this.repoRoot, ['worktree', 'add', '-b', branchName, worktreePath, base]);
  }

  private async validateTarget(worktree: string, file: string): Promise<void> {
    const relative = path.relative(worktree, path.resolve(worktree, file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.isAbsolute(file)) throw new Error('修复文件路径越界');
    const [root, actual] = await Promise.all([fs.realpath(worktree), fs.realpath(path.resolve(worktree, file))]);
    const resolved = path.relative(root, actual);
    if (resolved.startsWith('..') || path.isAbsolute(resolved)) throw new Error('修复文件符号链接越界');
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
4. Do NOT change anything else, create commits, or modify Git configuration

Respond with "DONE" after applying all fixes.`;
  }

  // ── Private: Git Helper ─────────────────────────────────────

  /** Execute a git command in the specified directory. */
  private async git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject an explicit fake Git boundary');
    return execFileAsync('git', args, {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8',
    });
  }
}
