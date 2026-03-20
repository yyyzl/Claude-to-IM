# Plan: Workflow Engine Implementation

> Implements the Workflow Engine spec (P0 + P1a scope)
>
> Estimated: P0 = 1-2 days, P1a = 6-8 days, Total P0+P1a ≈ 8-10 days
> (P1b/P2/P3 not estimated — scope TBD)

---

## Phase P0: Protocol Definition (1-2 days)

### Step 1: Create directory structure

```bash
mkdir -p .claude-workflows/templates
mkdir -p .claude-workflows/schemas
mkdir -p .claude-workflows/runs
```

### Step 1.5: Update .gitignore

Add to project `.gitignore`:
- `.claude-workflows/runs/` — runtime data, not tracked
- Keep `.claude-workflows/templates/` and `.claude-workflows/schemas/` tracked in git

### Step 2: Write prompt templates

Create `.claude-workflows/templates/spec-review-pack.md`:
- Codex blind review prompt with `{{spec}}`, `{{plan}}`, `{{unresolved_issues}}`, `{{rejected_issues}}`, `{{round_summary}}`, `{{round}}`, `{{context_files}}` placeholders
- Strict JSON output format with explicit `severity` enum: `critical|high|medium|low`
- Role instructions: independent reviewer, avoid re-raising rejected issues without new evidence

Create `.claude-workflows/templates/claude-decision.md`:
- Claude decision prompt with `{{round}}`, `{{codex_findings_with_ids}}`, `{{ledger_summary}}`, `{{current_spec}}`, `{{current_plan}}`, `{{previous_decisions}}` placeholders
- Accept/reject/defer/accept_and_resolve decision format (references issue IDs assigned by IssueMatcher)
- JSON output includes `spec_patch`/`plan_patch` fields + **mandatory** `resolves_issues` mapping for content delivery
- Empty-findings guidance: when no new findings, instruct Claude to address remaining open issues
- Fallback: `--- SPEC UPDATE ---` / `--- PLAN UPDATE ---` markers for non-JSON output

Create `.claude-workflows/templates/round-summary.md`:
- Template for generating round-over-round summary text

### Step 3: Write JSON schemas

Create `.claude-workflows/schemas/issue-ledger.schema.json`:
- Validate IssueLedger structure including `repeat_count` field
- Enum constraints on severity, status (including `resolved`), raised_by

Create `.claude-workflows/schemas/meta.schema.json`:
- Validate WorkflowMeta structure
- Enum constraints on workflow_type, status, current_step (5 values: `codex_review`, `issue_matching`, `pre_termination`, `claude_decision`, `post_decision`)
- Include `claude_timeout_ms`, `codex_max_retries`, `claude_max_retries`, `codex_context_window_tokens` fields

Create `.claude-workflows/schemas/event.schema.json`:
- Validate WorkflowEvent structure
- Enum constraints on event_type (including timeout/retry events AND `codex_parse_error`, `claude_parse_error`, `patch_apply_failed`, `resolves_issues_missing`, `issue_matching_completed`)

### P0 Deliverable

- 3 template files + 3 schema files + .gitignore update
- Validate by manually reviewing that all SpecReviewPack fields have corresponding template placeholders
- Verify: 7 placeholders in spec-review-pack template match 7 SpecReviewPack fields (including `rejected_issues`)
- Verify: claude-decision template has 6 placeholders including `{{previous_decisions}}` and empty-findings guidance
- Verify: event schema includes `codex_parse_error`, `claude_parse_error`, `patch_apply_failed`, `resolves_issues_missing`, `issue_matching_completed`
- Verify: meta schema `current_step` enum has 5 values

---

## Phase P1a: Spec-Review MVP (5-7 days)

### Step 1: Types (Day 1, ~2h)

