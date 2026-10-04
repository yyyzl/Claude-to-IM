import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowStore } from './workflow-store.js';
import type { IssueLedger, PatchResult } from './types.js';

type Target = 'spec' | 'plan';
interface Artifact {
  schema: 1;
  runId: string;
  round: number;
}

export interface PatchBaseline extends Artifact {
  spec: { version: number; hash: string };
  plan: { version: number; hash: string };
  ledger: IssueLedger;
}

export interface PatchApplication extends Artifact {
  baselineHash: string;
  rawHash: string;
  documents: Partial<Record<Target, PatchResult & { version: number }>>;
  hasPatchFailure: boolean;
  ledger: IssueLedger;
  completion: Record<string, unknown>;
}

/** 仅恢复证据不完整或冲突时转人工；磁盘写入故障仍向调用方抛出。 */
export class PatchRecoveryError extends Error {}

const ledgerSchema = z.object({
  run_id: z.string(),
  issues: z.array(z.looseObject({
    id: z.string(), round: z.number().int().positive(),
    raised_by: z.enum(['codex', 'claude', 'human']),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    description: z.string(), evidence: z.string(),
    status: z.enum(['open', 'accepted', 'rejected', 'deferred', 'resolved']),
    repeat_count: z.number().int().nonnegative(),
  })),
});
const artifactFields = { schema: z.literal(1), runId: z.string(), round: z.number().int().positive(), ledger: ledgerSchema };
const documentRefSchema = z.object({ version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) });
const baselineSchema = z.object({ ...artifactFields, spec: documentRefSchema, plan: documentRefSchema });
const patchResultSchema = z.object({
  version: z.number().int().positive(), merged: z.string(),
  appliedSections: z.array(z.string()), failedSections: z.array(z.string()),
});
const applicationSchema = z.object({
  ...artifactFields, baselineHash: z.string(), rawHash: z.string(),
  documents: z.object({ spec: patchResultSchema.optional(), plan: patchResultSchema.optional() }),
  hasPatchFailure: z.boolean(), completion: z.record(z.string(), z.unknown()),
});

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function encode(data: Artifact): string {
  return JSON.stringify({ checksum: hash(JSON.stringify(data)), data });
}

function decode<T extends Artifact>(raw: string, runId: string, round: number, name: string, schema: z.ZodType): T {
  try {
    const envelope = JSON.parse(raw) as { checksum: string; data: T };
    if (schema.safeParse(envelope.data).success && envelope.data.runId === runId && envelope.data.round === round &&
      envelope.checksum === hash(JSON.stringify(envelope.data))) return envelope.data;
  } catch { /* 由统一错误提示说明需要人工恢复，不输出文档或原始模型数据。 */ }
  throw new PatchRecoveryError(`本轮 ${name} 恢复记录损坏或归属不符；请保留运行目录并核对后重新审查。`);
}

/** 新调用模型之前记录准确输入；不能从可能被压缩的 round pack 反推。 */
export async function createPatchBaseline(
  store: WorkflowStore, runId: string, round: number, ledger: IssueLedger,
): Promise<PatchBaseline> {
  const spec = await store.loadDocumentVersion(runId, 'spec');
  const plan = await store.loadDocumentVersion(runId, 'plan');
  if (spec.content === null || plan.content === null) {
    throw new PatchRecoveryError('缺少 spec/plan 基线文档；请恢复原始版本或重新审查。');
  }
  const baseline: PatchBaseline = {
    schema: 1, runId, round,
    spec: { version: spec.version, hash: hash(spec.content) },
    plan: { version: plan.version, hash: hash(plan.content) },
    ledger: structuredClone(ledger),
  };
  await store.saveRoundArtifact(runId, round, 'claude-baseline.json', encode(baseline));
  return baseline;
}

