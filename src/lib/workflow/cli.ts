#!/usr/bin/env node

/**
 * Workflow CLI — Command-line entry point for running workflows.
 *
 * Supports three subcommands:
 *   - `spec-review`  — Review spec + plan documents (P1a)
 *   - `code-review`  — Review code changes via git diff (P1b-CR-0)
 *   - `review-fix`   — Review + auto-fix code changes via Codex (P1b-CR-1)
 *
 * Usage:
 *   workflow-cli spec-review --spec <path> --plan <path> [options]
 *   workflow-cli code-review [--range A..B | --branch-diff <base>] [options]
 *   workflow-cli review-fix  [--range A..B | --branch-diff <base>] [options]
 *   workflow-cli resume <run-id> [--base-path <dir>]
 *
 * Common options:
 *   --context <file,...>   Comma-separated additional context files
 *   --config <path>        JSON configuration override file
 *   --base-path <dir>      Workflow storage directory (default: .claude-workflows)
 *   --model <name>         Claude model identifier
 *   --codex-backend <name> Codex CLI backend name
 *
 * Code-review / review-fix options:
 *   --range <A..B>         Commit range for diff (e.g. HEAD~3..HEAD)
 *   --branch-diff <base>   Branch diff against base (e.g. main)
 *   --exclude <pat,...>    Exclude file patterns (glob)
 *   --cwd <dir>            Working directory for git commands (default: .)
 *
 * Signals:
 *   SIGINT (Ctrl+C) gracefully pauses the running workflow.
 *
 * @module workflow/cli
 */

import * as fs from 'node:fs/promises';
import * as process from 'node:process';
import * as path from 'node:path';
import { createSpecReviewEngine, createCodeReviewEngine } from './index.js';
import { DiffReader } from './diff-reader.js';
import { ReportGenerator } from './report-generator.js';
import { WorkflowStore } from './workflow-store.js';
import {
  CODE_REVIEW_PROFILE,
  type ContextFile,
  type ReviewScope,
  type WorkflowConfig,
  type WorkflowEvent,
  type WorkflowEventType,
} from './types.js';

// ── Types ──────────────────────────────────────────────────────

type Subcommand = 'spec-review' | 'code-review' | 'review-fix' | 'resume' | 'help';

interface ParsedArgs {
  subcommand: Subcommand;
  // spec-review
  specPath?: string;
  planPath?: string;
  // code-review / review-fix
  range?: string;
  branchDiff?: string;
  excludePatterns?: string[];
  cwd?: string;
  // resume
  resumeRunId?: string;
  // common
  contextPaths: string[];
  configPath?: string;
  basePath?: string;
  claudeModel?: string;
  codexBackend?: string;
}

// ── Argument Parser ────────────────────────────────────────────

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) return { subcommand: 'help', contextPaths: [] };

  const sub = argv[0].toLowerCase();
  const result: ParsedArgs = { subcommand: 'help', contextPaths: [] };

  // Map subcommand
  switch (sub) {
    case 'spec-review':
    case 'code-review':
    case 'review-fix':
      result.subcommand = sub;
      break;
    case 'resume':
      result.subcommand = 'resume';
      if (argv[1] && !argv[1].startsWith('--')) {
        result.resumeRunId = argv[1];
      }
      break;
    case 'help':
    case '--help':
    case '-h':
      return result;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      return result;
  }

  // Parse remaining flags
  const rest = result.subcommand === 'resume' ? argv.slice(2) : argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    switch (flag) {
      case '--spec':       result.specPath = rest[++i]; break;
      case '--plan':       result.planPath = rest[++i]; break;
      case '--range':      result.range = rest[++i]; break;
      case '--branch-diff': result.branchDiff = rest[++i]; break;
      case '--exclude':    result.excludePatterns = rest[++i]?.split(',').filter(Boolean); break;
      case '--context':    result.contextPaths = rest[++i]?.split(',').filter(Boolean) ?? []; break;
      case '--config':     result.configPath = rest[++i]; break;
      case '--base-path':  result.basePath = rest[++i]; break;
      case '--model':      result.claudeModel = rest[++i]; break;
      case '--codex-backend': result.codexBackend = rest[++i]; break;
      case '--cwd':        result.cwd = rest[++i]; break;
      default:
        console.error(`Unknown argument: ${flag}`);
        process.exit(1);
    }
  }

  return result;
}

