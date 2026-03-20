/**
 * Context Compressor — shrinks the Codex review pack when it grows too large.
 *
 * Called internally by the PackBuilder (not directly by the WorkflowEngine)
 * to ensure the pack stays within the Codex context window budget.
 *
 * Trigger conditions (either suffices):
 * - Estimated tokens exceed 60% of `windowTokens`
 * - Current round >= 4
 *
 * Compression strategy:
 * - Keep: latest spec + plan (verbatim)
 * - Keep: ledger summary (only open + accepted issues)
 * - Keep: last round data (verbatim)
 * - Drop: all intermediate round data (rounds 1 .. N-1)
 *
 * Token estimation uses the simple heuristic: chars / 4.
 *
 * @module workflow/context-compressor
 */

import type { IssueLedger, RoundData, Issue } from './types.js';
import { SPEC_REVIEW_OVERRIDES } from './types.js';

// ── ContextCompressor ───────────────────────────────────────────

export class ContextCompressor {
  /**
   * Compress the Codex pack payload when it grows too large.
   *
   * @param ctx.spec - Current spec document content.
   * @param ctx.plan - Current plan document content.
   * @param ctx.ledger - The issue ledger for filtering relevant issues.
   * @param ctx.rounds - Array of all round data collected so far.
   * @param ctx.currentRound - Current round number (1-based).
   * @param ctx.windowTokens - Token budget for the Codex context window.
   * @returns Compressed text, estimated token count, and list of dropped round numbers.
   */
  compress(ctx: {
    spec: string;
    plan: string;
    ledger: IssueLedger;
    rounds: RoundData[];
    currentRound: number;
    windowTokens: number;
  }): { text: string; estimatedTokens: number; droppedRounds: number[] } {
    const { spec, plan, ledger, rounds, currentRound, windowTokens } = ctx;

    // ── Compute raw text and estimate tokens ──────────────────
    const rawText = buildFullText(spec, plan, ledger, rounds);
    const rawTokens = estimateTokens(rawText);

    // ── Check trigger conditions ──────────────────────────────
    const thresholdRatio = SPEC_REVIEW_OVERRIDES.context_compress_threshold;
    const thresholdRound = SPEC_REVIEW_OVERRIDES.context_compress_round;

    const shouldCompress =
      rawTokens > windowTokens * thresholdRatio || currentRound >= thresholdRound;

    if (!shouldCompress) {
      return {
        text: rawText,
        estimatedTokens: rawTokens,
        droppedRounds: [],
      };
    }

    // ── Compress: keep spec + plan + ledger summary + last round ─
    const ledgerSummary = buildLedgerSummary(ledger);

    // Identify the last round's data
    const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;

    // Determine which rounds to drop (all except the last one)
    const droppedRounds: number[] = [];
    for (const rd of rounds) {
      if (lastRound && rd.round === lastRound.round) {
        continue; // keep the last round
      }
      droppedRounds.push(rd.round);
    }

    // Build compressed text
    const sections: string[] = [];

    sections.push('## Spec\n\n' + spec);
    sections.push('## Plan\n\n' + plan);
    sections.push('## Issue Ledger Summary (open + accepted)\n\n' + ledgerSummary);

    if (droppedRounds.length > 0) {
      sections.push(
        `## Compressed\n\nRounds ${droppedRounds.join(', ')} omitted to save context space.`,
      );
    }

    if (lastRound) {
      sections.push('## Last Round (Round ' + lastRound.round + ')\n\n' + formatRoundData(lastRound));
    }

    const compressedText = sections.join('\n\n---\n\n');
    const compressedTokens = estimateTokens(compressedText);

    return {
      text: compressedText,
      estimatedTokens: compressedTokens,
      droppedRounds,
    };
  }
}

// ── Private helpers ──────────────────────────────────────────────

/**
 * Estimate token count using the simple heuristic: chars / 4.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build the full (uncompressed) text from all components.
 * Used both for token estimation and as the default return when
 * compression is not triggered.
 */
function buildFullText(
  spec: string,
  plan: string,
  ledger: IssueLedger,
  rounds: RoundData[],
): string {
  const sections: string[] = [];

  sections.push('## Spec\n\n' + spec);
  sections.push('## Plan\n\n' + plan);
  sections.push('## Issue Ledger\n\n' + buildFullLedgerText(ledger));

  for (const rd of rounds) {
    sections.push('## Round ' + rd.round + '\n\n' + formatRoundData(rd));
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Build a full-text representation of all issues in the ledger.
 */
function buildFullLedgerText(ledger: IssueLedger): string {
  if (ledger.issues.length === 0) {
    return 'No issues tracked.';
  }

  return ledger.issues
    .map((issue) => formatIssue(issue))
    .join('\n');
}

/**
 * Build a compressed ledger summary containing only open and accepted issues.
 * Omits resolved, rejected, and deferred issues to save tokens.
 */
function buildLedgerSummary(ledger: IssueLedger): string {
  const relevantIssues = ledger.issues.filter(
    (issue) => issue.status === 'open' || issue.status === 'accepted',
  );

  if (relevantIssues.length === 0) {
    return 'No open or accepted issues.';
  }

  return relevantIssues
    .map((issue) => formatIssue(issue))
    .join('\n');
}

/**
 * Format a single issue as a compact one-line summary.
 */
function formatIssue(issue: Issue): string {
  return `- [${issue.id}] (${issue.severity}, ${issue.status}) ${issue.description}`;
}

/**
 * Format a single round's data by concatenating all available artifacts.
 */
function formatRoundData(rd: RoundData): string {
  const parts: string[] = [];

  if (rd.packJson) {
    parts.push('Pack:\n' + rd.packJson);
  }
  if (rd.codexOutput) {
    parts.push('Codex Output:\n' + rd.codexOutput);
  }
  if (rd.claudeDecision) {
    parts.push('Claude Decision:\n' + rd.claudeDecision);
  }

  return parts.length > 0 ? parts.join('\n\n') : '(no data)';
}