/** 在任何重匹配或账本写入之前查找已完成的应用决定。 */
export async function loadPatchRecovery(store: WorkflowStore, runId: string, round: number): Promise<{
  baseline: PatchBaseline | null; application: PatchApplication | null;
}> {
  const baselineRaw = await store.loadRoundArtifact(runId, round, 'claude-baseline.json');
  const applicationRaw = await store.loadRoundArtifact(runId, round, 'patch-application.json');
  const claudeRaw = await store.loadRoundArtifact(runId, round, 'claude-raw.md');
  if (baselineRaw === null) {
    if (applicationRaw !== null || claudeRaw !== null) {
      throw new PatchRecoveryError('本轮已有决策产物但缺少准确补丁基线，不能对最新文档猜测重放；请保留运行目录，核对原始 spec/plan 后重新审查。');
    }
    return { baseline: null, application: null };
  }
  const baseline = decode<PatchBaseline>(baselineRaw, runId, round, '基线', baselineSchema);
  const application = applicationRaw === null ? null : decode<PatchApplication>(applicationRaw, runId, round, '补丁应用', applicationSchema);
  if (baseline.ledger.run_id !== runId || (application && application.ledger.run_id !== runId)) {
    throw new PatchRecoveryError('问题账本的工作流归属与恢复记录不一致，拒绝覆盖。');
  }
  if (application && (application.baselineHash !== hash(JSON.stringify(baseline)) ||
    claudeRaw === null || application.rawHash !== hash(claudeRaw))) {
    throw new PatchRecoveryError('补丁应用记录与原始决策或基线不一致；请保留运行目录并人工核对。');
  }
  const ledger = await store.loadLedger(runId);
  if (JSON.stringify(ledger) !== JSON.stringify(baseline.ledger) &&
    (!application || JSON.stringify(ledger) !== JSON.stringify(application.ledger))) {
    throw new PatchRecoveryError('问题账本与本轮恢复记录不符，拒绝覆盖后续变更；请人工核对。');
  }
  for (const target of ['spec', 'plan'] as const) {
    const ref = baseline[target];
    const content = target === 'spec' ? await store.loadSpec(runId, ref.version) : await store.loadPlan(runId, ref.version);
    if (content === null || hash(content) !== ref.hash) {
      throw new PatchRecoveryError(`${target} 基线版本缺失或内容发生变化，不能安全恢复补丁。`);
    }
    const latest = await store.loadDocumentVersion(runId, target);
    const expected = application?.documents[target]?.version ?? ref.version;
    if (latest.version > expected || latest.version < ref.version) {
      throw new PatchRecoveryError(`${target} 出现本轮记录以外的文档版本，请人工核对后重新审查。`);
    }
  }
  return { baseline, application };
}

/** 完整决定先落盘，之后任何中断都只补齐这些固定版本及最终账本。 */
export async function savePatchApplication(
  store: WorkflowStore, baseline: PatchBaseline, raw: string,
  result: Pick<PatchApplication, 'documents' | 'hasPatchFailure' | 'ledger' | 'completion'>,
): Promise<PatchApplication> {
  const application: PatchApplication = {
    schema: 1, runId: baseline.runId, round: baseline.round,
    baselineHash: hash(JSON.stringify(baseline)), rawHash: hash(raw),
    ...structuredClone(result),
  };
  await store.saveRoundArtifact(baseline.runId, baseline.round, 'patch-application.json', encode(application));
  return application;
}

/** false 表示已暂停；已开始的原子写会排空，应用记录保留供下次继续。 */
export async function commitPatchApplication(
  store: WorkflowStore, baseline: PatchBaseline, application: PatchApplication, signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const writes: Array<{ target: Target; result: PatchResult & { version: number } }> = [];
  // 全部预检通过再落盘，避免发现 plan 冲突前先改动 spec。
  for (const target of ['spec', 'plan'] as const) {
    const result = application.documents[target];
    if (!result) continue;
    if (result.version !== baseline[target].version + 1) {
      throw new PatchRecoveryError(`${target} 补丁目标版本不符合本轮基线，拒绝覆盖。`);
    }
    const existing = target === 'spec'
      ? await store.loadSpec(application.runId, result.version)
      : await store.loadPlan(application.runId, result.version);
    if (existing !== null && existing !== result.merged) {
      throw new PatchRecoveryError(`${target} 目标版本已存在不同内容，拒绝覆盖；请保留现场并重新审查。`);
    }
    if (existing === null) writes.push({ target, result });
  }
  const currentLedger = await store.loadLedger(application.runId);
  if (JSON.stringify(currentLedger) !== JSON.stringify(baseline.ledger) &&
    JSON.stringify(currentLedger) !== JSON.stringify(application.ledger)) {
    throw new PatchRecoveryError('问题账本与本轮基线或应用结果不符，拒绝覆盖人工或其他步骤的变更。');
  }
  for (const { target, result } of writes) {
    if (signal?.aborted) return false;
    if (target === 'spec') await store.saveSpec(application.runId, result.merged, result.version);
    else await store.savePlan(application.runId, result.merged, result.version);
  }
  if (signal?.aborted) return false;
  await store.saveLedger(application.runId, application.ledger);
  return !signal?.aborted;
}
