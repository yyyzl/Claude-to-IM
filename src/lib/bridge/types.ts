/**
 * Bridge system types — shared across all bridge modules.
 *
 * The bridge connects external IM channels (Telegram, Discord, Slack)
 * to CodePilot chat sessions, allowing users to interact with Claude
 * from their preferred messaging platform.
 */

// Re-export bridge-local types from host.ts so consumers can import from one place
export type { FileAttachment } from './host.js';

// ── Channel Types ──────────────────────────────────────────────

/**
 * Channel type identifier.
 * Extensible — any string is valid so new adapters can register without
 * modifying this definition. Well-known values: 'telegram', 'discord', 'slack'.
 */
export type ChannelType = string;

/** Unique address of a user within a channel */
export interface ChannelAddress {
  channelType: ChannelType;
  chatId: string;        // Platform-specific chat/channel identifier
  userId?: string;       // Platform-specific user identifier (optional for group chats)
  displayName?: string;  // Human-readable name for audit logs
}

/** Composite key for routing: channelType + chatId */
export interface SessionKey {
  channelType: ChannelType;
  chatId: string;
}

// ── Messages ───────────────────────────────────────────────────

/** Inbound message from an IM channel */
export interface InboundMessage {
  /** Platform-specific message ID (for dedup and reference) */
  messageId: string;
  /** Address of the sender */
  address: ChannelAddress;
  /** Plain text content of the message */
  text: string;
  /** Timestamp of the message (ISO string or unix epoch ms) */
  timestamp: number;
  /** If this is a callback query (inline button press), the callback data */
  callbackData?: string;
  /** For callback queries: the message ID of the original message that triggered the callback */
  callbackMessageId?: string;
  /** 问答卡片提交；callbackMessageId 必须指向原始卡片。 */
  userInputResponse?: import('./host.js').UserInputResponse;
  /** 独立于模型问答的配置卡提交，来源仍使用 address/callbackMessageId。 */
  modelSelectionResponse?: ModelSelectionResponse;
  /** Platform-specific raw update object (for adapter-specific handling) */
  raw?: unknown;
  /** Adapter-specific update ID for deferred offset acknowledgement */
  updateId?: number;
  /** File attachments (images, documents) from the IM channel */
  attachments?: import('./host.js').FileAttachment[];
}

/** Outbound message to send to an IM channel */
export interface OutboundMessage {
  /** Target address */
  address: ChannelAddress;
  /** Message text (may contain HTML for Telegram) */
  text: string;
  /** Parse mode for the text */
  parseMode?: 'HTML' | 'Markdown' | 'plain';
  /** Inline keyboard buttons */
  inlineButtons?: InlineButton[][];
  /** If replying to a specific message */
  replyToMessageId?: string;
}

/** Inline keyboard button for permission prompts */
export interface InlineButton {
  text: string;
  callbackData: string;
}

/** Result of sending a message via an adapter */
export interface SendResult {
  ok: boolean;
  /** Platform-specific message ID of the sent message */
  messageId?: string;
  error?: string;
  /** 平台返回的 HTTP 状态，用于区分重试与明确失败。 */
  httpStatus?: number;
  /** 平台要求的重试等待秒数。 */
  retryAfter?: number;
}

// ── Bindings ───────────────────────────────────────────────────

/** 当前聊天的显式 Codex 偏好；default/null 均保持跟随语义。 */
export interface CodexModelPreferences {
  model: string;
  reasoningEffort: string | null;
  speed: 'normal' | 'fast';
}

export interface ModelCatalogEntry {
  id: string;
  /** Codex 协议实际型号；目录 ID 与型号可能不同。 */
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier: string | null;
}

export interface ModelCatalog {
  models: ModelCatalogEntry[];
}

export interface ModelSelectionResponse {
  requestId: string;
  revision: number;
  action: 'next' | 'back' | 'refresh' | 'previous_page' | 'next_page' | 'apply' | 'cancel';
  model?: string;
  reasoningEffort?: string;
  speed?: string;
}

/** 呈现所需的完整视图；原生平台仅负责渲染，不推断配置或归属。 */
export interface ModelSelectionView {
  requestId: string;
  revision: number;
  step: 'model' | 'settings' | 'applied' | 'cancelled' | 'expired';
  summary: string;
  notice?: string;
  models: ModelCatalogEntry[];
  page: number;
  pageCount: number;
  selectedModel: string;
  selectedModelEntry?: ModelCatalogEntry;
  /** 空字符串是表单中的“跟随模型默认”。 */
  reasoningEffort: string;
  speed: 'normal' | 'fast';
}

/** Links an IM chat to a CodePilot session */
export interface ChannelBinding {
  id: string;
  channelType: ChannelType;
  chatId: string;
  /** CodePilot session ID this chat is bound to */
  codepilotSessionId: string;
  /** SDK session ID for resume (cached from last conversation) */
  sdkSessionId: string;
  /** Working directory for this binding */
  workingDirectory: string;
  /** Model override for this binding */
  model: string;
  /** 后端目录验证后的思考强度；切换模型时重新验证。 */
  reasoningEffort?: string;
  codexModelPreferences?: CodexModelPreferences;
  /** 仅用于状态展示，不作为后续请求偏好。 */
  lastModelRuntime?: { model: string; reasoningEffort?: string; serviceTier?: string };
  /** Chat mode */
  mode: 'code' | 'plan' | 'ask';
  /** LLM backend used when this binding was last created/updated (e.g. 'claude' | 'codex') */
  backend?: string;
  /** Whether this binding is currently active */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Bridge Status ──────────────────────────────────────────────

/** Overall bridge system status */
export interface BridgeStatus {
  running: boolean;
  startedAt: string | null;
  adapters: AdapterStatus[];
}

/** Status of a single channel adapter */
export interface AdapterStatus {
  channelType: ChannelType;
  running: boolean;
  connectedAt: string | null;
  lastMessageAt: string | null;
  error: string | null;
}

// ── Audit & Dedup ──────────────────────────────────────────────

/** Audit log entry */
export interface AuditLogEntry {
  id: string;
  channelType: ChannelType;
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
  createdAt: string;
}

/** Permission link: maps permissionRequestId to an IM message for callback handling */
export interface PermissionLink {
  id: string;
  permissionRequestId: string;
  channelType: ChannelType;
  chatId: string;
  messageId: string;
  createdAt: string;
}

// ── Streaming Preview ─────────────────────────────────────────

/** Capabilities of a channel adapter's streaming preview support */
export interface PreviewCapabilities {
  supported: boolean;
  privateOnly: boolean;
}

/** Mutable state for an in-flight streaming preview */
export interface StreamingPreviewState {
  draftId: number;           // non-zero 31-bit random integer, reused within one answer cycle
  chatId: string;
  lastSentText: string;      // last text actually sent as draft
  lastSentAt: number;        // timestamp (ms) of last sent draft
  degraded: boolean;         // set true after API failure → skip further previews
  throttleTimer: ReturnType<typeof setTimeout> | null;
  pendingText: string;       // latest accumulated text (may not yet be sent due to throttle)
}

// ── Tool Call Info ─────────────────────────────────────────────

/** Tool call tracking for streaming card progress display */
export interface ToolCallInfo {
  id: string;
  name: string;
  status: 'running' | 'complete' | 'error';
}

// ── Config ─────────────────────────────────────────────────────

/** Platform-specific message length limits */
export const PLATFORM_LIMITS: Record<string, number> = {
  telegram: 4096,
  discord: 2000,
  slack: 40000,
  feishu: 30000,
  qq: 2000,
};
