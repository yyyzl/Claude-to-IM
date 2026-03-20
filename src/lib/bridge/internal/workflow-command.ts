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
 * - 工作流在后台异步执行，`/workflow start` 立即返回确认
 * - Engine 实例按需创建（lazy），不在 Bridge 启动时预创建
 * - 事件到消息的映射集中在 `bindProgressEvents()` 中，方便 P2B 卡片化迭代
 *
 * @module bridge/internal/workflow-command
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createSpecReviewEngine } from '../../workflow/index.js';
import type { WorkflowEngine } from '../../workflow/workflow-engine.js';
import type { WorkflowEvent, WorkflowMeta } from '../../workflow/types.js';
import type { BaseChannelAdapter } from '../channel-adapter.js';
import type { InboundMessage, ChannelBinding } from '../types.js';
import { deliver } from '../delivery-layer.js';
import { getBridgeContext } from '../context.js';

// ── Types ──────────────────────────────────────────────────────

/** Parsed `/workflow` subcommand. */
export type WorkflowSubcommand =
  | { kind: 'help' }
  | { kind: 'start'; specPath: string; planPath: string; contextPaths: string[] }
  | { kind: 'status'; runId?: string }
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
 *   /workflow start <spec> <plan> [--context file1,file2]
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
    case 'start': {
      // Expect: start <spec> <plan> [--context file1,file2]
      if (parts.length < 3) return { kind: 'help' };
      const specPath = parts[1];
      const planPath = parts[2];
      let contextPaths: string[] = [];

      const ctxIdx = parts.indexOf('--context');
      if (ctxIdx !== -1 && parts[ctxIdx + 1]) {
        contextPaths = parts[ctxIdx + 1].split(',').filter(Boolean);
      }

      return { kind: 'start', specPath, planPath, contextPaths };
    }

    case 'status':
      return { kind: 'status', runId: parts[1] };

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

    case 'start':
      await handleStart(adapter, msg, cmd, cwd, key);
      return;

    case 'status':
      await handleStatus(adapter, msg, cmd, key);
      return;

    case 'resume':
      await handleResume(adapter, msg, cmd, key);
      return;

    case 'stop':
      await handleStop(adapter, msg, key);
      return;
  }
}

// ── Subcommand Handlers ────────────────────────────────────────

async function handleStart(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  cmd: Extract<WorkflowSubcommand, { kind: 'start' }>,
  cwd: string,
  key: string,
): Promise<void> {
  // Guard: only one workflow per chat
  if (activeWorkflows.has(key)) {
    const running = activeWorkflows.get(key)!;
    await deliverText(adapter, msg,
      `已有工作流正在运行 (run: <code>${esc(running.runId)}</code>)\n` +
      `使用 <code>/workflow stop</code> 停止后再启动新的。`,
    );
    return;
  }

  // Resolve file paths (relative to cwd)
  const specFile = path.isAbsolute(cmd.specPath) ? cmd.specPath : path.join(cwd, cmd.specPath);
  const planFile = path.isAbsolute(cmd.planPath) ? cmd.planPath : path.join(cwd, cmd.planPath);

  // Validate & read files
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

  // Read optional context files
  const contextFiles: Array<{ path: string; content: string }> = [];
  for (const p of cmd.contextPaths) {
    const fullPath = path.isAbsolute(p) ? p : path.join(cwd, p);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      contextFiles.push({ path: p, content });
    } catch {
      await deliverText(adapter, msg, `Context 文件无法读取: <code>${esc(fullPath)}</code>，跳过。`);
    }
  }

  // Create engine and bind events
  const engine = createSpecReviewEngine();

  // Confirm start immediately (non-blocking)
  await deliverText(adapter, msg,
    `正在启动 Spec-Review 工作流...\n` +
    `Spec: <code>${esc(cmd.specPath)}</code>\n` +
    `Plan: <code>${esc(cmd.planPath)}</code>` +
    (contextFiles.length > 0 ? `\nContext: ${contextFiles.length} 个文件` : ''),
  );

  // 1. Set provisional entry FIRST (blocks concurrent /workflow start)
  activeWorkflows.set(key, {
    engine,
    runId: '(pending)',
    chatId: msg.address.chatId,
    channelType: msg.address.channelType,
    startedAt: Date.now(),
  });

  // 2. Register run_id capture listener (updates provisional entry with real run_id)
  engine.on('workflow_started', (e: WorkflowEvent) => {
    activeWorkflows.set(key, {
      engine,
      runId: e.run_id,
      chatId: msg.address.chatId,
      channelType: msg.address.channelType,
      startedAt: Date.now(),
    });
  });

  // 3. Bind progress events (message push)
  bindProgressEvents(engine, adapter, msg, key);

  // 4. Launch workflow in background (fire-and-forget with error handling)
  void engine.start({ spec, plan, contextFiles }).then(() => {
    activeWorkflows.delete(key);
  }).catch(async (err: unknown) => {
    activeWorkflows.delete(key);
    const errMsg = err instanceof Error ? err.message : String(err);
    await deliverText(adapter, msg, `工作流异常退出: ${esc(errMsg)}`);
  });
}

