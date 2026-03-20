#!/usr/bin/env node

/**
 * Workflow CLI — Command-line entry point for running Spec-Review workflows.
 *
 * Usage:
 *   workflow-review --spec <path> --plan <path> [--context <file,...>] [--config <path>] [--base-path <dir>]
 *   workflow-review --resume <run-id> [--base-path <dir>]
 *
 * Flags:
 *   --spec       Path to the spec document (required unless --resume)
 *   --plan       Path to the plan document (required unless --resume)
 *   --context    Comma-separated list of additional context file paths
 *   --config     Path to a JSON configuration override file
 *   --resume     Resume a paused/failed workflow by run ID
 *   --base-path  Base directory for workflow storage (default: .claude-workflows)
 *
 * Signals:
 *   SIGINT (Ctrl+C) gracefully pauses the running workflow.
 *
 * @module workflow/cli
 */

import * as fs from 'node:fs/promises';
import * as process from 'node:process';
import { createSpecReviewEngine } from './index.js';
import type { ContextFile, WorkflowEvent } from './types.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse arguments
  let specPath: string | undefined;
  let planPath: string | undefined;
  let configPath: string | undefined;
  let contextPaths: string[] = [];
  let resumeRunId: string | undefined;
  let basePath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--spec': specPath = args[++i]; break;
      case '--plan': planPath = args[++i]; break;
      case '--config': configPath = args[++i]; break;
      case '--context': contextPaths = args[++i].split(','); break;
      case '--resume': resumeRunId = args[++i]; break;
      case '--base-path': basePath = args[++i]; break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  // Validate
  if (!resumeRunId && (!specPath || !planPath)) {
    console.error(
      'Usage: workflow-review --spec <path> --plan <path> ' +
      '[--context <file,...>] [--config <path>] [--resume <run-id>]',
    );
    process.exit(1);
  }

  const engine = createSpecReviewEngine(basePath);

  // Register event listeners (print to stdout)
  const log = (e: WorkflowEvent, msg: string): void => console.log(`[${e.event_type}] ${msg}`);

  engine.on('workflow_started', (e: WorkflowEvent) => log(e, `Run: ${e.run_id}`));
  engine.on('round_started', (e: WorkflowEvent) => log(e, `Round ${e.round}`));
  engine.on('codex_review_started', (e: WorkflowEvent) => log(e, 'Invoking Codex...'));
  engine.on('codex_review_completed', (e: WorkflowEvent) => log(e, 'Codex review done'));
  engine.on('claude_decision_started', (e: WorkflowEvent) => log(e, 'Invoking Claude...'));
  engine.on('claude_decision_completed', (e: WorkflowEvent) => log(e, 'Claude decision done'));
  engine.on('issue_created', (e: WorkflowEvent) => log(e, JSON.stringify(e.data)));
  engine.on('termination_triggered', (e: WorkflowEvent) => log(e, JSON.stringify(e.data)));
  engine.on('workflow_completed', (e: WorkflowEvent) => log(e, 'Workflow completed!'));
  engine.on('workflow_failed', (e: WorkflowEvent) => log(e, `Workflow failed: ${JSON.stringify(e.data)}`));
  engine.on('human_review_requested', (e: WorkflowEvent) => log(e, `Human review needed: ${JSON.stringify(e.data)}`));

  // Handle SIGINT for graceful pause
  let runId: string | undefined;
  process.on('SIGINT', async () => {
    if (runId) {
      console.log('\nReceived SIGINT, pausing workflow...');
      await engine.pause(runId);
      console.log('Workflow paused. Resume with --resume ' + runId);
    }
    process.exit(0);
  });

  if (resumeRunId) {
    runId = resumeRunId;
    console.log(`Resuming workflow: ${resumeRunId}`);
    await engine.resume(resumeRunId);
  } else {
    // Read files
    const spec = await fs.readFile(specPath!, 'utf-8');
    const plan = await fs.readFile(planPath!, 'utf-8');

    // Read context files
    const contextFiles: ContextFile[] = [];
    for (const p of contextPaths) {
      if (p.trim()) {
        const content = await fs.readFile(p.trim(), 'utf-8');
        contextFiles.push({ path: p.trim(), content });
      }
    }

    // Read optional config
    let config: Record<string, unknown> | undefined;
    if (configPath) {
      const raw = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(raw) as Record<string, unknown>;
    }

    runId = await engine.start({
      spec,
      plan,
      config: config as Partial<import('./types.js').WorkflowConfig> | undefined,
      contextFiles,
    });
    console.log(`Workflow completed. Run ID: ${runId}`);
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
