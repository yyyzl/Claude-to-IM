/**
 * /workflow 命令处理 — 将 Workflow Engine 集成到 Bridge IM 命令系统。
 *
 * 职责：
 * - 解析 `/workflow <subcommand>` 子命令
 * - 管理每个聊天的活跃工作流实例
 * - 将 WorkflowEngine 事件翻译为 IM 消息推送
 *
 * 设计决策：
 * - 每个 chat 同时只能运行一个工作流（防止资源爆炸）
 * - 工作流在后台异步执行，`/workflow spec-review` / `code-review` 立即返回确认
 * - Engine 实例按需创建（lazy），不在 Bridge 启动时预创建
 * - 事件到消息的映射集中在 `bindProgressEvents()` 中，方便 P2B 卡片化迭代
 * - activeWorkflows 占位在任何 await 之前完成，防止并发 start 竞态
 *
 * @module bridge/internal/workflow-command
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createSpecReviewEngine, createCodeReviewEngine } from '../../workflow/index.js';
import type { WorkflowEngine } from '../../workflow/workflow-engine.js';
import { WorkflowStore } from '../../workflow/workflow-store.js';
import { ReportGenerator } from '../../workflow/report-generator.js';
import { DiffReader } from '../../workflow/diff-reader.js';
import { CODE_REVIEW_PROFILE } from '../../workflow/types.js';
import type { WorkflowConfig, WorkflowEvent, WorkflowMeta, ReviewScope } from '../../workflow/types.js';
import type { BaseChannelAdapter } from '../channel-adapter.js';
import type { InboundMessage, ChannelBinding } from '../types.js';
import { deliver } from '../delivery-layer.js';
import { getBridgeContext } from '../context.js';
import { buildWorkflowCardJson, formatElapsed } from '../markdown/feishu.js';

// ── Types ──────────────────────────────────────────────────────

/** Parsed `/workflow` subcommand. */
export type WorkflowSubcommand =
  | { kind: 'help' }
  | { kind: 'spec-review'; specPath: string; planPath: string; contextPaths: string[]; claudeModel?: string; codexBackend?: string }
  | { kind: 'code-review'; range?: string; branchDiff?: string; excludePatterns?: string[]; contextPaths: string[]; claudeModel?: string; codexBackend?: string }
  | { kind: 'review-fix'; range?: string; branchDiff?: string; excludePatterns?: string[]; contextPaths: string[]; claudeModel?: string; codexBackend?: string }
  | { kind: 'status'; runId?: string }
  | { kind: 'report'; runId: string }
  | { kind: 'resume'; runId: string }
  | { kind: 'stop'; runId?: string };

/** Tracks a running workflow in a specific chat. */
interface RunningWorkflow {
  engine: WorkflowEngine;
  runId: string;
  chatId: string;
  channelType: string;
  startedAt: number;
}

// ── State ──────────────────────────────────────────────────────

/**
 * Active workflows keyed by `${channelType}:${chatId}`.
 * At most one per chat.
 */
const activeWorkflows = new Map<string, RunningWorkflow>();

/** Build the map key for a chat. */
function chatKey(channelType: string, chatId: string): string {
  return `${channelType}:${chatId}`;
}

// ── Subcommand Parser ──────────────────────────────────────────

/**
 * Parse `/workflow` arguments into a typed subcommand.
 *
 * Formats:
 *   /workflow help
 *   /workflow spec-review <spec> <plan> [--context file1,file2]
 *   /workflow code-review [--range A..B] [--branch-diff base] [--exclude pat1,pat2]
 *   /workflow status [run-id]
 *   /workflow resume <run-id>
 *   /workflow stop [run-id]
 */
export function parseWorkflowArgs(argsRaw: string): WorkflowSubcommand {
  const args = argsRaw.trim();
  if (!args || args === 'help') return { kind: 'help' };

  const parts = args.split(/\s+/);
  const sub = parts[0].toLowerCase();

  switch (sub) {
    case 'spec-review':
    case 'code-review':
    case 'review-fix': {
      // Extract common named options first
      let claudeModel: string | undefined;
      let codexBackend: string | undefined;
      let contextPaths: string[] = [];

      const ctxIdx = parts.indexOf('--context');
      if (ctxIdx !== -1 && parts[ctxIdx + 1]) {
        contextPaths = parts[ctxIdx + 1].split(',').filter(Boolean);
      }

      const modelIdx = parts.indexOf('--model');
      if (modelIdx !== -1 && parts[modelIdx + 1]) {
        claudeModel = parts[modelIdx + 1];
      }

      const backendIdx = parts.indexOf('--codex-backend');
      if (backendIdx !== -1 && parts[backendIdx + 1]) {
        codexBackend = parts[backendIdx + 1];
      }

      if (sub === 'code-review' || sub === 'review-fix') {
        let range: string | undefined;
        let branchDiff: string | undefined;
        let excludePatterns: string[] | undefined;

        const rangeIdx = parts.indexOf('--range');
        if (rangeIdx !== -1 && parts[rangeIdx + 1]) {
          range = parts[rangeIdx + 1];
        }

        const branchIdx = parts.indexOf('--branch-diff');
        if (branchIdx !== -1 && parts[branchIdx + 1]) {
          branchDiff = parts[branchIdx + 1];
        }

        const excludeIdx = parts.indexOf('--exclude');
        if (excludeIdx !== -1 && parts[excludeIdx + 1]) {
          excludePatterns = parts[excludeIdx + 1].split(',').filter(Boolean);
        }

        return {
          kind: sub as 'code-review' | 'review-fix',
          range, branchDiff, excludePatterns,
          contextPaths, claudeModel, codexBackend,
        };
      }

      // ── spec-review (requires <spec> <plan>) ──
      if (parts.length < 3 || parts[1].startsWith('--')) return { kind: 'help' };
      const specPath = parts[1];
      const planPath = parts[2];

      return {
        kind: 'spec-review',
        specPath, planPath, contextPaths, claudeModel, codexBackend,
      };
    }

    case 'status':
      return { kind: 'status', runId: parts[1] };

    case 'report': {
      if (!parts[1]) return { kind: 'help' };
      return { kind: 'report', runId: parts[1] };
    }

    case 'resume': {
      if (!parts[1]) return { kind: 'help' };
      return { kind: 'resume', runId: parts[1] };
    }

    case 'stop':
      return { kind: 'stop', runId: parts[1] };

    default:
      return { kind: 'help' };
  }
}

// ── Main Handler ───────────────────────────────────────────────

/**
 * Handle `/workflow` command dispatched from bridge-manager.
 *
 * @param adapter  - Channel adapter for delivery
 * @param msg      - Original inbound message
 * @param args     - Everything after `/workflow `
 * @param binding  - Resolved channel binding (provides cwd)
 */
export async function handleWorkflowCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  args: string,
  binding: ChannelBinding,
): Promise<void> {
  const { store } = getBridgeContext();
  const cwd = binding.workingDirectory || process.cwd();
  const key = chatKey(msg.address.channelType, msg.address.chatId);
  const cmd = parseWorkflowArgs(args);

  // Audit log
  store.insertAuditLog({
    channelType: adapter.channelType,
    chatId: msg.address.chatId,
    direction: 'inbound',
    messageId: msg.messageId,
    summary: `[CMD] /workflow ${args ? args.slice(0, 200) : ''}`.trim(),
  });

  switch (cmd.kind) {
    case 'help':
      await deliverText(adapter, msg, buildHelpText());
      return;

    case 'spec-review':
      await handleStartSpecReview(adapter, msg, cmd, cwd, key);
      return;

    case 'code-review':
      await handleStartCodeReview(adapter, msg, cmd, cwd, key);
      return;

    case 'review-fix':
      await handleStartReviewFix(adapter, msg, cmd, cwd, key);
      return;

    case 'status':
      await handleStatus(adapter, msg, cmd, key, cwd);
      return;

    case 'report':
      await handleReport(adapter, msg, cmd, cwd);
      return;

    case 'resume':
      await handleResume(adapter, msg, cmd, key, cwd);
      return;

    case 'stop':
      await handleStop(adapter, msg, cmd, key);
      return;
  }
}

