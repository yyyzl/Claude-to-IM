/**
 * Host Interfaces — abstractions for host-application dependencies.
 *
 * These interfaces decouple the bridge system from any specific host
 * (e.g., CodePilot). A host must provide implementations of these
 * interfaces to use the bridge.
 */

import type { ChannelBinding, ChannelType, CodexModelPreferences, ModelCatalog } from './types.js';

// ── Bridge-local types (replacing @/types imports) ────────────

/** File attachment from an IM channel (images, documents). */
export interface FileAttachment {
  id: string;
  name: string;
  type: string; // MIME type
  size: number;
  data: string; // base64 encoded content
  filePath?: string;
}

/** 当前回合生成的 PNG；仅进入独立事件和待发记录，不保存到普通对话正文。 */
export interface GeneratedImage {
  id: string;
  mimeType: 'image/png';
  data: string;
  byteLength: number;
  sha256: string;
}

/** Server-Sent Event from the LLM stream. */
export interface SSEEvent {
  type: SSEEventType;
  data: string;
}

export type SSEEventType =
  | 'text'
  | 'generated_image'
  | 'tool_use'
  | 'tool_result'
  | 'tool_output'
  | 'tool_timeout'
  | 'status'
  | 'result'
  | 'error'
  | 'permission_request'
  | 'user_input_request'
  | 'progress'
  | 'mode_changed'
  | 'task_update'
  | 'keep_alive'
  | 'done';

/** Content block in an LLM response message. */
export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'code'; language: string; code: string };

/** Token usage statistics from an LLM response. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
}

/** API provider configuration (opaque to the bridge). */
export interface BridgeApiProvider {
  id: string;
  [key: string]: unknown;
}

// ── Session & Message types ──────────────────────────────────

/** Minimal session object returned by the store. */
export interface BridgeSession {
  id: string;
  working_directory: string;
  model: string;
  system_prompt?: string;
  provider_id?: string;
}

/** 当前聊天曾绑定的会话；归属必须来自实际绑定记录，不能从会话名称推断。 */
export interface ChannelSessionHistoryEntry {
  sessionId: string;
  title: string;
  workingDirectory: string;
  updatedAt: string;
}

/** Minimal message object returned by the store. */
export interface BridgeMessage {
  role: string;
  content: string;
}

// ── Host Interface: Settings ─────────────────────────────────

export interface SettingsProvider {
  getSetting(key: string): string | null;
}

// ── Host Interface: Store ────────────────────────────────────

/** Input for creating an audit log entry. */
export interface AuditLogInput {
  channelType: string;
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
}

/** Input for inserting a permission link. */
export interface PermissionLinkInput {
  permissionRequestId: string;
  channelType: string;
  chatId: string;
  messageId: string;
  toolName: string;
  suggestions: string;
}

/** Stored permission link record. */
export interface PermissionLinkRecord {
  permissionRequestId: string;
  chatId: string;
  messageId: string;
  resolved: boolean;
  suggestions: string;
}

/** Input for inserting an outbound reference. */
export interface OutboundRefInput {
  channelType: string;
  chatId: string;
  codepilotSessionId: string;
  platformMessageId: string;
  purpose: string;
}

export type ResponseChunk =
  | { kind?: 'text'; text: string; parseMode: 'HTML' | 'Markdown' | 'plain'; plainFallback?: string; sent: boolean; messageId?: string }
  | { kind: 'image'; image: GeneratedImage; imageKey?: string; sendUuid: string; sent: boolean; messageId?: string };

/** 可重投的最终回答；每块成功后立即持久化进度。 */
export interface ResponseDeliveryRecord {
  id: string;
  sessionId: string;
  address: import('./types.js').ChannelAddress;
  responseText: string;
  replyToMessageId?: string;
  chunks: ResponseChunk[];
  status: 'pending' | 'failed' | 'delivered';
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/** Input for upserting a channel binding. */
export interface UpsertChannelBindingInput {
  channelType: string;
  chatId: string;
  codepilotSessionId: string;
  sdkSessionId?: string;
  workingDirectory: string;
  model: string;
  mode?: string;
  backend?: string;
  codexModelPreferences?: CodexModelPreferences;
}

/**
 * Persistence layer for the bridge system.
 * All database operations are abstracted through this interface.
 */
export interface BridgeStore {
  /** 可选持久待发能力；必须连同 flush 提供，才能保证发送前落盘。 */
  saveResponseDelivery?(record: ResponseDeliveryRecord): void;
  getResponseDelivery?(id: string): ResponseDeliveryRecord | null;
  listResponseDeliveries?(channelType: string, chatId: string): ResponseDeliveryRecord[];
  flush?(): Promise<void>;
  close?(): Promise<void>;
  // ── Settings ──
  getSetting(key: string): string | null;

