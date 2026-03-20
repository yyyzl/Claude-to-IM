/**
 * Unit tests for PromptAssembler — renders structured data into final prompt text.
 *
 * Covers:
 * - renderSpecReviewPrompt: full pack, empty optionals, round 1, issue/file formatting
 * - renderClaudeDecisionPrompt: with findings, without findings, first round, finding format
 *
 * Strategy: Uses a real WorkflowStore backed by a temporary directory with
 * production template files copied into `templates/`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { PromptAssembler } from '../../lib/workflow/prompt-assembler.js';
import { WorkflowStore } from '../../lib/workflow/workflow-store.js';
import type {
  SpecReviewPack,
  ClaudeDecisionInput,
  Issue,
  Finding,
} from '../../lib/workflow/types.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Create a unique temporary directory for test isolation. */
async function makeTmpDir(): Promise<string> {
  const prefix = path.join(os.tmpdir(), 'wf-assembler-test-');
  return fs.mkdtemp(prefix);
}

/** Recursively remove a directory (test cleanup). */
async function removeTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ── Template content (mirrors production templates) ──────────────

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

// ── Test fixtures ────────────────────────────────────────────────

/** Build a complete SpecReviewPack with all fields populated. */
function createFullPack(): SpecReviewPack {
  return {
    spec: '# My Spec\nThis is the spec document.',
    plan: '# My Plan\nThis is the plan document.',
    unresolved_issues: [
      {
        id: 'ISS-001',
        round: 1,
        raised_by: 'codex',
        severity: 'critical',
        description: 'Missing error handling in auth module',
        evidence: 'Line 42 in auth.ts',
        status: 'open',
        repeat_count: 0,
      },
      {
        id: 'ISS-002',
        round: 1,
        raised_by: 'codex',
        severity: 'high',
        description: 'Race condition in data fetcher',
        evidence: 'Concurrent calls to fetchData()',
        status: 'open',
        repeat_count: 1,
      },
    ],
    rejected_issues: [
      {
        id: 'ISS-003',
        description: 'Unnecessary abstraction layer',
        round_rejected: 1,
      },
    ],
    context_files: [
      {
        path: 'src/auth.ts',
        content: 'export function authenticate() { /* ... */ }',
      },
      {
        path: 'src/fetcher.ts',
        content: 'export async function fetchData() { /* ... */ }',
      },
    ],
    round_summary: 'Round 1 found 3 issues; 1 rejected, 2 remain open.',
    round: 2,
  };
}

/** Build a minimal SpecReviewPack with empty optional arrays and no round_summary. */
function createMinimalPack(): SpecReviewPack {
  return {
    spec: '# Minimal Spec',
    plan: '# Minimal Plan',
    unresolved_issues: [],
    rejected_issues: [],
    context_files: [],
    round_summary: '',
    round: 1,
  };
}

/** Build a ClaudeDecisionInput with findings. */
function createDecisionInputWithFindings(): ClaudeDecisionInput {
  return {
    round: 2,
    codexFindingsWithIds: [
      {
        issueId: 'ISS-004',
        finding: {
          issue: 'SQL injection vulnerability',
          severity: 'critical',
          evidence: 'User input passed directly to query builder',
          suggestion: 'Use parameterized queries',
        },
        isNew: true,
      },
      {
        issueId: 'ISS-001',
        finding: {
          issue: 'Missing error handling in auth module',
          severity: 'high',
          evidence: 'Line 42 in auth.ts',
          suggestion: 'Add try-catch around auth call',
        },
        isNew: false,
      },
    ],
    ledgerSummary: '4 issues total: 2 open, 1 rejected, 1 resolved',
    currentSpec: '# Current Spec v2',
    currentPlan: '# Current Plan v2',
    previousDecisions: 'Round 1: Accepted ISS-001, Rejected ISS-003',
    hasNewFindings: true,
  };
}

/** Build a ClaudeDecisionInput with no findings. */
function createDecisionInputNoFindings(): ClaudeDecisionInput {
  return {
    round: 3,
    codexFindingsWithIds: [],
    ledgerSummary: '2 issues total: 1 open, 1 resolved',
    currentSpec: '# Current Spec v3',
    currentPlan: '# Current Plan v3',
    previousDecisions: 'Round 1: Accepted ISS-001\nRound 2: Rejected ISS-004',
    hasNewFindings: false,
  };
}