// ── Subcommand Handlers ────────────────────────────────────────

async function handleStartSpecReview(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  cmd: Extract<WorkflowSubcommand, { kind: 'spec-review' }>,
  cwd: string,
  key: string,
): Promise<void> {
  // ── Guard: only one workflow per chat ──
  // CRITICAL: check + set MUST happen synchronously (before any await)
  // to prevent concurrent workflow starts from both passing the guard.
  if (activeWorkflows.has(key)) {
    const running = activeWorkflows.get(key)!;
    await deliverText(adapter, msg,
      `已有工作流正在运行 (run: <code>${esc(running.runId)}</code>)\n` +
      `使用 <code>/workflow stop</code> 停止后再启动新的。`,
    );
    return;
  }

  // Reserve the slot IMMEDIATELY — no await before this point.
  // Uses null engine as placeholder; replaced with real engine below.
  activeWorkflows.set(key, {
    engine: null as unknown as WorkflowEngine,
    runId: '(reserving)',
    chatId: msg.address.chatId,
    channelType: msg.address.channelType,
    startedAt: Date.now(),
  });

  // From here on, any early return MUST call activeWorkflows.delete(key).
  try {
    // ── Path traversal guard ──
    const specFile = resolveSafePath(cwd, cmd.specPath);
    const planFile = resolveSafePath(cwd, cmd.planPath);
    if (!specFile) {
      await deliverText(adapter, msg, `Spec 路径不在工作目录范围内: <code>${esc(cmd.specPath)}</code>`);
      return;
    }
    if (!planFile) {
      await deliverText(adapter, msg, `Plan 路径不在工作目录范围内: <code>${esc(cmd.planPath)}</code>`);
      return;
    }

    // ── Validate & read files ──
    let spec: string;
    let plan: string;
    try {
      spec = await fs.readFile(specFile, 'utf-8');
    } catch {
      await deliverText(adapter, msg, `Spec 文件不存在或无法读取: <code>${esc(specFile)}</code>`);
      return;
    }
    try {
      plan = await fs.readFile(planFile, 'utf-8');
    } catch {
      await deliverText(adapter, msg, `Plan 文件不存在或无法读取: <code>${esc(planFile)}</code>`);
      return;
    }

    // Read optional context files (skip files outside cwd)
    const contextFiles: Array<{ path: string; content: string }> = [];
    for (const p of cmd.contextPaths) {
      const fullPath = resolveSafePath(cwd, p);
      if (!fullPath) {
        await deliverText(adapter, msg, `Context 路径不在工作目录范围内: <code>${esc(p)}</code>，跳过。`);
        continue;
      }
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        contextFiles.push({ path: p, content });
      } catch {
        await deliverText(adapter, msg, `Context 文件无法读取: <code>${esc(fullPath)}</code>，跳过。`);
      }
    }

    // ── Create engine and upgrade slot ──
    // Pass cwd-based basePath so workflow artifacts live alongside the chat's working directory,
    // not wherever the bot process happens to start.
    const engine = createSpecReviewEngine(path.join(cwd, '.claude-workflows'));

    // Upgrade the placeholder to a real provisional entry with engine.
    activeWorkflows.set(key, {
      engine,
      runId: '(pending)',
      chatId: msg.address.chatId,
      channelType: msg.address.channelType,
      startedAt: Date.now(),
    });

    // Register run_id capture listener (updates provisional entry with real run_id)
    engine.on('workflow_started', (e: WorkflowEvent) => {
      const current = activeWorkflows.get(key);
      // Only update if this engine still owns the slot (guard against stop+re-start)
      if (current && current.engine === engine) {
        activeWorkflows.set(key, { ...current, runId: e.run_id });
      }
    });

    // Bind progress events (message push)
    bindProgressEvents(engine, adapter, msg, key, 'spec-review');

    // Confirm start immediately (non-blocking)
    await deliverText(adapter, msg,
      `正在启动 Spec-Review 工作流...\n` +
      `Spec: <code>${esc(cmd.specPath)}</code>\n` +
      `Plan: <code>${esc(cmd.planPath)}</code>` +
      (contextFiles.length > 0 ? `\nContext: ${contextFiles.length} 个文件` : ''),
    );

    // ── Build config overrides from command-line options ──
    const configOverrides: Partial<WorkflowConfig> = {};
    if (cmd.claudeModel) configOverrides.claude_model = cmd.claudeModel;
    if (cmd.codexBackend) configOverrides.codex_backend = cmd.codexBackend;

    // ── Launch workflow in background (fire-and-forget) ──
    void engine.start({ spec, plan, contextFiles, config: configOverrides }).then(() => {
      // Only delete if this engine still owns the slot
      const current = activeWorkflows.get(key);
      if (current && current.engine === engine) activeWorkflows.delete(key);
    }).catch((err: unknown) => {
      const current = activeWorkflows.get(key);
      if (current && current.engine === engine) activeWorkflows.delete(key);
      const errMsg = err instanceof Error ? err.message : String(err);
      deliverText(adapter, msg, `工作流异常退出: ${esc(errMsg)}`).catch(() => {});
    });

  } catch (err: unknown) {
    // Unexpected error during setup — release the reserved slot
    activeWorkflows.delete(key);
    throw err;
  } finally {
    // If we returned early from within the try block (validation failures),
    // the slot may still be held with a placeholder engine. Clean it up.
    const current = activeWorkflows.get(key);
    if (current && current.engine === (null as unknown as WorkflowEngine)) {
      activeWorkflows.delete(key);
    }
  }
}