async function handleStatus(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  cmd: Extract<WorkflowSubcommand, { kind: 'status' }>,
  key: string,
): Promise<void> {
  const running = activeWorkflows.get(key);

  if (cmd.runId) {
    // Query specific run from store
    await deliverRunStatus(adapter, msg, cmd.runId);
    return;
  }

  if (running) {
    await deliverRunStatus(adapter, msg, running.runId);
  } else {
    await deliverText(adapter, msg, '当前聊天没有运行中的工作流。\n使用 <code>/workflow start</code> 启动。');
  }
}

async function handleResume(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  cmd: Extract<WorkflowSubcommand, { kind: 'resume' }>,
  key: string,
): Promise<void> {
  // Guard: no concurrent workflow
  if (activeWorkflows.has(key)) {
    const running = activeWorkflows.get(key)!;
    await deliverText(adapter, msg,
      `已有工作流正在运行 (run: <code>${esc(running.runId)}</code>)\n先使用 <code>/workflow stop</code> 停止。`,
    );
    return;
  }

  const engine = createSpecReviewEngine();
  bindProgressEvents(engine, adapter, msg, key);

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
    activeWorkflows.delete(key);
  }).catch(async (err: unknown) => {
    activeWorkflows.delete(key);
    const errMsg = err instanceof Error ? err.message : String(err);
    await deliverText(adapter, msg, `工作流恢复失败: ${esc(errMsg)}`);
  });
}

async function handleStop(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  key: string,
): Promise<void> {
  const running = activeWorkflows.get(key);
  if (!running) {
    await deliverText(adapter, msg, '当前聊天没有运行中的工作流。');
    return;
  }

  try {
    await running.engine.pause(running.runId);
    activeWorkflows.delete(key);
    await deliverText(adapter, msg,
      `工作流已暂停 (run: <code>${esc(running.runId)}</code>)\n` +
      `使用 <code>/workflow resume ${esc(running.runId)}</code> 恢复。`,
    );
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await deliverText(adapter, msg, `停止工作流失败: ${esc(errMsg)}`);
  }
}

// ── Event → IM Message Binding ─────────────────────────────────

/**
 * Subscribe to WorkflowEngine events and push formatted IM messages.
 *
 * This is the **single point** where events become messages.
 * P2B 卡片化只需替换此函数的输出格式，不改事件订阅逻辑。
 */