Create `src/lib/workflow/types.ts`:
- All interfaces from spec section 4:
  - `SpecReviewPack` (with `rejected_issues: RejectedIssueSummary[]` and `context_files: ContextFile[]`)
  - `RejectedIssueSummary` (id, description, round_rejected — no decision_reason)
  - `ContextFile` (path + content, not just path)
  - `IssueLedger`, `Issue`, `CodexReviewOutput`, `Finding`
  - `ClaudeDecisionOutput` (with `spec_patch`/`plan_patch` + `resolves_issues?: string[]`)
  - `Decision` (issue_id references IDs from IssueMatcher, action: `accept | reject | defer | accept_and_resolve`)
  - `WorkflowStep` type (5 values: `codex_review | issue_matching | pre_termination | claude_decision | post_decision`)
  - `WorkflowMeta` (using `WorkflowStep` for `current_step` and `last_completed.step`)
  - `WorkflowConfig` (including `codex_context_window_tokens`, `context_files: ContextFile[]`)
  - `WorkflowEvent`, `WorkflowEventType` (including `codex_parse_error`, `claude_parse_error`, `patch_apply_failed`, `resolves_issues_missing`, `issue_matching_completed`)
  - `ClaudeDecisionInput` (structured data for PromptAssembler, includes `hasNewFindings` flag and `previousDecisions`)
- Export DEFAULT_CONFIG and SPEC_REVIEW_OVERRIDES constants (including `max_deferred_issues`)
- RoundData type for ContextCompressor input
- TerminationResult type with `action: 'terminate' | 'pause_for_human'` field

### Step 2: WorkflowStore (Day 1, ~3h)

Create `src/lib/workflow/workflow-store.ts`:
- Constructor takes basePath (default `.claude-workflows/`)
- Implement all CRUD methods from spec section 6.7
- File I/O: use Node.js fs/promises
- Spec/Plan versioning: spec-v1.md, spec-v2.md, spec-v3.md pattern (consistent v-prefix)
- Events: ndjson append (one JSON per line)
- Error handling: throw on write failure and missing templates; return `null` on read missing (spec/plan/ledger/artifacts/meta)

Unit tests:
- Create/read/update run meta
- Save/load spec versions
- Append/read events
- Load template files

### Step 3: JsonParser (Day 2, ~2h)

Create `src/lib/workflow/json-parser.ts`:
- `parse<T>(raw: string): T | null` — 4-strategy best-effort extraction:
  1. Direct `JSON.parse()` on trimmed output
  2. Strip markdown code fences (triple-backtick json blocks) and retry
  3. Regex extraction of first `{ ... }` or `[ ... ]` block
  4. Return null on failure
- `extractPatches(raw, parsed)` — dual-strategy patch extraction:
  1. Read `spec_patch`/`plan_patch` from parsed JSON object
  2. Fallback: scan for `--- SPEC UPDATE ---` / `--- PLAN UPDATE ---` markers
  3. Return null if neither found

Unit tests (critical — this is a non-trivial utility):
- Clean JSON input
- JSON wrapped in markdown code fences
- JSON embedded in prose text
- Malformed JSON (returns null)
- extractPatches from JSON fields
- extractPatches from markers in raw text
- extractPatches when neither exists

### Step 4: IssueMatcher (Day 2, ~2h)

Create `src/lib/workflow/issue-matcher.ts`:
- `match(finding, existingIssues): Issue | null`
- Strategy 1: normalized description equality (lowercase, trim, collapse whitespace)
  - Note: `Finding.issue` maps to `Issue.description` (field name difference)
- Strategy 2: same evidence reference + similar severity (similar = within 1 level: critical↔high, high↔medium, medium↔low)
- Strategy 3: no match -> return null (caller creates new Issue)
- Special handling for deferred issues: if matched and status=deferred, return match but caller does NOT increment repeat_count
- `processFindings(findings, ledger, round)`: batch method (extends spec §6.9) that processes all findings, returns `{ newIssues, matchedIssues, newHighCriticalCount, newTotalCount }`
  - **Idempotency**: if re-run for the same round, detects existing issues by round and skips them (safe for crash resume)

Unit tests:
- Exact description match (different casing/whitespace)
- Evidence-based match (same evidence, similar severity)
- No match (genuinely new issue)
- Deferred issue re-raised (matched but no repeat_count increment)
- Rejected issue re-raised (matched and repeat_count incremented)
- Edge: empty existing issues list
- Idempotency: re-running processFindings with same data produces same result
- newHighCriticalCount: correctly counts only critical/high new issues

### Step 5: PromptAssembler (Day 2, ~1.5h)