async function handleStartCodeReview(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  cmd: Extract<WorkflowSubcommand, { kind: 'code-review' }>,
  cwd: string,
  key: string,
): Promise<void> {
  // ── Guard: only one workflow per chat ──
  if (activeWorkflows.has(key)) {
    const running = activeWorkflows.get(key)!;
    await deliverText(adapter, msg,
      `已有工作流正在运行 (run: <code>${esc(running.runId)}</code>)\n` +
      `使用 <code>/workflow stop</code> 停止后再启动新的。`,
    );
    return;
  }

  // Reserve the slot IMMEDIATELY
  activeWorkflows.set(key, {
    engine: null as unknown as WorkflowEngine,
    runId: '(reserving)',
    chatId: msg.address.chatId,
    channelType: msg.address.channelType,
    startedAt: Date.now(),
  });

  try {
    // ── Build ReviewScope from CLI options ──
    const scope: ReviewScope = buildReviewScope(cmd);

    // ── Read context files ──
    const contextFiles: Array<{ path: string; content: string }> = [];
    for (const p of cmd.contextPaths) {
      const fullPath = resolveSafePath(cwd, p);
      if (!fullPath) {
        await deliverText(adapter, msg, `Context 路径不在工作目录范围内: <code>${esc(p)}</code>，跳过。`);
        continue;
      }
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        contextFiles.push({ path: p, content });
      } catch {
        await deliverText(adapter, msg, `Context 文件无法读取: <code>${esc(fullPath)}</code>，跳过。`);
      }
    }

    // ── Create DiffReader and read snapshot ──
    const diffReader = new DiffReader(cwd);
    let snapshot;
    try {
      snapshot = await diffReader.createSnapshot(scope);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      activeWorkflows.delete(key);
      await deliverText(adapter, msg, `读取 git diff 失败: ${esc(errMsg)}`);
      return;
    }

    if (snapshot.files.length === 0) {
      activeWorkflows.delete(key);
      await deliverText(adapter, msg, '没有发现代码变更，无需审查。');
      return;
    }

    // ── Create engine and upgrade slot ──
    const basePath = path.join(cwd, '.claude-workflows');
    const engine = createCodeReviewEngine(basePath);

    activeWorkflows.set(key, {
      engine,
      runId: '(pending)',
      chatId: msg.address.chatId,
      channelType: msg.address.channelType,
      startedAt: Date.now(),
    });

    // Register run_id capture listener
    engine.on('workflow_started', (e: WorkflowEvent) => {
      const current = activeWorkflows.get(key);
      if (current && current.engine === engine) {
        activeWorkflows.set(key, { ...current, runId: e.run_id });
      }
    });

    // Bind progress events
    bindProgressEvents(engine, adapter, msg, key, 'code-review');

    // Confirm start
    const scopeDesc = formatScopeDescription(scope);
    await deliverText(adapter, msg,
      `正在启动 Code-Review 工作流...\n` +
      `范围: <code>${esc(scopeDesc)}</code>\n` +
      `文件: ${snapshot.files.length} 个` +
      (snapshot.excluded_files.length > 0 ? `（已排除 ${snapshot.excluded_files.length} 个）` : '') +
      (contextFiles.length > 0 ? `\nContext: ${contextFiles.length} 个文件` : ''),
    );

    // ── Build config overrides ──
    const configOverrides: Partial<WorkflowConfig> = {};
    if (cmd.claudeModel) configOverrides.claude_model = cmd.claudeModel;
    if (cmd.codexBackend) configOverrides.codex_backend = cmd.codexBackend;

    // ── Launch workflow with snapshot ──
    // Pass spec/plan as empty strings (code-review doesn't use them;
    // profile.behavior.applyPatches=false ensures they're not read).
    // snapshot is persisted by engine.start() before runLoop begins.
    void (async () => {
      try {
        await engine.start({
          spec: '',
          plan: '',
          contextFiles,
          config: configOverrides,
          profile: CODE_REVIEW_PROFILE,
          snapshot,
        });

        // Cleanup on completion
        const current = activeWorkflows.get(key);
        if (current && current.engine === engine) activeWorkflows.delete(key);
      } catch (err: unknown) {
        const current = activeWorkflows.get(key);
        if (current && current.engine === engine) activeWorkflows.delete(key);
        const errMsg = err instanceof Error ? err.message : String(err);
        deliverText(adapter, msg, `工作流异常退出: ${esc(errMsg)}`).catch(() => {});
      }
    })();

  } catch (err: unknown) {
    activeWorkflows.delete(key);
    throw err;
  } finally {
    const current = activeWorkflows.get(key);
    if (current && current.engine === (null as unknown as WorkflowEngine)) {
      activeWorkflows.delete(key);
    }
  }
}

/**
 * Handle `/workflow review-fix` — code-review + auto-fix via Codex in worktree.
 *
 * Flow: code-review workflow → collect accepted fix_instructions → Codex applies in worktree.
 */
async function handleStartReviewFix(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  cmd: Extract<WorkflowSubcommand, { kind: 'review-fix' }>,
  cwd: string,
  key: string,
): Promise<void> {
  // ── Guard: only one workflow per chat ──
  if (activeWorkflows.has(key)) {
    const running = activeWorkflows.get(key)!;
    await deliverText(adapter, msg,
      `已有工作流正在运行 (run: <code>${esc(running.runId)}</code>)\n` +
      `使用 <code>/workflow stop</code> 停止后再启动新的。`,
    );
    return;
  }

  // Reserve the slot IMMEDIATELY
  activeWorkflows.set(key, {
    engine: null as unknown as WorkflowEngine,
    runId: '(reserving)',
    chatId: msg.address.chatId,
    channelType: msg.address.channelType,
    startedAt: Date.now(),
  });

  try {
    // ── Build ReviewScope from CLI options ──
    const scope: ReviewScope = buildReviewScope(cmd);

    // ── Read context files ──
    const contextFiles: Array<{ path: string; content: string }> = [];
    for (const p of cmd.contextPaths) {
      const fullPath = resolveSafePath(cwd, p);
      if (!fullPath) {
        await deliverText(adapter, msg, `Context 路径不在工作目录范围内: <code>${esc(p)}</code>，跳过。`);
        continue;
      }
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        contextFiles.push({ path: p, content });
      } catch {
        await deliverText(adapter, msg, `Context 文件无法读取: <code>${esc(fullPath)}</code>，跳过。`);
      }
    }

    // ── Create DiffReader and read snapshot ──
    const diffReader = new DiffReader(cwd);
    let snapshot;
    try {
      snapshot = await diffReader.createSnapshot(scope);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      activeWorkflows.delete(key);
      await deliverText(adapter, msg, `读取 git diff 失败: ${esc(errMsg)}`);
      return;
    }

    if (snapshot.files.length === 0) {
      activeWorkflows.delete(key);
      await deliverText(adapter, msg, '没有发现代码变更，无需审查。');
      return;
    }

    // ── Create engine and upgrade slot ──
    const basePath = path.join(cwd, '.claude-workflows');
    const engine = createCodeReviewEngine(basePath);

    activeWorkflows.set(key, {
      engine,
      runId: '(pending)',
      chatId: msg.address.chatId,
      channelType: msg.address.channelType,
      startedAt: Date.now(),
    });

    // Register run_id capture listener
    engine.on('workflow_started', (e: WorkflowEvent) => {
      const current = activeWorkflows.get(key);
      if (current && current.engine === engine) {
        activeWorkflows.set(key, { ...current, runId: e.run_id });
      }
    });

    // Bind progress events
    bindProgressEvents(engine, adapter, msg, key, 'review-fix');

    // Confirm start
    const scopeDesc = formatScopeDescription(scope);
    await deliverText(adapter, msg,
      `🔧 正在启动 Review-and-Fix 工作流...\n` +
      `范围: <code>${esc(scopeDesc)}</code>\n` +
      `文件: ${snapshot.files.length} 个` +
      (snapshot.excluded_files.length > 0 ? `（已排除 ${snapshot.excluded_files.length} 个）` : '') +
      '\n<i>审查完成后将自动使用 Codex 在 worktree 中修复代码</i>',
    );

    // ── Build config overrides ──
    const configOverrides: Partial<WorkflowConfig> = {};
    if (cmd.claudeModel) configOverrides.claude_model = cmd.claudeModel;
    if (cmd.codexBackend) configOverrides.codex_backend = cmd.codexBackend;

    // ── Launch workflow + auto-fix ──
    void (async () => {
      try {
        const runId = await engine.start({
          spec: '',
          plan: '',
          contextFiles,
          config: configOverrides,
          profile: CODE_REVIEW_PROFILE,
          snapshot,
        });

        // ── Auto-fix phase ──
        await deliverText(adapter, msg, '📝 审查完成，开始自动修复...');

        const { AutoFixer } = await import('../../workflow/auto-fixer.js');
        const fixer = new AutoFixer(cwd, engine, basePath);
        const fixResult = await fixer.applyFixes(runId, {
          codexBackend: cmd.codexBackend,
          codexTimeoutMs: configOverrides.codex_timeout_ms,
        });

        if (fixResult.fixedCount > 0) {
          await deliverText(adapter, msg,
            `✅ <b>Auto-fix 完成</b>\n` +
            `修复: ${fixResult.fixedCount}/${fixResult.totalCount} 个问题\n` +
            `Worktree: <code>${esc(fixResult.worktreePath)}</code>\n` +
            `分支: <code>${esc(fixResult.worktreeBranch)}</code>\n\n` +
            `<i>使用 git merge 合并修复，或直接在 worktree 中检查</i>`,
          );
        } else if (fixResult.totalCount > 0) {
          await deliverText(adapter, msg,
            `⚠️ Auto-fix 未能修复任何问题 (共 ${fixResult.totalCount} 个)\n` +
            fixResult.errors.map((e) => `  • ${esc(e)}`).join('\n'),
          );
        } else {
          await deliverText(adapter, msg, '✅ 审查未发现需要修复的问题。');
        }

        // Cleanup
        const current = activeWorkflows.get(key);
        if (current && current.engine === engine) activeWorkflows.delete(key);
      } catch (err: unknown) {
        const current = activeWorkflows.get(key);
        if (current && current.engine === engine) activeWorkflows.delete(key);
        const errMsg = err instanceof Error ? err.message : String(err);
        deliverText(adapter, msg, `工作流异常退出: ${esc(errMsg)}`).catch(() => {});
      }
    })();

  } catch (err: unknown) {
    activeWorkflows.delete(key);
    throw err;
  } finally {
    const current = activeWorkflows.get(key);
    if (current && current.engine === (null as unknown as WorkflowEngine)) {
      activeWorkflows.delete(key);
    }
  }
}

