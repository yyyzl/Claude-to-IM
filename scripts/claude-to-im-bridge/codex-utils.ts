/** Codex 本地运行时解析与模型目录选择。 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export interface CodexModelListItem {
  id: string;
  model?: string;
  displayName?: string;
  isDefault?: boolean;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
  inputModalities?: string[];
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
    const selected = models.find(model => model.id === id || model.model === id);
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
  if (effort && !model.supportedReasoningEfforts?.some(option => option.reasoningEffort === effort)) {
    throw new Error(`模型 ${model.model || model.id} 不支持思考强度 ${effort}`);
  }
  return effort;
}