Create `src/lib/workflow/prompt-assembler.ts`:
- Constructor takes WorkflowStore (for loading templates)
- Load template from WorkflowStore
- Simple string replacement: `{{var}}` -> value
- For arrays (unresolved_issues, rejected_issues): render as markdown lists
- For context_files: render as `### filename\n\`\`\`\ncontent\n\`\`\``
- For codex_findings_with_ids: render as numbered list with issue IDs
- For ledger_summary: render as markdown table (ID | Description | Status | Severity)
- For previous_decisions: render as round-by-round summary
- **Two Claude prompt variants**:
  - Normal: `hasNewFindings=true` → standard decision prompt with findings
  - Empty findings: `hasNewFindings=false` → alternate prompt asking Claude to address remaining open issues

Unit tests:
- Render spec-review prompt with full pack (all 7 placeholders including rejected_issues)
- Render claude-decision prompt (with codex_findings_with_ids + ledger_summary + previous_decisions)
- Render claude-decision prompt with empty findings (hasNewFindings=false)
- Handle empty optional fields gracefully
- Handle first round (no rejected_issues, no round_summary, no previous_decisions)

### Step 6: PackBuilder (Day 3, ~2.5h)

Create `src/lib/workflow/pack-builder.ts`:
- Constructor takes WorkflowStore + ContextCompressor
- `buildSpecReviewPack(runId, round, config)`: read latest spec, plan, ledger from store; filter unresolved issues (open/deferred only, deferred subject to `max_deferred_issues`); build rejected_issues list (description only, no decision_reason); use pre-inlined context_files from config; generate round_summary from ledger stats; **internally** call ContextCompressor when payload exceeds threshold
- `buildClaudeDecisionInput(runId, round, matchedFindings)`: return `ClaudeDecisionInput` structured data (NOT rendered prompt text) — includes codex findings with issue IDs, ledger summary, current spec/plan, previous decisions summary, and `hasNewFindings` flag
- `buildLedgerSummary(ledger)`: render IssueLedger as markdown table (ID | Description | Status | Severity | Round)
- `buildPreviousDecisionsSummary(runId, upToRound)`: load prior round artifacts, build a summary of Claude's decisions for context continuity

Unit tests:
- Build pack for round 1 (empty ledger, no rejected_issues)
- Build pack for round 2+ (with prior issues, rejected issues present)
- Verify unresolved_issues excludes accepted/rejected/resolved
- Verify rejected_issues includes rejected items WITHOUT decision_reason
- Verify deferred issues limited by max_deferred_issues (oldest dropped)
- Verify context_files have inlined content (not just paths)
- Generate correct round_summary text
- Build claude decision input with issue IDs and hasNewFindings flag
- Build previous decisions summary from round artifacts

### Step 7: ModelInvoker (Day 3-4, ~3.5h)

Create `src/lib/workflow/model-invoker.ts`:
- `invokeCodex(prompt, opts)`: spawn `codeagent-wrapper` as child process with prompt via stdin/tempfile, capture stdout, enforce timeout with retry
  - `opts.signal?: AbortSignal` — kills child process on abort (graceful pause support)
  - Handle stderr: log warnings but don't fail unless exit code ≠ 0
- `invokeClaude(prompt, opts)`: call Claude API via `@anthropic-ai/sdk` (independent **stateless** abstraction, NOT reusing bridge LLMProvider), handle streaming to completion, enforce timeout with retry
  - `opts.signal?: AbortSignal` — cancels HTTP request on abort (graceful pause support)
  - Each call is independent; context continuity is the engine's responsibility (assembled into prompt)
- Both methods return raw string output
- Timeout handling: AbortController + setTimeout, retry up to `maxRetries` times, throw TimeoutError if all retries exhausted (WorkflowEngine catches and executes skip-round via TIMEOUT GUARD)
- Abort handling: throw AbortError (distinct from TimeoutError), WorkflowEngine catches and saves checkpoint

Unit tests (with mocks):
- Mock child_process for Codex
- Mock Claude API (@anthropic-ai/sdk)
- Timeout + retry behavior (1 retry then success)
- Timeout + all retries exhausted (throw TimeoutError)
- AbortSignal triggered (throw AbortError, verify child process killed)
- Codex stderr handling (warning logged, not thrown)

