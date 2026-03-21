/**
 * Issue Matcher — Finding deduplication and ledger integration.
 *
 * Matches Codex findings against existing issues in the IssueLedger
 * to prevent duplicates and maintain accurate issue tracking across rounds.
 *
 * @module workflow/issue-matcher
 */

import type {
  Finding,
  Issue,
  IssueLedger,
  ProcessFindingsResult,
  Severity,
} from './types.js';

// ── Severity ordering for similarity comparison ─────────────────

/** Numeric rank for each severity level (lower = more severe). */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ── Private helpers ─────────────────────────────────────────────

/**
 * Normalize a text string for comparison.
 * Lowercases, trims, and collapses consecutive whitespace to a single space.
 */
function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Determine whether two severity levels are "similar" (within 1 rank step).
 *
 * Examples:
 * - critical vs high  => true  (|0-1| = 1)
 * - critical vs medium => false (|0-2| = 2)
 * - medium vs low      => true  (|2-3| = 1)
 */
function isSimilarSeverity(a: Severity, b: Severity): boolean {
  return Math.abs(SEVERITY_RANK[a] - SEVERITY_RANK[b]) <= 1;
}

/**
 * Format a zero-padded 3-digit issue sequence number.
 * e.g. 1 => "001", 12 => "012", 123 => "123"
 */
function formatIssueId(seq: number): string {
  return `ISS-${String(seq).padStart(3, '0')}`;
}

// ── IssueMatcher ────────────────────────────────────────────────

export class IssueMatcher {
  /**
   * Match a single Codex Finding against existing Issues in the ledger.
   *
   * Strategy (in order of precedence):
   * 1. **Exact match**: normalized `finding.issue` equals normalized `issue.description`.
   * 2. **Evidence match**: normalized `finding.evidence` equals normalized `issue.evidence`
   *    AND the severity levels are similar (within 1 rank step).
   * 3. **No match**: returns `null` — caller should create a new Issue.
   *
   * @param finding - The Codex finding to match.
   * @param existingIssues - All issues currently in the ledger.
   * @returns The matched Issue, or `null` if no match was found.
   */
  match(finding: Finding, existingIssues: Issue[]): Issue | null {
    const normalizedIssue = normalize(finding.issue);
    const normalizedEvidence = normalize(finding.evidence);

    // Strategy 1: Exact description match
    for (const issue of existingIssues) {
      if (normalize(issue.description) === normalizedIssue) {
        return issue;
      }
    }

    // Strategy 2: Evidence match + similar severity
    for (const issue of existingIssues) {
      if (
        normalize(issue.evidence) === normalizedEvidence &&
        isSimilarSeverity(finding.severity, issue.severity)
      ) {
        return issue;
      }
    }

    // Strategy 3: No match
    return null;
  }

  /**
   * Batch process all Codex findings for a given round.
   *
   * Dedup logic per finding:
   * - **matched + rejected**: reopen the issue (`status` -> `open`), increment `repeat_count`.
   * - **matched + deferred**: keep deferred, do NOT increment `repeat_count`.
   * - **matched + open/accepted/resolved**: skip (already tracked, no changes needed).
   * - **no match**: create a new Issue (`status` = `open`, `repeat_count` = 0).
   *
   * **Idempotency**: if re-run for the same round, detects issues already created
   * in this round and skips creation to avoid duplicates.
   *
   * @param findings - All Codex findings from this round.
   * @param ledger - The current issue ledger (mutated in place).
   * @param round - The current round number (1-based).
   * @returns Structured result for engine consumption.
   */
  processFindings(
    findings: Finding[],
    ledger: IssueLedger,
    round: number,
  ): ProcessFindingsResult {
    const newIssues: Issue[] = [];
    const matchedIssues: ProcessFindingsResult['matchedIssues'] = [];

    // Idempotency: collect issue IDs already created in this round
    const existingRoundIssueDescriptions = new Set(
      ledger.issues
        .filter((issue) => issue.round === round)
        .map((issue) => normalize(issue.description)),
    );

    // Track the next sequence number for new issue IDs
    let nextSeq = ledger.issues.length + 1;

    for (const finding of findings) {
      const matched = this.match(finding, ledger.issues);

      if (matched !== null) {
        // Idempotency guard: skip if already processed in this round
        if (matched.last_processed_round === round) {
          matchedIssues.push({
            issueId: matched.id,
            finding,
            isNew: false,
          });
          continue;
        }

        // Finding matched an existing issue — apply status-dependent logic
        this.handleMatchedIssue(matched);
        matched.last_processed_round = round;

        matchedIssues.push({
          issueId: matched.id,
          finding,
          isNew: false,
        });
      } else {
        // No match — check idempotency before creating
        const normalizedDesc = normalize(finding.issue);

        if (existingRoundIssueDescriptions.has(normalizedDesc)) {
          // Already created in a previous run of this round — find the existing issue
          const existingIssue = ledger.issues.find(
            (issue) =>
              issue.round === round &&
              normalize(issue.description) === normalizedDesc,
          )!;

          matchedIssues.push({
            issueId: existingIssue.id,
            finding,
            isNew: false,
          });
          continue;
        }

        // Create a new issue
        const newIssue: Issue = {
          id: formatIssueId(nextSeq),
          round,
          raised_by: 'codex',
          severity: finding.severity,
          description: finding.issue,
          evidence: finding.evidence,
          status: 'open',
          repeat_count: 0,
          last_processed_round: round,
        };

        nextSeq++;
        ledger.issues.push(newIssue);
        newIssues.push(newIssue);
        existingRoundIssueDescriptions.add(normalizedDesc);

        matchedIssues.push({
          issueId: newIssue.id,
          finding,
          isNew: true,
        });
      }
    }

    // Compute summary counts
    const newHighCriticalCount = newIssues.filter(
      (issue) => issue.severity === 'critical' || issue.severity === 'high',
    ).length;

    return {
      newIssues,
      matchedIssues,
      newHighCriticalCount,
      newTotalCount: newIssues.length,
    };
  }

  // ── Private instance helpers ────────────────────────────────────

  /**
   * Apply status-dependent logic for a matched issue.
   *
   * - rejected  -> reopen (status = 'open') and increment repeat_count
   * - deferred  -> keep as-is, do NOT increment repeat_count
   * - open/accepted/resolved -> no-op (already tracked)
   */
  private handleMatchedIssue(issue: Issue): void {
    switch (issue.status) {
      case 'rejected':
        issue.status = 'open';
        issue.repeat_count++;
        // Clear previous decision metadata since the issue is reopened
        issue.decided_by = undefined;
        issue.decision_reason = undefined;
        break;

      case 'deferred':
        // Keep deferred, do NOT increment repeat_count
        break;

      case 'open':
      case 'accepted':
      case 'resolved':
        // Already tracked — no changes needed
        break;
    }
  }
}