/**
 * Build a {@link ReviewScope} from parsed code-review CLI options.
 */
function buildReviewScope(
  cmd: { range?: string; branchDiff?: string; excludePatterns?: string[] },
): ReviewScope {
  if (cmd.range) {
    // --range A..B → commit_range scope
    const parts = cmd.range.split('..');
    return {
      type: 'commit_range',
      base_ref: parts[0],
      head_ref: parts[1] || 'HEAD',
      exclude_patterns: cmd.excludePatterns,
    };
  }
  if (cmd.branchDiff) {
    // --branch-diff base → branch scope (three-dot diff)
    return {
      type: 'branch',
      base_ref: cmd.branchDiff,
      head_ref: 'HEAD',
      exclude_patterns: cmd.excludePatterns,
    };
  }
  // Default: staged changes
  return {
    type: 'staged',
    exclude_patterns: cmd.excludePatterns,
  };
}

/**
 * Format a human-readable scope description for the start message.
 */
function formatScopeDescription(scope: ReviewScope): string {
  switch (scope.type) {
    case 'staged': return 'staged changes';
    case 'unstaged': return 'unstaged changes';
    case 'commit': return `commit (${scope.head_ref ?? 'HEAD'})`;
    case 'commit_range': return `range (${scope.base_ref}..${scope.head_ref})`;
    case 'branch': return `branch diff (${scope.base_ref}...${scope.head_ref ?? 'HEAD'})`;
    default: return scope.type;
  }
}

async function handleStatus(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  cmd: Extract<WorkflowSubcommand, { kind: 'status' }>,
  key: string,
  cwd: string,
): Promise<void> {
  const running = activeWorkflows.get(key);

  if (cmd.runId) {
    // Query specific run from store — use cwd-based path to match start's storage location.
    await deliverRunStatus(adapter, msg, cmd.runId, cwd);
    return;
  }

  if (running) {
    await deliverRunStatus(adapter, msg, running.runId, cwd);
  } else {
    await deliverText(
      adapter,
      msg,
      '当前聊天没有运行中的工作流。\n使用 <code>/workflow spec-review &lt;spec&gt; &lt;plan&gt;</code> 或 <code>/workflow code-review</code> 启动。',
    );
  }
}

/**
 * Handle `/workflow report <run-id>` — deliver the full code-review report.
 *
 * Reads the persisted Markdown report from the workflow store. If it doesn't
 * exist yet (e.g. workflow still running), generates it on the fly.
 *
 * Long reports are chunked into segments that respect IM platform message
 * length limits (≈4000 chars per segment for Feishu rich text).
 */
async function handleReport(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  cmd: Extract<WorkflowSubcommand, { kind: 'report' }>,
  cwd: string,
): Promise<void> {
  try {
    // ISS-008 fix: validate runId format to prevent path traversal attacks.
    // Only allow the expected YYYYMMDD-xxxxxx format.
    if (!/^[0-9]{8}-[a-f0-9]{6}$/.test(cmd.runId)) {
      await deliverText(adapter, msg, `无效的工作流 ID 格式: <code>${esc(cmd.runId)}</code>`);
      return;
    }

    const basePath = path.join(cwd, '.claude-workflows');
    const store = new WorkflowStore(basePath);
    const meta = await store.getMeta(cmd.runId);

    if (!meta) {
      await deliverText(adapter, msg, `未找到工作流: <code>${esc(cmd.runId)}</code>`);
      return;
    }

    // ISS-004: Only code-review workflows have reports.
    if (meta.workflow_type !== 'code-review') {
      await deliverText(adapter, msg, `该工作流类型 (${esc(meta.workflow_type ?? 'unknown')}) 不支持报告查看。仅 code-review 工作流生成报告。`);
      return;
    }

    // Try to read persisted report first
    let markdown: string | null = null;
    try {
      // WorkflowStore persists runs under {basePath}/runs/{runId}/
      const reportPath = path.join(basePath, 'runs', cmd.runId, 'code-review-report.md');
      markdown = await fs.readFile(reportPath, 'utf-8');
    } catch {
      // Not persisted — generate on the fly
    }

    // Fallback: generate report on the fly
    if (!markdown) {
      try {
        const generator = new ReportGenerator(store);
        const result = await generator.generate(cmd.runId);
        markdown = result.markdown;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await deliverText(adapter, msg, `生成报告失败: ${esc(errMsg)}`);
        return;
      }
    }

    // ISS-003 fix: when workflow is still running, prepend a clear disclaimer
    // so users don't mistake an interim snapshot for a final conclusion.
    if (meta.status !== 'completed') {
      markdown = `> ⚠️ **Interim Report** — 工作流仍在运行中 (Round ${meta.current_round}/${meta.config?.max_rounds ?? '?'})，` +
        `以下结论可能随后续轮次变化。\n\n` + markdown;
    }

    // Chunk the report for delivery (Feishu rich text limit ~4000 chars).
    // ISS-011 fix: use a conservative limit that accounts for worst-case
    // esc() expansion (& → &amp; is 5x, but average expansion is ~1.3x)
    // and <pre>/<i> wrapper overhead (~60 chars). 2800 with ~1.4x expansion
    // yields ~3920 — safely under the 4000-char platform limit.
    const MAX_CHUNK = 2800;
    const chunks = chunkMarkdownReport(markdown, MAX_CHUNK);

    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `<i>[${i + 1}/${chunks.length}]</i>\n` : '';
      // Wrap in <pre> for monospace rendering of Markdown tables
      await deliverText(adapter, msg, `${prefix}<pre>${esc(chunks[i])}</pre>`);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await deliverText(adapter, msg, `读取报告失败: ${esc(errMsg)}`);
  }
}

/**
 * Split a Markdown report into chunks that respect a maximum character limit.
 *
 * Splits at line boundaries, and handles individual lines that exceed the
 * limit by splitting them at character boundaries.
 *
 * ISS-002 fix: handles oversized single lines instead of emitting chunks
 * larger than maxChunkSize.
 * ISS-006 fix: accounts for esc() HTML entity expansion (worst case: each
 * char becomes 4x for '&' → '&amp;') and <pre>/<i> wrapper overhead.
 */
function chunkMarkdownReport(markdown: string, maxChunkSize: number): string[] {
  if (markdown.length <= maxChunkSize) return [markdown];

  const chunks: string[] = [];
  const lines = markdown.split('\n');
  let current = '';

  for (const line of lines) {
    // If adding this line would exceed the limit, flush current chunk
    if (current.length + line.length + 1 > maxChunkSize && current.length > 0) {
      chunks.push(current.trimEnd());
      current = '';
    }

    // ISS-002: If a single line itself exceeds the limit, split it
    if (line.length > maxChunkSize) {
      // Flush any remaining content first
      if (current.trim()) {
        chunks.push(current.trimEnd());
        current = '';
      }
      // Split the oversized line into maxChunkSize segments
      for (let offset = 0; offset < line.length; offset += maxChunkSize) {
        chunks.push(line.substring(offset, offset + maxChunkSize));
      }
    } else {
      current += (current ? '\n' : '') + line;
    }
  }

  if (current.trim()) {
    chunks.push(current.trimEnd());
  }

  return chunks.length > 0 ? chunks : [markdown.substring(0, maxChunkSize)];
}

