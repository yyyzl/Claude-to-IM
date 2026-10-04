import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BridgeApiProvider, ChannelSessionHistoryEntry, ResponseDeliveryRecord } from "../../src/lib/bridge/host.js";
import type { ChannelBinding } from "../../src/lib/bridge/types.js";
import { validateGeneratedImage, checkGeneratedImageBudget } from "../../src/lib/bridge/internal/generated-image.js";
export type { ChannelBinding } from "../../src/lib/bridge/types.js";

import { resolveBridgeSetting } from "./settings.ts";

export type ChannelType = string;

export type BridgeMode = "code" | "plan" | "ask";

export interface BridgeSession {
  id: string;
  working_directory: string;
  model: string;
  system_prompt?: string;
  provider_id?: string;
  // 额外字段（不影响 bridge 类型约束）
  name?: string;
  sdk_session_id?: string;
}

export interface BridgeMessage {
  role: string;
  content: string;
}

export interface AuditLogInput {
  channelType: string;
  chatId: string;
  direction: "inbound" | "outbound";
  messageId: string;
  summary: string;
}

export interface PermissionLinkInput {
  permissionRequestId: string;
  channelType: string;
  chatId: string;
  messageId: string;
  toolName: string;
  suggestions: string;
}

export interface PermissionLinkRecord {
  permissionRequestId: string;
  chatId: string;
  messageId: string;
  resolved: boolean;
  suggestions: string;
}

export interface OutboundRefInput {
  channelType: string;
  chatId: string;
  codepilotSessionId: string;
  platformMessageId: string;
  purpose: string;
}

export interface UpsertChannelBindingInput {
  channelType: string;
  chatId: string;
  codepilotSessionId: string;
  workingDirectory: string;
  model: string;
  backend?: string;
}

type PersistedData = {
  sessions: Record<string, BridgeSession>;
  bindings: Record<string, ChannelBinding>;
  messages: Record<string, BridgeMessage[]>;
  channelOffsets: Record<string, string>;
  responseDeliveries?: Record<string, ResponseDeliveryRecord>;
  channelSessionHistory?: Record<string, ChannelSessionHistoryEntry[]>;
};

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

type SessionLock = {
  lockId: string;
  owner: string;
  expiresAt: number;
};

/**
 * 一个最小可用的 BridgeStore 实现：
 * - 单进程：内存锁、内存 dedup
 * - 轻量持久化：sessions/bindings/messages/channelOffsets → JSON 文件
 */
export class JsonFileBridgeStore {
  private projectRoot: string;
  private dataPath: string;

  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>(); // key: `${channelType}:${chatId}`
  private channelSessionHistory = new Map<string, Map<string, ChannelSessionHistoryEntry>>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>(); // key: permissionRequestId
  private channelOffsets = new Map<string, string>();
  private dedup = new Map<string, number>(); // key -> expiresAt(ms)
  private sessionLocks = new Map<string, SessionLock>(); // sessionId -> lock

  private saveTimer: NodeJS.Timeout | null = null;
  private responseDeliveries = new Map<string, ResponseDeliveryRecord>();
  private dirty = false;
  private closed = false;
  private closing = false;
  private saving: Promise<void> | null = null;
  private lastGoodRaw: string | null = null;
  private corruptRaw: string | null = null;

  constructor(opts: { projectRoot: string; dataPath: string }) {
    this.projectRoot = opts.projectRoot;
    this.dataPath = opts.dataPath;
    this.load();
  }

  // ── Settings ───────────────────────────────────────────────

  getSetting(key: string): string | null {
    return resolveBridgeSetting(key, this.projectRoot);
  }

