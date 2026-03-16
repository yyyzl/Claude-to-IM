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

/**
 * Start a new session for an IM chat and re-bind the channel to it.
 *
 * 默认会继承当前绑定的 workingDirectory/model/mode（如果存在），
 * 这样用户可以“清空上下文”但不丢配置。
 */
export function startNewSession(
  address: ChannelAddress,
  opts: StartNewSessionOptions = {},
): ChannelBinding {
  const { store } = getBridgeContext();

  const existing = store.getChannelBinding(address.channelType, address.chatId);
  const effectiveCwd = opts.workingDirectory
    || existing?.workingDirectory
    || store.getSetting('bridge_default_work_dir')
    || homedir()
    || '';
  const effectiveModel = opts.model
    || existing?.model
    || store.getSetting('bridge_default_model')
    || '';
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
  });

  // 关键：新会话必须清空 sdkSessionId，避免 SDK 恢复到旧上下文。
  // 同时补齐 upsert 可能没更新到的列（mode/active 等），保证行为一致。
  store.updateChannelBinding(binding.id, {
    sdkSessionId: '',
    mode: effectiveMode,
    active: true,
    workingDirectory: effectiveCwd,
    model: effectiveModel,
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
    workingDirectory: defaultCwd,
    model: defaultModel,
  });

  // 新建绑定时务必清空 sdkSessionId，避免恢复到历史 SDK 会话。
  store.updateChannelBinding(binding.id, {
    sdkSessionId: '',
    mode: 'code',
    active: true,
    workingDirectory: defaultCwd,
    model: defaultModel,
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
  });

  // 切换会话时也要清空 sdkSessionId，防止恢复到之前的 SDK 上下文。
  store.updateChannelBinding(binding.id, {
    sdkSessionId: '',
    mode,
    active: true,
    workingDirectory: session.working_directory,
    model: session.model,
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
