# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added
- `src/lib/workflow/ARCHITECTURE.md` — workflow engine architecture documentation
- Workflow Engine integration section in `docs/development.zh-CN.md`
- This CHANGELOG file

### Changed
- Updated `docs/workflow-conclusions-summary.md` — corrected P2B Feishu integration status from "not started" to "mostly complete"
- Updated `src/lib/bridge/ARCHITECTURE.md` — added QQ adapter, internal/ modules, workflow card lifecycle, path traversal protection

### Chores
- Archived 3 Trellis tasks: workflow-spec-fill, bridge-spec-enhance, guides-enhance

---

## [0.1.0] - 2026-03-24

### Workflow Engine: Code-Review MVP + Review-Fix

- **Code-Review workflow** (review-only): Codex blind-reviews git diff, Claude arbitrates findings, generates Markdown/JSON report
- **Review-Fix workflow**: Code-Review + AutoFixer for automated fix-and-re-review loop
- **CLI subcommands**: `npm run workflow:code-review`, `npm run workflow:review-fix`
- **IM commands**: `/workflow code-review`, `/workflow review-fix`, `/workflow report`
- **Feishu interactive cards**: progress updates in-place, Stop/Resume/Report buttons, completion/failure/pause terminal states
- **finalizeCard retry + fallback**: 3-retry with exponential backoff + cardElement degradation
- **20+ bug fixes**: ISS-001~005, template engine bugs, engine bugs, workflow card title dynamic display

### Workflow Engine: Spec-Review (Stable)

- **Delphi-method review loop**: Codex blind-review → Issue matching → Claude decision → patch application
- **5-step crash-safe state machine** with sub-checkpoints (C1-C4)
- **Profile-driven strategy**: `SPEC_REVIEW_PROFILE` / `CODE_REVIEW_PROFILE` — no conditionals
- **Issue Ledger**: single source of truth with idempotent matching, repeat detection
- **Dynamic termination**: 5-condition priority (LGTM, deadlock, no new high/critical, all-low, max rounds)
- **Context compression**: CJK-aware token estimation (0.67/CJK vs 0.25/ASCII)
- **Agent SDK migration**: Claude invocation via local Agent SDK (no API key needed)
- **Backpressure stdin writes**: 32KB chunked writes for large prompts
- **Atomic file writes**: write-tmp → fsync → rename pattern
- **367 unit tests** passing

### Bridge System (Stable)

- **4 platform adapters**: Telegram (long polling), Discord (Gateway WebSocket), Feishu (WSClient), QQ (WebSocket Gateway)
- **Streaming preview**: platform-specific throttling (700ms Telegram, 1500ms Discord, 2000ms Feishu)
- **Permission management**: inline approve/deny buttons with atomic claim
- **Reliable delivery**: chunking, retry, dedup, audit logging
- **Markdown rendering**: IR-based cross-platform (Telegram HTML, Discord native, Feishu cards)
- **Security**: input validation, path traversal protection, rate limiting (20/min/chat)
- **Session management**: per-chat active task tracking, session lock chains
- **Codex passthrough**: direct Codex CLI access from IM

### Documentation & Specs

- **Workflow conclusions summary**: 1326-line comprehensive document covering all design decisions
- **Coding standards**: 614-line project-wide coding standards
- **Development guide**: 30K+ characters, Chinese + English
- **Trellis spec system**: 8 backend specs (2457 lines) + 3 guides (1317 lines)
- **GitNexus code intelligence**: 1328 symbols, 3786 relationships, 113 execution flows

---

## [0.0.1] - 2026-03-05

### Added
- Initial extraction of Claude-to-IM bridge as standalone project
- Telegram, Discord, Feishu adapters (MVP)
- QQ adapter (C2C private chat)
- MIT license, README (English + Chinese), development guide
