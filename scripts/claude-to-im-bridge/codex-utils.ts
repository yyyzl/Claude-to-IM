/** Codex 本地运行时解析与模型目录选择。 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ModelCatalogEntry } from '../../src/lib/bridge/types.js';

export interface CodexModelListItem extends ModelCatalogEntry {
  hidden?: boolean;
  inputModalities?: string[];
}

function catalogRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Codex 模型目录 ${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function catalogString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new Error(`Codex 模型目录 ${field} 必须是非空字符串`);
  return value;
}

function catalogDescription(value: unknown, field: string): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`Codex 模型目录 ${field} 必须是字符串`);
  return value;
}

/** 验证整页输入；不接受半页损坏数据，避免刷新后出现虚假的可选能力。 */
export function parseCodexModelPage(value: unknown): { models: CodexModelListItem[]; nextCursor: string | null } {
  const page = catalogRecord(value, 'response');
  if (!Array.isArray(page.data)) throw new Error('Codex 模型目录 data 必须是数组');
  const models = page.data.map(value => {
    const item = catalogRecord(value, 'model');
    const id = catalogString(item.id, 'id');
    const model = catalogString(item.model, `${id}.model`);
    const displayName = item.displayName === undefined ? model : catalogString(item.displayName, `${id}.displayName`);
    if (typeof item.isDefault !== 'boolean') throw new Error(`Codex 模型目录 ${id}.isDefault 必须是布尔值`);
    if (item.hidden !== undefined && typeof item.hidden !== 'boolean') throw new Error(`Codex 模型目录 ${id}.hidden 必须是布尔值`);
    const defaultReasoningEffort = catalogString(item.defaultReasoningEffort, `${id}.defaultReasoningEffort`);
    if (!Array.isArray(item.supportedReasoningEfforts)) throw new Error(`Codex 模型目录 ${id}.supportedReasoningEfforts 必须是数组`);
    const effortIds = new Set<string>();
    const supportedReasoningEfforts = item.supportedReasoningEfforts.map(value => {
      const option = catalogRecord(value, `${id}.effort`);
      const reasoningEffort = catalogString(option.reasoningEffort, `${id}.reasoningEffort`);
      if (effortIds.has(reasoningEffort)) throw new Error(`Codex 模型目录 ${id} 包含重复强度 ${reasoningEffort}`);
      effortIds.add(reasoningEffort);
      return { reasoningEffort, description: catalogDescription(option.description, `${id}.effort.description`) };
    });
    if (!effortIds.has(defaultReasoningEffort)) throw new Error(`Codex 模型目录 ${id} 的默认强度不在支持列表中`);
    const tiers = item.serviceTiers === undefined ? [] : item.serviceTiers;
    if (!Array.isArray(tiers)) throw new Error(`Codex 模型目录 ${id}.serviceTiers 必须是数组`);
    const tierIds = new Set<string>();
    const serviceTiers = tiers.map(value => {
      const tier = catalogRecord(value, `${id}.serviceTier`);
      const tierId = catalogString(tier.id, `${id}.serviceTier.id`);
      if (tierIds.has(tierId)) throw new Error(`Codex 模型目录 ${id} 包含重复速度 ${tierId}`);
      tierIds.add(tierId);
      return { id: tierId, name: catalogString(tier.name, `${id}.serviceTier.name`), description: catalogDescription(tier.description, `${id}.serviceTier.description`) };
    });
    const defaultServiceTier = item.defaultServiceTier == null ? null : catalogString(item.defaultServiceTier, `${id}.defaultServiceTier`);
    if (defaultServiceTier && defaultServiceTier !== 'default' && !tierIds.has(defaultServiceTier)) throw new Error(`Codex 模型目录 ${id} 的默认速度不在支持列表中`);
    let inputModalities: string[] | undefined;
    if (item.inputModalities !== undefined) {
      if (!Array.isArray(item.inputModalities)) throw new Error(`Codex 模型目录 ${id}.inputModalities 必须是数组`);
      inputModalities = item.inputModalities.map(value => catalogString(value, `${id}.inputModality`));
    }
    return { id, model, displayName, isDefault: item.isDefault, defaultReasoningEffort, supportedReasoningEfforts, serviceTiers, defaultServiceTier, hidden: item.hidden === true, inputModalities };
  });
  return { models, nextCursor: page.nextCursor == null ? null : catalogString(page.nextCursor, 'nextCursor') };
}

/** 显式可执行文件优先，否则只使用项目锁定版本，避免 PATH 版本漂移。 */
export function resolveCodexBinary(userSpecified?: string, projectRoot = fileURLToPath(new URL('../../', import.meta.url))): string {
  if (userSpecified?.trim()) return userSpecified.trim();
  const requireFromProject = createRequire(path.join(projectRoot, 'package.json'));
  try {
    const manifestPath = requireFromProject.resolve('@openai/codex/package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { bin?: { codex?: string } };
    if (typeof manifest.bin?.codex !== 'string') throw new Error('缺少 bin.codex');
    const entry = path.resolve(path.dirname(manifestPath), manifest.bin.codex);
    if (!fs.existsSync(entry)) throw new Error('入口不存在');
    return entry;
  } catch {
    throw new Error('未找到项目依赖 @openai/codex，请运行 npm install，或显式配置 bridge_codex_bin。');
  }
}

export function buildTurnSandboxPolicy(sandboxMode: string): Record<string, unknown> {
  switch (sandboxMode) {
    case 'danger-full-access': return { type: 'dangerFullAccess' };
    case 'workspace-write': return { type: 'workspaceWrite' };
    case 'read-only': return { type: 'readOnly' };
    default: throw new Error(`不支持的 sandbox_mode: ${sandboxMode}`);
  }
}

/** 用户的精确选择不得静默换成另一型号，默认选择服务端目录的默认项。 */
export function selectCodexModel(models: CodexModelListItem[], opts: { explicitId?: string; hint?: string } = {}): CodexModelListItem | null {
  const selection = (opts.explicitId || opts.hint || '').trim();
  const [id] = selection.split(/\s+/);
  if (id && id !== 'default') {
    const selected = models.find(model => !model.hidden && (model.id === id || model.model === id));
    if (!selected) throw new Error(`Codex 模型目录中没有 ${id}；请检查 /model 或 bridge_codex_model 配置。`);
    return selected;
  }
  const visible = models.filter(model => !model.hidden);
  return visible.find(model => model.isDefault) ?? visible[0] ?? null;
}

export function selectCodexEffort(model: CodexModelListItem, selection?: string, configuredEffort?: string): string | undefined {
  const tokens = selection?.trim().split(/\s+/) ?? [];
  if (tokens.length > 2) throw new Error('模型格式应为 <model-id> [effort]');
  const effort = tokens[1] || configuredEffort || model.defaultReasoningEffort;
  if (effort && !model.supportedReasoningEfforts.some(option => option.reasoningEffort === effort)) {
    throw new Error(`模型 ${model.model} 不支持思考强度 ${effort}`);
  }
  return effort;
}