function bindProgressEvents(
  engine: WorkflowEngine,
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  _key: string,
): void {
  const push = (text: string): void => {
    void deliverText(adapter, msg, text);
  };

  engine.on('workflow_started', (e: WorkflowEvent) => {
    push(`🚀 <b>工作流已启动</b> (run: <code>${esc(e.run_id)}</code>)`);
  });

  engine.on('round_started', (e: WorkflowEvent) => {
    push(`📋 <b>第 ${e.round} 轮</b>审查开始`);
  });

  engine.on('codex_review_started', () => {
    push('🔍 Codex 审查中...');
  });

  engine.on('codex_review_completed', (e: WorkflowEvent) => {
    const data = e.data as { findings_count?: number };
    const count = data.findings_count ?? '?';
    push(`✅ Codex 审查完成，发现 <b>${count}</b> 个问题`);
  });

  engine.on('claude_decision_started', () => {
    push('🤔 Claude 决策中...');
  });

  engine.on('claude_decision_completed', (e: WorkflowEvent) => {
    const data = e.data as {
      accepted?: number;
      rejected?: number;
      deferred?: number;
      spec_updated?: boolean;
      plan_updated?: boolean;
    };
    const parts: string[] = [];
    if (data.accepted) parts.push(`accepted: ${data.accepted}`);
    if (data.rejected) parts.push(`rejected: ${data.rejected}`);
    if (data.deferred) parts.push(`deferred: ${data.deferred}`);
    const updates: string[] = [];
    if (data.spec_updated) updates.push('spec');
    if (data.plan_updated) updates.push('plan');
    push(
      `✅ Claude 决策完成` +
      (parts.length > 0 ? ` (${parts.join(', ')})` : '') +
      (updates.length > 0 ? `\n📝 已更新: ${updates.join(', ')}` : ''),
    );
  });

  engine.on('termination_triggered', (e: WorkflowEvent) => {
    const data = e.data as { reason?: string; action?: string; details?: string };
    push(
      `⏹ <b>终止判定</b>: ${esc(data.reason ?? 'unknown')}\n` +
      (data.details ? esc(data.details) : ''),
    );
  });

  engine.on('workflow_completed', (e: WorkflowEvent) => {
    const data = e.data as { total_rounds?: number; total_issues?: number };
    push(
      `🎉 <b>工作流完成！</b>\n` +
      `Run: <code>${esc(e.run_id)}</code>\n` +
      (data.total_rounds ? `轮次: ${data.total_rounds}\n` : '') +
      (data.total_issues != null ? `Issue 总数: ${data.total_issues}` : ''),
    );
  });

  engine.on('workflow_failed', (e: WorkflowEvent) => {
    const data = e.data as { error?: string };
    push(`❌ <b>工作流失败</b>: ${esc(data.error ?? 'unknown error')}`);
  });

  engine.on('human_review_requested', (e: WorkflowEvent) => {
    const data = e.data as { reason?: string };
    push(
      `⚠️ <b>需要人工审查</b>\n` +
      (data.reason ? `原因: ${esc(data.reason)}\n` : '') +
      `使用 <code>/workflow resume ${esc(e.run_id)}</code> 继续`,
    );
  });

  engine.on('workflow_resumed', (e: WorkflowEvent) => {
    push(`🔄 <b>工作流已恢复</b> (run: <code>${esc(e.run_id)}</code>)`);
  });

  // Error events (non-fatal, informational)
  engine.on('codex_review_timeout', (e: WorkflowEvent) => {
    push(`⏱ Codex 审查超时 (第 ${e.round} 轮)，正在重试...`);
  });

  engine.on('claude_decision_timeout', (e: WorkflowEvent) => {
    push(`⏱ Claude 决策超时 (第 ${e.round} 轮)，正在重试...`);
  });

  engine.on('codex_parse_error', (e: WorkflowEvent) => {
    push(`⚠️ Codex 输出解析失败 (第 ${e.round} 轮)，正在重试...`);
  });

  engine.on('claude_parse_error', (e: WorkflowEvent) => {
    push(`⚠️ Claude 输出解析失败 (第 ${e.round} 轮)，正在重试...`);
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
): Promise<void> {
  try {
    // WorkflowStore reads from file system. Create a temp store to query.
    const { WorkflowStore } = await import('../../workflow/workflow-store.js');
    const store = new WorkflowStore();
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
    '<code>/workflow start &lt;spec&gt; &lt;plan&gt;</code>',
    '  启动 Spec-Review 工作流',
    '',
    '<code>/workflow start &lt;spec&gt; &lt;plan&gt; --context f1,f2</code>',
    '  启动并附加上下文文件',
    '',
    '<code>/workflow status [run-id]</code>',
    '  查看当前/指定工作流状态',
    '',
    '<code>/workflow resume &lt;run-id&gt;</code>',
    '  恢复暂停或失败的工作流',
    '',
    '<code>/workflow stop</code>',
    '  停止当前运行的工作流',
    '',
    '<code>/workflow help</code>',
    '  显示此帮助',
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

/** Minimal HTML entity escaping for user-supplied values. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
