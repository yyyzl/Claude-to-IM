/**
 * 用量统计（按天汇总，按项目维度拆分）。
 *
 * 设计目标：
 * - 不依赖宿主 DB：直接写入用户目录的 JSON 汇总文件
 * - 统计口径：以 TokenUsage.input/output 为主；cache_* 作为 input 的拆分字段单独统计展示（避免重复计数）
 * - 项目维度：优先以 git repo root 作为项目 key；无 git 时降级为 workingDirectory
 *
 * 注意：该模块仅做“轻量”统计，写入失败不得影响主业务流程。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { TokenUsage } from '../host.js';

export interface DailyTokenUsage {
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd?: number;
}

export interface ProjectUsageSummary {
  label: string;
  days: Record<string, DailyTokenUsage>; // YYYY-MM-DD -> totals
}

export interface UsageSummaryFile {
  version: 1;
  updatedAt: string; // ISO
  projects: Record<string, ProjectUsageSummary>; // projectKey -> summary
}

export interface ResolvedProjectInfo {
  projectKey: string;
  projectLabel: string;
}

const SUMMARY_VERSION = 1 as const;
const DEFAULT_RETENTION_DAYS = 90;

function toSafeNonNegativeNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return n > 0 ? n : 0;
}

export function formatLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizePathKey(p: string): string {
  // 用 / 统一 Windows 路径分隔符，方便跨平台查看与匹配
  return p.replaceAll('\\', '/');
}

export function resolveUsageSummaryPath(
  store?: { getSetting(key: string): string | null },
): string {
  const fromSetting = store?.getSetting?.('bridge_usage_summary_path');
  if (fromSetting && fromSetting.trim()) {
    return path.resolve(fromSetting.trim());
  }

  const home = os.homedir?.() || '';
  const baseDir = home ? path.join(home, '.claude-to-im') : path.resolve('.claude-to-im');
  return path.join(baseDir, 'usage-summary.json');
}

export function getUsageRetentionDays(store?: { getSetting(key: string): string | null }): number {
  const raw = store?.getSetting?.('bridge_usage_retention_days');
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const n = parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  if (n <= 0) return 0;
  return Math.min(n, 3650); // hard cap: 10 years
}

export function findGitRepoRoot(startDir: string): string | null {
  const initial = startDir?.trim();
  if (!initial) return null;

  let current = path.resolve(initial);
  // 如果传入的是文件路径，先取目录
  try {
    const st = fs.existsSync(current) ? fs.statSync(current) : null;
    if (st && st.isFile()) current = path.dirname(current);
  } catch {
    // ignore
  }

  while (true) {
    const gitPath = path.join(current, '.git');
    try {
      if (fs.existsSync(gitPath)) {
        return current;
      }
    } catch {
      // ignore
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

export function resolveProjectInfoFromWorkingDirectory(workingDirectory: string): ResolvedProjectInfo {
  const cwd = workingDirectory?.trim();
  if (!cwd) {
    return { projectKey: 'unknown', projectLabel: 'unknown' };
  }

  const repoRoot = findGitRepoRoot(cwd);
  const keyPath = normalizePathKey(repoRoot || path.resolve(cwd));
  const label = path.basename(repoRoot || path.resolve(cwd)) || keyPath;
  return { projectKey: keyPath, projectLabel: label };
}

export async function loadUsageSummaryFile(filePath: string): Promise<UsageSummaryFile> {
  try {
    const text = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(text) as Partial<UsageSummaryFile>;
    if (parsed && parsed.version === SUMMARY_VERSION && parsed.projects && typeof parsed.projects === 'object') {
      return {
        version: SUMMARY_VERSION,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        projects: parsed.projects as UsageSummaryFile['projects'],
      };
    }
  } catch {
    // ignore
  }
  return { version: SUMMARY_VERSION, updatedAt: new Date().toISOString(), projects: {} };
}

function pruneByRetention(summary: UsageSummaryFile, retentionDays: number, now: Date): void {
  if (retentionDays <= 0) return;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (retentionDays - 1));
  const cutoffKey = formatLocalDateKey(cutoff);

  for (const project of Object.values(summary.projects)) {
    const days = project.days || {};
    for (const dayKey of Object.keys(days)) {
      if (dayKey < cutoffKey) {
        delete days[dayKey];
      }
    }
    project.days = days;
  }
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });

  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const payload = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(tmp, payload, 'utf-8');
  await fs.promises.rename(tmp, filePath);
}

export async function recordTokenUsageToDailySummary(opts: {
  filePath: string;
  project: ResolvedProjectInfo;
  usage: TokenUsage;
  now?: Date;
  retentionDays?: number;
}): Promise<void> {
  const now = opts.now ?? new Date();
  const dateKey = formatLocalDateKey(now);

  const usage = opts.usage;
  const inputTokens = toSafeNonNegativeNumber((usage as any)?.input_tokens);
  const outputTokens = toSafeNonNegativeNumber((usage as any)?.output_tokens);
  const cacheRead = toSafeNonNegativeNumber((usage as any)?.cache_read_input_tokens);
  const cacheCreate = toSafeNonNegativeNumber((usage as any)?.cache_creation_input_tokens);
  const costUsdRaw = (usage as any)?.cost_usd;
  const costUsd = costUsdRaw == null ? undefined : toSafeNonNegativeNumber(costUsdRaw);

  const summary = await loadUsageSummaryFile(opts.filePath);

  const projectKey = opts.project.projectKey;
  const existingProject = summary.projects[projectKey];
  const project: ProjectUsageSummary = existingProject
    ? { ...existingProject, label: opts.project.projectLabel, days: existingProject.days || {} }
    : { label: opts.project.projectLabel, days: {} };

  const existingDay = project.days[dateKey];
  const day: DailyTokenUsage = existingDay
    ? { ...existingDay }
    : {
      turns: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };

  day.turns += 1;
  day.input_tokens += inputTokens;
  day.output_tokens += outputTokens;
  day.cache_read_input_tokens += cacheRead;
  day.cache_creation_input_tokens += cacheCreate;
  if (costUsd != null) {
    day.cost_usd = (day.cost_usd ?? 0) + costUsd;
  }

  project.days[dateKey] = day;
  summary.projects[projectKey] = project;
  summary.updatedAt = now.toISOString();

  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  pruneByRetention(summary, retentionDays, now);

  await atomicWriteJson(opts.filePath, summary);
}
