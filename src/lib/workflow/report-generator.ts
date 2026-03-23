/**
 * Report Generator — generates structured code review reports.
 *
 * Called after the workflow completes (or on demand) to produce
 * a Markdown report + structured JSON data from the IssueLedger,
 * ReviewSnapshot, and WorkflowMeta.
 *
 * Data source layering (INV-3):
 * - Issue decisions: IssueLedger (sole truth source for issue-level data)
 * - Review scope/exclusions: ReviewSnapshot
 * - Run metadata: WorkflowMeta
 *
 * @module workflow/report-generator
 */

import type { WorkflowStore } from './workflow-store.js';
import type {
  CodeReviewCategory,
  CodeReviewReport,
  FileReviewResult,
  IssueLedger,
  Issue,
  ReviewSnapshot,
  Severity,
  WorkflowMeta,
} from './types.js';

// ── Severity display ordering ────────────────────────────────

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

// ── Report Generator ─────────────────────────────────────────

export class ReportGenerator {
  constructor(private readonly store: WorkflowStore) {}

  /**
   * Generate a code review report.
   *
   * Reads IssueLedger, ReviewSnapshot, and WorkflowMeta from the store,
   * then produces both Markdown text and structured JSON data.
   *
   * @param runId - The workflow run identifier.
   * @returns Markdown report string and structured report data.
   */
  async generate(runId: string): Promise<{
    markdown: string;
    data: CodeReviewReport;
  }> {
    // Load data sources
    const meta = await this.store.getMeta(runId);
    if (!meta) throw new Error(`[ReportGenerator] Run not found: ${runId}`);

    const ledger = await this.store.loadLedger(runId);
    if (!ledger) throw new Error(`[ReportGenerator] Ledger not found: ${runId}`);

    const snapshot = await this.store.loadSnapshot(runId);

    // Build structured report data
    const data = this.buildReportData(runId, meta, ledger, snapshot);

    // Render Markdown
    const markdown = this.renderMarkdown(data, snapshot);

    return { markdown, data };
  }

  // ── Data Assembly ──────────────────────────────────────────

  private buildReportData(
    runId: string,
    meta: WorkflowMeta,
    ledger: IssueLedger,
    snapshot: ReviewSnapshot | null,
  ): CodeReviewReport {
    const issues = ledger.issues;

    // Count by action (status reflects final decision)
    let accepted = 0;
    let rejected = 0;
    let deferred = 0;
    for (const issue of issues) {
      switch (issue.status) {
        case 'accepted': accepted++; break;
        case 'rejected': rejected++; break;
        case 'deferred': deferred++; break;
      }
    }

    // Count by severity
    const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const issue of issues) {
      bySeverity[issue.severity]++;
    }

    // Count by category (only issues with category field)
    const byCategory: Partial<Record<CodeReviewCategory, number>> = {};
    for (const issue of issues) {
      if (issue.category) {
        byCategory[issue.category] = (byCategory[issue.category] ?? 0) + 1;
      }
    }

    // Group issues by file
    const fileResults = this.groupByFile(issues);

    // Determine conclusion
    const conclusion = this.determineConclusion(bySeverity, accepted, rejected, deferred);