// ── Help Text ──────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
Workflow CLI — Dual-model review engine

SUBCOMMANDS:
  spec-review   Review spec + plan documents
  code-review   Review code changes (git diff)
  review-fix    Review + auto-fix code changes (Codex applies fixes in worktree)
  resume        Resume a paused/failed workflow
  help          Show this help

USAGE:
  workflow-cli spec-review --spec <path> --plan <path> [options]
  workflow-cli code-review [--range HEAD~3..HEAD] [--branch-diff main] [options]
  workflow-cli review-fix  [--range HEAD~3..HEAD] [--branch-diff main] [options]
  workflow-cli resume <run-id> [--base-path <dir>]

COMMON OPTIONS:
  --context <files>       Comma-separated context file paths
  --config <path>         JSON config override file
  --base-path <dir>       Storage directory (default: .claude-workflows)
  --model <name>          Claude model (default: claude-sonnet-4-20250514)
  --codex-backend <name>  Codex backend (default: codex)

CODE-REVIEW / REVIEW-FIX OPTIONS:
  --range <A..B>          Commit range diff (e.g. HEAD~3..HEAD)
  --branch-diff <base>    Branch diff against base branch (e.g. main)
  --exclude <patterns>    Comma-separated exclude globs
  --cwd <dir>             Working directory for git (default: .)

SIGNALS:
  Ctrl+C  Gracefully pauses the running workflow.

EXAMPLES:
  # Review spec documents
  workflow-cli spec-review --spec docs/spec.md --plan docs/plan.md

  # Review staged changes
  workflow-cli code-review

  # Review last 3 commits
  workflow-cli code-review --range HEAD~3..HEAD

  # Review branch against main
  workflow-cli code-review --branch-diff main

  # Review + auto-fix branch against main
  workflow-cli review-fix --branch-diff main

  # Resume a paused workflow
  workflow-cli resume 20260324-a1b2c3