/** Build a ClaudeDecisionInput for the first round (no previous decisions). */
function createDecisionInputFirstRound(): ClaudeDecisionInput {
  return {
    round: 1,
    codexFindingsWithIds: [
      {
        issueId: 'ISS-001',
        finding: {
          issue: 'Missing validation',
          severity: 'medium',
          evidence: 'No input validation on POST /api/users',
          suggestion: 'Add zod schema validation',
        },
        isNew: true,
      },
    ],
    ledgerSummary: '1 issue total: 1 open',
    currentSpec: '# Initial Spec',
    currentPlan: '# Initial Plan',
    previousDecisions: '',
    hasNewFindings: true,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('PromptAssembler', () => {
  let tmpDir: string;
  let store: WorkflowStore;
  let assembler: PromptAssembler;

  before(async () => {
    tmpDir = await makeTmpDir();

    // Create templates/ subdirectory and write production templates
    const templatesPath = path.join(tmpDir, 'templates');
    await fs.mkdir(templatesPath, { recursive: true });
    await fs.writeFile(
      path.join(templatesPath, 'spec-review-pack.md'),
      SPEC_REVIEW_TEMPLATE,
      'utf-8',
    );
    await fs.writeFile(
      path.join(templatesPath, 'claude-decision.md'),
      CLAUDE_DECISION_TEMPLATE,
      'utf-8',
    );

    store = new WorkflowStore(tmpDir);
    assembler = new PromptAssembler(store);
  });

  after(async () => {
    await removeTmpDir(tmpDir);
  });

  // ── renderSpecReviewPrompt ──────────────────────────────────

  describe('renderSpecReviewPrompt', () => {
    // ── Case 1: Full pack — all placeholders replaced ─────────
    it('replaces all placeholders when every field is populated', async () => {
      const pack = createFullPack();
      const result = await assembler.renderSpecReviewPrompt(pack);

      // No un-replaced placeholders should remain
      assert.ok(!result.includes('{{'), `Unexpected placeholder found in output: ${extractPlaceholders(result)}`);

      // Verify each field's content appears in the output
      assert.ok(result.includes('# My Spec'));
      assert.ok(result.includes('# My Plan'));
      assert.ok(result.includes('ISS-001'));
      assert.ok(result.includes('ISS-002'));
      assert.ok(result.includes('ISS-003'));
      assert.ok(result.includes('src/auth.ts'));
      assert.ok(result.includes('src/fetcher.ts'));
      assert.ok(result.includes('Round 1 found 3 issues'));
      assert.ok(result.includes('2')); // round number
    });

    // ── Case 2: Empty optional fields — shows "None" ──────────
    it('renders "None" for empty optional arrays', async () => {
      const pack = createMinimalPack();
      const result = await assembler.renderSpecReviewPrompt(pack);

      // Count occurrences of "None" (unresolved_issues, rejected_issues, context_files)
      const noneCount = countOccurrences(result, 'None');
      assert.ok(
        noneCount >= 3,
        `Expected at least 3 "None" entries for empty arrays, got ${noneCount}`,
      );

      // Spec and Plan should still appear
      assert.ok(result.includes('# Minimal Spec'));
      assert.ok(result.includes('# Minimal Plan'));
    });

    // ── Case 3: Round 1, no round_summary — shows "First round" ──
    it('shows "First round" when round_summary is empty', async () => {
      const pack = createMinimalPack();
      // round_summary is already '' in minimal pack
      const result = await assembler.renderSpecReviewPrompt(pack);

      assert.ok(
        result.includes('First round'),
        'Expected "First round" when round_summary is empty',
      );
    });

    // ── Case 4: Unresolved issues format ──────────────────────
    it('formats unresolved issues as "- [ID] (severity) description"', async () => {
      const pack = createFullPack();
      const result = await assembler.renderSpecReviewPrompt(pack);

      // Verify the exact format for each unresolved issue
      assert.ok(
        result.includes('- [ISS-001] (critical) Missing error handling in auth module'),
        'Issue ISS-001 not formatted correctly',
      );
      assert.ok(
        result.includes('- [ISS-002] (high) Race condition in data fetcher'),
        'Issue ISS-002 not formatted correctly',
      );
    });

    // ── Case 5: Context files format — filename + fenced code ──
    it('formats context files with heading and fenced code block', async () => {
      const pack = createFullPack();
      const result = await assembler.renderSpecReviewPrompt(pack);

      // Each file: ### path\n```\ncontent\n```
      assert.ok(
        result.includes('### src/auth.ts'),
        'Missing heading for src/auth.ts',
      );
      assert.ok(
        result.includes('### src/fetcher.ts'),
        'Missing heading for src/fetcher.ts',
      );

      // Verify fenced code blocks contain the content
      assert.ok(
        result.includes('```\nexport function authenticate() { /* ... */ }\n```'),
        'auth.ts content not in fenced code block',
      );
      assert.ok(
        result.includes('```\nexport async function fetchData() { /* ... */ }\n```'),
        'fetcher.ts content not in fenced code block',
      );
    });
  });

  // ── renderClaudeDecisionPrompt ──────────────────────────────

  describe('renderClaudeDecisionPrompt', () => {
    // ── Case 6: Normal prompt with findings ───────────────────
    it('renders findings with numbered list when hasNewFindings=true', async () => {
      const input = createDecisionInputWithFindings();
      const result = await assembler.renderClaudeDecisionPrompt(input);

      // No un-replaced placeholders
      assert.ok(!result.includes('{{'), `Unexpected placeholder found: ${extractPlaceholders(result)}`);

      // Verify round number
      assert.ok(result.includes('round 2'));

      // Verify findings are numbered
      assert.ok(result.includes('1. [ISS-004]'), 'Missing finding #1');
      assert.ok(result.includes('2. [ISS-001]'), 'Missing finding #2');

      // Verify ledger summary, spec, plan, previous decisions
      assert.ok(result.includes('4 issues total'));
      assert.ok(result.includes('# Current Spec v2'));
      assert.ok(result.includes('# Current Plan v2'));
      assert.ok(result.includes('Round 1: Accepted ISS-001'));
    });

    // ── Case 7: No findings prompt ────────────────────────────
    it('shows "No new findings from Codex." when hasNewFindings=false', async () => {
      const input = createDecisionInputNoFindings();
      const result = await assembler.renderClaudeDecisionPrompt(input);

      assert.ok(
        result.includes('No new findings from Codex.'),
        'Expected "No new findings from Codex." message',
      );

      // Other fields should still be present
      assert.ok(result.includes('round 3'));
      assert.ok(result.includes('# Current Spec v3'));
      assert.ok(result.includes('# Current Plan v3'));
    });

    // ── Case 8: First round — no previous decisions ───────────
    it('shows "First round - no previous decisions." when previousDecisions is empty', async () => {
      const input = createDecisionInputFirstRound();
      const result = await assembler.renderClaudeDecisionPrompt(input);

      assert.ok(
        result.includes('First round - no previous decisions.'),
        'Expected "First round - no previous decisions." for first round',
      );
    });

    // ── Case 9: Finding format with (NEW), ID, evidence, suggestion ──
    it('formats findings with (NEW) marker, issue ID, evidence and suggestion', async () => {
      const input = createDecisionInputWithFindings();
      const result = await assembler.renderClaudeDecisionPrompt(input);

      // Finding 1 is NEW
      assert.ok(
        result.includes('[ISS-004] (NEW) (critical) SQL injection vulnerability'),
        'New finding ISS-004 missing (NEW) marker or incorrect format',
      );
      assert.ok(
        result.includes('Evidence: User input passed directly to query builder'),
        'Missing evidence for ISS-004',
      );
      assert.ok(
        result.includes('Suggestion: Use parameterized queries'),
        'Missing suggestion for ISS-004',
      );

      // Finding 2 is NOT new — should NOT have (NEW)
      assert.ok(
        result.includes('[ISS-001] (high) Missing error handling in auth module'),
        'Existing finding ISS-001 incorrectly formatted',
      );
      // Verify ISS-001 line does NOT contain (NEW)
      const iss001Line = result.split('\n').find((line) => line.includes('[ISS-001]'));
      assert.ok(iss001Line, 'Could not find ISS-001 line');
      assert.ok(
        !iss001Line.includes('(NEW)'),
        'ISS-001 should NOT have (NEW) marker since isNew=false',
      );
      assert.ok(
        result.includes('Evidence: Line 42 in auth.ts'),
        'Missing evidence for ISS-001',
      );
      assert.ok(
        result.includes('Suggestion: Add try-catch around auth call'),
        'Missing suggestion for ISS-001',
      );
    });
  });
});

// ── Utility functions ────────────────────────────────────────────

/** Count occurrences of a substring in a string. */
function countOccurrences(text: string, sub: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    pos = text.indexOf(sub, pos);
    if (pos === -1) break;
    count++;
    pos += sub.length;
  }
  return count;
}

/** Extract all remaining {{...}} placeholders for diagnostic messages. */
function extractPlaceholders(text: string): string {
  const matches = text.match(/\{\{[^}]+\}\}/g);
  return matches ? matches.join(', ') : '(none)';
}
