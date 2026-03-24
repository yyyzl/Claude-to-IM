/**
 * Integration tests for Code-Review workflow (P1b-CR-0 Phase 5).
 *
 * Strategy:
 * - Real dependencies: WorkflowStore, PackBuilder, PromptAssembler,
 *   TerminationJudge, JsonParser, IssueMatcher, PatchApplier, ContextCompressor,
 *   DecisionValidator, ReportGenerator
 * - Mocked: ModelInvoker (no actual Codex/Claude calls)
 *
 * Tests:
 * 1. Normal 2-round code-review (accept+reject -> LGTM terminate)
 * 2. Accepted issues are terminal (LGTM with accepted issues → terminate)
 * 3. ReportGenerator produces correct Markdown and structured data
 * 4. WorkflowProfile behavior flags are respected (no patches, fresh context, fix_instruction)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { WorkflowEngine } from '../../lib/workflow/workflow-engine.js';
import { WorkflowStore } from '../../lib/workflow/workflow-store.js';
import { PackBuilder } from '../../lib/workflow/pack-builder.js';
import { PromptAssembler } from '../../lib/workflow/prompt-assembler.js';
import { ModelInvoker } from '../../lib/workflow/model-invoker.js';
import { TerminationJudge } from '../../lib/workflow/termination-judge.js';
import { JsonParser } from '../../lib/workflow/json-parser.js';
import { IssueMatcher } from '../../lib/workflow/issue-matcher.js';
import { PatchApplier } from '../../lib/workflow/patch-applier.js';
import { ContextCompressor } from '../../lib/workflow/context-compressor.js';
import { DecisionValidator } from '../../lib/workflow/decision-validator.js';
import { ReportGenerator } from '../../lib/workflow/report-generator.js';
import type { WorkflowEvent, ReviewSnapshot } from '../../lib/workflow/types.js';
import { CODE_REVIEW_PROFILE } from '../../lib/workflow/types.js';

// ── Templates (mirroring production files) ──────────────────────

const CODE_REVIEW_PACK_TEMPLATE = `You are an independent code reviewer.
{{review_scope}}
{{diff}}
{{changed_files}}
{{unresolved_issues}}
{{accepted_issues}}
{{rejected_issues}}
{{round_summary}}
{{round}}
{{context_files}}`;

const CODE_REVIEW_DECISION_TEMPLATE = `You are the arbitrator for a code review.
{{round}}
{{codex_findings_with_ids}}
{{ledger_summary}}
{{diff}}
{{changed_files}}`;

const CODE_REVIEW_DECISION_SYSTEM_TEMPLATE = `You are an expert code review arbitrator.`;

const ROUND_SUMMARY_TEMPLATE = `## Round {{round}} Summary
- **New issues raised**: {{new_issues_count}}
- **Matched to existing**: {{matched_count}}
- **Decisions made**: {{decisions_count}}
  - Accepted: {{accepted_count}}
  - Rejected: {{rejected_count}}
  - Deferred: {{deferred_count}}
  - Accept & Resolved: {{accept_and_resolved_count}}
- **Spec updated**: {{spec_updated}}
- **Plan updated**: {{plan_updated}}
- **Issues resolved this round**: {{resolved_count}}
- **Overall assessment**: {{overall_assessment}}
{{additional_notes}}`;

const TEST_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,7 @@
-export async function login(input: unknown) {
-  return db.query(input as string);
+export async function login(input: unknown) {
+  if (!input) {
+    throw new Error('missing input');
+  }
+  return db.query(String(input));
 }

diff --git a/src/utils.ts b/src/utils.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/utils.ts
@@ -0,0 +1,4 @@
+export function formatName(name: string): string {
+  return name.trim();
+}
`;

// ── Helpers ───────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wf-cr-test-'));
}

async function removeTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

async function writeTemplates(tmpDir: string): Promise<void> {
  const templatesDir = path.join(tmpDir, 'templates');
  await fs.mkdir(templatesDir, { recursive: true });
  await fs.writeFile(path.join(templatesDir, 'code-review-pack.md'), CODE_REVIEW_PACK_TEMPLATE, 'utf-8');
  await fs.writeFile(path.join(templatesDir, 'code-review-decision.md'), CODE_REVIEW_DECISION_TEMPLATE, 'utf-8');
  await fs.writeFile(path.join(templatesDir, 'code-review-decision-system.md'), CODE_REVIEW_DECISION_SYSTEM_TEMPLATE, 'utf-8');
  await fs.writeFile(path.join(templatesDir, 'round-summary.md'), ROUND_SUMMARY_TEMPLATE, 'utf-8');
}

function buildEngine(store: WorkflowStore, mockInvoker: MockModelInvoker): WorkflowEngine {
  const compressor = new ContextCompressor();
  const packBuilder = new PackBuilder(store, compressor);
  const promptAssembler = new PromptAssembler(store);
  const terminationJudge = new TerminationJudge();
  const jsonParser = new JsonParser();
  const issueMatcher = new IssueMatcher();
  const patchApplier = new PatchApplier();
  const decisionValidator = new DecisionValidator();

  return new WorkflowEngine(
    store, packBuilder, promptAssembler,
    mockInvoker as unknown as ModelInvoker,
    terminationJudge, jsonParser, issueMatcher, patchApplier,
    decisionValidator,
  );
}

function eventTypes(events: WorkflowEvent[]): string[] {
  return events.map((e) => e.event_type);
}

/** Create a sample ReviewSnapshot for testing. */
function createTestSnapshot(): ReviewSnapshot {
  return {
    created_at: new Date().toISOString(),
    head_commit: 'abc1234567890def',
    base_ref: 'HEAD',
    scope: { type: 'staged' },
    files: [
      {
        path: 'src/auth.ts',
        blob_sha: 'deadbeef1234',
        change_type: 'modified',
        language: 'typescript',
      },
      {
        path: 'src/utils.ts',
        blob_sha: 'cafebabe5678',
        change_type: 'added',
        language: 'typescript',
      },
    ],
    excluded_files: [
      { path: '.env', reason: 'sensitive' },
    ],
    diff: TEST_DIFF,
    changed_files: [
      {
        path: 'src/auth.ts',
        content: `export async function login(input: unknown) {
  if (!input) {
    throw new Error('missing input');
  }
  return db.query(String(input));
}
`,
        diff_hunks: `@@ -1,3 +1,7 @@
-export async function login(input: unknown) {
-  return db.query(input as string);
+export async function login(input: unknown) {
+  if (!input) {
+    throw new Error('missing input');
+  }
+  return db.query(String(input));
 }`,
        language: 'typescript',
        stats: { additions: 4, deletions: 1 },
        change_type: 'modified',
      },
      {
        path: 'src/utils.ts',
        content: `export function formatName(name: string): string {
  return name.trim();
}
`,
        diff_hunks: `@@ -0,0 +1,4 @@
+export function formatName(name: string): string {
+  return name.trim();
+}
`,
        language: 'typescript',
        stats: { additions: 3, deletions: 0 },
        change_type: 'added',
      },
    ],
  } as ReviewSnapshot;
}