  // ── Channel bindings ──
  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null;
  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding;
  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void;
  listChannelBindings(channelType?: ChannelType): ChannelBinding[];
  /** 可选历史能力；宿主负责在绑定创建、切换及更新时维护，并返回独立副本。 */
  listChannelSessionHistory?(channelType: string, chatId: string): ChannelSessionHistoryEntry[];

  // ── Sessions ──
  getSession(id: string): BridgeSession | null;
  createSession(
    name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    mode?: string,
  ): BridgeSession;
  updateSessionProviderId(sessionId: string, providerId: string): void;

  // ── Messages ──
  addMessage(sessionId: string, role: string, content: string, usage?: string | null): void;
  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] };

  // ── Session locking ──
  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean;
  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void;
  releaseSessionLock(sessionId: string, lockId: string): void;
  setSessionRuntimeStatus(sessionId: string, status: string): void;

  // ── SDK session ──
  updateSdkSessionId(sessionId: string, sdkSessionId: string): void;
  updateSessionModel(sessionId: string, model: string): void;
  syncSdkTasks(sessionId: string, todos: unknown): void;

  // ── Provider ──
  getProvider(id: string): BridgeApiProvider | undefined;
  getDefaultProviderId(): string | null;

  // ── Audit & dedup ──
  insertAuditLog(entry: AuditLogInput): void;
  checkDedup(key: string): boolean;
  insertDedup(key: string): void;
  cleanupExpiredDedup(): void;
  insertOutboundRef(ref: OutboundRefInput): void;

  // ── Permission links ──
  insertPermissionLink(link: PermissionLinkInput): void;
  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null;
  markPermissionLinkResolved(permissionRequestId: string): boolean;
  /** List unresolved permission links for a given chat. */
  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[];

  // ── Channel offsets (adapter watermarks) ──
  getChannelOffset(key: string): string;
  setChannelOffset(key: string, offset: string): void;
}

// ── Host Interface: LLM Provider ─────────────────────────────

/** Parameters for starting an LLM stream. */
export interface StreamChatParams {
  prompt: string;
  sessionId: string;
  sdkSessionId?: string;
  model?: string;
  reasoningEffort?: string;
  /** 显式聊天偏好快照；Codex 必须用目录复验并覆盖旧 model/effort hint。 */
  codexModelPreferences?: CodexModelPreferences;
  systemPrompt?: string;
  workingDirectory?: string;
  abortController?: AbortController;
  permissionMode?: string;
  provider?: BridgeApiProvider;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  files?: FileAttachment[];
  onRuntimeStatusChange?: (status: string) => void;
}

export interface LLMProvider {
  /** Codex 模型目录；实现须返回完整、已验证的快照。 */
  getModelCatalog?(options?: { refresh?: boolean }): Promise<ModelCatalog>;
  /**
   * Start a streaming chat with the LLM.
   * Returns a ReadableStream of SSE-formatted strings.
   */
  streamChat(params: StreamChatParams): ReadableStream<string>;
}

// ── Host Interface: Permission Gateway ───────────────────────

/** Resolution result for a pending permission. */
export interface PermissionResolution {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedPermissions?: unknown[];
  scope?: 'turn' | 'session';
  updatedInput?: Record<string, unknown>;
  reason?: 'expired' | 'cancelled' | 'delivery_failed';
}

/** 模型向用户询问的信息。问题 ID 由 provider 映射回厂商协议。 */
export interface UserInputQuestion {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  allowOther?: boolean;
  isSecret?: boolean;
}

export interface UserInputRequest {
  requestId: string;
  questions: UserInputQuestion[];
}

export interface UserInputResponse {
  requestId: string;
  answers: Record<string, string[]>;
}

export interface PermissionGateway {
  /** 观察真实请求终态；用于移除原卡按钮，不另行猜测超时时间。 */
  onResolution?(permissionRequestId: string, listener: (resolution: PermissionResolution) => void): () => void;
  /**
   * Resolve a pending permission request.
   * Returns true if the permission was found and resolved.
   */
  resolvePendingPermission(permissionRequestId: string, resolution: PermissionResolution): boolean;
}

// ── Host Interface: Lifecycle Hooks ──────────────────────────

export interface LifecycleHooks {
  /** Called when the bridge system starts (e.g., to suppress competing polling). */
  onBridgeStart?(): void;
  /** Called when the bridge system stops. */
  onBridgeStop?(): void;
}
