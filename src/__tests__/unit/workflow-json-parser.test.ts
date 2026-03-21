/**
 * Unit tests for JsonParser — best-effort JSON extraction from LLM output.
 *
 * Covers:
 * - parse<T>(): direct JSON, markdown fences, embedded JSON, arrays, invalid input
 * - extractPatches(): parsed fields, marker-based fallback, mixed scenarios
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JsonParser } from '../../lib/workflow/json-parser.js';
import type { ClaudeDecisionOutput } from '../../lib/workflow/types.js';

// ── Helpers ──────────────────────────────────────────────────────

const parser = new JsonParser();

/** Shorthand to build a minimal valid ClaudeDecisionOutput. */
function makeDecisionOutput(
  overrides: Partial<ClaudeDecisionOutput> = {},
): ClaudeDecisionOutput {
  return {
    decisions: [],
    spec_updated: false,
    plan_updated: false,
    summary: 'test summary',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('JsonParser', () => {
  // ================================================================
  // parse<T>()
  // ================================================================

  describe('parse<T>()', () => {
    // ── 1. Direct JSON input ──────────────────────────────────────

    it('parses direct JSON input correctly', () => {
      const input = '{"name": "test", "value": 42}';
      const result = parser.parse<{ name: string; value: number }>(input);
      assert.deepStrictEqual(result, { name: 'test', value: 42 });
    });

    // ── 2. Markdown code fences ───────────────────────────────────

    it('strips markdown code fences and parses JSON', () => {
      const input = '```json\n{"decision": "accept", "reason": "looks good"}\n```';
      const result = parser.parse<{ decision: string; reason: string }>(input);
      assert.deepStrictEqual(result, {
        decision: 'accept',
        reason: 'looks good',
      });
    });

    // ── 3. JSON embedded in plain text ────────────────────────────

    it('extracts JSON object embedded in surrounding text', () => {
      const input =
        'Here is my analysis:\n{"severity": "high", "issue": "missing validation"}\nEnd of response.';
      const result = parser.parse<{ severity: string; issue: string }>(input);
      assert.deepStrictEqual(result, {
        severity: 'high',
        issue: 'missing validation',
      });
    });

    // ── 4. Array JSON embedded in text ────────────────────────────

    it('extracts JSON array embedded in surrounding text', () => {
      const input = 'The results are: [1, 2, 3] as expected.';
      const result = parser.parse<number[]>(input);
      assert.deepStrictEqual(result, [1, 2, 3]);
    });

    // ── 5. Completely invalid input ───────────────────────────────

    it('returns null for completely invalid input with no JSON', () => {
      const input = 'This is just plain text with no JSON at all.';
      const result = parser.parse<unknown>(input);
      assert.equal(result, null);
    });

    // ── 6. Empty string ──────────────────────────────────────────

    it('returns null for empty string', () => {
      const result = parser.parse<unknown>('');
      assert.equal(result, null);
    });

    // ── 7. Nested objects ─────────────────────────────────────────

    it('correctly extracts deeply nested JSON objects', () => {
      const nested = {
        level1: {
          level2: {
            level3: { value: 'deep' },
          },
          items: [1, 2, { nested: true }],
        },
      };
      const input = `Some preamble text\n${JSON.stringify(nested)}\nsome trailing text`;
      const result = parser.parse<typeof nested>(input);
      assert.deepStrictEqual(result, nested);
    });
  });

  // ================================================================
  // extractPatches()
  // ================================================================

  describe('extractPatches()', () => {
    // ── 8. Both patches from parsed JSON ──────────────────────────

    it('extracts spec_patch and plan_patch from parsed object', () => {
      const parsed = makeDecisionOutput({
        spec_patch: '--- a/spec.md\n+++ b/spec.md\n@@ -1 +1 @@\n-old\n+new',
        plan_patch: '--- a/plan.md\n+++ b/plan.md\n@@ -1 +1 @@\n-old\n+new',
      });

      const { specPatch, planPatch } = parser.extractPatches('raw output', parsed);
      assert.equal(specPatch, parsed.spec_patch);
      assert.equal(planPatch, parsed.plan_patch);
    });

    // ── 9. Only spec_patch present ────────────────────────────────

    it('returns only specPatch when plan_patch is absent', () => {
      const parsed = makeDecisionOutput({
        spec_patch: 'spec patch content',
      });

      const { specPatch, planPatch } = parser.extractPatches('raw output', parsed);
      assert.equal(specPatch, 'spec patch content');
      assert.equal(planPatch, null);
    });

    // ── 10. Fallback: SPEC UPDATE marker ──────────────────────────

    it('extracts specPatch from SPEC UPDATE markers when parsed is null', () => {
      const raw = [
        'Some text before',
        '--- SPEC UPDATE ---',
        'patched spec content here',
        '--- END SPEC UPDATE ---',
        'Some text after',
      ].join('\n');

      const { specPatch, planPatch } = parser.extractPatches(raw, null);
      assert.equal(specPatch, 'patched spec content here');
      assert.equal(planPatch, null);
    });

    // ── 11. Fallback: PLAN UPDATE marker ──────────────────────────

    it('extracts planPatch from PLAN UPDATE markers when parsed is null', () => {
      const raw = [
        'Some text before',
        '--- PLAN UPDATE ---',
        'patched plan content here',
        '--- END PLAN UPDATE ---',
        'Some text after',
      ].join('\n');

      const { specPatch, planPatch } = parser.extractPatches(raw, null);
      assert.equal(specPatch, null);
      assert.equal(planPatch, 'patched plan content here');
    });

    // ── 12. Fallback: Both markers present ────────────────────────

    it('extracts both patches from markers when parsed is null', () => {
      const raw = [
        '--- SPEC UPDATE ---',
        'spec content',
        '--- END SPEC UPDATE ---',
        '--- PLAN UPDATE ---',
        'plan content',
        '--- END PLAN UPDATE ---',
      ].join('\n');

      const { specPatch, planPatch } = parser.extractPatches(raw, null);
      assert.equal(specPatch, 'spec content');
      assert.equal(planPatch, 'plan content');
    });

    // ── 13. No parsed, no markers ─────────────────────────────────

    it('returns { null, null } when parsed is null and raw has no markers', () => {
      const raw = 'Just some plain text with no markers at all.';

      const { specPatch, planPatch } = parser.extractPatches(raw, null);
      assert.equal(specPatch, null);
      assert.equal(planPatch, null);
    });

    // ── 14. TP0 SPEC PATCH markers (primary) ─────────────────────

    it('extracts specPatch from SPEC PATCH markers (TP0 format)', () => {
      const raw = [
        '```json',
        '{"decisions": [], "spec_updated": true, "plan_updated": false, "summary": "ok"}',
        '```',
        '',
        '--- SPEC PATCH ---',
        '## 6.5 TerminationJudge',
        'Updated content here',
        '--- END SPEC PATCH ---',
      ].join('\n');

      const { specPatch, planPatch } = parser.extractPatches(raw, null);
      assert.equal(specPatch, '## 6.5 TerminationJudge\nUpdated content here');
      assert.equal(planPatch, null);
    });

    // ── 15. TP0 both PATCH markers ─────────────────────────────────

    it('extracts both patches from PATCH markers (TP0 format)', () => {
      const raw = [
        '--- SPEC PATCH ---',
        'spec patch content',
        '--- END SPEC PATCH ---',
        '',
        '--- PLAN PATCH ---',
        'plan patch content',
        '--- END PLAN PATCH ---',
      ].join('\n');

      const { specPatch, planPatch } = parser.extractPatches(raw, null);
      assert.equal(specPatch, 'spec patch content');
      assert.equal(planPatch, 'plan patch content');
    });

    // ── 16. PATCH markers take priority over UPDATE markers ────────

    it('prefers PATCH markers over legacy UPDATE markers', () => {
      const raw = [
        '--- SPEC PATCH ---',
        'new patch content',
        '--- END SPEC PATCH ---',
        '--- SPEC UPDATE ---',
        'legacy content',
        '--- END SPEC UPDATE ---',
      ].join('\n');

      const { specPatch } = parser.extractPatches(raw, null);
      assert.equal(specPatch, 'new patch content');
    });

    // ── 17. Empty string fields fallback to markers ───────────────

    it('falls back to markers when parsed fields are empty strings', () => {
      const parsed = makeDecisionOutput({
        spec_patch: '   ',
        plan_patch: '',
      });

      const raw = [
        '--- SPEC UPDATE ---',
        'marker spec content',
        '--- END SPEC UPDATE ---',
        '--- PLAN UPDATE ---',
        'marker plan content',
        '--- END PLAN UPDATE ---',
      ].join('\n');

      const { specPatch, planPatch } = parser.extractPatches(raw, parsed);
      assert.equal(specPatch, 'marker spec content');
      assert.equal(planPatch, 'marker plan content');
    });
  });
});