### Step 8: TerminationJudge (Day 4, ~2.5h)

Create `src/lib/workflow/termination-judge.ts`:
- Implement `judge()` with priority-ordered checks from spec section 7.2:
  1. LGTM check (overall_assessment) — LGTM with no open/accepted issues -> terminate; LGTM with open/accepted issues -> returns null (engine proceeds to Claude)
  2. Deadlock detection (repeat_count >= 2 on rejected issues) -> `action: 'pause_for_human'`
  3. No new high/critical for 2 consecutive rounds — **judge computes from ledger** (filter `round === currentRound` + `severity in ['critical','high']`), NOT from a pre-computed count -> `action: 'terminate'`
  4. Only low-severity remaining -> `action: 'terminate'`
  5. Max rounds reached -> `action: 'terminate'`
- Input `ctx` includes `previousRoundHadNewHighCritical: boolean` and `isSkippedRound?: boolean`
- Skipped rounds (`isSkippedRound=true`) reset the "2 consecutive" counter
- Return TerminationResult with `reason`, `action`, and `details`, or null to continue

Unit tests (critical -- cover ALL branches):
- LGTM + no open/accepted issues -> terminate
- LGTM with open issues -> null (engine proceeds to Claude)
- LGTM with accepted (unresolved) issues -> null (engine proceeds to Claude)
- Deadlock detected (repeat_count >= 2, action=pause_for_human)
- No new high/critical issues for 2 consecutive rounds (computed from ledger) -> terminate
- 1 round with no new high/critical only -> null (not yet 2 consecutive)
- Skipped round resets consecutive counter -> null
- Only low issues remain (action=terminate)
- Max rounds reached (action=terminate)
- Continue when ledger has new high-severity issue in current round
- Edge case: first round (`previousRoundHadNewHighCritical=true` by convention)

### Step 9: ContextCompressor (Day 4, ~1h)

Create `src/lib/workflow/context-compressor.ts`:
- `compress()`: check trigger conditions (round >= 4 or estimated tokens > 60% of `windowTokens` param)
- `windowTokens` comes from `config.codex_context_window_tokens` (passed by PackBuilder)
- If triggered: keep latest spec/plan, ledger summary (open+accepted only), latest round, drop middle rounds
- Rough token estimation: chars / 4
- **Called INTERNALLY by PackBuilder during buildSpecReviewPack()** (NOT by WorkflowEngine directly, NOT during Claude decision step)
- Claude context is managed separately — PromptAssembler always includes full context in each stateless Claude prompt

Unit tests:
- No compression needed (round < 4, tokens < threshold)
- Compression triggered at round 4
- Compression triggered by token threshold (small window size)
- Verify dropped rounds list

### Step 10: PatchApplier (Day 4-5, ~2h)

