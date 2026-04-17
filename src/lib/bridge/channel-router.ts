/**
 * Channel Router — resolves IM addresses to CodePilot sessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelBinding (and underlying chat_session).
 */

import { homedir } from 'node:os';
import type { ChannelAddress, ChannelBinding, ChannelType } from './types.js';
import { getBridgeContext } from './context.js';

export interface StartNewSessionOptions {
  workingDirectory?: string;
  model?: string;
  mode?: 'code' | 'plan' | 'ask';
}

function getCurrentBackend(): string {
  const { store } = getBridgeContext();
  return (store.getSetting('bridge_llm_backend') || 'claude').trim().toLowerCase();
}

function hasBackendChanged(binding: ChannelBinding | null, currentBackend: string): boolean {
  // backend 为 undefined（旧数据无此字段）视为"未知"，不触发切换逻辑，保持向后兼容。
  return (binding?.backend != null) && (binding.backend !== currentBackend);
}

/**
 * Start a new session for an IM chat and re-bind the channel to it.
 *
 * 默认会继承当前绑定的 workingDirectory/mode（如果存在），
 * 这样用户可以“清空上下文”但不丢目录与模式配置。
 * model 不再继承旧 binding / session，/new 总是回到当前 backend 的默认模型，
 * 避免用户切换模型后仍被历史聊天状态污染。
 */
export function startNewSession(
  address: ChannelAddress,
  opts: StartNewSessionOptions = {},
): ChannelBinding {
  const { store } = getBridgeContext();

  const existing = store.getChannelBinding(address.channelType, address.chatId);
  const currentBackend = getCurrentBackend();

  const effectiveCwd = opts.workingDirectory
    || existing?.workingDirectory
    || store.getSetting('bridge_default_work_dir')
    || homedir()
    || '';
  // 按 backend 选择各自的默认 model，避免跨 backend 的模型名污染。
  // claude → bridge_default_model（历来就是给 Claude 用的）
  // codex  → bridge_codex_model_id / bridge_codex_model_hint（不 fallback 到
  //          bridge_default_model，因为那通常是 Claude 模型名；
  //          为空时 Codex provider 会用自己的内置默认值）
  const backendDefaultModel = currentBackend === 'codex'
    ? (store.getSetting('bridge_codex_model_id') || store.getSetting('bridge_codex_model_hint') || '')
    : (store.getSetting('bridge_default_model') || '');
  const effectiveModel = opts.model || backendDefaultModel || '';
  const effectiveMode = opts.mode
    || existing?.mode
    || 'code';
  const defaultProviderId = store.getSetting('bridge_default_provider_id') || '';

  const displayName = address.displayName || address.chatId;
  const session = store.createSession(
    `Bridge: ${displayName}`,
    effectiveModel,
    undefined,
    effectiveCwd,
    effectiveMode,
  );

  if (defaultProviderId) {
    store.updateSessionProviderId(session.id, defaultProviderId);
  }

  const binding = store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId: session.id,
    workingDirectory: effectiveCwd,
    model: effectiveModel,
    backend: currentBackend,
  });

  // 关键：新会话必须清空 sdkSessionId，避免 SDK 恢复到旧上下文。
  // 同时补齐 upsert 可能没更新到的列（mode/active/backend 等），保证行为一致。
  store.updateChannelBinding(binding.id, {
    sdkSessionId: '',
    mode: effectiveMode,
    active: true,
    workingDirectory: effectiveCwd,
    model: effectiveModel,
    backend: currentBackend,
  });

  return store.getChannelBinding(address.channelType, address.chatId) || binding;
}


/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 */
export function resolve(address: ChannelAddress): ChannelBinding {
  const { store } = getBridgeContext();
  const existing = store.getChannelBinding(address.channelType, address.chatId);
  if (existing) {
    const currentBackend = getCurrentBackend();
    if (hasBackendChanged(existing, currentBackend)) {
      return startNewSession(address);
    }
    // Verify the linked session still exists; if not, create a new one
    const session = store.getSession(existing.codepilotSessionId);
    if (session) return existing;
    // Session was deleted ? recreate (keep binding config if possible)
    return startNewSession(address);
  }
  return startNewSession(address);
}

/**
 * Create a new binding with a fresh CodePilot session.
 */
export function createBinding(
  address: ChannelAddress,
  workingDirectory?: string,
): ChannelBinding {
  const { store } = getBridgeContext();
  const currentBackend = getCurrentBackend();
  const defaultCwd = workingDirectory
    || store.getSetting('bridge_default_work_dir')
    || homedir()
    || '';
  const defaultModel = store.getSetting('bridge_default_model') || '';
  const defaultProviderId = store.getSetting('bridge_default_provider_id') || '';

  const displayName = address.displayName || address.chatId;
  const session = store.createSession(
    `Bridge: ${displayName}`,
    defaultModel,
    undefined,
    defaultCwd,
    'code',
  );

  if (defaultProviderId) {
    store.updateSessionProviderId(session.id, defaultProviderId);
  }

  const binding = store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId: session.id,
    sdkSessionId: '',
    workingDirectory: defaultCwd,
    model: defaultModel,
    mode: 'code',
    backend: currentBackend,
  });

  // 新建绑定时务必清空 sdkSessionId，避免恢复到历史 SDK 会话。
  store.updateChannelBinding(binding.id, {
    sdkSessionId: '',
    mode: 'code',
    active: true,
    workingDirectory: defaultCwd,
    model: defaultModel,
    backend: currentBackend,
  });

  return store.getChannelBinding(address.channelType, address.chatId) || binding;
}

/**
 * Bind an IM chat to an existing CodePilot session.
 */
export function bindToSession(
  address: ChannelAddress,
  codepilotSessionId: string,
): ChannelBinding | null {
  const { store } = getBridgeContext();
  const currentBackend = getCurrentBackend();
  const session = store.getSession(codepilotSessionId);
  if (!session) return null;

  const existing = store.getChannelBinding(address.channelType, address.chatId);
  const mode = existing?.mode || 'code';

  const binding = store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId,
    workingDirectory: session.working_directory,
    model: session.model,
    backend: currentBackend,
  });

  // 切换会话时也要清空 sdkSessionId，防止恢复到之前的 SDK 上下文。
  store.updateChannelBinding(binding.id, {
    sdkSessionId: '',
    mode,
    active: true,
    workingDirectory: session.working_directory,
    model: session.model,
    backend: currentBackend,
  });

  return store.getChannelBinding(address.channelType, address.chatId) || binding;
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active'>>,
): void {
  getBridgeContext().store.updateChannelBinding(id, updates);
}

/**
 * List all bindings, optionally filtered by channel type.
 */
export function listBindings(channelType?: ChannelType): ChannelBinding[] {
  return getBridgeContext().store.listChannelBindings(channelType);
}
