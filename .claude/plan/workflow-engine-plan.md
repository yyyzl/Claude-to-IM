# Workflow Engine: Design Decisions & Reference

> P0 + P1a + P2a 已全部实现（14 个引擎模块 + 1 个 IM 集成模块，~6200 行 TypeScript）。
> P2a 新增 `workflow-command.ts`（738 行）：`/workflow` 命令 + 事件推送。
> 本文档已精简为设计决策参考，完整实施步骤已归档。
> 完整 Spec 见 `workflow-engine-spec.md`，质量档案见 `.claude-workflows/reports/workflow-engine-deep-audit.md`。

---

## Key Design Decisions

1. **Simple string templates over Handlebars**: Template engine adds dependency complexity. `{{var}}` replacement covers our needs for P1a.

2. **ModelInvoker as stateless independent abstraction**: Does NOT reuse bridge's `LLMProvider` (which returns `ReadableStream<string>` for SSE). ModelInvoker returns `Promise<string>` (full completion). Both Claude and Codex calls are stateless — context continuity is achieved by assembling full context into each prompt. Easy to mock for testing, easy to swap implementations later.

3. **ndjson for events**: Append-only, one JSON per line. No need to parse full file to append. Compatible with future SO integration (events.ndjson format already aligned).

4. **JsonParser as dedicated module**: LLMs sometimes return JSON with markdown code fences, embedded in prose, or partially malformed. A 4-strategy parser with dual-mode patch extraction (JSON fields + marker fallback) handles this robustly.

5. **IssueMatcher runs before TerminationJudge**: Findings must be matched to existing issues BEFORE termination checks. This ensures (a) TerminationJudge can compute high/critical counts from the ledger, (b) Claude receives findings with assigned issue IDs, and (c) "2 consecutive rounds no new high" uses real dedup data, not raw finding count. processFindings() is idempotent for crash-safe resume.

6. **WorkflowStore on filesystem (not DB)**: Keeps the module self-contained. No external dependencies. Easy to inspect artifacts manually. Aligns with .claude-workflows convention.

7. **TerminationResult.action field**: Separates "why" (reason) from "what to do" (action). Engine uses `action` to decide terminate vs pause. This cleanly handles the deadlock -> human_review mapping.

8. **LGTM with open-issue guard**: Codex saying LGTM does not auto-terminate if there are unresolved open issues in the ledger from previous rounds. The engine proceeds to Claude to address remaining issues.

9. **Unified timeout strategy + TIMEOUT GUARD**: Both Codex and Claude use the same pattern: ModelInvoker retries N times -> if all exhausted, throws TimeoutError -> WorkflowEngine catches and executes skip-round. TIMEOUT GUARD checks `round > max_rounds` directly after skip, preventing infinite skip loops.

10. **Content delivery via spec_patch/plan_patch + PatchApplier**: Claude outputs modified sections in JSON fields. PatchApplier performs section-level replacement by heading match at **any level** (# through ####). `resolves_issues` is **mandatory** for explicit patch-to-issue mapping; if absent, accepted issues remain unresolved (safety measure). Marker-based fallback ensures robustness when JSON parsing partially fails.

11. **Graceful pause via AbortController**: `pause()` triggers `abortController.abort()`. ModelInvoker propagates AbortSignal to child process (Codex) or HTTP request (Claude). Engine catches AbortError, saves checkpoint, and breaks loop. This replaces the previous design where pause only updated meta status.

12. **Write ordering for crash safety**: Within each step, artifacts are persisted in order: raw LLM output → ledger → spec/plan → checkpoint event → meta (last). Meta's `current_step` serves as a commit marker with 5 fine-grained states. On resume, the engine checks `current_step` + artifact existence to determine the precise re-entry point.

13. **accept_and_resolve action**: Some issues are valid but need no spec/plan change. `accept_and_resolve` transitions directly to `resolved`, preventing accepted issues from getting stuck when no patch is needed.

14. **resolves_issues safety**: Missing `resolves_issues` does NOT auto-resolve accepted issues (unlike original design). This prevents accidental resolution when Claude omits the field. A `resolves_issues_missing` warning event is emitted instead.

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| codeagent-wrapper CLI interface changes | Isolate in ModelInvoker; single point to update |
| LLM output format deviates from template | JsonParser 4-strategy extraction + marker fallback; save raw output regardless |
| Large spec/plan exceeds Codex context | ContextCompressor reduces payload (called in PackBuilder); Pack only sends unresolved issues |
| Concurrent workflow runs | Use run_id-based directory isolation; no shared state |
| Windows path issues | Use path.join() consistently; normalize separators |
| spec_patch/plan_patch extraction fails | Dual strategy: JSON field -> marker scan -> save raw + mark error; never lose data |
| Issue re-identification across rounds | IssueMatcher with normalized + evidence matching; log unmatched as new issues |
| Crash during step (partial writes) | Atomic write protocol (write-tmp → fsync → rename) for critical files; write ordering: raw → ledger → spec/plan → checkpoint event → meta; 5-state current_step + sub-checkpoint events for Step C + artifact checks ensure precise resume; IssueMatcher uses `last_processed_round` for idempotency |
| Claude returns invalid decisions | DecisionValidator catches unknown/duplicate issue_ids, missing coverage, invalid resolves_issues targets → transitions to human_review instead of corrupting state |
| Patch applied but heading not found | Patch-resolve consistency rule: failedSections prevent affected issues from being marked resolved; all failures trigger human_review if ALL sections fail |
| Codex persistent timeout (infinite loop) | TIMEOUT GUARD checks max_rounds after each skip; also AbortSignal for SIGINT |
| @anthropic-ai/sdk not installed | Explicit dependency in package.json; fail-fast on import if missing |
| Test scripts don't cover workflow tests | Updated test pattern to include `workflow-*.test.ts` |

---

## Completed Extension Points

- **P2a** ✅: `/workflow` command integrated into `bridge-manager.ts`. `workflow-command.ts` (738 lines) handles 5 subcommands (help/start/stop/status/resume). `bindProgressEvents()` subscribes to 14 engine event types and pushes formatted text to IM. Per-chat concurrency guard, path traversal protection, background async execution.

## Future Extension Points

- **P1b**: Add workflow type registry. PackBuilder and PromptAssembler get type-specific methods. WorkflowEngine loop becomes configurable step chain.
- **P2b**: Upgrade `bindProgressEvents()` output from text to Feishu interactive cards with inline buttons. Add milestone aggregation to reduce push noise. Code comment marks the exact extension point.
- **P3**: WorkflowStore interface can be backed by SO API instead of filesystem. Event format already ndjson-compatible.
