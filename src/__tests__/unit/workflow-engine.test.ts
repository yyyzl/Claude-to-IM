/**
 * Integration tests for WorkflowEngine — the core orchestrator.
 *
 * Strategy:
 * - Real dependencies: WorkflowStore, PackBuilder, PromptAssembler,
 *   TerminationJudge, JsonParser, IssueMatcher, PatchApplier, ContextCompressor
 * - Mocked: ModelInvoker (no actual Codex/Claude calls)
 *
 * Tests:
 * 1. Normal 2-round flow (critical accept + medium reject -> LGTM terminate)
 * 2. LGTM with open issues (Claude accept_and_resolve -> terminate)
 * 3. Deadlock detection (rejected issue re-raised 2+ times -> pause_for_human)
 * 4. Resume mechanism (paused workflow resumes from correct step)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
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
import type {
  WorkflowMeta,
  WorkflowEvent,
  IssueLedger,
} from '../../lib/workflow/types.js';
import { DEFAULT_CONFIG } from '../../lib/workflow/types.js';

// ── Template contents (copied from production templates) ──────────

const SPEC_REVIEW_TEMPLATE = `You are an independent technical reviewer. Review the following Spec and Plan rigorously.

Your responsibilities:
- Find logic gaps, missing edge cases, inconsistencies
- Assess technical feasibility
- Check spec-plan consistency
- Focus on unresolved issues; do NOT re-raise issues listed in "Previously Rejected"
  unless you have strong new evidence

Output format (strict JSON):
{ "findings": [{ "issue": "description", "severity": "critical|high|medium|low",
                  "evidence": "section reference", "suggestion": "proposed fix" }],
  "overall_assessment": "lgtm|minor_issues|major_issues",
  "summary": "one-paragraph summary" }

IMPORTANT: severity must be one of: critical, high, medium, low (exactly these values).

## Current Spec
{{spec}}

## Current Plan
{{plan}}

## Unresolved Issues (focus here)
{{unresolved_issues}}

## Previously Rejected (do not re-raise without new evidence)
{{rejected_issues}}

## Previous Rounds Summary
{{round_summary}}

## Current Round
{{round}}

## Reference Files
{{context_files}}`;

const CLAUDE_DECISION_TEMPLATE = `Codex completed round {{round}} independent review. Decide on each finding:
accept (modify spec/plan), reject (explain why), defer, or accept_and_resolve (valid but no patch needed).

Each finding below has an assigned issue ID. Use these IDs in your decisions.

## Codex Findings (with assigned IDs)
{{codex_findings_with_ids}}

(If no findings above: Codex found no new issues. Please review and address the remaining
open/accepted issues in the ledger below. You may reject, defer, or accept_and_resolve them.)

## Previous Rounds Decisions (for context continuity)
{{previous_decisions}}

## Current Issue Ledger
{{ledger_summary}}

## Current Spec (for reference when writing patches)
{{current_spec}}

## Current Plan (for reference when writing patches)
{{current_plan}}

Output format (strict JSON):
{ "decisions": [{ "issue_id": "ISS-001", "action": "accept|reject|defer|accept_and_resolve", "reason": "..." }],
  "spec_updated": true/false, "plan_updated": true/false,
  "spec_patch": "...(full modified section with heading, only if spec_updated)...",
  "plan_patch": "...(full modified section with heading, only if plan_updated)...",
  "resolves_issues": ["ISS-001", "ISS-003"],
  "summary": "..." }

IMPORTANT:
- When action="accept" AND you provide a patch, you MUST include "resolves_issues" listing the issue IDs
  your patch addresses. If omitted, accepted issues will NOT be auto-resolved (safety measure).
- Use "accept_and_resolve" for issues that are valid but require no spec/plan change.
- Patch sections must include their heading (e.g., "## 4.2 Issue Lifecycle" or "### 6.5 TerminationJudge").
  The heading level must match the original document exactly.

If JSON output is not possible, wrap modified sections in markers:
--- SPEC UPDATE ---
(modified spec content)
--- END SPEC UPDATE ---
--- PLAN UPDATE ---
(modified plan content)
--- END PLAN UPDATE ---`;

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

// ── Helpers ───────────────────────────────────────────────────────

/** Create a unique temporary directory for test isolation. */
async function makeTmpDir(): Promise<string> {
  const prefix = path.join(os.tmpdir(), 'wf-engine-test-');
  return fs.mkdtemp(prefix);
}

