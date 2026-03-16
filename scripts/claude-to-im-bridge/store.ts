import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveBridgeSetting } from "./settings.ts";

export type ChannelType = string;

export type BridgeMode = "code" | "plan" | "ask";

export interface ChannelBinding {
  id: string;
  channelType: ChannelType;
  chatId: string;
  codepilotSessionId: string;
  sdkSessionId: string;
  workingDirectory: string;
  model: string;
  mode: BridgeMode;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

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
}

type PersistedData = {
  sessions: Record<string, BridgeSession>;
  bindings: Record<string, ChannelBinding>;
  messages: Record<string, BridgeMessage[]>;
  channelOffsets: Record<string, string>;
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
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>(); // key: permissionRequestId
  private channelOffsets = new Map<string, string>();
  private dedup = new Map<string, number>(); // key -> expiresAt(ms)
  private sessionLocks = new Map<string, SessionLock>(); // sessionId -> lock

  private saveTimer: NodeJS.Timeout | null = null;

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
    const key = `${data.channelType}:${data.chatId}`;
    const prev = this.bindings.get(key);
    const now = new Date().toISOString();

    const binding: ChannelBinding = prev
      ? {
          ...prev,
          codepilotSessionId: data.codepilotSessionId,
          workingDirectory: data.workingDirectory,
          model: data.model,
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
          mode: "code",
          active: true,
          createdAt: now,
          updatedAt: now,
        };

    this.bindings.set(key, binding);
    this.scheduleSave();
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, b] of this.bindings) {
      if (b.id !== id) continue;
      this.bindings.set(key, { ...b, ...updates, updatedAt: new Date().toISOString() });
      this.scheduleSave();
      return;
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    return channelType ? all.filter((b) => b.channelType === channelType) : all;
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
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.provider_id = providerId;
    this.sessions.set(sessionId, session);
    this.scheduleSave();
  }

  // ── Messages ───────────────────────────────────────────────

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
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
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.sdk_session_id = sdkSessionId;
    this.sessions.set(sessionId, session);
    this.scheduleSave();
  }

  updateSessionModel(sessionId: string, model: string): void {
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

  getProvider(_id: string): unknown {
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
    this.channelOffsets.set(key, offset);
    this.scheduleSave();
  }

  // ── Persistence ────────────────────────────────────────────

  private load(): void {
    try {
      if (!fs.existsSync(this.dataPath)) return;
      const raw = fs.readFileSync(this.dataPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedData>;

      if (parsed.sessions) {
        for (const s of Object.values(parsed.sessions)) {
          if (s?.id) this.sessions.set(s.id, s);
        }
      }
      if (parsed.bindings) {
        for (const b of Object.values(parsed.bindings)) {
          if (b?.channelType && b?.chatId) this.bindings.set(`${b.channelType}:${b.chatId}`, b);
        }
      }
      if (parsed.messages) {
        for (const [sid, msgs] of Object.entries(parsed.messages)) {
          this.messages.set(sid, Array.isArray(msgs) ? msgs : []);
        }
      }
      if (parsed.channelOffsets) {
        for (const [k, v] of Object.entries(parsed.channelOffsets)) {
          this.channelOffsets.set(k, String(v));
        }
      }
    } catch {
      // 读取失败则忽略（避免阻塞 runner）
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 200);
  }

  private save(): void {
    try {
      const dir = path.dirname(this.dataPath);
      fs.mkdirSync(dir, { recursive: true });

      const data: PersistedData = {
        sessions: Object.fromEntries(this.sessions.entries()),
        bindings: Object.fromEntries(this.bindings.entries()),
        messages: Object.fromEntries(this.messages.entries()),
        channelOffsets: Object.fromEntries(this.channelOffsets.entries()),
      };

      fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2), "utf8");
    } catch {
      // best effort
    }
  }
}