  // ── Channel bindings ───────────────────────────────────────

  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding {
    this.assertWritable();
    const key = `${data.channelType}:${data.chatId}`;
    const prev = this.bindings.get(key);
    const now = new Date().toISOString();

    const binding: ChannelBinding = prev
      ? {
          ...prev,
          codepilotSessionId: data.codepilotSessionId,
          workingDirectory: data.workingDirectory,
          model: data.model,
          ...(data.backend != null ? { backend: data.backend } : {}),
          updatedAt: now,
        }
      : {
          id: crypto.randomUUID(),
          channelType: data.channelType,
          chatId: data.chatId,
          codepilotSessionId: data.codepilotSessionId,
          sdkSessionId: "",
          workingDirectory: data.workingDirectory,
          model: data.model,
          backend: data.backend,
          mode: "code",
          active: true,
          createdAt: now,
          updatedAt: now,
        };

    if (prev) this.rememberChannelSession(prev);
    this.rememberChannelSession(binding);
    this.bindings.set(key, binding);
    this.scheduleSave();
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    this.assertWritable();
    for (const [key, b] of this.bindings) {
      if (b.id !== id) continue;
      const binding = { ...b, ...updates, updatedAt: new Date().toISOString() };
      this.rememberChannelSession(b);
      this.rememberChannelSession(binding);
      this.bindings.set(key, binding);
      this.scheduleSave();
      return;
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    return channelType ? all.filter((b) => b.channelType === channelType) : all;
  }

  private rememberChannelSession(binding: ChannelBinding): void {
    const session = this.sessions.get(binding.codepilotSessionId);
    if (!session) return;
    const key = `${binding.channelType}:${binding.chatId}`;
    let history = this.channelSessionHistory.get(key);
    if (!history) { history = new Map(); this.channelSessionHistory.set(key, history); }
    history.set(session.id, {
      sessionId: session.id,
      title: session.name || '未命名会话',
      workingDirectory: binding.workingDirectory || session.working_directory,
      updatedAt: binding.updatedAt || binding.createdAt || '',
    });
  }

  listChannelSessionHistory(channelType: string, chatId: string): ChannelSessionHistoryEntry[] {
    return [...(this.channelSessionHistory.get(`${channelType}:${chatId}`)?.values() ?? [])]
      .filter(row => this.sessions.has(row.sessionId))
      .map(row => ({ ...row }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ── Sessions ───────────────────────────────────────────────

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  createSession(
    name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    _mode?: string,
  ): BridgeSession {
    this.assertWritable();
    const id = crypto.randomUUID();
    const session: BridgeSession = {
      id,
      name,
      working_directory: cwd || "",
      model,
      ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
    };
    this.sessions.set(id, session);
    this.scheduleSave();
    return session;
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    this.assertWritable();
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.provider_id = providerId;
    this.sessions.set(sessionId, session);
    this.scheduleSave();
  }

  // ── Messages ───────────────────────────────────────────────

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
    this.assertWritable();
    const list = this.messages.get(sessionId) || [];
    list.push({ role, content });
    this.messages.set(sessionId, list);
    this.scheduleSave();
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const list = this.messages.get(sessionId) || [];
    const limit = opts?.limit ?? list.length;
    return { messages: list.slice(Math.max(0, list.length - limit)) };
  }

  // ── Session locking ────────────────────────────────────────

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const now = Date.now();
    const existing = this.sessionLocks.get(sessionId);
    if (existing && existing.expiresAt > now) {
      return false;
    }
    this.sessionLocks.set(sessionId, { lockId, owner, expiresAt: now + ttlSecs * 1000 });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const existing = this.sessionLocks.get(sessionId);
    if (!existing) return;
    if (existing.lockId !== lockId) return;
    existing.expiresAt = Date.now() + ttlSecs * 1000;
    this.sessionLocks.set(sessionId, existing);
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const existing = this.sessionLocks.get(sessionId);
    if (!existing) return;
    if (existing.lockId !== lockId) return;
    this.sessionLocks.delete(sessionId);
  }

  setSessionRuntimeStatus(_sessionId: string, _status: string): void {
    // runner 不做 UI 展示，best-effort noop
  }

  // ── SDK session ────────────────────────────────────────────

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    this.assertWritable();
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.sdk_session_id = sdkSessionId;
    this.sessions.set(sessionId, session);
    this.scheduleSave();
  }

  updateSessionModel(sessionId: string, model: string): void {
    this.assertWritable();
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.model = model;
    this.sessions.set(sessionId, session);
    this.scheduleSave();
  }

  syncSdkTasks(_sessionId: string, _todos: unknown): void {
    // runner 暂不持久化 TODO
  }

  // ── Provider ───────────────────────────────────────────────

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  // ── Audit & dedup ──────────────────────────────────────────

  insertAuditLog(_entry: AuditLogInput): void {
    // 可在此处接入你自己的日志系统；runner 默认不持久化审计
  }

  checkDedup(key: string): boolean {
    const expiresAt = this.dedup.get(key);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.dedup.delete(key);
      return false;
    }
    return true;
  }

  insertDedup(key: string): void {
    this.dedup.set(key, Date.now() + DEDUP_TTL_MS);
  }

  cleanupExpiredDedup(): void {
    const now = Date.now();
    for (const [k, expiresAt] of this.dedup) {
      if (expiresAt <= now) this.dedup.delete(k);
    }
  }

  insertOutboundRef(_ref: OutboundRefInput): void {
    // noop
  }

  // ── Permission links ───────────────────────────────────────

