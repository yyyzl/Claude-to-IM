/** 只观察真实网关终态；投递超时与审批有效期分别处理。 */
import type { BaseChannelAdapter } from './channel-adapter.js';
import type { PermissionGateway, PermissionResolution } from './host.js';
import type { ChannelAddress } from './types.js';

export function observeInteraction(adapter: BaseChannelAdapter, address: ChannelAddress, requestId: string, permissions: PermissionGateway, answered = false, onSettled?: () => void) {
  let messageId: string | undefined;
  let status: 'allowed' | 'denied' | 'expired' | 'failed' | 'answered' | undefined;
  let unsubscribe: (() => void) | undefined;
  const update = () => {
    if (messageId && status && adapter.updateInteractionMessage) {
      void adapter.updateInteractionMessage(address, messageId, status).catch(error => console.warn('[bridge] 交互卡结果回写失败：', error instanceof Error ? error.message : '未知错误'));
    }
  };
  const resolve = (resolution: PermissionResolution) => {
    if (status) return;
    status = resolution.reason === 'expired' ? 'expired' : resolution.reason === 'delivery_failed' ? 'failed' : resolution.behavior === 'allow' ? answered ? 'answered' : 'allowed' : 'denied';
    unsubscribe?.(); onSettled?.(); update();
  };
  unsubscribe = permissions.onResolution?.(requestId, resolve);
  return { get settled() { return Boolean(status); }, sent(id: string) { messageId = id; update(); }, resolve };
}

export async function boundedInteraction<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('交互消息投递超时，已拒绝本次请求')), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