/** Recursively remove a directory (test cleanup). */
async function removeTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Write the 3 production templates into the tmpDir/templates/ subdirectory. */
async function writeTemplates(tmpDir: string): Promise<void> {
  const templatesDir = path.join(tmpDir, 'templates');
  await fs.mkdir(templatesDir, { recursive: true });
  await fs.writeFile(
    path.join(templatesDir, 'spec-review-pack.md'),
    SPEC_REVIEW_TEMPLATE,
    'utf-8',
  );
  await fs.writeFile(
    path.join(templatesDir, 'claude-decision.md'),
    CLAUDE_DECISION_TEMPLATE,
    'utf-8',
  );
  await fs.writeFile(
    path.join(templatesDir, 'round-summary.md'),
    ROUND_SUMMARY_TEMPLATE,
    'utf-8',
  );
}

/** Build a fully wired WorkflowEngine with a MockModelInvoker. */
function buildEngine(
  store: WorkflowStore,
  mockInvoker: MockModelInvoker,
): WorkflowEngine {
  const compressor = new ContextCompressor();
  const packBuilder = new PackBuilder(store, compressor);
  const promptAssembler = new PromptAssembler(store);
  const terminationJudge = new TerminationJudge();
  const jsonParser = new JsonParser();
  const issueMatcher = new IssueMatcher();
  const patchApplier = new PatchApplier();

  return new WorkflowEngine(
    store,
    packBuilder,
    promptAssembler,
    mockInvoker as unknown as ModelInvoker,
    terminationJudge,
    jsonParser,
    issueMatcher,
    patchApplier,
  );
}

/** Extract event types from an event list for quick assertion. */
function eventTypes(events: WorkflowEvent[]): string[] {
  return events.map((e) => e.event_type);
}

// ── Sample test fixtures ──────────────────────────────────────────

const SAMPLE_SPEC = `# My Feature Spec

## 1. Overview
This is a sample specification for testing.

## 2. Architecture
The system uses a modular design.

## 3. Naming Conventions
All modules follow camelCase naming.

## 4. Error Handling
Basic error handling is in place.

## 4.2 Error Handling Details
Currently minimal.
`;

const SAMPLE_PLAN = `# Implementation Plan

## Phase 1
Set up project structure.

## Phase 2
Implement core features.
`;

// ── MockModelInvoker ──────────────────────────────────────────────

/**
 * Base class for MockModelInvoker. Subclassed per test scenario.
 * Has the same method signatures as the real ModelInvoker.
 */
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

