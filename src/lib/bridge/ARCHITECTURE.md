# Claude-to-IM Architecture

## Module Dependency Graph

```
bridge-manager.ts (orchestrator)
├── channel-adapter.ts (abstract base + registry)
│   └── adapters/
│       ├── telegram-adapter.ts (long polling + media groups)
│       ├── discord-adapter.ts (Gateway WebSocket + discord.js)
│       ├── feishu-adapter.ts (WSClient + interactive cards)
│       └── qq-adapter.ts (WebSocket Gateway + REST)
├── channel-router.ts (address → session binding)
├── conversation-engine.ts (LLM stream processing)
├── permission-broker.ts (tool approval forwarding)
├── delivery-layer.ts (reliable outbound delivery)
├── markdown/
│   ├── ir.ts (intermediate representation)
│   ├── render.ts (generic renderer)
│   ├── telegram.ts (Markdown → HTML chunks)
│   ├── discord.ts (native Discord markdown)
│   └── feishu.ts (Feishu cards/posts + workflow card builder)
├── security/
│   ├── validators.ts (input validation + path traversal protection)
│   └── rate-limiter.ts (token bucket per chat)
├── internal/
│   ├── workflow-command.ts (/workflow command handler)
│   ├── codex-passthrough.ts (Codex CLI passthrough)
│   ├── git-llm.ts + git-command.ts (Git operations)
│   ├── session-lock.ts + timeouts.ts (session management)
│   └── bridge-help.ts + usage-command.ts (help + usage stats)
├── types.ts (shared type definitions)
├── host.ts (host interface definitions)
└── context.ts (DI container)
```

## Dependency Injection

All host dependencies are abstracted through interfaces in `host.ts` and accessed via the `BridgeContext` singleton in `context.ts`.

```
┌─────────────┐   implements   ┌──────────────────────┐
│ host.ts     │◄──────────────│ hosts/codepilot.ts   │
│ (interfaces)│                │ (CodePilot adapter)  │
└──────┬──────┘                └──────────────────────┘
       │ injected via
       ▼
┌──────────────┐   used by   ┌──────────────────────────┐
│ context.ts   │────────────►│ All bridge modules       │
│ (DI container)│             │ (via getBridgeContext())  │
└──────────────┘              └──────────────────────────┘
```

**No bridge module imports directly from the host application.** All access goes through `getBridgeContext().store`, `.llm`, `.permissions`, or `.lifecycle`.

## Message Flow

### Inbound (IM → LLM)

1. **Adapter** polls/listens for messages, enqueues `InboundMessage`
2. **Bridge Manager** calls `adapter.consumeOne()`, dispatches to `handleMessage()`
3. Per-session locking via `processWithSessionLock()` — serializes same-session, parallelizes different-session
4. **Channel Router** resolves `ChannelAddress` → `ChannelBinding` (creates session if needed)
5. **Conversation Engine** acquires DB session lock, sends prompt to LLM via `llm.streamChat()`
6. SSE stream is consumed server-side:
   - `text` events → accumulated response + streaming preview
   - `permission_request` events → forwarded immediately via Permission Broker
   - `status`/`result` events → SDK session ID capture
7. Response text saved to DB, returned to Bridge Manager

### Outbound (LLM → IM)

1. **Bridge Manager** receives response text, dispatches to `deliverResponse()`
2. Platform-specific rendering: Telegram (HTML chunks), Discord (native markdown), Feishu (cards)
3. **Delivery Layer** handles chunking, rate limiting, retry, dedup, audit logging
4. **Adapter** sends via platform API

### Permission Flow

1. LLM stream emits `permission_request` event (stream blocks)
2. **Permission Broker** formats interactive message with inline buttons
3. **Delivery Layer** sends to IM, records `PermissionLink` in store
4. User clicks button → adapter emits callback `InboundMessage`
5. **Bridge Manager** routes callback to `broker.handlePermissionCallback()`
6. **Permission Broker** validates origin (chat + message ID match), claims atomically, resolves via `PermissionGateway`
7. Stream unblocks and continues

## Key Design Decisions

### globalThis Singletons
Bridge Manager state lives on `globalThis` to survive Next.js HMR. The DI context also uses `globalThis`.

### Deferred Offset Acknowledgement
Telegram adapter separates `fetchOffset` (API watermark) from `committedOffset` (DB). Offset only advances after `handleMessage()` completes, preventing message loss on crash.

### Streaming Preview Throttling
Preview drafts use configurable interval (700ms Telegram, 1500ms Discord) + minimum delta chars. Trailing-edge timer ensures the latest text is always sent. On permanent API failure, preview degrades gracefully (stops sending, doesn't retry).

### Session Lock Chains
`processWithSessionLock()` uses Promise chaining — not mutual exclusion — so different sessions process concurrently while same-session messages serialize. Lock cleanup happens in `.finally()`.

### Workflow Card Lifecycle (2026-03-24)
Feishu adapter supports workflow progress cards via optional methods:
- `createWorkflowCard()` — creates initial interactive card
- `updateWorkflowCard()` — updates existing card in-place (debounced)
- `finalizeWorkflowCard()` — sets terminal state (completed/failed/paused) with 3-retry + exponential backoff + cardElement fallback

Cards degrade gracefully: if creation fails, `workflow-command.ts` falls back to text-mode push.

### Active Task Tracking by Chat (2026-03-21)
`/stop` and `/status` use `activeTasksByChat` Map (keyed by `channelType:chatId`) instead of session ID. This prevents "No task running" false negatives when sessions switch mid-workflow.

### Path Traversal Protection (2026-03-20)
`resolveSafePath()` in `validators.ts` ensures spec/plan file paths resolve within the working directory. Prevents arbitrary file reads via malicious `/workflow` arguments.
