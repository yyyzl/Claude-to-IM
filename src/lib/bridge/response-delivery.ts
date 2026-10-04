/** 最终回答待发记录：发送前持久化，补发只处理未确认成功的分块。 */
import { createHash, randomUUID } from 'node:crypto';
import type { BaseChannelAdapter, ImageUploadResult } from './channel-adapter.js';
import type { BridgeStore, GeneratedImage, ResponseDeliveryRecord } from './host.js';
import type { ChannelAddress, SendResult } from './types.js';
import { getBridgeContext } from './context.js';
import { deliverSingle } from './delivery-layer.js';
import { markdownToTelegramChunks } from './markdown/telegram.js';
import { markdownToDiscordChunks } from './markdown/discord.js';
import { splitFeishuMarkdown } from './markdown/feishu.js';
import { PLATFORM_LIMITS } from './types.js';
import { validateGeneratedImage, checkGeneratedImageBudget } from './internal/generated-image.js';

const memory = new WeakMap<BridgeStore, Map<string, ResponseDeliveryRecord>>();
const running = new Set<string>();
type Options = { turnId?: string; isCurrent?: () => boolean; finalize?: () => Promise<boolean>; images?: GeneratedImage[] };
function records(store: BridgeStore): Map<string, ResponseDeliveryRecord> {
  let rows = memory.get(store); if (!rows) { rows = new Map(); memory.set(store, rows); } return rows;
}
function durable(store: BridgeStore): boolean { return Boolean(store.saveResponseDelivery && store.getResponseDelivery && store.listResponseDeliveries && store.flush); }
function snapshot(record: ResponseDeliveryRecord): ResponseDeliveryRecord { return structuredClone(record); }
async function save(store: BridgeStore, record: ResponseDeliveryRecord): Promise<void> {
  record.updatedAt = new Date().toISOString();
  records(store).set(record.id, snapshot(record));
  const completed = [...records(store).values()].filter(row => row.status === 'delivered').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const row of completed.slice(100)) records(store).delete(row.id);
  if (durable(store)) { store.saveResponseDelivery!(snapshot(record)); await store.flush!(); }
}
function list(store: BridgeStore, address: ChannelAddress): ResponseDeliveryRecord[] {
  const stored = durable(store) ? store.listResponseDeliveries!(address.channelType, address.chatId) : [];
  const merged = new Map(stored.map(record => [record.id, record]));
  for (const record of records(store).values()) merged.set(record.id, record);
  return [...merged.values()].filter(record => record.address.channelType === address.channelType && record.address.chatId === address.chatId && (!record.address.userId || record.address.userId === address.userId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function chunks(channel: string, text: string): ResponseDeliveryRecord['chunks'] {
  if (!text) return [];
  if (channel === 'telegram') return markdownToTelegramChunks(text, 4096).map(chunk => ({ kind: 'text', text: chunk.html, parseMode: 'HTML', plainFallback: chunk.text, sent: false }));
  const limit = PLATFORM_LIMITS[channel] || 4096;
  let parts = channel === 'feishu' ? splitFeishuMarkdown(text) : markdownToDiscordChunks(text, limit).map(chunk => chunk.text);
  if (channel === 'qq' && parts.length > 3) parts = [...parts.slice(0, 2), parts.slice(2).join('\n').slice(0, limit - 25) + '\n[... response truncated]'];
  return parts.map(part => ({ kind: 'text', text: part, parseMode: channel === 'qq' ? 'plain' : 'Markdown', sent: false }));
}

/** 上传截止时间只结束本地等待；迟到结果不能自行触发发送。 */
async function uploadWithinDeadline(adapter: BaseChannelAdapter, store: BridgeStore, image: GeneratedImage): Promise<ImageUploadResult> {
  const configured = Number(store.getSetting('bridge_delivery_timeout_ms'));
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 15_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => adapter.uploadImage(image)).catch(() => ({ ok: false, error: '图片上传失败，请稍后补发' })),
      new Promise<ImageUploadResult>(resolve => { timer = setTimeout(() => resolve({ ok: false, error: '图片上传超时，尚未发送图片消息；可手动补发' }), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
function checkCurrent(options: Options): void { if (options.isCurrent && !options.isCurrent()) throw new Error('任务已取消或会话已切换；回答保留供手动补发'); }
async function finalizeWithinDeadline(store: BridgeStore, finalize: () => Promise<boolean>): Promise<boolean> {
  const configured = Number(store.getSetting('bridge_delivery_timeout_ms'));
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(finalize).catch(() => false),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('最终卡片更新超时，平台结果未知；请确认后手动补发')), configured > 0 ? configured : 15_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
async function attempt(adapter: BaseChannelAdapter, store: BridgeStore, record: ResponseDeliveryRecord, options: Options = {}): Promise<SendResult> {
  const key = `${record.address.channelType}:${record.address.chatId}:${record.id}`;
  if (running.has(key)) return { ok: false, error: `回答 ${record.id} 正在发送，请勿重复补发` };
  if (record.status === 'delivered') return { ok: true };
  running.add(key);
  let lastMessageId: string | undefined;
  try {
    checkCurrent(options);
    record.status = 'pending'; record.attempts++; record.lastError = undefined;
    await save(store, record);
    checkCurrent(options);
    if (options.finalize && record.chunks.every(chunk => !chunk.sent)) {
      const finalized = await finalizeWithinDeadline(store, options.finalize);
      if (finalized) {
        for (const chunk of record.chunks) if (chunk.kind !== 'image') chunk.sent = true;
        await save(store, record);
      }
      checkCurrent(options);
    }
    for (const chunk of record.chunks) {
      if (chunk.sent) continue;
      checkCurrent(options);
      let result: SendResult;
      if (chunk.kind === 'image') {
        if (!chunk.imageKey) {
          const uploaded = await uploadWithinDeadline(adapter, store, chunk.image);
          if (!uploaded.ok || !uploaded.imageKey?.trim()) throw new Error(uploaded.error || '图片上传未返回有效标识，尚未发送');
          chunk.imageKey = uploaded.imageKey;
          await save(store, record);
        }
        checkCurrent(options);
        result = await deliverSingle(adapter, {
          address: record.address, text: '', parseMode: 'plain', replyToMessageId: record.replyToMessageId,
          image: { imageKey: chunk.imageKey, sendUuid: chunk.sendUuid },
        }, undefined, options.isCurrent);
      } else {
        result = await deliverSingle(adapter, { address: record.address, text: chunk.text, parseMode: chunk.parseMode, replyToMessageId: record.replyToMessageId }, chunk.plainFallback, options.isCurrent);
      }
      if (!result.ok) throw new Error(result.error || '回答发送失败');
      chunk.sent = true; chunk.messageId = result.messageId; lastMessageId = result.messageId;
      try {
        if (result.messageId) store.insertOutboundRef({ channelType: adapter.channelType, chatId: record.address.chatId, codepilotSessionId: record.sessionId, platformMessageId: result.messageId, purpose: 'response' });
        store.insertAuditLog({ channelType: adapter.channelType, chatId: record.address.chatId, direction: 'outbound', messageId: result.messageId || '', summary: chunk.kind === 'image' ? '[生成图片已发送]' : chunk.text.slice(0, 200) });
      } catch { /* 引用和审计不改变已确认的发送结果。 */ }
      await save(store, record);
      checkCurrent(options);
    }
    record.status = 'delivered'; record.responseText = ''; record.chunks = [];
    await save(store, record);
    return { ok: true, messageId: lastMessageId };
  } catch (error) {
    record.status = 'failed'; record.lastError = error instanceof Error ? error.message : String(error);
    try { await save(store, record); } catch (saveError) { record.lastError += `；待发记录保存失败：${saveError instanceof Error ? saveError.message : String(saveError)}`; records(store).set(record.id, snapshot(record)); }
    return { ok: false, messageId: lastMessageId, error: `回答 ${record.id} 未完整送达：${record.lastError}${durable(store) ? '' : '（宿主不支持持久待发，重启可能丢失）'}` };
  } finally { running.delete(key); }
}

export async function deliverResponse(adapter: BaseChannelAdapter, address: ChannelAddress, responseText: string, sessionId: string, replyToMessageId?: string, options: Options = {}): Promise<SendResult> {
  const store = getBridgeContext().store;
  const images = new Map<string, GeneratedImage>();
  let totalBytes = 0;
  try {
    for (const value of options.images ?? []) {
      const image = validateGeneratedImage(value);
      const previous = images.get(image.id);
      if (previous) {
        if (previous.sha256 !== image.sha256) throw new Error('重复生成图片标识的内容不一致');
        continue;
      }
      totalBytes += image.byteLength;
      checkGeneratedImageBudget(images.size + 1, totalBytes);
      images.set(image.id, image);
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '生成图片记录无效' };
  }
  const identity = options.turnId || replyToMessageId || randomUUID();
  const imageIdentity = [...images.values()].map(image => [image.id, image.sha256]);
  const id = createHash('sha256').update(JSON.stringify([address.channelType, address.chatId, sessionId, identity, responseText, ...imageIdentity])).digest('hex').slice(0, 20);
  const existing = list(store, address).find(record => record.id === id);
  const now = new Date().toISOString();
  const record: ResponseDeliveryRecord = existing ?? { id, sessionId, address: { ...address }, responseText, replyToMessageId, chunks: [
    ...chunks(adapter.channelType, responseText),
    ...[...images.values()].map(image => ({ kind: 'image' as const, image, sendUuid: randomUUID(), sent: false })),
  ], status: 'pending', attempts: 0, createdAt: now, updatedAt: now };
  return attempt(adapter, store, record, options);
}

export async function retryResponseDelivery(adapter: BaseChannelAdapter, address: ChannelAddress, id?: string, options: Pick<Options, 'isCurrent'> = {}): Promise<SendResult> {
  const store = getBridgeContext().store;
  const record = list(store, address).find(record => id ? record.id === id : record.status !== 'delivered');
  if (!record) return { ok: false, error: '没有可补发的回答，或该记录不属于当前聊天/用户' };
  return attempt(adapter, store, snapshot(record), options);
}

export function getResponseDeliveryStatus(address: ChannelAddress): string {
  const store = getBridgeContext().store;
  const pending = list(store, address).filter(record => record.status !== 'delivered');
  if (!pending.length) return '回答投递：没有待补发记录。';
  const latest = pending[0];
  return `回答投递：${pending.length} 条待补发；最近 ${latest.id}（${latest.chunks.filter(chunk => chunk.sent).length}/${latest.chunks.length} 块已发送，尝试 ${latest.attempts} 次）。${latest.lastError ? `错误：${latest.lastError}` : ''}\n/retry ${latest.id}${durable(store) ? '' : '\n宿主仅支持本进程待发，重启可能丢失。'}`;
}
