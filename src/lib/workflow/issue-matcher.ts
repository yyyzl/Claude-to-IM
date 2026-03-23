/**
 * Issue Matcher — Finding deduplication and ledger integration.
 *
 * Matches Codex findings against existing issues in the IssueLedger
 * to prevent duplicates and maintain accurate issue tracking across rounds.
 *
 * @module workflow/issue-matcher
 */

import type {
  CodeFinding,
  CodeReviewCategory,
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

// ── CodeFinding type guard & file-location matching ──────────

/**
 * Type guard: check if a Finding is actually a CodeFinding (has file + category).
 * CodeFinding extends Finding with `file`, `category`, and optional `line_range`.
 */
function isCodeFinding(finding: Finding): finding is CodeFinding {
  return 'file' in finding && 'category' in finding;
}

/**
 * Check whether two line ranges overlap (any line in one range falls within the other).
 * Returns false if either range is undefined.
 */
function rangesOverlap(
  a: { start: number; end: number } | undefined,
  b: { start: number; end: number } | undefined,
): boolean {
  if (!a || !b) return false;
  return a.start <= b.end && b.start <= a.end;
}

// ── Identifier extraction for fuzzy matching ─────────────────

/** Minimum identifier count to enable fuzzy matching (avoids false positives on sparse text). */
const MIN_IDENTIFIERS_FOR_FUZZY = 2;

/** Jaccard similarity threshold — above this, two identifier sets are "the same topic". */
const JACCARD_THRESHOLD = 0.4;

/**
 * Minimum number of code identifiers (non-section-ref, non-issue-ref) that must
 * overlap in the intersection for a fuzzy match to be accepted.
 *
 * This prevents false positives where two issues share section references (§4.5, §7.2)
 * but describe completely different problems.
 */
const MIN_CODE_ID_OVERLAP = 2;

/**
 * Extract key identifiers from a text string for fuzzy dedup.
 *
 * Extracted tokens (all lowercased):
 * 1. Backtick-quoted identifiers: `resolves_issues`, `PatchApplier`
 * 2. Bare PascalCase identifiers (≥2 uppercase transitions): ClaudeDecisionOutput, PatchApplier
 * 3. Bare snake_case identifiers (≥2 segments): resolves_issues, auto_terminate
 * 4. Section references: §4.4, §6.10, §7.1
 * 5. Issue ID references: ISS-001, ISS-012
 *
 * Returns a Set of unique lowercased identifiers.
 */
export function extractIdentifiers(text: string): Set<string> {
  const ids = new Set<string>();

  // 1. Backtick-quoted code identifiers
  const backtickRe = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = backtickRe.exec(text)) !== null) {
    ids.add(m[1].toLowerCase().trim());
  }

  // 2. Bare PascalCase identifiers (e.g. ClaudeDecisionOutput, PatchApplier)
  // Requires ≥2 uppercase-led segments to avoid matching ordinary capitalized words.
  const pascalRe = /\b([A-Z][a-z]+(?:[A-Z][a-z0-9]*)+)\b/g;
  while ((m = pascalRe.exec(text)) !== null) {
    ids.add(m[1].toLowerCase());
  }

  // 3. Bare snake_case identifiers (e.g. resolves_issues, auto_terminate)
  // Requires ≥2 underscore-separated segments to avoid short false positives.
  const snakeRe = /\b([a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+)\b/g;
  while ((m = snakeRe.exec(text)) !== null) {
    ids.add(m[1].toLowerCase());
  }

  // 4. Section references: §4.4, §6.10.1, etc.
  const sectionRe = /§(\d+(?:\.\d+)*)/g;
  while ((m = sectionRe.exec(text)) !== null) {
    ids.add(`§${m[1]}`);
  }

  // 5. Issue ID references: ISS-001, ISS-012
  const issueRe = /ISS-\d{3}/gi;
  while ((m = issueRe.exec(text)) !== null) {
    ids.add(m[0].toUpperCase());
  }

  return ids;
}

/**
 * Check whether an identifier is a "code identifier" (not a section ref or issue ref).
 * Code identifiers are the primary signal for semantic dedup; section/issue refs are contextual.
 */
function isCodeIdentifier(id: string): boolean {
  return !id.startsWith('§') && !id.startsWith('ISS-');
}

/**
 * Compute Jaccard similarity between two sets: |A ∩ B| / |A ∪ B|.
 * Returns 0 if both sets are empty.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
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
   * 3. **Identifier overlap**: extract identifiers (backtick-quoted, bare PascalCase/snake_case,
   *    section refs §X.Y, issue IDs) from both description+evidence texts.
   *    Match requires ALL of:
   *    - Jaccard similarity >= 0.4
   *    - Severity within 1 rank step
   *    - Both sides have >= 2 total identifiers
   *    - Intersection contains >= 2 code identifiers (non-§, non-ISS-) to prevent
   *      false matches where only section references overlap
   *    This catches LLM re-phrasings of the same issue while rejecting "same chapter,
   *    different problem" false positives.
   * 4. **No match**: returns `null` — caller should create a new Issue.
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

    // Strategy 2.5: File-location match (code-review only — §7.1)
    // Only fires when the finding has structured file/category fields (CodeFinding).
    // Conditions: same file + overlapping line range + same category + similar severity.
    if (isCodeFinding(finding)) {
      let bestLocationMatch: Issue | null = null;
      for (const issue of existingIssues) {
        if (
          issue.source_file &&
          issue.source_line_range &&
          finding.file === issue.source_file &&
          rangesOverlap(finding.line_range, issue.source_line_range) &&
          finding.category === issue.category &&
          isSimilarSeverity(finding.severity, issue.severity)
        ) {
          bestLocationMatch = issue;
          break; // First match wins — same file+range+category is highly specific
        }
      }
      if (bestLocationMatch !== null) return bestLocationMatch;
    }

    // Strategy 3: Identifier overlap (fuzzy matching for LLM re-phrasings)
    const findingIds = extractIdentifiers(`${finding.issue} ${finding.evidence}`);
    if (findingIds.size >= MIN_IDENTIFIERS_FOR_FUZZY) {
      let bestMatch: Issue | null = null;
      let bestScore = 0;

      for (const issue of existingIssues) {
        const issueIds = extractIdentifiers(`${issue.description} ${issue.evidence}`);
        if (issueIds.size < MIN_IDENTIFIERS_FOR_FUZZY) continue;

        if (!isSimilarSeverity(finding.severity, issue.severity)) continue;

        const score = jaccardSimilarity(findingIds, issueIds);
        if (score < JACCARD_THRESHOLD || score <= bestScore) continue;

        // Guard: require ≥ MIN_CODE_ID_OVERLAP code identifiers in the intersection.
        // Pure section-ref overlap (§4.5, §7.2) is NOT sufficient — different problems
        // can reference the same spec sections.
        let codeIdOverlap = 0;
        for (const id of findingIds) {
          if (issueIds.has(id) && isCodeIdentifier(id)) codeIdOverlap++;
        }
        if (codeIdOverlap < MIN_CODE_ID_OVERLAP) continue;

        bestScore = score;
        bestMatch = issue;
      }

      if (bestMatch !== null) return bestMatch;
    }

    // Strategy 4: No match
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
          // Code-review structured fields (§7.1): copy from CodeFinding if available.
          // These remain undefined for spec-review findings (backward-compatible).
          ...(isCodeFinding(finding) && {
            source_file: finding.file,
            source_line_range: finding.line_range,
            category: finding.category,
          }),
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