async function handleResume(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  cmd: Extract<WorkflowSubcommand, { kind: 'resume' }>,
  key: string,
  cwd: string,
): Promise<void> {
  // Guard: no concurrent workflow
  if (activeWorkflows.has(key)) {
    const running = activeWorkflows.get(key)!;
    await deliverText(adapter, msg,
      `已有工作流正在运行 (run: <code>${esc(running.runId)}</code>)\n先使用 <code>/workflow stop</code> 停止。`,
    );
    return;
  }

  // Use cwd-based basePath to match start's storage location.
  // Determine engine type from persisted meta.
  const basePath = path.join(cwd, '.claude-workflows');
  const resumeStore = new WorkflowStore(basePath);
  const resumeMeta = await resumeStore.getMeta(cmd.runId);
  const resumeType: WorkflowProgressState['workflowType'] =
    resumeMeta?.workflow_type === 'code-review' ? 'code-review' : 'spec-review';
  const engine = resumeType === 'code-review'
    ? createCodeReviewEngine(basePath)
    : createSpecReviewEngine(basePath);
  bindProgressEvents(engine, adapter, msg, key, resumeType);

  activeWorkflows.set(key, {
    engine,
    runId: cmd.runId,
    chatId: msg.address.chatId,
    channelType: msg.address.channelType,
    startedAt: Date.now(),
  });

  await deliverText(adapter, msg, `正在恢复工作流: <code>${esc(cmd.runId)}</code>`);

  // Launch resume in background
  void engine.resume(cmd.runId).then(() => {
    const current = activeWorkflows.get(key);
    if (current && current.engine === engine) activeWorkflows.delete(key);
  }).catch((err: unknown) => {
    const current = activeWorkflows.get(key);
    if (current && current.engine === engine) activeWorkflows.delete(key);
    const errMsg = err instanceof Error ? err.message : String(err);
    deliverText(adapter, msg, `工作流恢复失败: ${esc(errMsg)}`).catch(() => {});
  });
}

async function handleStop(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  cmd: Extract<WorkflowSubcommand, { kind: 'stop' }>,
  key: string,
): Promise<void> {
  // If a specific run-id is provided, look it up; otherwise use the active workflow.
  const running = activeWorkflows.get(key);

  if (cmd.runId && (!running || running.runId !== cmd.runId)) {
    // Explicit run-id that doesn't match the active workflow (or no active workflow).
    await deliverText(adapter, msg,
      `未找到运行中的工作流: <code>${esc(cmd.runId)}</code>`,
    );
    return;
  }

  if (!running) {
    await deliverText(adapter, msg, '当前聊天没有运行中的工作流。');
    return;
  }

  try {
    // stop = graceful pause (engine can be resumed later).
    // The command is named "stop" for user simplicity; internally it's a pause.
    await running.engine.pause(running.runId);
    activeWorkflows.delete(key);
    await deliverText(adapter, msg,
      `工作流已停止 (run: <code>${esc(running.runId)}</code>)\n` +
      `如需继续，使用 <code>/workflow resume ${esc(running.runId)}</code> 恢复。`,
    );
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await deliverText(adapter, msg, `停止工作流失败: ${esc(errMsg)}`);
  }
}

// ── Event → IM Message Binding ─────────────────────────────────

/**
 * State tracked for each round of the workflow.
 * Used to build the aggregated card markdown.
 */
interface RoundProgress {
  codex: 'pending' | 'running' | 'done';
  codexFindings?: number;
  codexAssessment?: string;
  newIssues?: number;
  highCritical?: number;
  claude: 'pending' | 'running' | 'done';
  claudeDecision?: { accepted: number; rejected: number; deferred: number; resolved: number };
  specUpdated?: boolean;
  planUpdated?: boolean;
  warnings: string[];
}

/**
 * Full progress state for a workflow run.
 * Accumulated across events and re-rendered into the card on each update.
 */
interface WorkflowProgressState {
  runId: string;
  currentRound: number;
  rounds: Map<number, RoundProgress>;
  termination?: { reason: string; details?: string };
  humanReview?: { reason?: string };
  startedAt: number;
  /** Workflow type — used to render the correct card header title. */
  workflowType: 'spec-review' | 'code-review' | 'review-fix';
  /** Whether the adapter supports workflow cards (detected once). */
  cardMode: boolean;
  /** Whether the card has been created yet. */
  cardCreated: boolean;
  /** Debounce timer for card updates (prevents rapid successive API calls). */
  updateTimer: ReturnType<typeof setTimeout> | null;
}

/** Debounce interval for card updates (ms). */
const CARD_UPDATE_DEBOUNCE_MS = 500;

/**
 * Render the progress state into markdown for the card body.
 */