`.trim());
}

// ── Event Logger ───────────────────────────────────────────────

/** Bind standard event listeners for console output. */
function bindEventLogger(engine: import('./workflow-engine.js').WorkflowEngine): void {
  const log = (e: WorkflowEvent, msg: string): void =>
    console.log(`[${e.event_type}] ${msg}`);

  const events: Array<[WorkflowEventType, (e: WorkflowEvent) => void]> = [
    ['workflow_started',         (e) => log(e, `Run: ${e.run_id}`)],
    ['round_started',            (e) => log(e, `Round ${e.round}`)],
    ['codex_review_started',     (e) => log(e, 'Invoking Codex...')],
    ['codex_review_completed',   (e) => log(e, 'Codex review done')],
    ['claude_decision_started',  (e) => log(e, 'Invoking Claude...')],
    ['claude_decision_completed',(e) => log(e, 'Claude decision done')],
    ['issue_created',            (e) => log(e, JSON.stringify(e.data))],
    ['termination_triggered',    (e) => log(e, JSON.stringify(e.data))],
    ['workflow_completed',       (e) => log(e, 'Workflow completed!')],
    ['workflow_failed',          (e) => log(e, `Failed: ${JSON.stringify(e.data)}`)],
    ['human_review_requested',   (e) => log(e, `Human review: ${JSON.stringify(e.data)}`)],
    ['workflow_resumed',         (e) => log(e, `Resumed from round ${e.data.resumed_from_round}`)],
  ];

  for (const [eventType, handler] of events) {
    engine.on(eventType, handler);
  }
}

// ── Common Helpers ─────────────────────────────────────────────

/** Read context files from paths. */
async function readContextFiles(paths: string[]): Promise<ContextFile[]> {
  const files: ContextFile[] = [];
  for (const p of paths) {
    const trimmed = p.trim();
    if (trimmed) {
      const content = await fs.readFile(trimmed, 'utf-8');
      files.push({ path: trimmed, content });
    }
  }
  return files;
}

/** Read optional JSON config file. */
async function readConfig(configPath: string | undefined): Promise<Partial<WorkflowConfig> | undefined> {
  if (!configPath) return undefined;
  const raw = await fs.readFile(configPath, 'utf-8');
  return JSON.parse(raw) as Partial<WorkflowConfig>;
}

/** Build ReviewScope from CLI args. */
function buildReviewScope(args: ParsedArgs): ReviewScope {
  if (args.branchDiff) {
    return {
      type: 'branch',
      base_ref: args.branchDiff,
      head_ref: 'HEAD',
      exclude_patterns: args.excludePatterns,
    };
  }

  if (args.range) {
    const [base, head] = args.range.split('..');
    if (args.range.includes('...')) {
      // Three-dot: branch diff
      const [base3, head3] = args.range.split('...');
      return {
        type: 'branch',
        base_ref: base3,
        head_ref: head3 || 'HEAD',
        exclude_patterns: args.excludePatterns,
      };
    }
    return {
      type: 'commit_range',
      base_ref: base,
      head_ref: head || 'HEAD',
      exclude_patterns: args.excludePatterns,
    };
  }

  // Default: staged changes
  return {
    type: 'staged',
    exclude_patterns: args.excludePatterns,
  };
}

// ── Subcommand Handlers ────────────────────────────────────────

async function handleSpecReview(args: ParsedArgs): Promise<void> {
  if (!args.specPath || !args.planPath) {
    console.error('Error: spec-review requires --spec <path> and --plan <path>');
    process.exit(1);
  }

  const engine = createSpecReviewEngine(args.basePath);
  bindEventLogger(engine);

  let runId: string | undefined;
  setupSigintHandler(engine, () => runId);

  const spec = await fs.readFile(args.specPath, 'utf-8');
  const plan = await fs.readFile(args.planPath, 'utf-8');
  const contextFiles = await readContextFiles(args.contextPaths);
  const config = await readConfig(args.configPath);

  if (args.claudeModel) (config as Record<string, unknown> ?? {}).claude_model = args.claudeModel;
  if (args.codexBackend) (config as Record<string, unknown> ?? {}).codex_backend = args.codexBackend;

  runId = await engine.start({ spec, plan, config, contextFiles });
  console.log(`\nSpec-review completed. Run ID: ${runId}`);
}

async function handleCodeReview(args: ParsedArgs, enableFix: boolean): Promise<void> {
  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
  const engine = createCodeReviewEngine(args.basePath);
  bindEventLogger(engine);

  let runId: string | undefined;
  setupSigintHandler(engine, () => runId);

  // Build review scope
  const scope = buildReviewScope(args);

  // Create snapshot via DiffReader
  console.log(`Creating review snapshot (cwd: ${cwd})...`);
  const diffReader = new DiffReader(cwd);

  if (!(await diffReader.isGitRepo())) {
    console.error(`Error: ${cwd} is not a git repository.`);
    process.exit(1);
  }

  const snapshot = await diffReader.createSnapshot(scope);
  console.log(
    `Snapshot created: ${snapshot.files.length} files, ` +
    `${snapshot.excluded_files.length} excluded, ` +
    `diff length: ${snapshot.diff.length} chars`,
  );

  // Read context files and config
  const contextFiles = await readContextFiles(args.contextPaths);
  const config = await readConfig(args.configPath);
  const mergedConfig: Partial<WorkflowConfig> = { ...config };
  if (args.claudeModel) mergedConfig.claude_model = args.claudeModel;
  if (args.codexBackend) mergedConfig.codex_backend = args.codexBackend;

  // Choose profile based on enableFix flag
  // For now, both use CODE_REVIEW_PROFILE; review-fix extends with post-processing
  const profile = { ...CODE_REVIEW_PROFILE };
  if (enableFix) {
    // Override max_rounds to allow more iterations for fix verification
    profile.configOverrides = { ...profile.configOverrides, max_rounds: 2 };
  }

  // Start workflow — pass empty spec/plan (code-review doesn't use them)
  runId = await engine.start({
    spec: '',
    plan: '',
    config: mergedConfig,
    contextFiles,
    profile,
    snapshot,
  });

  console.log(`\nCode review completed. Run ID: ${runId}`);

  // Generate report
  const reportGen = new ReportGenerator(new WorkflowStore(args.basePath));
  const { markdown, data } = await reportGen.generate(runId);

  // Print summary to console
  console.log('\n' + '='.repeat(60));
  console.log(markdown);
  console.log('='.repeat(60));
  console.log(`\nConclusion: ${data.conclusion}`);
  console.log(`Stats: ${data.stats.total_findings} findings, ${data.stats.accepted} accepted, ${data.stats.rejected} rejected`);

  // If review-fix mode, run auto-fix after review
  if (enableFix && data.stats.accepted > 0) {
    console.log('\n--- Review-and-Fix Mode ---');
    console.log(`${data.stats.accepted} accepted issues with fix instructions.`);
    console.log('Starting auto-fix via Codex in isolated worktree...\n');

    try {
      const { AutoFixer } = await import('./auto-fixer.js');
      const fixer = new AutoFixer(cwd, engine, args.basePath);
      const fixResult = await fixer.applyFixes(runId, {
        codexBackend: args.codexBackend,
        codexTimeoutMs: mergedConfig.codex_timeout_ms,
      });

      if (fixResult.success) {
        console.log(`\n✅ Auto-fix completed in worktree: ${fixResult.worktreePath}`);
        console.log(`   Fixed: ${fixResult.fixedCount}/${fixResult.totalCount} issues`);
        console.log(`   Diff:\n${fixResult.diffPreview}`);
        console.log(`\nTo apply fixes:`);
        console.log(`  cd "${fixResult.worktreePath}" && git diff | git apply`);
        console.log(`Or to cherry-pick:`);
        console.log(`  git merge --no-ff ${fixResult.worktreeBranch}`);
      } else {
        console.log(`\n⚠️ Auto-fix partially completed: ${fixResult.fixedCount}/${fixResult.totalCount}`);
        if (fixResult.errors.length > 0) {
          console.log('Errors:');
          for (const err of fixResult.errors) {
            console.log(`  - ${err}`);
          }
        }
      }
    } catch (err: unknown) {
      console.error('Auto-fix failed:', err instanceof Error ? err.message : String(err));
      console.log('Review report is still available above.');
    }
  }
}

async function handleResume(args: ParsedArgs): Promise<void> {
  if (!args.resumeRunId) {
    console.error('Error: resume requires a run ID');
    process.exit(1);
  }

  // Detect workflow type from stored meta
  const store = new WorkflowStore(args.basePath);
  const meta = await store.getMeta(args.resumeRunId);
  if (!meta) {
    console.error(`Error: run not found: ${args.resumeRunId}`);
    process.exit(1);
  }

  const isCodeReview = meta.workflow_type === 'code-review';
  const engine = isCodeReview
    ? createCodeReviewEngine(args.basePath)
    : createSpecReviewEngine(args.basePath);

  bindEventLogger(engine);
  setupSigintHandler(engine, () => args.resumeRunId);

  console.log(`Resuming ${meta.workflow_type} workflow: ${args.resumeRunId}`);
  await engine.resume(args.resumeRunId);
  console.log(`\nWorkflow resumed and completed. Run ID: ${args.resumeRunId}`);
}

// ── SIGINT Handler ─────────────────────────────────────────────

function setupSigintHandler(
  engine: import('./workflow-engine.js').WorkflowEngine,
  getRunId: () => string | undefined,
): void {
  process.on('SIGINT', async () => {
    const rid = getRunId();
    if (rid) {
      console.log('\nReceived SIGINT, pausing workflow...');
      await engine.pause(rid);
      console.log(`Workflow paused. Resume with: workflow-cli resume ${rid}`);
    }
    process.exit(0);
  });
}

// ── Main Entry ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.subcommand) {
    case 'help':
      printHelp();
      return;

    case 'spec-review':
      await handleSpecReview(args);
      return;

    case 'code-review':
      await handleCodeReview(args, false);
      return;

    case 'review-fix':
      await handleCodeReview(args, true);
      return;

    case 'resume':
      await handleResume(args);
      return;
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