  insertPermissionLink(link: PermissionLinkInput): void {
    this.permissionLinks.set(link.permissionRequestId, {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      suggestions: link.suggestions,
    });
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link) return false;
    if (link.resolved) return false;
    link.resolved = true;
    this.permissionLinks.set(permissionRequestId, link);
    return true;
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    return Array.from(this.permissionLinks.values()).filter((l) => l.chatId === chatId && !l.resolved);
  }

  // ── Channel offsets ─────────────────────────────────────────

  getChannelOffset(key: string): string {
    return this.channelOffsets.get(key) ?? "0";
  }

  setChannelOffset(key: string, offset: string): void {
    this.assertWritable();
    this.channelOffsets.set(key, offset);
    this.scheduleSave();
  }

  // ── Persistence ────────────────────────────────────────────

  saveResponseDelivery(record: ResponseDeliveryRecord): void {
    this.assertWritable();
    this.responseDeliveries.set(record.id, structuredClone(record));
    const completed = [...this.responseDeliveries.values()].filter(value => value.status === 'delivered')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const expired of completed.slice(100)) this.responseDeliveries.delete(expired.id);
    this.scheduleSave();
  }

  getResponseDelivery(id: string): ResponseDeliveryRecord | null {
    const record = this.responseDeliveries.get(id);
    return record ? structuredClone(record) : null;
  }

  listResponseDeliveries(channelType: string, chatId: string): ResponseDeliveryRecord[] {
    return [...this.responseDeliveries.values()]
      .filter(record => record.address.channelType === channelType && record.address.chatId === chatId)
      .map(record => structuredClone(record));
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.dataPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('[BridgeStore] 无法读取存储，拒绝空载启动', { cause: error });
    }
    let parsed: PersistedData;
    try {
      parsed = parsePersistedData(raw);
    } catch (error) {
      try {
        const backup = fs.readFileSync(this.dataPath + '.bak', 'utf8');
        parsed = parsePersistedData(backup);
        this.corruptRaw = raw;
        raw = backup;
        console.warn('[BridgeStore] 主存储损坏，已加载有效备份；下次保存前保留损坏原件。');
      } catch {
        throw new Error('[BridgeStore] 主存储损坏且没有有效备份，拒绝覆盖原文件', { cause: error });
      }
    }
    this.sessions = new Map(Object.entries(parsed.sessions));
    this.bindings = new Map(Object.entries(parsed.bindings));
    this.messages = new Map(Object.entries(parsed.messages));
    this.channelOffsets = new Map(Object.entries(parsed.channelOffsets));
    this.responseDeliveries = new Map(Object.entries(parsed.responseDeliveries ?? {}));
    this.channelSessionHistory = new Map(Object.entries(parsed.channelSessionHistory ?? {})
      .map(([key, rows]) => [key, new Map(rows.map(row => [row.sessionId, row]))]));
    // 旧文件仅有当前绑定可证明聊天归属；不导入其余孤立会话。
    for (const binding of this.bindings.values()) this.rememberChannelSession(binding);
    this.lastGoodRaw = raw;
  }

  private assertWritable(): void {
    if (this.closed || this.closing) throw new Error('[BridgeStore] 存储正在关闭或已关闭');
  }

  private scheduleSave(): void {
    this.assertWritable();
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush().catch(error => {
        console.error('[BridgeStore] 持久化失败，内存变更尚未保存：', error instanceof Error ? error.message : 'unknown error');
      });
    }, 200);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    while (this.saving || this.dirty) {
      if (this.saving) { await this.saving; continue; }
      const saving = this.save();
      this.saving = saving;
      try { await saving; }
      finally { if (this.saving === saving) this.saving = null; }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.flush();
    this.closed = true;
  }

  private async save(): Promise<void> {
    this.dirty = false;
    const raw = JSON.stringify({
      sessions: Object.fromEntries(this.sessions),
      bindings: Object.fromEntries(this.bindings),
      messages: Object.fromEntries(this.messages),
      channelOffsets: Object.fromEntries(this.channelOffsets),
      responseDeliveries: Object.fromEntries(this.responseDeliveries),
      channelSessionHistory: Object.fromEntries([...this.channelSessionHistory].map(([key, rows]) => [key, [...rows.values()]])),
    } satisfies PersistedData, null, 2);
    try {
      await fs.promises.mkdir(path.dirname(this.dataPath), { recursive: true });
      if (this.corruptRaw !== null) {
        await fs.promises.writeFile(this.dataPath + '.corrupt-' + crypto.randomUUID(), this.corruptRaw, { flag: 'wx', mode: 0o600 });
        this.corruptRaw = null;
      }
      if (this.lastGoodRaw !== null) await atomicWrite(this.dataPath + '.bak', this.lastGoodRaw);
      await atomicWrite(this.dataPath, raw);
      this.lastGoodRaw = raw;
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const temporary = target + '.tmp-' + crypto.randomUUID();
  const handle = await fs.promises.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  // 失败时保留旧文件及临时快照，不静默删除任何恢复材料。
  await fs.promises.rename(temporary, target);
}

function validateResponseChunks(chunks: unknown): void {
  if (!Array.isArray(chunks)) throw new Error('Invalid response chunks');
  const imageIds = new Set<string>();
  let imageBytes = 0;
  for (const value of chunks) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response chunk');
    const chunk = value as Record<string, unknown>;
    if (typeof chunk.sent !== 'boolean' || (chunk.messageId !== undefined && typeof chunk.messageId !== 'string')) throw new Error('Invalid chunk progress');
    if (chunk.kind === 'image') {
      if (typeof chunk.sendUuid !== 'string' || !chunk.sendUuid.trim() || chunk.sendUuid.length > 128
        || (chunk.imageKey !== undefined && (typeof chunk.imageKey !== 'string' || !chunk.imageKey.trim() || chunk.imageKey.length > 2048))
        || (chunk.sent && chunk.imageKey === undefined)) throw new Error('Invalid image delivery identifiers');
      const image = validateGeneratedImage(chunk.image);
      if (imageIds.has(image.id)) throw new Error('Duplicate generated image');
      imageIds.add(image.id);
      imageBytes += image.byteLength;
      checkGeneratedImageBudget(imageIds.size, imageBytes);
      chunk.image = image;
    } else {
      if ((chunk.kind !== undefined && chunk.kind !== 'text') || typeof chunk.text !== 'string'
        || typeof chunk.parseMode !== 'string' || !['HTML', 'Markdown', 'plain'].includes(chunk.parseMode)
        || (chunk.plainFallback !== undefined && typeof chunk.plainFallback !== 'string')) throw new Error('Invalid text delivery');
    }
  }
}