function renderProgressMarkdown(state: WorkflowProgressState): string {
  const lines: string[] = [];
  lines.push(`**Run:** \`${state.runId}\``);
  lines.push('');

  for (const [num, round] of [...state.rounds.entries()].sort((a, b) => a[0] - b[0])) {
    const isActive = num === state.currentRound && !state.termination && !state.humanReview;
    const roundIcon = isActive ? '⏳' : '✅';
    lines.push(`${roundIcon} **第 ${num} 轮**`);

    // Codex
    if (round.codex === 'running') {
      lines.push('  🔍 Codex 审查中...');
    } else if (round.codex === 'done') {
      const count = round.codexFindings ?? '?';
      const assess =
        round.codexAssessment === 'lgtm' ? ' 👍' :
        round.codexAssessment === 'major_issues' ? ' ⚠️' : '';
      lines.push(`  🔍 Codex: **${count}** 个问题${assess}`);
    }

    // Issue matching
    if (round.newIssues != null && round.newIssues > 0) {
      const hc = round.highCritical
        ? ` (🔴 Critical/High: **${round.highCritical}**)`
        : '';
      lines.push(`  📊 新增 **${round.newIssues}** 个问题${hc}`);
    }

    // Claude
    if (round.claude === 'running') {
      lines.push('  🤔 Claude 决策中...');
    } else if (round.claude === 'done' && round.claudeDecision) {
      const d = round.claudeDecision;
      const parts: string[] = [];
      if (d.accepted) parts.push(`${d.accepted}✓`);
      if (d.resolved) parts.push(`${d.resolved}↺`);
      if (d.rejected) parts.push(`${d.rejected}✗`);
      if (d.deferred) parts.push(`${d.deferred}⏳`);
      lines.push(`  🤔 Claude: ${parts.length > 0 ? parts.join(' ') : '已完成'}`);

      const updates: string[] = [];
      if (round.specUpdated) updates.push('spec');
      if (round.planUpdated) updates.push('plan');
      if (updates.length > 0) lines.push(`  📝 已更新: ${updates.join(', ')}`);
    }

    // Warnings for this round
    for (const w of round.warnings) {
      lines.push(`  ⚠️ ${w}`);
    }

    lines.push('');
  }

  // Termination
  if (state.termination) {
    lines.push(`⏹ **终止判定**: ${state.termination.reason}`);
    if (state.termination.details) lines.push(state.termination.details);
    lines.push('');
  }

  // Human review
  if (state.humanReview) {
    lines.push('⚠️ **需要人工审查**');
    if (state.humanReview.reason) lines.push(`原因: ${state.humanReview.reason}`);
    lines.push(`使用 \`/workflow resume ${state.runId}\` 继续`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Render the final completion summary markdown.
 */
function renderCompletionMarkdown(
  state: WorkflowProgressState,
  data: {
    total_rounds?: number;
    total_issues?: number;
    reason?: string;
    severity?: { critical?: number; high?: number; medium?: number; low?: number };
    status?: { open?: number; accepted?: number; rejected?: number; deferred?: number; resolved?: number };
    report_markdown_path?: string;
    report_json_path?: string;
  },
): string {
  const lines: string[] = [];

  // Include the existing round progress first
  lines.push(renderProgressMarkdown(state));
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('🎉 **工作流完成！**');
  if (data.reason) lines.push(`终止原因: ${data.reason}`);
  if (data.total_rounds) lines.push(`轮次: ${data.total_rounds}`);
  if (data.total_issues != null) lines.push(`Issue 总数: **${data.total_issues}**`);

  if (data.severity) {
    const s = data.severity;
    const parts: string[] = [];
    if (s.critical) parts.push(`🔴 Critical: ${s.critical}`);
    if (s.high) parts.push(`🟠 High: ${s.high}`);
    if (s.medium) parts.push(`🟡 Medium: ${s.medium}`);
    if (s.low) parts.push(`🟢 Low: ${s.low}`);
    if (parts.length > 0) lines.push(`严重度: ${parts.join(' · ')}`);
  }

  if (data.status) {
    const st = data.status;
    const parts: string[] = [];
    if (st.open) parts.push(`open: ${st.open}`);
    if (st.resolved) parts.push(`resolved: ${st.resolved}`);
    if (st.accepted) parts.push(`accepted: ${st.accepted}`);
    if (st.rejected) parts.push(`rejected: ${st.rejected}`);
    if (st.deferred) parts.push(`deferred: ${st.deferred}`);
    if (parts.length > 0) lines.push(`状态: ${parts.join(' · ')}`);
  }

  if (data.report_markdown_path || data.report_json_path) {
    lines.push('报告:');
    if (data.report_markdown_path) lines.push(`- Markdown: \`${data.report_markdown_path}\``);
    if (data.report_json_path) lines.push(`- JSON: \`${data.report_json_path}\``);
  }

  return lines.join('\n');
}

/**
 * Get or create a RoundProgress entry for the given round.
 */
function ensureRound(state: WorkflowProgressState, round: number): RoundProgress {
  let r = state.rounds.get(round);
  if (!r) {
    r = { codex: 'pending', claude: 'pending', warnings: [] };
    state.rounds.set(round, r);
  }
  return r;
}

/**
 * Subscribe to WorkflowEngine events and push progress via a single
 * updatable card (when supported) or fallback to individual text messages.
 *
 * This is the **single point** where events become messages.
 * Card mode: all events update one card. Text mode: each event sends a text message.
 */
/**
 * Map workflow type to the card header title shown during execution.
 */
function workflowHeaderTitle(type: WorkflowProgressState['workflowType']): string {
  switch (type) {
    case 'code-review': return '🔍 Code-Review 工作流';
    case 'review-fix':  return '🔧 Review-Fix 工作流';
    case 'spec-review': return '🔄 Spec-Review 工作流';
  }
}

function bindProgressEvents(
  engine: WorkflowEngine,
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  _key: string,
  workflowType: WorkflowProgressState['workflowType'] = 'spec-review',
): void {
  // Detect card support
  const supportsCards = typeof adapter.createWorkflowCard === 'function';

  // ── Text-mode fallback (original behaviour) ──
  const pushText = (text: string): void => {
    deliverText(adapter, msg, text).catch((err) => {
      console.error('[workflow-command] Failed to push progress message:', err);
    });
  };

  // ── Card-mode state ──
  const state: WorkflowProgressState = {
    runId: '(pending)',
    currentRound: 0,
    rounds: new Map(),
    startedAt: Date.now(),
    workflowType,
    cardMode: supportsCards,
    cardCreated: false,
    updateTimer: null,
  };

  /**
   * Schedule a debounced card update.
   * Events that fire in quick succession (e.g. codex_completed + issue_matching)
   * are batched into a single API call.
   */
  const scheduleCardUpdate = (): void => {
    if (!state.cardMode) return;
    if (state.updateTimer) clearTimeout(state.updateTimer);
    state.updateTimer = setTimeout(() => {
      state.updateTimer = null;
      flushCardUpdate();
    }, CARD_UPDATE_DEBOUNCE_MS);
  };

  /**
   * Immediately flush the card update.
   */
  const flushCardUpdate = (): void => {
    if (!state.cardMode || !state.cardCreated) return;

    const elapsed = formatElapsed(Date.now() - state.startedAt);
    const content = renderProgressMarkdown(state);
    const cardJson = buildWorkflowCardJson(content, {
      headerTitle: workflowHeaderTitle(state.workflowType),
      footer: { status: '🔄 运行中', elapsed },
      runId: state.runId,
      isRunning: true,
    });

    adapter.updateWorkflowCard?.(msg.address.chatId, cardJson).catch((err) => {
      console.error('[workflow-command] Failed to update workflow card:', err);
    });
  };

  /**
   * Create the initial card (called on workflow_started).
   */
  const createCard = (): void => {
    if (!state.cardMode || state.cardCreated) return;

    const content = renderProgressMarkdown(state);
    const cardJson = buildWorkflowCardJson(content, {
      headerTitle: workflowHeaderTitle(state.workflowType),
      footer: { status: '🔄 启动中', elapsed: '0s' },
      runId: state.runId,
      isRunning: true,
    });

    state.cardCreated = true; // optimistic — prevent double creation
    adapter.createWorkflowCard?.(msg.address.chatId, cardJson, msg.messageId)
      ?.then((cardId) => {
        if (!cardId) {
          // Card creation failed — degrade to text mode
          console.warn('[workflow-command] Card creation failed, falling back to text mode');
          state.cardMode = false;
          state.cardCreated = false;
          // Re-send the start message as text
          pushText(`🚀 <b>工作流已启动</b> (run: <code>${esc(state.runId)}</code>)`);
        } else {
          // Card created successfully — flush any pending updates accumulated during creation
          flushCardUpdate();
        }
      })
      ?.catch(() => {
        state.cardMode = false;
        state.cardCreated = false;
      });
  };

  /**
   * Finalize the card with terminal content (completed / failed / paused).
   */
  const finalizeCard = (content: string, headerTitle: string, headerTemplate: string, footerStatus: string): void => {
    if (state.updateTimer) {
      clearTimeout(state.updateTimer);
      state.updateTimer = null;
    }

    const elapsed = formatElapsed(Date.now() - state.startedAt);
    const isCompleted = footerStatus.includes('✅') || footerStatus.includes('完成');
    // ISS-004: Only show report button for code-review workflows.
    // Previously all completed workflows got hasReport:true, causing
    // spec-review to show a misleading "View Report" button.
    // ISS-001 fix: review-fix also generates code-review reports
    const hasReport = isCompleted && (state.workflowType === 'code-review' || state.workflowType === 'review-fix');
    const cardJson = buildWorkflowCardJson(content, {
      headerTitle,
      headerTemplate,
      footer: { status: footerStatus, elapsed },
      runId: state.runId,
      isRunning: false,
      hasReport,
    });

    adapter.finalizeWorkflowCard?.(msg.address.chatId, cardJson)?.catch((err) => {
      console.error('[workflow-command] Failed to finalize workflow card:', err);
    });
  };

  // ── Event subscriptions ──────────────────────────────────────

  engine.on('workflow_started', (e: WorkflowEvent) => {
    state.runId = e.run_id;
    if (state.cardMode) {
      createCard();
    } else {
      pushText(`🚀 <b>工作流已启动</b> (run: <code>${esc(e.run_id)}</code>)`);
    }
  });

  engine.on('round_started', (e: WorkflowEvent) => {
    state.currentRound = e.round;
    ensureRound(state, e.round);
    if (state.cardMode) {
      scheduleCardUpdate();
    } else {
      pushText(`📋 <b>第 ${e.round} 轮</b>审查开始`);
    }
  });

  engine.on('codex_review_started', (e: WorkflowEvent) => {
    const round = ensureRound(state, e.round);
    round.codex = 'running';
    if (state.cardMode) {
      scheduleCardUpdate();
    } else {
      pushText('🔍 Codex 审查中...');
    }
  });

  engine.on('codex_review_completed', (e: WorkflowEvent) => {
    const data = e.data as { findings_count?: number; overall_assessment?: string };
    const round = ensureRound(state, e.round);
    round.codex = 'done';
    round.codexFindings = data.findings_count;
    round.codexAssessment = data.overall_assessment;

    if (state.cardMode) {
      scheduleCardUpdate();
    } else {
      const count = data.findings_count ?? '?';
      const assessment = data.overall_assessment ?? '';
      const assessLabel =
        assessment === 'lgtm' ? ' 👍' :
        assessment === 'major_issues' ? ' ⚠️' : '';
      pushText(`✅ Codex 审查完成，发现 <b>${count}</b> 个问题${assessLabel}`);
    }
  });

  engine.on('issue_matching_completed', (e: WorkflowEvent) => {
    const data = e.data as { new_issues?: number; new_high_critical?: number };
    const round = ensureRound(state, e.round);
    round.newIssues = data.new_issues;
    round.highCritical = data.new_high_critical;

    if (state.cardMode) {
      scheduleCardUpdate();
    } else {
      const newCount = data.new_issues ?? 0;
      const hcCount = data.new_high_critical ?? 0;
      if (newCount > 0) {
        pushText(
          `📊 新增 <b>${newCount}</b> 个问题` +
          (hcCount > 0 ? ` (🔴 Critical/High: <b>${hcCount}</b>)` : ''),
        );
      }
    }
  });

  engine.on('context_degraded', (e: WorkflowEvent) => {
    const data = e.data as { level?: string; target?: string; original_size?: number; final_size?: number; phase?: string };
    const levelLabel = data.level === 'hard_truncated' ? '⚠️ 硬截断' : data.level === 'truncated' ? '⚠️ 截断' : '📉 降级为 hunks';
    const targetLabel = data.target === 'codex' ? 'Codex' : 'Claude';
    const phaseName = data.phase === 'codex_review' ? '审查' : '决策';
    const sizeInfo = data.original_size && data.final_size
      ? ` (${Math.round(data.original_size / 1024)}KB → ${Math.round(data.final_size / 1024)}KB)`
      : '';
    // Only push text — cards already show real-time progress, no need to update card for this
    pushText(`${levelLabel} ${targetLabel} ${phaseName}上下文已降级${sizeInfo}`);
  });

  engine.on('claude_decision_started', (e: WorkflowEvent) => {
    const round = ensureRound(state, e.round);
    round.claude = 'running';
    if (state.cardMode) {
      scheduleCardUpdate();
    } else {
      pushText('🤔 Claude 决策中...');
    }
  });

  engine.on('claude_decision_completed', (e: WorkflowEvent) => {
    const data = e.data as {
      accepted?: number; rejected?: number; deferred?: number; resolved?: number;
      spec_updated?: boolean; plan_updated?: boolean;
    };
    const round = ensureRound(state, e.round);
    round.claude = 'done';
    round.claudeDecision = {
      accepted: data.accepted ?? 0,
      rejected: data.rejected ?? 0,
      deferred: data.deferred ?? 0,
      resolved: data.resolved ?? 0,
    };
    round.specUpdated = data.spec_updated;
    round.planUpdated = data.plan_updated;

    if (state.cardMode) {
      scheduleCardUpdate();
    } else {
      const parts: string[] = [];
      if (data.accepted) parts.push(`accepted: ${data.accepted}`);
      if (data.resolved) parts.push(`resolved: ${data.resolved}`);
      if (data.rejected) parts.push(`rejected: ${data.rejected}`);
      if (data.deferred) parts.push(`deferred: ${data.deferred}`);
      const updates: string[] = [];
      if (data.spec_updated) updates.push('spec');
      if (data.plan_updated) updates.push('plan');
      pushText(
        `✅ Claude 决策完成` +
        (parts.length > 0 ? ` (${parts.join(', ')})` : '') +
        (updates.length > 0 ? `\n📝 已更新: ${updates.join(', ')}` : ''),
      );
    }
  });

  engine.on('termination_triggered', (e: WorkflowEvent) => {
    const data = e.data as { reason?: string; action?: string; details?: string };
    state.termination = { reason: data.reason ?? 'unknown', details: data.details };
    if (state.cardMode) {
      scheduleCardUpdate();
    } else {
      pushText(
        `⏹ <b>终止判定</b>: ${esc(data.reason ?? 'unknown')}\n` +
        (data.details ? esc(data.details) : ''),
      );
    }
  });

  engine.on('workflow_completed', (e: WorkflowEvent) => {
    const data = e.data as {
      total_rounds?: number; total_issues?: number; reason?: string;
      severity?: { critical?: number; high?: number; medium?: number; low?: number };
      status?: { open?: number; accepted?: number; rejected?: number; deferred?: number; resolved?: number };
      report_markdown_path?: string; report_json_path?: string;
    };

    if (state.cardMode && state.cardCreated) {
      const content = renderCompletionMarkdown(state, data);
      finalizeCard(content, '✅ 工作流完成', 'green', '✅ 已完成');
    } else {
      const lines: string[] = [`🎉 <b>工作流完成！</b>`];
      lines.push(`Run: <code>${esc(e.run_id)}</code>`);
      if (data.reason) lines.push(`终止原因: ${esc(data.reason)}`);
      if (data.total_rounds) lines.push(`轮次: ${data.total_rounds}`);
      if (data.total_issues != null) lines.push(`Issue 总数: <b>${data.total_issues}</b>`);
      if (data.severity) {
        const s = data.severity;
        const sevParts: string[] = [];
        if (s.critical) sevParts.push(`🔴 Critical: ${s.critical}`);
        if (s.high) sevParts.push(`🟠 High: ${s.high}`);
        if (s.medium) sevParts.push(`🟡 Medium: ${s.medium}`);
        if (s.low) sevParts.push(`🟢 Low: ${s.low}`);
        if (sevParts.length > 0) lines.push(`严重度: ${sevParts.join(' · ')}`);
      }
      if (data.status) {
        const st = data.status;
        const stParts: string[] = [];
        if (st.open) stParts.push(`open: ${st.open}`);
        if (st.resolved) stParts.push(`resolved: ${st.resolved}`);
        if (st.accepted) stParts.push(`accepted: ${st.accepted}`);
        if (st.rejected) stParts.push(`rejected: ${st.rejected}`);
        if (st.deferred) stParts.push(`deferred: ${st.deferred}`);
        if (stParts.length > 0) lines.push(`状态: ${stParts.join(' · ')}`);
      }
      if (data.report_markdown_path || data.report_json_path) {
        lines.push('报告已生成:');
        if (data.report_markdown_path) lines.push(`Markdown: <code>${esc(data.report_markdown_path)}</code>`);
        if (data.report_json_path) lines.push(`JSON: <code>${esc(data.report_json_path)}</code>`);
      }
      pushText(lines.join('\n'));
    }
  });

  engine.on('workflow_failed', (e: WorkflowEvent) => {
    const data = e.data as { error?: string };
    if (state.cardMode && state.cardCreated) {
      const content = renderProgressMarkdown(state) + `\n\n---\n\n❌ **工作流失败**: ${data.error ?? 'unknown error'}`;
      finalizeCard(content, '❌ 工作流失败', 'red', '❌ 失败');
    } else {
      pushText(`❌ <b>工作流失败</b>: ${esc(data.error ?? 'unknown error')}`);
    }
  });

  engine.on('human_review_requested', (e: WorkflowEvent) => {
    const data = e.data as { reason?: string };
    state.humanReview = { reason: data.reason };
    if (state.cardMode && state.cardCreated) {
      const content = renderProgressMarkdown(state);
      finalizeCard(content, '⚠️ 需要人工审查', 'orange', '⏸ 等待人工');
    } else {
      pushText(
        `⚠️ <b>需要人工审查</b>\n` +
        (data.reason ? `原因: ${esc(data.reason)}\n` : '') +
        `使用 <code>/workflow resume ${esc(e.run_id)}</code> 继续`,
      );
    }
  });

  engine.on('workflow_resumed', (e: WorkflowEvent) => {
    state.humanReview = undefined;
    if (state.cardMode) {
      // Resume reuses the same chat, but card was already finalized.
      // Need a new card for the resumed workflow.
      state.cardCreated = false;
      state.runId = e.run_id;
      createCard();
    } else {
      pushText(`🔄 <b>工作流已恢复</b> (run: <code>${esc(e.run_id)}</code>)`);
    }
  });

  // Error events (non-fatal, informational)
  engine.on('codex_review_timeout', (e: WorkflowEvent) => {
    const round = ensureRound(state, e.round);
    round.codex = 'done';
    round.warnings.push(`Codex 审查超时，已跳过`);
    if (state.cardMode) {
      scheduleCardUpdate();
    } else {
      pushText(`⏱ Codex 审查超时 (第 ${e.round} 轮)，已跳过，进入下一轮`);
    }
  });

  engine.on('claude_decision_timeout', (e: WorkflowEvent) => {
    const round = ensureRound(state, e.round);
    round.claude = 'done';
    round.warnings.push(`Claude 决策超时，已跳过`);
    if (state.cardMode) {
      scheduleCardUpdate();
    } else {
      pushText(`⏱ Claude 决策超时 (第 ${e.round} 轮)，已跳过，进入下一轮`);
    }
  });

  engine.on('claude_decision_skipped', (e: WorkflowEvent) => {
    const data = e.data as { error_type?: string; message?: string; reason?: string; skipped?: boolean };
    const round = ensureRound(state, e.round);
    round.claude = 'done';
    const detail = data.message
      ? data.message.substring(0, 100)
      : (data.reason ?? 'Claude 跳过');
    round.warnings.push(detail);
    if (state.cardMode) {
      scheduleCardUpdate();
    } else {
      pushText(`⚠️ Claude 决策跳过 (第 ${e.round} 轮): ${esc(detail)}`);
    }
  });

  engine.on('codex_parse_error', (e: WorkflowEvent) => {
    const round = ensureRound(state, e.round);
    round.warnings.push(`Codex 输出解析失败`);
    if (state.cardMode) {
      scheduleCardUpdate();
    } else {
      pushText(`⚠️ Codex 输出解析失败 (第 ${e.round} 轮)，使用空结果继续`);
    }
  });

  engine.on('claude_parse_error', (e: WorkflowEvent) => {
    const round = ensureRound(state, e.round);
    round.warnings.push(`Claude 输出解析失败`);
    if (state.cardMode) {
      scheduleCardUpdate();
    } else {
      pushText(`⚠️ Claude 输出解析失败 (第 ${e.round} 轮)，使用空结果继续`);
    }
  });
}

// ── Status Renderer ────────────────────────────────────────────

/**
 * Read workflow meta from store and deliver formatted status.
 */
async function deliverRunStatus(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  runId: string,
  cwd: string,
): Promise<void> {
  try {
    const store = new WorkflowStore(path.join(cwd, '.claude-workflows'));
    const meta: WorkflowMeta | null = await store.getMeta(runId);

    if (!meta) {
      await deliverText(adapter, msg, `未找到工作流: <code>${esc(runId)}</code>`);
      return;
    }

    const elapsed = activeWorkflows.get(chatKey(msg.address.channelType, msg.address.chatId));
    const isRunning = elapsed != null;
    const statusIcon = getStatusIcon(meta.status);

    const lines = [
      `<b>Workflow Status</b>`,
      `Run: <code>${esc(meta.run_id)}</code>`,
      `Status: ${statusIcon} ${meta.status}${isRunning ? ' (live)' : ''}`,
      `Type: ${meta.workflow_type}`,
      `Round: ${meta.current_round} / ${meta.config.max_rounds}`,
      `Step: ${meta.current_step}`,
      `Created: ${meta.created_at}`,
    ];

    if (meta.last_completed) {
      lines.push(`Last checkpoint: round ${meta.last_completed.round}, step ${meta.last_completed.step}`);
    }

    await deliverText(adapter, msg, lines.join('\n'));
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await deliverText(adapter, msg, `查询工作流状态失败: ${esc(errMsg)}`);
  }
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'running': return '🟢';
    case 'paused': return '⏸️';
    case 'completed': return '✅';
    case 'failed': return '❌';
    case 'human_review': return '⚠️';
    default: return '❓';
  }
}

// ── Help Text ──────────────────────────────────────────────────

function buildHelpText(): string {
  return [
    '<b>/workflow 命令</b>',
    '',
    '<b>Spec-Review</b>',
    '<code>/workflow spec-review &lt;spec&gt; &lt;plan&gt;</code>',
    '  启动 Spec-Review 工作流',
    '',
    '<code>/workflow spec-review &lt;spec&gt; &lt;plan&gt; --context f1,f2</code>',
    '  启动并附加上下文文件',
    '',
    '<b>Code-Review</b>',
    '<code>/workflow code-review</code>',
    '  审查 staged changes（默认）',
    '',
    '<code>/workflow code-review --range A..B</code>',
    '  审查两个 commit 之间的变更',
    '',
    '<code>/workflow code-review --branch-diff main</code>',
    '  审查相对于 base 分支的所有变更',
    '',
    '<code>/workflow code-review --exclude "*.test.ts,*.md"</code>',
    '  排除指定文件模式',
    '',
    '<b>Review-and-Fix (P1b-CR-1)</b>',
    '<code>/workflow review-fix</code>',
    '  审查 + 自动修复 staged changes',
    '',
    '<code>/workflow review-fix --branch-diff main</code>',
    '  审查并修复分支变更（Codex 在 worktree 中修复）',
    '',
    '<b>通用选项</b>',
    '<code>--model &lt;model-id&gt;</code>  指定 Claude 模型',
    '<code>--codex-backend &lt;backend&gt;</code>  指定 Codex 后端',
    '<code>--context f1,f2</code>  附加上下文文件',
    '',
    '<b>控制命令</b>',
    '<code>/workflow status [run-id]</code>  查看状态',
    '<code>/workflow report &lt;run-id&gt;</code>  查看审查报告',
    '<code>/workflow resume &lt;run-id&gt;</code>  恢复工作流',
    '<code>/workflow stop [run-id]</code>  停止工作流（可恢复）',
    '<code>/workflow help</code>  显示此帮助',
  ].join('\n');
}

// ── Delivery Helpers ───────────────────────────────────────────

/** Deliver a plain HTML text message, replying to the original message. */
async function deliverText(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  await deliver(adapter, {
    address: msg.address,
    text,
    parseMode: 'HTML',
    replyToMessageId: msg.messageId,
  });
}

/**
 * Minimal HTML entity escaping for user-supplied values.
 *
 * NOTE: Only safe for tag *content*. Do NOT use inside HTML attributes
 * (would need `"` and `'` escaping). Current usages are all content-context.
 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Resolve a user-supplied file path relative to `cwd` and verify it stays
 * within the cwd boundary (path traversal guard).
 *
 * @returns Resolved absolute path, or `null` if the path escapes cwd.
 */
function resolveSafePath(cwd: string, filePath: string): string | null {
  const resolved = path.resolve(cwd, filePath);
  const normalizedCwd = path.resolve(cwd);
  // Ensure resolved path starts with cwd + separator (or is cwd itself)
  if (resolved !== normalizedCwd && !resolved.startsWith(normalizedCwd + path.sep)) {
    return null;
  }
  return resolved;
}

// ── Test Helpers (exported for unit testing) ───────────────────

/** @internal Expose activeWorkflows for testing. */
export function _getActiveWorkflows(): Map<string, RunningWorkflow> {
  return activeWorkflows;
}

/** @internal Clear all active workflows (for test teardown). */
export function _clearActiveWorkflows(): void {
  activeWorkflows.clear();
}

/** @internal Expose resolveSafePath for testing. */
export const _resolveSafePath = resolveSafePath;

/** @internal Expose renderProgressMarkdown for testing. */
export const _renderProgressMarkdown = renderProgressMarkdown;

/** @internal Expose renderCompletionMarkdown for testing. */
export const _renderCompletionMarkdown = renderCompletionMarkdown;

/** @internal Re-export types for testing. */
export type { RoundProgress as _RoundProgress, WorkflowProgressState as _WorkflowProgressState };
