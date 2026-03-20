/**
 * Unit tests for ContextCompressor — shrinks the Codex review pack
 * when the round count or token estimate exceeds thresholds.
 *
 * Covers:
 * - No compression needed (round < 4, tokens below threshold)
 * - Compression triggered at round 4
 * - Compression triggered by token threshold (small window size)
 * - Verify dropped rounds list is correct
 * - Verify compressed output contains spec + plan + last round but not middle rounds
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ContextCompressor } from '../../lib/workflow/context-compressor.js';
import type { IssueLedger, RoundData } from '../../lib/workflow/types.js';
import { SPEC_REVIEW_OVERRIDES } from '../../lib/workflow/types.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Create an IssueLedger with the given issues (convenience wrapper). */
function createLedger(
  issues: IssueLedger['issues'] = [],
  runId = 'test-run',
): IssueLedger {
  return { run_id: runId, issues };
}

/**
 * Create a RoundData entry with optional overrides.
 * By default populates all three text fields to produce a predictable token footprint.
 */
function createRoundData(
  round: number,
  data: Partial<Omit<RoundData, 'round'>> = {},
): RoundData {
  return {
    round,
    packJson: data.packJson ?? `{"round":${round},"pack":"data-for-round-${round}"}`,
    codexOutput: data.codexOutput ?? `Codex review output for round ${round}`,
    claudeDecision: data.claudeDecision ?? `Claude decision output for round ${round}`,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('ContextCompressor', () => {
  const compressor = new ContextCompressor();

  // Constant test fixtures
  const spec = '# Feature Spec\nThis is the spec document content.';
  const plan = '# Implementation Plan\nThis is the plan document content.';

  // ── 1. No compression needed (round < 4, tokens below threshold) ──

  describe('no compression needed', () => {
    it('returns full text with empty droppedRounds when round < 4 and tokens below threshold', () => {
      const ledger = createLedger([
        {
          id: 'ISS-001',
          round: 1,
          raised_by: 'codex',
          severity: 'high',
          description: 'Missing error handling',
          evidence: 'Line 42',
          status: 'open',
          repeat_count: 0,
        },
      ]);

      const rounds: RoundData[] = [
        createRoundData(1),
        createRoundData(2),
      ];

      const result = compressor.compress({
        spec,
        plan,
        ledger,
        rounds,
        currentRound: 2,
        windowTokens: 128_000, // large enough to never trigger token threshold
      });

      assert.deepStrictEqual(result.droppedRounds, []);
      assert.ok(result.text.includes('## Spec'));
      assert.ok(result.text.includes('## Plan'));
      assert.ok(result.text.includes('## Round 1'));
      assert.ok(result.text.includes('## Round 2'));
      assert.ok(result.estimatedTokens > 0);
    });

    it('returns full text at round 3 with large window', () => {
      const ledger = createLedger();
      const rounds = [createRoundData(1), createRoundData(2), createRoundData(3)];

      const result = compressor.compress({
        spec,
        plan,
        ledger,
        rounds,
        currentRound: 3,
        windowTokens: 128_000,
      });

      assert.deepStrictEqual(result.droppedRounds, []);
      // All rounds should be present
      assert.ok(result.text.includes('## Round 1'));
      assert.ok(result.text.includes('## Round 2'));
      assert.ok(result.text.includes('## Round 3'));
    });
  });

  // ── 2. Compression triggered at round 4 ──────────────────────

  describe('compression triggered at round >= 4', () => {
    it('compresses at exactly round 4 regardless of token count', () => {
      const ledger = createLedger();
      const rounds = [
        createRoundData(1),
        createRoundData(2),
        createRoundData(3),
        createRoundData(4),
      ];

      const result = compressor.compress({
        spec,
        plan,
        ledger,
        rounds,
        currentRound: 4,
        windowTokens: 999_999, // huge window — only round threshold triggers
      });

      // Compression should have been triggered
      assert.ok(result.droppedRounds.length > 0);
    });

    it('compresses at round 5', () => {
      const ledger = createLedger();
      const rounds = [
        createRoundData(1),
        createRoundData(2),
        createRoundData(3),
        createRoundData(4),
        createRoundData(5),
      ];

      const result = compressor.compress({
        spec,
        plan,
        ledger,
        rounds,
        currentRound: 5,
        windowTokens: 999_999,
      });

      assert.ok(result.droppedRounds.length > 0);
      // Only the last round (5) should survive — rounds 1-4 dropped
      assert.deepStrictEqual(result.droppedRounds, [1, 2, 3, 4]);
    });
  });

  // ── 3. Compression triggered by token threshold ───────────────

  describe('compression triggered by token threshold', () => {
    it('compresses when estimated tokens exceed 60% of windowTokens', () => {
      const ledger = createLedger();
      const rounds = [createRoundData(1), createRoundData(2)];

      // Build the same full text the compressor would build internally,
      // then choose a windowTokens so that rawTokens > windowTokens * 0.6
      // Token estimate = Math.ceil(text.length / 4)
      // We set windowTokens very small so even modest content triggers compression.
      const result = compressor.compress({
        spec,
        plan,
        ledger,
        rounds,
        currentRound: 2, // below round threshold (4)
        windowTokens: 10, // tiny window — token threshold triggers immediately
      });

      assert.ok(result.droppedRounds.length > 0);
      assert.deepStrictEqual(result.droppedRounds, [1]); // round 1 dropped, round 2 kept
    });
  });

  // ── 4. Verify dropped rounds list is correct ──────────────────

  describe('dropped rounds list accuracy', () => {
    it('drops all rounds except the last one', () => {
      const ledger = createLedger();
      const rounds = [
        createRoundData(1),
        createRoundData(2),
        createRoundData(3),
        createRoundData(4),
      ];

      const result = compressor.compress({
        spec,
        plan,
        ledger,
        rounds,
        currentRound: 4,
        windowTokens: 999_999,
      });

      assert.deepStrictEqual(result.droppedRounds, [1, 2, 3]);
    });

    it('returns empty droppedRounds with only one round and no compression', () => {
      const ledger = createLedger();
      const rounds = [createRoundData(1)];

      const result = compressor.compress({
        spec,
        plan,
        ledger,
        rounds,
        currentRound: 1,
        windowTokens: 128_000,
      });

      assert.deepStrictEqual(result.droppedRounds, []);
    });

    it('drops nothing when there is only one round but compression triggers', () => {
      const ledger = createLedger();
      const rounds = [createRoundData(1)];

      // Force compression via tiny window, but only 1 round — nothing to drop
      const result = compressor.compress({
        spec,
        plan,
        ledger,
        rounds,
        currentRound: 4, // triggers round threshold
        windowTokens: 10,
      });

      assert.deepStrictEqual(result.droppedRounds, []);
    });
  });

  // ── 5. Verify compressed output structure ─────────────────────

  describe('compressed output contains spec + plan + last round but not middle rounds', () => {
    it('includes spec, plan, ledger summary, and last round in output', () => {
      const ledger = createLedger([
        {
          id: 'ISS-001',
          round: 1,
          raised_by: 'codex',
          severity: 'high',
          description: 'Missing error handling',
          evidence: 'Line 42',
          status: 'open',
          repeat_count: 0,
        },
        {
          id: 'ISS-002',
          round: 2,
          raised_by: 'codex',
          severity: 'medium',
          description: 'Resolved issue',
          evidence: 'Line 100',
          status: 'resolved',
          repeat_count: 0,
        },
      ]);

      const rounds = [
        createRoundData(1),
        createRoundData(2),
        createRoundData(3),
        createRoundData(4),
      ];

      const result = compressor.compress({
        spec,
        plan,
        ledger,
        rounds,
        currentRound: 4,
        windowTokens: 999_999,
      });

      // Spec and plan are present
      assert.ok(result.text.includes('## Spec'));
      assert.ok(result.text.includes(spec));
      assert.ok(result.text.includes('## Plan'));
      assert.ok(result.text.includes(plan));

      // Last round is present
      assert.ok(result.text.includes('## Last Round (Round 4)'));
      assert.ok(result.text.includes('data-for-round-4'));

      // Middle rounds are NOT in the output
      assert.ok(!result.text.includes('## Round 1'));
      assert.ok(!result.text.includes('## Round 2'));
      assert.ok(!result.text.includes('## Round 3'));
      assert.ok(!result.text.includes('data-for-round-1'));
      assert.ok(!result.text.includes('data-for-round-2'));
      assert.ok(!result.text.includes('data-for-round-3'));

      // Compressed notice with dropped round numbers
      assert.ok(result.text.includes('Rounds 1, 2, 3 omitted'));
    });

    it('filters ledger summary to only open and accepted issues', () => {
      const ledger = createLedger([
        {
          id: 'ISS-001',
          round: 1,
          raised_by: 'codex',
          severity: 'high',
          description: 'Open issue stays',
          evidence: 'evidence',
          status: 'open',
          repeat_count: 0,
        },
        {
          id: 'ISS-002',
          round: 1,
          raised_by: 'codex',
          severity: 'medium',
          description: 'Accepted issue stays',
          evidence: 'evidence',
          status: 'accepted',
          repeat_count: 0,
        },
        {
          id: 'ISS-003',
          round: 1,
          raised_by: 'codex',
          severity: 'low',
          description: 'Resolved issue hidden',
          evidence: 'evidence',
          status: 'resolved',
          repeat_count: 0,
        },
        {
          id: 'ISS-004',
          round: 1,
          raised_by: 'codex',
          severity: 'low',
          description: 'Rejected issue hidden',
          evidence: 'evidence',
          status: 'rejected',
          repeat_count: 0,
        },
        {
          id: 'ISS-005',
          round: 1,
          raised_by: 'codex',
          severity: 'low',
          description: 'Deferred issue hidden',
          evidence: 'evidence',
          status: 'deferred',
          repeat_count: 0,
        },
      ]);

      const rounds = [createRoundData(1), createRoundData(2), createRoundData(3), createRoundData(4)];

      const result = compressor.compress({
        spec,
        plan,
        ledger,
        rounds,
        currentRound: 4,
        windowTokens: 999_999,
      });

      // Compressed output uses ledger summary, not full ledger
      assert.ok(result.text.includes('Issue Ledger Summary (open + accepted)'));

      // Open and accepted issues are present
      assert.ok(result.text.includes('ISS-001'));
      assert.ok(result.text.includes('Open issue stays'));
      assert.ok(result.text.includes('ISS-002'));
      assert.ok(result.text.includes('Accepted issue stays'));

      // Resolved, rejected, deferred issues are filtered out
      assert.ok(!result.text.includes('ISS-003'));
      assert.ok(!result.text.includes('Resolved issue hidden'));
      assert.ok(!result.text.includes('ISS-004'));
      assert.ok(!result.text.includes('Rejected issue hidden'));
      assert.ok(!result.text.includes('ISS-005'));
      assert.ok(!result.text.includes('Deferred issue hidden'));
    });

    it('handles empty rounds array gracefully', () => {
      const ledger = createLedger();

      const result = compressor.compress({
        spec,
        plan,
        ledger,
        rounds: [],
        currentRound: 4, // triggers compression
        windowTokens: 999_999,
      });

      // Should still succeed — no rounds to drop, no last round section
      assert.deepStrictEqual(result.droppedRounds, []);
      assert.ok(result.text.includes('## Spec'));
      assert.ok(result.text.includes('## Plan'));
    });

    it('estimatedTokens equals Math.ceil(text.length / 4)', () => {
      const ledger = createLedger();
      const rounds = [createRoundData(1)];

      const result = compressor.compress({
        spec,
        plan,
        ledger,
        rounds,
        currentRound: 1,
        windowTokens: 128_000,
      });

      assert.equal(result.estimatedTokens, Math.ceil(result.text.length / 4));
    });
  });
});
