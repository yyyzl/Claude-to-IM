/** 模型目录能力解析；用户可读名称与协议档位 ID 必须分开。 */
import type { ModelCatalogEntry } from '../types.js';

/** 与 Codex TUI 一致，按名称识别 Fast，返回目录原始条目用于发送真实 ID。 */
export function findFastServiceTier(
  model: Pick<ModelCatalogEntry, 'serviceTiers'>,
): ModelCatalogEntry['serviceTiers'][number] | undefined {
  return model.serviceTiers.find(tier => tier.name.toLowerCase() === 'fast');
}