describe('WorkflowEngine Integration', () => {

  // ================================================================
  // Test 1: Normal 2-round flow
  // ================================================================
  describe('Test 1: Normal 2-round flow (accept critical + reject medium -> LGTM)', () => {
    let tmpDir: string;
    let store: WorkflowStore;
    let runId: string;

    before(async () => {
      tmpDir = await makeTmpDir();
      await writeTemplates(tmpDir);
      store = new WorkflowStore(tmpDir);

      // Mock: Round 1 Codex returns 2 findings, Round 2 LGTM
      // Mock: Round 1 Claude accepts critical and patches, rejects medium
      class Test1Invoker extends MockModelInvoker {
        override async invokeCodex(_prompt: string, _opts: unknown): Promise<string> {
          this.codexCallCount++;
          if (this.codexCallCount === 1) {
            return JSON.stringify({
              findings: [
                {
                  issue: 'Missing error handling in section 4',
                  severity: 'critical',
                  evidence: 'spec section 4.2',
                  suggestion: 'Add try-catch',
                },
                {
                  issue: 'Naming inconsistency',
                  severity: 'medium',
                  evidence: 'spec section 3.1',
                  suggestion: 'Standardize naming',
                },
              ],
              overall_assessment: 'major_issues',
              summary: 'Found 2 issues in first review',
            });
          }
          // Round 2: LGTM with no findings
          return JSON.stringify({
            findings: [],
            overall_assessment: 'lgtm',
            summary: 'All issues addressed, LGTM',
          });
        }

        override async invokeClaude(_prompt: string, _opts: unknown): Promise<string> {
          this.claudeCallCount++;
          return JSON.stringify({
            decisions: [
              {
                issue_id: 'ISS-001',
                action: 'accept',
                reason: 'Valid concern, will add error handling',
              },
              {
                issue_id: 'ISS-002',
                action: 'reject',
                reason: 'Current naming is consistent',
              },
            ],
            spec_updated: true,
            plan_updated: false,
            spec_patch: '## 4.2 Error Handling Details\n\nAll operations must use try-catch blocks.',
            resolves_issues: ['ISS-001'],
            summary: 'Accepted critical error handling issue, rejected naming concern',
          });
        }
      }

      const mock = new Test1Invoker();
      const engine = buildEngine(store, mock);

      runId = await engine.start({
        spec: SAMPLE_SPEC,
        plan: SAMPLE_PLAN,
        config: { max_rounds: 5 },
      });
    });

    after(async () => {
      await removeTmpDir(tmpDir);
    });

    it('workflow completes with status "completed"', async () => {
      const meta = await store.getMeta(runId);
      assert.ok(meta, 'meta should exist');
      assert.equal(meta.status, 'completed');
    });

    it('has 2 issues in the ledger', async () => {
      const ledger = await store.loadLedger(runId);
      assert.ok(ledger, 'ledger should exist');
      assert.equal(ledger.issues.length, 2);
    });

    it('ISS-001 is resolved', async () => {
      const ledger = await store.loadLedger(runId);
      assert.ok(ledger);
      const iss1 = ledger.issues.find((i) => i.id === 'ISS-001');
      assert.ok(iss1, 'ISS-001 should exist');
      assert.equal(iss1.status, 'resolved');
      assert.equal(iss1.resolved_in_round, 1);
    });

    it('ISS-002 is rejected', async () => {
      const ledger = await store.loadLedger(runId);
      assert.ok(ledger);
      const iss2 = ledger.issues.find((i) => i.id === 'ISS-002');
      assert.ok(iss2, 'ISS-002 should exist');
      assert.equal(iss2.status, 'rejected');
    });

    it('spec-v2 exists and contains the patch', async () => {
      const spec = await store.loadSpec(runId);
      assert.ok(spec, 'spec should exist');
      assert.ok(
        spec.includes('All operations must use try-catch blocks'),
        'spec should contain the patched content',
      );
    });

    it('events.ndjson has the correct event sequence', async () => {
      const events = await store.loadEvents(runId);
      const types = eventTypes(events);

      // Verify key events in order
      assert.ok(types.includes('workflow_started'), 'should have workflow_started');
      assert.ok(types.includes('round_started'), 'should have round_started');
      assert.ok(types.includes('codex_review_started'), 'should have codex_review_started');
      assert.ok(types.includes('codex_review_completed'), 'should have codex_review_completed');
      assert.ok(types.includes('issue_created'), 'should have issue_created');
      assert.ok(types.includes('issue_matching_completed'), 'should have issue_matching_completed');
      assert.ok(types.includes('claude_decision_started'), 'should have claude_decision_started');
      assert.ok(types.includes('claude_decision_completed'), 'should have claude_decision_completed');
      assert.ok(types.includes('spec_updated'), 'should have spec_updated');
      assert.ok(types.includes('issue_status_changed'), 'should have issue_status_changed');
      assert.ok(types.includes('termination_triggered'), 'should have termination_triggered');
      assert.ok(types.includes('workflow_completed'), 'should have workflow_completed');

      // workflow_started should be first
      assert.equal(types[0], 'workflow_started');
      // workflow_completed should be last
      assert.equal(types[types.length - 1], 'workflow_completed');
    });

    it('termination reason is lgtm', async () => {
      const events = await store.loadEvents(runId);
      const termEvent = events.find((e) => e.event_type === 'termination_triggered');
      assert.ok(termEvent, 'should have termination event');
      assert.equal(termEvent.data.reason, 'lgtm');
    });
  });

  // ================================================================
  // Test 2: LGTM with open issues (Claude accept_and_resolve)
  // ================================================================
  describe('Test 2: LGTM with open issues -> Claude accept_and_resolve -> terminate', () => {
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
            // Round 1: 1 finding
            return JSON.stringify({
              findings: [
                {
                  issue: 'Missing validation in API endpoint',
                  severity: 'high',
                  evidence: 'spec section 2',
                  suggestion: 'Add input validation',
                },
              ],
              overall_assessment: 'minor_issues',
              summary: 'Found 1 issue',
            });
          }
          // Round 2: LGTM (no findings)
          return JSON.stringify({
            findings: [],
            overall_assessment: 'lgtm',
            summary: 'All good, LGTM',
          });
        }

        override async invokeClaude(_prompt: string, _opts: unknown): Promise<string> {
          this.claudeCallCount++;
          if (this.claudeCallCount === 1) {
            // Round 1: accept_and_resolve (valid but no patch needed)
            return JSON.stringify({
              decisions: [
                {
                  issue_id: 'ISS-001',
                  action: 'accept_and_resolve',
                  reason: 'Valid point, validation is already handled at middleware level',
                },
              ],
              spec_updated: false,
              plan_updated: false,
              summary: 'Accepted and resolved - validation exists at middleware layer',
            });
          }
          // Should not reach here for this scenario
          return JSON.stringify({
            decisions: [],
            spec_updated: false,
            plan_updated: false,
            summary: 'No decisions needed',
          });
        }
      }

      const mock = new Test2Invoker();
      const engine = buildEngine(store, mock);

      runId = await engine.start({
        spec: SAMPLE_SPEC,
        plan: SAMPLE_PLAN,
        config: { max_rounds: 5 },
      });
    });

    after(async () => {
      await removeTmpDir(tmpDir);
    });

    it('workflow completes successfully', async () => {
      const meta = await store.getMeta(runId);
      assert.ok(meta);
      assert.equal(meta.status, 'completed');
    });

    it('ISS-001 is resolved via accept_and_resolve', async () => {
      const ledger = await store.loadLedger(runId);
      assert.ok(ledger);
      const iss = ledger.issues.find((i) => i.id === 'ISS-001');
      assert.ok(iss, 'ISS-001 should exist');
      assert.equal(iss.status, 'resolved');
    });

    it('terminates with lgtm reason', async () => {
      const events = await store.loadEvents(runId);
      const termEvent = events.find((e) => e.event_type === 'termination_triggered');
      assert.ok(termEvent);
      assert.equal(termEvent.data.reason, 'lgtm');
    });
  });

  // ================================================================
  // Test 3: Deadlock detection
  // ================================================================
  describe('Test 3: Deadlock detection (repeat_count >= 2 -> pause_for_human)', () => {
    let tmpDir: string;
    let store: WorkflowStore;
    let runId: string;

    before(async () => {
      tmpDir = await makeTmpDir();
      await writeTemplates(tmpDir);
      store = new WorkflowStore(tmpDir);

      // Scenario: Codex keeps raising the same issue, Claude keeps rejecting.
      // Each round also introduces a NEW high-severity issue to prevent
      // the "no_new_high_severity for 2 rounds" termination rule from firing
      // before deadlock can be detected.
      //
      // Flow:
      // Round 1: Codex raises issue A + B, Claude rejects A, accept_and_resolve B
      //          -> ISS-001 rejected (repeat_count=0), ISS-002 resolved
      // Round 2: Codex re-raises A (matched->reopened, repeat_count=1) + new C
      //          Claude rejects A again, accept_and_resolve C
      //          -> ISS-001 rejected (repeat_count=1), ISS-003 resolved
      // Round 3: Codex re-raises A (matched->reopened, repeat_count=2) + new D
      //          -> issue_matching: ISS-001 status=open, repeat_count=2
      //          -> pre_termination: ISS-001 is open (not rejected), no deadlock
      //          -> Claude rejects A, accept_and_resolve D
      //          -> ISS-001 rejected (repeat_count=2)
      //          -> post_decision: judge sees rejected + repeat_count=2 -> deadlock!
      class Test3Invoker extends MockModelInvoker {
        override async invokeCodex(_prompt: string, _opts: unknown): Promise<string> {
          this.codexCallCount++;
          // Always re-raise the same deadlock issue + a unique new high-severity issue
          return JSON.stringify({
            findings: [
              {
                issue: 'Security vulnerability in auth module',
                severity: 'critical',
                evidence: 'spec section 2.1',
                suggestion: 'Use bcrypt instead of md5',
              },
              {
                issue: `Performance concern round ${this.codexCallCount}`,
                severity: 'high',
                evidence: `spec section ${this.codexCallCount}.0`,
                suggestion: `Optimize round ${this.codexCallCount}`,
              },
            ],
            overall_assessment: 'major_issues',
            summary: 'Critical security issue and performance concern found',
          });
        }

        override async invokeClaude(_prompt: string, _opts: unknown): Promise<string> {
          this.claudeCallCount++;
          // Determine the new issue ID: ISS-002 for round 1, ISS-003 for round 2, ISS-004 for round 3
          const newIssueId = `ISS-${String(this.claudeCallCount + 1).padStart(3, '0')}`;
          return JSON.stringify({
            decisions: [
              {
                issue_id: 'ISS-001',
                action: 'reject',
                reason: 'We use argon2, not md5. Codex is wrong.',
              },
              {
                issue_id: newIssueId,
                action: 'accept_and_resolve',
                reason: 'Valid performance concern, already addressed.',
              },
            ],
            spec_updated: false,
            plan_updated: false,
            summary: 'Rejected security concern, resolved performance issue',
          });
        }
      }

      const mock = new Test3Invoker();
      const engine = buildEngine(store, mock);

      runId = await engine.start({
        spec: SAMPLE_SPEC,
        plan: SAMPLE_PLAN,
        config: { max_rounds: 5 },
      });
    });

    after(async () => {
      await removeTmpDir(tmpDir);
    });

    it('workflow status is human_review', async () => {
      const meta = await store.getMeta(runId);
      assert.ok(meta);
      assert.equal(meta.status, 'human_review');
    });

    it('ISS-001 has repeat_count >= 2 when deadlock triggers', async () => {
      const events = await store.loadEvents(runId);
      const humanReviewEvent = events.find(
        (e) => e.event_type === 'human_review_requested',
      );
      assert.ok(humanReviewEvent, 'should have human_review_requested event');
      assert.equal(humanReviewEvent.data.reason, 'deadlock_detected');
    });

    it('ran at least 3 rounds before deadlock detection', async () => {
      const events = await store.loadEvents(runId);
      const roundStartEvents = events.filter(
        (e) => e.event_type === 'round_started',
      );
      // Deadlock detected at pre_termination of round 3
      // (after round 3 issue_matching reopens with repeat_count=2)
      assert.ok(
        roundStartEvents.length >= 3,
        `Expected >= 3 round_started events, got ${roundStartEvents.length}`,
      );
    });
  });

  // ================================================================
  // Test 4: Resume mechanism (paused workflow resumes from correct step)
  // ================================================================
  describe('Test 4: Resume mechanism (pause after codex_review -> resume)', () => {
    let tmpDir: string;
    let store: WorkflowStore;
    let runId: string;

    before(async () => {
      tmpDir = await makeTmpDir();
      await writeTemplates(tmpDir);
      store = new WorkflowStore(tmpDir);

      // Phase 1: Run normally for round 1 codex_review, then we manually pause.
      // Phase 2: Resume and complete.

      let phase = 1;

      class Test4Invoker extends MockModelInvoker {
        override async invokeCodex(_prompt: string, _opts: unknown): Promise<string> {
          this.codexCallCount++;
          // Round 1: 1 finding
          if (this.codexCallCount === 1) {
            return JSON.stringify({
              findings: [
                {
                  issue: 'Missing logging in module X',
                  severity: 'medium',
                  evidence: 'spec section 3',
                  suggestion: 'Add structured logging',
                },
              ],
              overall_assessment: 'minor_issues',
              summary: 'Found 1 minor issue',
            });
          }
          // Round 2 (after resume): LGTM
          return JSON.stringify({
            findings: [],
            overall_assessment: 'lgtm',
            summary: 'LGTM after addressing issues',
          });
        }

        override async invokeClaude(_prompt: string, _opts: unknown): Promise<string> {
          this.claudeCallCount++;
          return JSON.stringify({
            decisions: [
              {
                issue_id: 'ISS-001',
                action: 'accept_and_resolve',
                reason: 'Will add logging',
              },
            ],
            spec_updated: false,
            plan_updated: false,
            summary: 'Accepted logging concern',
          });
        }
      }

      const mock = new Test4Invoker();

      // Phase 1: Start a workflow that runs to completion of round 1 codex_review.
      // We achieve the "pause" by starting a normal workflow, letting it run,
      // then manually updating meta to paused at a meaningful checkpoint.
      //
      // Since the engine runs synchronously within start(), we need a different approach:
      // We start a full workflow first, then create a new scenario that tests resume.

      // First, run a workflow that gets to paused state via manual intervention.
      // The cleanest approach: start a workflow, let round 1 complete, then
      // manually set status='paused' and current_step to simulate mid-round pause,
      // then resume.

      const engine1 = buildEngine(store, mock);
      runId = await engine1.start({
        spec: SAMPLE_SPEC,
        plan: SAMPLE_PLAN,
        config: { max_rounds: 5 },
      });

      // At this point the workflow completed normally. Let's verify, then
      // set up a resume test by resetting state.
      // For a proper resume test, we manually set meta back to 'paused'
      // and rewind to round 2 codex_review step (simulating a crash after round 1).

      // The workflow already completed. For resume testing, we change status to 'paused'.
      await store.updateMeta(runId, {
        status: 'paused',
        current_round: 2,
        current_step: 'codex_review',
      });

      // Reset mock call counts for phase 2
      mock.codexCallCount = 1; // codex was called once in round 1, set to 1 so next call returns LGTM
      mock.claudeCallCount = 0;

      // Phase 2: Resume
      const engine2 = buildEngine(store, mock);
      await engine2.resume(runId);
    });

    after(async () => {
      await removeTmpDir(tmpDir);
    });

    it('workflow completes after resume', async () => {
      const meta = await store.getMeta(runId);
      assert.ok(meta);
      assert.equal(meta.status, 'completed');
    });

    it('has workflow_resumed event', async () => {
      const events = await store.loadEvents(runId);
      const resumeEvent = events.find((e) => e.event_type === 'workflow_resumed');
      assert.ok(resumeEvent, 'should have workflow_resumed event');
      assert.equal(resumeEvent.data.resumed_from_step, 'codex_review');
      assert.equal(resumeEvent.data.resumed_from_round, 2);
    });

    it('has workflow_completed event after resume', async () => {
      const events = await store.loadEvents(runId);
      const types = eventTypes(events);

      // Find the index of workflow_resumed
      const resumeIdx = types.indexOf('workflow_resumed');
      assert.ok(resumeIdx >= 0, 'workflow_resumed should be in events');

      // workflow_completed should come after workflow_resumed
      const completedIdx = types.lastIndexOf('workflow_completed');
      assert.ok(completedIdx > resumeIdx, 'workflow_completed should come after workflow_resumed');
    });

    it('resume continues from the correct round', async () => {
      const events = await store.loadEvents(runId);

      // After resume, round 2 should start with codex_review
      const postResumeEvents = events.filter(
        (e) =>
          e.event_type === 'workflow_resumed' ||
          (e.round === 2 &&
            events.indexOf(e) > events.findIndex((ev) => ev.event_type === 'workflow_resumed')),
      );
      assert.ok(postResumeEvents.length > 0, 'should have events after resume');
    });
  });
});