function parsePersistedData(raw: string): PersistedData {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // SyntaxError 可能包含原始 JSON 片段，图片与凭据不能进入错误 cause。
    throw new Error('Invalid store JSON syntax');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid store');
  const record = data as Record<string, unknown>;
  for (const key of ['sessions', 'bindings', 'messages', 'channelOffsets']) {
    if (!record[key] || typeof record[key] !== 'object' || Array.isArray(record[key])) throw new Error('Invalid store field: ' + key);
  }
  for (const messages of Object.values(record.messages as Record<string, unknown>)) {
    if (!Array.isArray(messages) || messages.some(m => !m || typeof m.role !== 'string' || typeof m.content !== 'string')) throw new Error('Invalid stored messages');
  }
  for (const [id, value] of Object.entries(record.sessions as Record<string, Record<string, unknown>>)) {
    if (!value || value.id !== id || typeof value.model !== 'string' || typeof value.working_directory !== 'string') throw new Error('Invalid stored session');
  }
  for (const [key, value] of Object.entries(record.bindings as Record<string, Record<string, unknown>>)) {
    if (!value || typeof value.id !== 'string' || key !== `${value.channelType}:${value.chatId}` || typeof value.codepilotSessionId !== 'string') throw new Error('Invalid stored binding');
  }
  if (Object.values(record.channelOffsets as Record<string, unknown>).some(v => typeof v !== 'string')) throw new Error('Invalid offsets');
  if (record.channelSessionHistory !== undefined && (!record.channelSessionHistory || typeof record.channelSessionHistory !== 'object' || Array.isArray(record.channelSessionHistory))) throw new Error('Invalid channel session history');
  for (const rows of Object.values((record.channelSessionHistory ?? {}) as Record<string, ChannelSessionHistoryEntry[]>)) {
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.sessionId !== 'string'
      || typeof row.title !== 'string' || typeof row.workingDirectory !== 'string' || typeof row.updatedAt !== 'string')
      || new Set(rows.map(row => row.sessionId)).size !== rows.length) throw new Error('Invalid channel session history');
  }
  if (record.responseDeliveries !== undefined && (!record.responseDeliveries || typeof record.responseDeliveries !== 'object' || Array.isArray(record.responseDeliveries))) throw new Error('Invalid response deliveries');
  for (const [id, value] of Object.entries((record.responseDeliveries ?? {}) as Record<string, ResponseDeliveryRecord>)) {
    if (!value || value.id !== id || typeof value.sessionId !== 'string' || typeof value.responseText !== 'string'
      || !value.address || typeof value.address.channelType !== 'string' || typeof value.address.chatId !== 'string'
      || !['pending', 'failed', 'delivered'].includes(value.status) || !Number.isSafeInteger(value.attempts) || value.attempts < 0
      || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') throw new Error('Invalid response delivery');
    validateResponseChunks(value.chunks);
  }
  return record as PersistedData;
}
