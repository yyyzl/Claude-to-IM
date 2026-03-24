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
    let open = 0;
    for (const issue of issues) {
      switch (issue.status) {
        case 'accepted': accepted++; break;
        case 'rejected': rejected++; break;
        case 'deferred': deferred++; break;
        case 'open': open++; break;
        // 'resolved' counted via accepted path in determineConclusion
      }
    }

    // Count by severity (ALL issues — for report display)
    const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const issue of issues) {
      bySeverity[issue.severity]++;
    }

    // Count by severity excluding rejected (for conclusion logic only).
    // A rejected critical is a false positive — it should NOT inflate the
    // final verdict to "critical_issues". (Fix 2: reviewer caught this.)
    const bySeverityActive: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const issue of issues) {
      if (issue.status !== 'rejected') {
        bySeverityActive[issue.severity]++;
      }
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

    // Determine conclusion — use bySeverityActive (excludes rejected) to avoid
    // false positives inflating the verdict.
    const conclusion = this.determineConclusion(bySeverityActive, accepted, rejected, deferred, open);

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
      const filePath = issue.source_file ?? '（未知文件）';

      if (!fileMap.has(filePath)) {
        fileMap.set(filePath, { path: filePath, issues: [] });
      }

      // P0-3: Distinguish 'open' (never reviewed by Claude) from 'deferred' (Claude chose to defer).
      // Previously both mapped to 'defer', masking unreviewed issues as if they had been triaged.
      const actionMap: Record<string, 'accept' | 'reject' | 'defer' | 'unreviewed'> = {
        accepted: 'accept',
        rejected: 'reject',
        deferred: 'defer',
        open: 'unreviewed', // never reviewed by Claude — no decision was made
        resolved: 'accept', // resolved shown as accepted
      };

      fileMap.get(filePath)!.issues.push({
        id: issue.id,
        severity: issue.severity,
        category: issue.category ?? 'bug',
        description: issue.description,
        line_range: issue.source_line_range,
        action: actionMap[issue.status] ?? 'unreviewed',
        reason: issue.decision_reason ?? '',
        fix_instruction: issue.fix_instruction,
      });
    }

    // Sort by file path
    return [...fileMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Determine the overall conclusion of the code review.
   *
   * Decision tree (P0-2 fix):
   *   1. No findings at all → clean
   *   2. All findings rejected → clean (all false positives)
   *   3. Unreviewed (open) findings exist → needs_review
   *   4. Accepted + critical severity → critical_issues
   *   5. Accepted + high severity → issues_found
   *   6. Only accepted medium/low → minor_issues_only
   *
   * Previously: `accepted === 0 → clean` was wrong when open issues existed.
   */
  private determineConclusion(
    bySeverity: Record<Severity, number>,
    accepted: number,
    rejected: number,
    deferred: number,
    open: number,
  ): CodeReviewReport['conclusion'] {
    // bySeverity only contains non-rejected issues (active), so add rejected
    // back to get the true total across all statuses.
    const activeFindings = Object.values(bySeverity).reduce((a, b) => a + b, 0);
    const totalFindings = activeFindings + rejected;

    // No findings at all → clean
    if (totalFindings === 0) return 'clean';

    // ISS-001 fix: check open/deferred BEFORE the "all rejected" check.
    // Previously, rejected was compared against bySeverity-only total, so
    // mixed states like "1 rejected + 1 open" incorrectly returned 'clean'.

    // Unreviewed (open) findings exist → needs_review
    // These are findings Claude never processed (e.g. early termination).
    if (open > 0) return 'needs_review';

    // Any deferred findings → needs_review (deferred still need human attention,
    // even if some other findings were already accepted).
    if (deferred > 0) return 'needs_review';

    // All findings rejected (false positives) → clean
    if (rejected === totalFindings) return 'clean';

    // From here, accepted > 0
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
    lines.push('# 代码审查报告');
    lines.push('');
    lines.push(`**运行 ID**: ${data.run_id}`);
    lines.push(`**审查范围**: ${this.formatScope(data.scope)}`);
    lines.push(`**轮次**: ${data.total_rounds}`);
    lines.push(`**生成时间**: ${data.generated_at}`);
    if (snapshot?.head_commit) {
      lines.push(`**提交**: ${snapshot.head_commit.substring(0, 10)}`);
    }
    lines.push('');

    // Summary table
    lines.push('## 摘要');
    lines.push('');
    lines.push('| 指标 | 数量 |');
    lines.push('|------|------|');
    lines.push(`| 问题总数 | ${data.stats.total_findings} |`);
    lines.push(`| 已接受 | ${data.stats.accepted} |`);
    lines.push(`| 已驳回（误报） | ${data.stats.rejected} |`);
    lines.push(`| 已暂缓 | ${data.stats.deferred} |`);
    lines.push('');

    // By severity
    lines.push('### 按严重级别');
    for (const sev of SEVERITY_ORDER) {
      const count = data.stats.by_severity[sev];
      if (count > 0) {
        lines.push(`- ${this.severityIcon(sev)} ${formatSeverity(sev)}：${count}`);
      }
    }
    lines.push('');

    // By category
    const categories = Object.entries(data.stats.by_category)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);
    if (categories.length > 0) {
      lines.push('### 按类别');
      for (const [cat, count] of categories) {
        lines.push(`- ${formatCategory(cat)}: ${count}`);
      }
      lines.push('');
    }

    // Conclusion
    lines.push(`## 结论：${this.formatConclusion(data.conclusion)}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // File Results
    lines.push('## 文件明细');
    lines.push('');

    if (data.file_results.length === 0) {
      lines.push('未发现问题。');
    } else {
      for (const file of data.file_results) {
        lines.push(`### \`${file.path}\``);
        lines.push('');
        lines.push('| ID | 严重级别 | 类别 | 行号 | 问题描述 | 处理结果 | 裁决理由 | 修复建议 |');
        lines.push('|----|----------|------|------|----------|----------|----------|----------|');

        for (const issue of file.issues) {
          const lineStr = issue.line_range
            ? `${issue.line_range.start}-${issue.line_range.end}`
            : '无';
          const fix = issue.fix_instruction ?? '无';
          const reason = issue.reason || '无';
          const desc = issue.description.replace(/\|/g, '\\|').replace(/\n/g, ' ');
          const fixEsc = fix.replace(/\|/g, '\\|').replace(/\n/g, ' ');
          const reasonEsc = reason.replace(/\|/g, '\\|').replace(/\n/g, ' ');

          lines.push(
            `| ${issue.id} | ${formatSeverity(issue.severity)} | ${formatCategory(issue.category)} ` +
            `| ${lineStr} | ${desc} | ${formatAction(issue.action)} | ${reasonEsc} | ${fixEsc} |`,
          );
        }
        lines.push('');
      }
    }

    // Excluded files
    if (data.excluded_files.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push('## 已排除文件');
      lines.push('');
      lines.push('| 文件 | 原因 |');
      lines.push('|------|------|');
      for (const ef of data.excluded_files) {
        lines.push(`| ${ef.path} | ${formatExcludedReason(ef.reason)} |`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ── Formatting helpers ─────────────────────────────────────

  private formatScope(scope: { type: string; base_ref?: string; head_ref?: string }): string {
    switch (scope.type) {
      case 'staged': return '暂存区变更';
      case 'unstaged': return '工作区未暂存变更';
      case 'commit': return `单个提交（${scope.head_ref ?? 'HEAD'}）`;
      case 'commit_range': return `提交区间（${scope.base_ref}..${scope.head_ref})`;
      case 'branch': return `分支差异（${scope.base_ref}...${scope.head_ref ?? 'HEAD'}）`;
      default: return scope.type;
    }
  }

  private formatConclusion(conclusion: CodeReviewReport['conclusion']): string {
    switch (conclusion) {
      case 'clean': return '✅ 通过';
      case 'needs_review': return '⚠️ 仍需复核';
      case 'minor_issues_only': return '🟡 仅有中低优先级问题';
      case 'issues_found': return '🟠 发现需要处理的问题';
      case 'critical_issues': return '🔴 存在严重问题';
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

function formatSeverity(severity: Severity): string {
  switch (severity) {
    case 'critical':
      return '严重';
    case 'high':
      return '高';
    case 'medium':
      return '中';
    case 'low':
      return '低';
  }
}

function formatCategory(cat: string): string {
  const map: Record<string, string> = {
    bug: '缺陷',
    security: '安全',
    performance: '性能',
    error_handling: '错误处理',
    type_safety: '类型安全',
    concurrency: '并发',
    style: '风格',
    architecture: '架构',
    test_coverage: '测试覆盖',
    documentation: '文档',
  };
  return map[cat] ?? cat;
}

function formatAction(action: string): string {
  switch (action) {
    case 'accept':
      return '已接受';
    case 'reject':
      return '已驳回';
    case 'defer':
      return '已暂缓';
    case 'unreviewed':
      return '未裁决';
    default:
      return action;
  }
}

function formatExcludedReason(reason: string): string {
  if (reason === 'binary') return '二进制文件';
  if (reason === 'sensitive') return '敏感文件';
  if (reason === 'path_traversal') return '路径越界';
  if (reason === 'blob_not_found') return '找不到 git blob';
  if (reason.startsWith('pattern_excluded:')) {
    return `匹配排除规则：${reason.slice('pattern_excluded:'.length).trim()}`;
  }
  return reason;
}