// ── MockModelInvoker ──────────────────────────────────────────────

class MockModelInvoker {
  codexCallCount = 0;
  claudeCallCount = 0;

  async invokeCodex(_prompt: string, _opts: unknown): Promise<string> {
    this.codexCallCount++;
    throw new Error('invokeCodex not implemented in base mock');
  }

  async invokeClaude(_prompt: string, _opts: unknown): Promise<string> {
    this.claudeCallCount++;
    throw new Error('invokeClaude not implemented in base mock');
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe('Code-Review Workflow Integration (P1b-CR-0)', () => {

  // ================================================================
  // Test 1: Normal 2-round code-review flow
  // ================================================================
  describe('Test 1: Normal 2-round code-review (accept high + reject medium -> LGTM)', () => {
    let tmpDir: string;
    let store: WorkflowStore;
    let runId: string;

    before(async () => {
      tmpDir = await makeTmpDir();
      await writeTemplates(tmpDir);
      store = new WorkflowStore(tmpDir);

      class Test1Invoker extends MockModelInvoker {
        override async invokeCodex(_prompt: string, _opts: unknown): Promise<string> {
          this.codexCallCount++;
          if (this.codexCallCount === 1) {
            // Round 1: Codex finds 2 issues
            return JSON.stringify({
              findings: [
                {
                  issue: 'Missing input validation in auth handler',
                  severity: 'high',
                  evidence: 'src/auth.ts line 15-20',
                  suggestion: 'Add zod schema validation',
                  file: 'src/auth.ts',
                  line_range: { start: 15, end: 20 },
                  category: 'security',
                },
                {
                  issue: 'Unused import',
                  severity: 'low',
                  evidence: 'src/utils.ts line 1',
                  suggestion: 'Remove unused import',
                  file: 'src/utils.ts',
                  line_range: { start: 1, end: 1 },
                  category: 'style',
                },
              ],
              overall_assessment: 'minor_issues',
              summary: 'Found 2 issues: one security concern and one style issue',
            });
          }
          // Round 2: LGTM
          return JSON.stringify({
            findings: [],
            overall_assessment: 'lgtm',
            summary: 'All issues addressed, code looks good',
          });
        }

        override async invokeClaude(_prompt: string, _opts: unknown): Promise<string> {
          this.claudeCallCount++;
          // Round 1: accept the high, reject the low
          return JSON.stringify({
            decisions: [
              {
                issue_id: 'ISS-001',
                action: 'accept',
                reason: 'Valid security concern — input is used directly in SQL query',
                fix_instruction: 'Add zod schema validation before the database query at line 18',
              },
              {
                issue_id: 'ISS-002',
                action: 'reject',
                reason: 'Import is actually used in the test file via re-export',
              },
            ],
            summary: 'Accepted security issue with fix instruction, rejected style issue',
          });
        }
      }

      const mockInvoker = new Test1Invoker();
      const engine = buildEngine(store, mockInvoker);

      // Start with CODE_REVIEW_PROFILE + snapshot
      runId = await engine.start({
        spec: '',   // code-review doesn't use spec/plan
        plan: '',
        profile: CODE_REVIEW_PROFILE,
        snapshot: createTestSnapshot(),
      });
    });

    after(async () => {
      await removeTmpDir(tmpDir);
    });

    it('completes in 2 rounds', async () => {
      const meta = await store.getMeta(runId);
      assert.ok(meta);
      assert.equal(meta.status, 'completed');
      assert.equal(meta.current_round, 2);
    });

    it('uses code-review workflow type', async () => {
      const meta = await store.getMeta(runId);
      assert.ok(meta);
      assert.equal(meta.workflow_type, 'code-review');
    });

    it('records correct issue statuses (accepted is terminal)', async () => {
      const ledger = await store.loadLedger(runId);
      assert.ok(ledger);
      assert.equal(ledger.issues.length, 2);

      const iss1 = ledger.issues.find((i) => i.id === 'ISS-001');
      const iss2 = ledger.issues.find((i) => i.id === 'ISS-002');

      assert.ok(iss1);
      assert.equal(iss1.status, 'accepted');  // Terminal in code-review
      assert.equal(iss1.severity, 'high');
      assert.equal(iss1.category, 'security');
      assert.equal(iss1.source_file, 'src/auth.ts');
      assert.ok(iss1.fix_instruction?.includes('zod'));

      assert.ok(iss2);
      assert.equal(iss2.status, 'rejected');
    });

    it('stores fix_instruction separately from decision_reason', async () => {
      const ledger = await store.loadLedger(runId);
      assert.ok(ledger);

      const iss1 = ledger.issues.find((i) => i.id === 'ISS-001');
      assert.ok(iss1);
      // fix_instruction and decision_reason are distinct
      assert.notEqual(iss1.fix_instruction, iss1.decision_reason);
      assert.ok(iss1.decision_reason?.includes('Valid security concern'));
      assert.ok(iss1.fix_instruction?.includes('zod schema validation'));
    });

    it('does NOT apply patches (applyPatches=false)', async () => {
      // Spec should still be the empty string we started with
      const spec = await store.loadSpec(runId);
      assert.equal(spec, '');
    });

    it('emits correct event sequence', async () => {
      const events = await store.loadEvents(runId);
      const types = eventTypes(events);

      // Expect: workflow_started -> round_started -> codex_review_started ->
      //   codex_review_completed -> issue_matching_completed ->
      //   claude_decision_started -> claude_decision_completed ->
      //   issue_status_changed (x2) ->
      //   round_started(R2) -> ... -> termination_triggered -> workflow_completed
      assert.ok(types.includes('workflow_started'));
      assert.ok(types.includes('codex_review_completed'));
      assert.ok(types.includes('issue_matching_completed'));
      assert.ok(types.includes('claude_decision_completed'));
      assert.ok(types.includes('termination_triggered'));
      assert.ok(types.includes('workflow_completed'));

      // No patch events (code-review mode)
      assert.ok(!types.includes('spec_updated'));
      assert.ok(!types.includes('plan_updated'));
      assert.ok(!types.includes('patch_apply_failed'));
    });

    it('persists non-empty diff and changed file content for code-review prompts', async () => {
      const packRaw = await store.loadRoundArtifact(runId, 1, 'pack.json');
      assert.ok(packRaw);
      const pack = JSON.parse(packRaw) as {
        diff: string;
        changed_files: Array<{ path: string; content: string }>;
      };

      assert.ok(pack.diff.includes('diff --git a/src/auth.ts b/src/auth.ts'));
      assert.ok(pack.changed_files.length >= 2);
      assert.ok(pack.changed_files[0].content.includes("throw new Error('missing input')"));

      const claudeInput = await store.loadRoundArtifact(runId, 1, 'claude-input.md');
      assert.ok(claudeInput);
      assert.ok(claudeInput.includes('src/auth.ts'));
      assert.ok(claudeInput.includes("throw new Error('missing input')"));
      assert.ok(claudeInput.includes('diff --git a/src/auth.ts b/src/auth.ts'));
    });
  });

  // ================================================================
  // Test 2: Accepted is terminal — LGTM with accepted issues terminates
  // ================================================================
  describe('Test 2: acceptedIsTerminal — LGTM with accepted issues terminates cleanly', () => {
    let tmpDir: string;
    let store: WorkflowStore;
    let runId: string;

    before(async () => {
      tmpDir = await makeTmpDir();
      await writeTemplates(tmpDir);
      store = new WorkflowStore(tmpDir);

      class Test2Invoker extends MockModelInvoker {
        override async invokeCodex(_prompt: string, _opts: unknown): Promise<string> {
          this.codexCallCount++;
          if (this.codexCallCount === 1) {
            return JSON.stringify({
              findings: [
                {
                  issue: 'Potential null dereference',
                  severity: 'medium',
                  evidence: 'src/auth.ts line 30',
                  suggestion: 'Add null check',
                  file: 'src/auth.ts',
                  line_range: { start: 30, end: 35 },
                  category: 'bug',
                },
              ],
              overall_assessment: 'minor_issues',
              summary: 'Found 1 potential null deref',
            });
          }
          // Round 2: LGTM — accepted issue should NOT block termination
          return JSON.stringify({
            findings: [],
            overall_assessment: 'lgtm',
            summary: 'LGTM',
          });
        }

        override async invokeClaude(_prompt: string, _opts: unknown): Promise<string> {
          this.claudeCallCount++;
          return JSON.stringify({
            decisions: [
              {
                issue_id: 'ISS-001',
                action: 'accept',
                reason: 'Confirmed: can produce undefined when user object is null',
                fix_instruction: 'Add optional chaining: user?.name instead of user.name at line 32',
              },
            ],
            summary: 'Accepted the null deref issue',
          });
        }
      }

      const engine = buildEngine(store, new Test2Invoker());
      runId = await engine.start({
        spec: '', plan: '',
        profile: CODE_REVIEW_PROFILE,
        snapshot: createTestSnapshot(),
      });
    });

    after(async () => {
      await removeTmpDir(tmpDir);
    });

    it('terminates after LGTM despite accepted (non-resolved) issues', async () => {
      const meta = await store.getMeta(runId);
      assert.ok(meta);
      assert.equal(meta.status, 'completed');

      // In spec-review, accepted would block LGTM termination.
      // In code-review, acceptedIsTerminal=true means accepted issues don't block.
      const ledger = await store.loadLedger(runId);
      assert.ok(ledger);
      assert.equal(ledger.issues.length, 1);
      assert.equal(ledger.issues[0].status, 'accepted');
    });

    it('termination reason is lgtm', async () => {
      const events = await store.loadEvents(runId);
      const termEvent = events.find((e) => e.event_type === 'termination_triggered');
      assert.ok(termEvent);
      assert.equal(termEvent.data.reason, 'lgtm');
    });
  });

  // ================================================================
  // Test 3: ReportGenerator produces correct output
  // ================================================================
  describe('Test 3: ReportGenerator produces Markdown and structured data', () => {
    let tmpDir: string;
    let store: WorkflowStore;
    let runId: string;

    before(async () => {
      tmpDir = await makeTmpDir();
      await writeTemplates(tmpDir);
      store = new WorkflowStore(tmpDir);

      class Test3Invoker extends MockModelInvoker {
        override async invokeCodex(_prompt: string, _opts: unknown): Promise<string> {
          this.codexCallCount++;
          if (this.codexCallCount === 1) {
            return JSON.stringify({
              findings: [
                {
                  issue: 'SQL injection vulnerability',
                  severity: 'critical',
                  evidence: 'src/auth.ts line 42',
                  suggestion: 'Use parameterized queries',
                  file: 'src/auth.ts',
                  line_range: { start: 42, end: 45 },
                  category: 'security',
                },
                {
                  issue: 'Missing error boundary',
                  severity: 'medium',
                  evidence: 'src/utils.ts line 10-15',
                  suggestion: 'Wrap async call in try-catch',
                  file: 'src/utils.ts',
                  line_range: { start: 10, end: 15 },
                  category: 'error_handling',
                },
                {
                  issue: 'Inconsistent naming',
                  severity: 'low',
                  evidence: 'src/utils.ts line 3',
                  suggestion: 'Rename to camelCase',
                  file: 'src/utils.ts',
                  line_range: { start: 3, end: 3 },
                  category: 'style',
                },
              ],
              overall_assessment: 'major_issues',
              summary: 'Found 3 issues including a critical SQL injection',
            });
          }
          return JSON.stringify({
            findings: [],
            overall_assessment: 'lgtm',
            summary: 'LGTM',
          });
        }

        override async invokeClaude(_prompt: string, _opts: unknown): Promise<string> {
          this.claudeCallCount++;
          return JSON.stringify({
            decisions: [
              {
                issue_id: 'ISS-001',
                action: 'accept',
                reason: 'Confirmed SQL injection risk',
                fix_instruction: 'Replace string concatenation with parameterized query using $1 placeholders',
              },
              {
                issue_id: 'ISS-002',
                action: 'accept',
                reason: 'Valid error handling gap',
                fix_instruction: 'Wrap the fetch() call at line 12 in a try-catch block',
              },
              {
                issue_id: 'ISS-003',
                action: 'reject',
                reason: 'The naming follows the project convention, not standard camelCase',
              },
            ],
            summary: 'Accepted 2 issues with fixes, rejected naming issue',
          });
        }
      }

      const engine = buildEngine(store, new Test3Invoker());
      runId = await engine.start({
        spec: '', plan: '',
        profile: CODE_REVIEW_PROFILE,
        snapshot: createTestSnapshot(),
      });
    });

    after(async () => {
      await removeTmpDir(tmpDir);
    });

    it('generates a structured report with correct stats', async () => {
      const reporter = new ReportGenerator(store);
      const { data, markdown } = await reporter.generate(runId);

      // Stats
      assert.equal(data.stats.total_findings, 3);
      assert.equal(data.stats.accepted, 2);
      assert.equal(data.stats.rejected, 1);
      assert.equal(data.stats.deferred, 0);

      // By severity
      assert.equal(data.stats.by_severity.critical, 1);
      assert.equal(data.stats.by_severity.medium, 1);
      assert.equal(data.stats.by_severity.low, 1);

      // By category
      assert.equal(data.stats.by_category.security, 1);
      assert.equal(data.stats.by_category.error_handling, 1);
      assert.equal(data.stats.by_category.style, 1);

      // Conclusion
      assert.equal(data.conclusion, 'critical_issues');

      // File results
      assert.equal(data.file_results.length, 2);
      const authFile = data.file_results.find((f) => f.path === 'src/auth.ts');
      const utilsFile = data.file_results.find((f) => f.path === 'src/utils.ts');
      assert.ok(authFile);
      assert.ok(utilsFile);
      assert.equal(authFile.issues.length, 1);
      assert.equal(utilsFile.issues.length, 2);

      // Excluded files from snapshot
      assert.equal(data.excluded_files.length, 1);
      assert.equal(data.excluded_files[0].path, '.env');
    });

    it('generates Markdown with expected sections', async () => {
      const reporter = new ReportGenerator(store);
      const { markdown } = await reporter.generate(runId);

      assert.ok(markdown.includes('# 代码审查报告'));
      assert.ok(markdown.includes('## 摘要'));
      assert.ok(markdown.includes('## 文件明细'));
      assert.ok(markdown.includes('`src/auth.ts`'));
      assert.ok(markdown.includes('`src/utils.ts`'));
      assert.ok(markdown.includes('修复建议'));
      assert.ok(markdown.includes('parameterized query'));

      // Excluded files section
      assert.ok(markdown.includes('## 已排除文件'));
      assert.ok(markdown.includes('.env'));
      assert.ok(markdown.includes('敏感文件'));
    });

    it('report contains fix_instruction separately from reason', async () => {
      const reporter = new ReportGenerator(store);
      const { data } = await reporter.generate(runId);

      const authIssue = data.file_results
        .find((f) => f.path === 'src/auth.ts')
        ?.issues[0];

      assert.ok(authIssue);
      assert.equal(authIssue.action, 'accept');
      assert.ok(authIssue.reason.includes('SQL injection'));
      assert.ok(authIssue.fix_instruction?.includes('parameterized query'));
      assert.notEqual(authIssue.reason, authIssue.fix_instruction);
    });

    it('writes final report artifacts to the run directory', async () => {
      const markdownPath = path.join(tmpDir, 'runs', runId, 'code-review-report.md');
      const jsonPath = path.join(tmpDir, 'runs', runId, 'code-review-report.json');

      const markdown = await fs.readFile(markdownPath, 'utf-8');
      const jsonRaw = await fs.readFile(jsonPath, 'utf-8');
      const report = JSON.parse(jsonRaw) as { run_id: string; stats: { total_findings: number } };

      assert.ok(markdown.includes('# 代码审查报告'));
      assert.equal(report.run_id, runId);
      assert.equal(report.stats.total_findings, 3);
    });
  });

  // ================================================================
  // Test 4: Profile behavior flags are correctly enforced
  // ================================================================
  describe('Test 4: Profile behavior flags enforcement', () => {
    let tmpDir: string;
    let store: WorkflowStore;
    let runId: string;
    let capturedClaudePrompt: string;

    before(async () => {
      tmpDir = await makeTmpDir();
      await writeTemplates(tmpDir);
      store = new WorkflowStore(tmpDir);

      class Test4Invoker extends MockModelInvoker {
        override async invokeCodex(_prompt: string, _opts: unknown): Promise<string> {
          this.codexCallCount++;
          if (this.codexCallCount === 1) {
            return JSON.stringify({
              findings: [
                {
                  issue: 'Test finding',
                  severity: 'medium',
                  evidence: 'src/auth.ts line 1',
                  suggestion: 'Fix it',
                  file: 'src/auth.ts',
                  line_range: { start: 1, end: 5 },
                  category: 'bug',
                },
              ],
              overall_assessment: 'minor_issues',
              summary: 'Found 1 issue',
            });
          }
          return JSON.stringify({
            findings: [],
            overall_assessment: 'lgtm',
            summary: 'LGTM',
          });
        }

        override async invokeClaude(prompt: string, _opts: unknown): Promise<string> {
          this.claudeCallCount++;
          capturedClaudePrompt = prompt;
          return JSON.stringify({
            decisions: [
              {
                issue_id: 'ISS-001',
                action: 'accept',
                reason: 'Confirmed issue',
                fix_instruction: 'Add null check at line 3',
              },
            ],
            summary: 'Accepted',
          });
        }
      }

      const engine = buildEngine(store, new Test4Invoker());
      runId = await engine.start({
        spec: '', plan: '',
        profile: CODE_REVIEW_PROFILE,
        snapshot: createTestSnapshot(),
      });
    });

    after(async () => {
      await removeTmpDir(tmpDir);
    });

    it('Claude prompt does NOT include previousDecisions (fresh context)', () => {
      // In code-review, claudeIncludesPreviousDecisions=false
      // The prompt should not contain "Previous Rounds Decisions" content
      // (it may contain the placeholder heading but no actual decision data)
      assert.ok(capturedClaudePrompt);
      // The prompt template for code-review doesn't have a previousDecisions section at all
      assert.ok(!capturedClaudePrompt.includes('previous_decisions'));
    });

    it('no spec/plan patches were written', async () => {
      const spec = await store.loadSpec(runId, 1);
      assert.equal(spec, '');
      // No v2 should exist
      const specV2 = await store.loadSpec(runId, 2);
      assert.equal(specV2, null);
    });

    it('accepted issue has fix_instruction stored', async () => {
      const ledger = await store.loadLedger(runId);
      assert.ok(ledger);
      const iss = ledger.issues[0];
      assert.equal(iss.status, 'accepted');
      assert.ok(iss.fix_instruction);
      assert.ok(iss.fix_instruction.includes('null check'));
    });
  });
});