Create `src/lib/workflow/patch-applier.ts`:
- `apply(currentDoc, patch)`: section-level replacement matched by ANY heading level (# through ####)
  - Parse both docs into sections by heading regex `/^(#{1,4})\s+/m`
  - Match patch sections to current doc by exact heading (same level + same text, case-sensitive, trimmed)
  - When replacing, content extends to next heading of SAME or HIGHER level
  - Replace matched sections; append unmatched sections at end
  - Return `{ merged, appliedSections, failedSections }`
- Heading rename NOT supported in P1a (YAGNI)
- On heading mismatch: include in `failedSections` (engine logs `patch_apply_failed` event)

Unit tests:
- Single section replacement at `##` level (exact heading match)
- Single section replacement at `###` level (subsection)
- Multiple sections in one patch (mixed heading levels)
- Heading not found (appended + recorded as failed)
- Empty patch (no-op, return original)
- Patch with new section not in original (appended)
- Verify: replacing `### X` does NOT affect sibling `### Y`
- Verify: heading level mismatch (`## Foo` vs `### Foo`) → failedSections

### Step 11: WorkflowEngine (Day 5-6, ~7h)

Create `src/lib/workflow/workflow-engine.ts`:
- Constructor: inject all 9 dependencies (store, packBuilder, promptAssembler, modelInvoker, terminationJudge, contextCompressor, jsonParser, issueMatcher, **patchApplier**)
  - Note: contextCompressor is injected into PackBuilder (not directly used by engine)
- Internal: `abortController: AbortController | null` for graceful pause
- `start()`: create run, save initial artifacts (spec-v1.md, plan-v1.md), enter round loop
- Round loop (5-step state machine with checkpoints):
  - **Step A** (`codex_review`): buildSpecReviewPack(config) -> renderSpecReviewPrompt -> invokeCodex({signal}) -> jsonParser
    - Save raw output FIRST, then updateMeta(current_step='issue_matching')
    - On timeout skip -> TIMEOUT GUARD (check max_rounds, set isSkippedRound=true)
    - On abort -> save checkpoint, break
    - On parse failure -> log `codex_parse_error` event, save raw, use best-effort partial
  - **Step B1** (`issue_matching`): issueMatcher.processFindings (assign/match issue IDs, record counts)
    - Save ledger, append `issue_matching_completed` event, updateMeta(current_step='pre_termination')
    - **Idempotent on re-run** (crash-safe)
  - **Step B2** (`pre_termination`): terminationJudge.judge({previousRoundHadNewHighCritical}) — pre-check
    - LGTM guard: proceed to Claude if open/accepted issues remain
  - **Step C** (`claude_decision`): buildClaudeDecisionInput -> renderClaudeDecisionPrompt -> invokeClaude({signal}) -> jsonParser -> extractPatches -> patchApplier.apply()
    - Handle `accept_and_resolve` action: directly transition to resolved (no patch needed)
    - Handle missing `resolves_issues`: emit `resolves_issues_missing`, do NOT auto-resolve
    - Save raw output FIRST, then ledger, then spec/plan, then updateMeta(current_step='post_decision')
    - On timeout skip -> TIMEOUT GUARD
    - On abort -> save checkpoint, break
  - **Step D** (`post_decision`): terminationJudge.judge({...}) — post-check
  - round++
- Write ordering for crash safety: raw output → ledger → spec/plan → checkpoint event → meta (last)
- Event emission: emit events through registered callbacks
- `resume()`: read meta `current_step`, check partially-saved artifacts per step, determine precise re-entry point (see spec §7.3)
- `pause()`: abort in-flight LLM calls via abortController.abort(), wait for safe checkpoint, update meta

Integration tests:
- Full 2-round loop with mock ModelInvoker (Codex returns issues round 1, Claude accepts some, Codex says LGTM round 2)
- LGTM with open issues (does NOT skip Claude)
- LGTM with no findings but open issues (Claude receives alternate prompt)
- Resume from checkpoint after Step A crash (reuses saved Codex output, current_step='issue_matching')
- Resume from checkpoint after B1 crash (idempotent processFindings, current_step='issue_matching')
- Resume from checkpoint after Step C crash (reuses saved Claude output, current_step='claude_decision')
- Deadlock detection (same issue rejected twice -> pause_for_human)
- Timeout skip + TIMEOUT GUARD (Codex times out -> round++ -> isSkippedRound resets consecutive counter)
- Issue lifecycle: accepted -> resolved via explicit resolves_issues mapping
- Issue lifecycle: accept_and_resolve -> resolved (no patch)
- Missing resolves_issues: accepted issues stay accepted, warning emitted
- Deferred issue re-raised: stays deferred, no repeat_count increment
- Graceful pause: abort during Codex call -> checkpoint saved -> resume works
- Parse error: codex_parse_error event logged, raw output preserved
- current_step transitions through all 5 states correctly

### Step 12: CLI Entry Point (Day 7, ~1.5h)

Create `src/lib/workflow/cli.ts`:
- Parse command-line arguments: `--spec <path>` `--plan <path>` `[--config <path>]` `[--context <file,...>]` `[--resume <run-id>]`
- Read spec and plan files from disk
- Read and inline context files into `ContextFile[]` (path + content; engine receives content, not paths)
- Call `createSpecReviewEngine()` factory, register event listeners, then `engine.start()` or `engine.resume()`
- Print progress events to stdout
- Handle SIGINT for graceful pause: call `engine.pause()` which triggers AbortController
- Add as npm script in package.json (e.g., `"workflow:review": "node dist/lib/workflow/cli.js"`)

Unit tests:
- Argument parsing (including --resume)
- File reading + context file inlining
- Integration with factory function

### Step 13: Index + Wiring + Package Config (Day 7, ~1h)

Create `src/lib/workflow/index.ts`:
- Export all public types and classes (including PatchApplier, ClaudeDecisionInput, WorkflowStep)
- Factory function: `createSpecReviewEngine(basePath?)` that wires all 9 dependencies together
  - ContextCompressor injected into PackBuilder (not directly into engine)

Update `package.json`:
- Add `@anthropic-ai/sdk` to dependencies
- Update test script pattern to include `workflow-*.test.ts` (not just `bridge-*.test.ts`)
- Add `exports` entry (correct format matching existing pattern):
  ```json
  "./src/lib/workflow/*.js": {
    "types": "./dist/lib/workflow/*.d.ts",
    "import": "./dist/lib/workflow/*.js"
  }
  ```
- Add npm script: `"workflow:review": "node dist/lib/workflow/cli.js"`

### Step 14: End-to-End Test (Day 8, ~3h)

- Full integration test with mock Codex and Claude responses
- Verify: all files created in .claude-workflows/runs/{id}/ (spec-v1.md naming)
- Verify: events.ndjson has correct event sequence (including timeout/retry/parse_error/resolves_issues_missing/issue_matching_completed events)
- Verify: issue-ledger.json tracks all decisions with full lifecycle (including resolves_issues mapping + accept_and_resolve)
- Verify: termination triggers correctly (all 6 priority conditions + TIMEOUT GUARD + isSkippedRound)
- Verify: spec_patch/plan_patch content delivery via PatchApplier works (multi-level headings)
- Verify: rejected_issues appear in Codex prompt (without decision_reason)
- Verify: Claude receives issue IDs in findings + previous_decisions for context continuity
- Verify: Claude receives alternate prompt when no new findings but open issues exist
- Verify: graceful pause + resume preserves state (using 5-state current_step)
- Verify: write ordering (raw -> ledger -> spec/plan -> checkpoint event -> meta)
- Verify: resume after B1 crash is idempotent (no duplicate issues)

---

## Implementation Order Summary

| Day | Step | Module | Tests | Hours |
|-----|------|--------|-------|-------|
| 0 | P0 | templates + schemas + .gitignore | Manual review | ~2h |
| 1 | 1-2 | types.ts + workflow-store.ts | Unit | ~5h |
| 2 | 3-5 | json-parser.ts + issue-matcher.ts + prompt-assembler.ts | Unit | ~6.5h |
| 3 | 6-7 | pack-builder.ts + model-invoker.ts (start) | Unit | ~6h |
| 4 | 7-9 | model-invoker.ts (finish) + termination-judge.ts + context-compressor.ts | Unit (critical) | ~7h |
| 5 | 10 | patch-applier.ts (multi-level heading) | Unit | ~2h |
| 5-6 | 11 | workflow-engine.ts (5-state machine, idempotent resume) | Integration | ~7h |
| 7 | 12-13 | cli.ts + index.ts + package.json updates | Unit | ~2.5h |
| 8 | 14 | E2E test + bug fixes | E2E | ~3h |

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
| Crash during step (partial writes) | Write ordering: raw → ledger → spec/plan → checkpoint event → meta; 5-state current_step + artifact checks ensure precise resume; IssueMatcher.processFindings is idempotent |
| Codex persistent timeout (infinite loop) | TIMEOUT GUARD checks max_rounds after each skip; also AbortSignal for SIGINT |
| @anthropic-ai/sdk not installed | Explicit dependency in package.json; fail-fast on import if missing |
| Test scripts don't cover workflow tests | Updated test pattern to include `workflow-*.test.ts` |

---

## Future Extension Points

- **P1b**: Add workflow type registry. PackBuilder and PromptAssembler get type-specific methods. WorkflowEngine loop becomes configurable step chain.
- **P2**: WorkflowEngine.on() already provides event hooks. Bridge registers listeners for IM push. /workflow command delegates to engine.
- **P3**: WorkflowStore interface can be backed by SO API instead of filesystem. Event format already ndjson-compatible.