    return {
      run_id: runId,
      scope: snapshot?.scope ?? { type: 'staged' },
      total_rounds: meta.current_round,
      stats: {
        total_findings: issues.length,
        accepted,
        rejected,
        deferred,
        by_severity: bySeverity,
        by_category: byCategory,
      },
      file_results: fileResults,
      conclusion,
      generated_at: new Date().toISOString(),
      excluded_files: snapshot?.excluded_files ?? [],
    };
  }

  private groupByFile(issues: Issue[]): FileReviewResult[] {
    const fileMap = new Map<string, FileReviewResult>();

    for (const issue of issues) {
      const filePath = issue.source_file ?? '(unknown)';

      if (!fileMap.has(filePath)) {
        fileMap.set(filePath, { path: filePath, issues: [] });
      }

      const actionMap: Record<string, 'accept' | 'reject' | 'defer'> = {
        accepted: 'accept',
        rejected: 'reject',
        deferred: 'defer',
        open: 'defer',      // open issues shown as deferred in report
        resolved: 'accept', // resolved shown as accepted
      };

      fileMap.get(filePath)!.issues.push({
        id: issue.id,
        severity: issue.severity,
        category: issue.category ?? 'bug',
        description: issue.description,
        line_range: issue.source_line_range,
        action: actionMap[issue.status] ?? 'defer',
        reason: issue.decision_reason ?? '',
        fix_instruction: issue.fix_instruction,
      });
    }

    // Sort by file path
    return [...fileMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private determineConclusion(
    bySeverity: Record<Severity, number>,
    accepted: number,
    _rejected: number,
    _deferred: number,
  ): CodeReviewReport['conclusion'] {
    if (accepted === 0) return 'clean';
    if (bySeverity.critical > 0) return 'critical_issues';
    if (bySeverity.high > 0) return 'issues_found';
    return 'minor_issues_only';
  }

  // ── Markdown Rendering (§10.3) ─────────────────────────────

  private renderMarkdown(
    data: CodeReviewReport,
    snapshot: ReviewSnapshot | null,
  ): string {
    const lines: string[] = [];

    // Header
    lines.push('# Code Review Report');
    lines.push('');
    lines.push(`**Run ID**: ${data.run_id}`);
    lines.push(`**Scope**: ${this.formatScope(data.scope)}`);
    lines.push(`**Rounds**: ${data.total_rounds}`);
    lines.push(`**Generated**: ${data.generated_at}`);
    if (snapshot?.head_commit) {
      lines.push(`**Head Commit**: ${snapshot.head_commit.substring(0, 10)}`);
    }
    lines.push('');

    // Summary table
    lines.push('## Summary');
    lines.push('');
    lines.push('| Metric | Count |');
    lines.push('|--------|-------|');
    lines.push(`| Total findings | ${data.stats.total_findings} |`);
    lines.push(`| Accepted | ${data.stats.accepted} |`);
    lines.push(`| Rejected (false positive) | ${data.stats.rejected} |`);
    lines.push(`| Deferred | ${data.stats.deferred} |`);
    lines.push('');

    // By severity
    lines.push('### By Severity');
    for (const sev of SEVERITY_ORDER) {
      const count = data.stats.by_severity[sev];
      if (count > 0) {
        lines.push(`- ${this.severityIcon(sev)} ${capitalize(sev)}: ${count}`);
      }
    }
    lines.push('');

    // By category
    const categories = Object.entries(data.stats.by_category)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);
    if (categories.length > 0) {
      lines.push('### By Category');
      for (const [cat, count] of categories) {
        lines.push(`- ${formatCategory(cat)}: ${count}`);
      }
      lines.push('');
    }

    // Conclusion
    lines.push(`## Conclusion: ${this.formatConclusion(data.conclusion)}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // File Results
    lines.push('## File Results');
    lines.push('');

    if (data.file_results.length === 0) {
      lines.push('No issues found.');
    } else {
      for (const file of data.file_results) {
        lines.push(`### \`${file.path}\``);
        lines.push('');
        lines.push('| ID | Severity | Category | Lines | Description | Action | Reason | Fix Instruction |');
        lines.push('|----|----------|----------|-------|-------------|--------|--------|-----------------|');

        for (const issue of file.issues) {
          const lineStr = issue.line_range
            ? `${issue.line_range.start}-${issue.line_range.end}`
            : '—';
          const fix = issue.fix_instruction ?? '—';
          const reason = issue.reason || '—';
          const desc = issue.description.replace(/\|/g, '\\|').replace(/\n/g, ' ');
          const fixEsc = fix.replace(/\|/g, '\\|').replace(/\n/g, ' ');
          const reasonEsc = reason.replace(/\|/g, '\\|').replace(/\n/g, ' ');

          lines.push(
            `| ${issue.id} | ${capitalize(issue.severity)} | ${formatCategory(issue.category)} ` +
            `| ${lineStr} | ${desc} | ${capitalize(issue.action)} | ${reasonEsc} | ${fixEsc} |`,
          );
        }
        lines.push('');
      }
    }

    // Excluded files
    if (data.excluded_files.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push('## Excluded Files');
      lines.push('');
      lines.push('| File | Reason |');
      lines.push('|------|--------|');
      for (const ef of data.excluded_files) {
        lines.push(`| ${ef.path} | ${ef.reason} |`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ── Formatting helpers ─────────────────────────────────────

  private formatScope(scope: { type: string; base_ref?: string; head_ref?: string }): string {
    switch (scope.type) {
      case 'staged': return 'staged changes';
      case 'unstaged': return 'unstaged changes';
      case 'commit': return `commit (${scope.head_ref ?? 'HEAD'})`;
      case 'commit_range': return `range (${scope.base_ref}..${scope.head_ref})`;
      case 'branch': return `branch diff (${scope.base_ref}...${scope.head_ref ?? 'HEAD'})`;
      default: return scope.type;
    }
  }

  private formatConclusion(conclusion: CodeReviewReport['conclusion']): string {
    switch (conclusion) {
      case 'clean': return '✅ Clean';
      case 'minor_issues_only': return '🟡 Minor Issues Only';
      case 'issues_found': return '🟠 Issues Found';
      case 'critical_issues': return '🔴 Critical Issues';
    }
  }

  private severityIcon(severity: Severity): string {
    switch (severity) {
      case 'critical': return '🔴';
      case 'high': return '🟠';
      case 'medium': return '🟡';
      case 'low': return '🟢';
    }
  }
}

// ── Module-level helpers ─────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatCategory(cat: string): string {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
