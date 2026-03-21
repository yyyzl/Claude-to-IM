/**
 * ModelInvoker — Unified invocation layer for Codex CLI and Claude Agent SDK.
 *
 * Encapsulates child-process management (Codex) and Agent SDK calls (Claude)
 * behind a consistent `Promise<string>` interface with timeout, retry, and
 * AbortSignal support.
 *
 * Claude invocations use `@anthropic-ai/claude-agent-sdk` (local Claude Code
 * process) instead of the HTTP API, eliminating the need for ANTHROPIC_API_KEY.
 *
 * @module workflow/model-invoker
 */

import { spawn } from 'node:child_process';
import { TimeoutError, AbortError, ModelInvocationError } from './types.js';

// ── Public types ──────────────────────────────────────────────────

/** Options controlling a single model invocation. */
export interface ModelInvokerOptions {
  /** Maximum time in milliseconds to wait for a response before timing out. */
  timeoutMs: number;
  /** Maximum number of retry attempts after a timeout (default: 1). */
  maxRetries?: number;
  /** Model identifier override (used by `invokeClaude`; ignored by `invokeCodex`). */
  model?: string;
  /** Signal to abort the invocation early (e.g. workflow cancellation). */
  signal?: AbortSignal;
  /** System prompt for Claude (used as the `system` parameter in messages.create). */
  systemPrompt?: string;
  /** Maximum output tokens for Claude (default: 200_000). */
  maxOutputTokens?: number;
  /** Backend name for Codex CLI (default: 'codex'). Passed as --backend <value>. */
  backend?: string;
}

// ── Constants ─────────────────────────────────────────────────────

/** Command invoked for Codex CLI calls. */
const CODEX_COMMAND = 'codeagent-wrapper';

// ── ModelInvoker ──────────────────────────────────────────────────

export class ModelInvoker {
  constructor(
    private readonly spawnImpl: typeof spawn = spawn,
  ) {}

  // ── Public API ────────────────────────────────────────────────

  /**
   * Invoke Codex CLI (`codeagent-wrapper`) as a child process.
   *
   * Sends the prompt via stdin, collects stdout as the result string.
   * Implements timeout handling with retry, and supports external abort
   * via {@link AbortSignal}.
   *
   * - stderr output is logged as warnings (not thrown) unless exit code != 0.
   * - If all retries are exhausted on timeout, throws {@link TimeoutError}.
   * - If the signal is aborted, the child process is killed and {@link AbortError} is thrown.
   *
   * @param prompt - The prompt text to send to Codex.
   * @param opts   - Invocation options (timeout, retries, signal).
   * @returns The raw stdout output from Codex.
   */
  async invokeCodex(prompt: string, opts: ModelInvokerOptions): Promise<string> {
    const maxRetries = opts.maxRetries ?? 1;

    return this.withRetry('codex', maxRetries, opts.signal, () =>
      this.executeCodexProcess(prompt, opts.timeoutMs, opts.signal, opts.backend),
    );
  }

  /**
   * Invoke Claude via local Agent SDK for decision-making.
   *
   * Uses `@anthropic-ai/claude-agent-sdk` (local Claude Code process) instead
   * of the HTTP API, so no ANTHROPIC_API_KEY is needed. The Agent SDK is
   * lazy-loaded via dynamic import.
   *
   * - All built-in tools are disabled (`tools: []`) — pure text generation.
   * - Session is ephemeral (`persistSession: false`).
   * - Timeout and retry logic mirrors {@link invokeCodex}.
   * - AbortSignal is forwarded to the SDK's `abortController` option.
   *
   * @param prompt - The prompt text to send to Claude.
   * @param opts   - Invocation options (timeout, retries, model, signal).
   * @returns The full completion string from Claude.
   */
  async invokeClaude(prompt: string, opts: ModelInvokerOptions): Promise<string> {
    const maxRetries = opts.maxRetries ?? 1;

    return this.withRetry('claude', maxRetries, opts.signal, () =>
      this.executeClaudeRequest(prompt, opts),
    );
  }

  // ── Private: retry wrapper ────────────────────────────────────

  /**
   * Generic retry loop shared by both Codex and Claude invocations.
   *
   * Error classification:
   * - {@link AbortError} — never retried (immediately re-thrown).
   * - {@link ModelInvocationError} — non-retryable API/config errors
   *   (e.g. auth failures, invalid model, missing executable);
   *   immediately re-thrown without retry.
   * - All other errors (timeouts, transient 5xx, network) — retried
   *   up to `maxRetries` times; throws {@link TimeoutError} when exhausted.
   *
   * Additionally, errors whose message matches known non-retryable patterns
   * (e.g. authentication, API key, ENOENT) are promoted to
   * {@link ModelInvocationError} on the spot, preventing wasteful retries.
   *
   * @param model      - Model identifier for error messages.
   * @param maxRetries - Maximum number of retry attempts.
   * @param signal     - Optional abort signal to check before each attempt.
   * @param fn         - The actual invocation function to call.
   * @returns The result string from the invocation.
   */
  private async withRetry(
    model: 'codex' | 'claude',
    maxRetries: number,
    signal: AbortSignal | undefined,
    fn: () => Promise<string>,
  ): Promise<string> {
    const totalAttempts = maxRetries + 1;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Check abort before each attempt
      if (signal?.aborted) {
        console.warn(`[ModelInvoker] ${model} aborted before attempt ${attempt + 1}/${totalAttempts}`);
        throw new AbortError(model);
      }

      if (attempt > 0) {
        console.warn(
          `[ModelInvoker] ${model} retry ${attempt}/${maxRetries} — ` +
          `starting attempt ${attempt + 1}/${totalAttempts}`,
        );
      }

      try {
        return await fn();
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // AbortError is never retried
        if (err instanceof AbortError) {
          console.warn(`[ModelInvoker] ${model} aborted during attempt ${attempt + 1}/${totalAttempts}`);
          throw err;
        }

        // Non-retryable API/config errors — surface immediately
        if (err instanceof ModelInvocationError) {
          console.error(
            `[ModelInvoker] ${model} NON-RETRYABLE ERROR on attempt ${attempt + 1}/${totalAttempts}: ` +
            `${errMsg} (status=${err.statusCode ?? 'n/a'})`,
          );
          throw err;
        }

        // Heuristic: promote plain errors that match known non-retryable
        // patterns (auth failures, missing executables, etc.) to
        // ModelInvocationError so they are never retried.
        if (isNonRetryableError(errMsg)) {
          console.error(
            `[ModelInvoker] ${model} NON-RETRYABLE (detected by pattern) on attempt ` +
            `${attempt + 1}/${totalAttempts}: ${errMsg}`,
          );
          throw new ModelInvocationError(model, undefined, err,
            `${model} non-retryable error: ${errMsg}`,
          );
        }

        // Last attempt — throw TimeoutError
        if (attempt >= maxRetries) {
          console.error(
            `[ModelInvoker] ${model} FAILED — exhausted all ${totalAttempts} attempts. ` +
            `Last error: ${errMsg}`,
          );
          throw new TimeoutError(model, maxRetries);
        }

        // Otherwise, log and retry (next iteration)
        console.warn(
          `[ModelInvoker] ${model} attempt ${attempt + 1}/${totalAttempts} failed: ${errMsg}. ` +
          `Will retry (${maxRetries - attempt} remaining)…`,
        );
      }
    }

    // Unreachable — the loop always returns or throws. TypeScript needs this.
    throw new TimeoutError(model, maxRetries);
  }

  // ── Private: Codex child process execution ────────────────────

  /**
   * Spawn a single Codex CLI process, pipe the prompt to stdin,
   * and collect stdout. Implements timeout via `setTimeout` and
   * abort via signal listener.
   *
   * @param prompt    - Prompt text to write to stdin.
   * @param timeoutMs - Maximum duration before the process is killed.
   * @param signal    - Optional abort signal for external cancellation.
   * @param backend   - Codex CLI backend name (default: 'codex').
   * @returns Collected stdout as a string.
   */
  private executeCodexProcess(
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
    backend?: string,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // `-` is required for codeagent-wrapper stdin mode; without it the wrapper
      // exits early with "task required" and large prompts can trigger pipe EOFs.
      const args = ['--backend', backend ?? 'codex', '-'];
      const startTime = Date.now();

      console.log(
        `[ModelInvoker] Spawning: ${CODEX_COMMAND} ${args.join(' ')} ` +
        `(timeout=${timeoutMs}ms, promptLen=${prompt.length} chars)`,
      );

      const child = this.spawnImpl(CODEX_COMMAND, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Ensure the child process inherits PATH so codeagent-wrapper is found
        env: process.env,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      // ── Settle helper (ensures we only resolve/reject once) ──

      const settle = (
        action: 'resolve' | 'reject',
        value: string | Error,
      ): void => {
        if (settled) return;
        settled = true;

        clearTimeout(timer);
        cleanupSignal();

        if (action === 'resolve') {
          resolve(value as string);
        } else {
          reject(value as Error);
        }
      };

      // ── Timeout ──

      const timer = setTimeout(() => {
        const elapsed = Date.now() - startTime;
        console.error(
          `[ModelInvoker] Codex TIMEOUT — elapsed=${elapsed}ms, limit=${timeoutMs}ms. ` +
          `Killing child process (SIGTERM). promptLen=${prompt.length} chars`,
        );
        child.kill('SIGTERM');
        settle('reject', new Error(
          `Codex process timed out after ${elapsed}ms (limit=${timeoutMs}ms, promptLen=${prompt.length})`,
        ));
      }, timeoutMs);

      // ── AbortSignal handling ──

      const onAbort = (): void => {
        const elapsed = Date.now() - startTime;
        console.warn(`[ModelInvoker] Codex ABORTED via signal after ${elapsed}ms. Killing child (SIGTERM).`);
        child.kill('SIGTERM');
        settle('reject', new AbortError('codex'));
      };

      if (signal) {
        if (signal.aborted) {
          // Already aborted before spawn — kill immediately
          console.warn('[ModelInvoker] Codex abort signal already raised before spawn. Killing immediately.');
          child.kill('SIGTERM');
          settle('reject', new AbortError('codex'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const cleanupSignal = (): void => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      // ── Collect stdout ──

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });

      // ── Collect stderr (log as warning, don't throw unless exit code != 0) ──

      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      // ── Process error (e.g. command not found) ──

      child.on('error', (err: Error) => {
        const elapsed = Date.now() - startTime;
        console.error(
          `[ModelInvoker] Codex child process ERROR after ${elapsed}ms: ${err.message}` +
          `${(err as NodeJS.ErrnoException).code ? ` (code=${(err as NodeJS.ErrnoException).code})` : ''}`,
        );
        settle('reject', err);
      });

      // If the child exits before consuming stdin, Node emits an error on the
      // writable side. Treat it as a failed invocation instead of crashing.
      child.stdin.on('error', (err: Error) => {
        const elapsed = Date.now() - startTime;
        console.warn(
          `[ModelInvoker] Codex stdin pipe error after ${elapsed}ms: ${err.message}` +
          `${(err as NodeJS.ErrnoException).code ? ` (code=${(err as NodeJS.ErrnoException).code})` : ''}`,
        );
        settle('reject', err);
      });

      // ── Process exit ──

      child.on('close', (code: number | null) => {
        const elapsed = Date.now() - startTime;
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        const stdoutLen = Buffer.concat(stdoutChunks).length;

        if (stderr.length > 0) {
          console.warn(`[ModelInvoker] Codex stderr (elapsed=${elapsed}ms): ${stderr.substring(0, 1000)}`);
        }

        if (code !== 0 && code !== null) {
          const errDetail =
            `Codex process exited with code ${code} after ${elapsed}ms` +
            ` (promptLen=${prompt.length}, stdoutLen=${stdoutLen})` +
            `${stderr ? `\n  stderr: ${stderr.substring(0, 500)}` : ''}`;
          console.error(`[ModelInvoker] ${errDetail}`);
          settle('reject', new Error(errDetail));
          return;
        }

        const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
        console.log(
          `[ModelInvoker] Codex completed OK — elapsed=${elapsed}ms, ` +
          `stdoutLen=${stdout.length} chars`,
        );
        settle('resolve', stdout);
      });

      // ── Write prompt to stdin with backpressure handling ──
      //
      // Node.js pipe buffers are small (4-64 KB on Windows, 64 KB-1 MB on
      // Linux). A large spec + plan prompt can easily exceed this, so we
      // chunk the data and respect the 'drain' event to avoid silent
      // truncation or pipe EOF errors.

      const STDIN_CHUNK_SIZE = 32 * 1024; // 32 KB — safe for all OS pipe buffers
      let writeOffset = 0;

      const drainWrite = (): void => {
        try {
          let ok = true;
          while (writeOffset < prompt.length && ok) {
            const chunk = prompt.slice(writeOffset, writeOffset + STDIN_CHUNK_SIZE);
            writeOffset += chunk.length;

            ok = child.stdin.write(chunk, 'utf-8');

            if (writeOffset >= prompt.length) {
              // All data written — close the stream
              child.stdin.end();
              return;
            }
          }

          if (writeOffset < prompt.length) {
            // Internal buffer full — wait for drain, then resume
            child.stdin.once('drain', drainWrite);
          }
        } catch (err: unknown) {
          const elapsed = Date.now() - startTime;
          const e = err instanceof Error ? err : new Error(String(err));
          console.error(
            `[ModelInvoker] Codex stdin.write() threw after ${elapsed}ms: ${e.message}` +
            ` (promptLen=${prompt.length}, written=${writeOffset})`,
          );
          settle('reject', e);
        }
      };

      drainWrite();
    });
  }

  // ── Private: Claude Agent SDK execution ──────────────────────

  /**
   * Execute a single Claude query via `@anthropic-ai/claude-agent-sdk`.
   *
   * Spawns a local Claude Code process with all tools disabled — the model
   * only produces text output. Timeout is enforced via AbortController.
   *
   * @param prompt - Prompt text to send as a user message.
   * @param opts   - Invocation options (timeout, model, signal).
   * @returns The full completion text from the result message.
   */
  private async executeClaudeRequest(
    prompt: string,
    opts: ModelInvokerOptions,
  ): Promise<string> {
    // Dynamic import — loaded at runtime to keep the dependency lazy.
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const queryFn = sdk.query;

    const startTime = Date.now();
    const model = opts.model ?? 'claude-sonnet-4-20250514';

    // Create an internal AbortController for timeout management.
    // If the caller also provides an external signal, we link them so
    // whichever fires first aborts the query.
    const internalController = new AbortController();
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    // Link external signal → internal abort
    const onExternalAbort = (): void => {
      internalController.abort();
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        throw new AbortError('claude');
      }
      opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    // Enforce timeout
    timeoutTimer = setTimeout(() => {
      console.error(
        `[ModelInvoker] Claude Agent SDK TIMEOUT — elapsed=${Date.now() - startTime}ms, ` +
        `limit=${opts.timeoutMs}ms. Aborting query.`,
      );
      internalController.abort();
    }, opts.timeoutMs);

    console.log(
      `[ModelInvoker] Claude Agent SDK query starting ` +
      `(model=${model}, timeout=${opts.timeoutMs}ms, promptLen=${prompt.length} chars)`,
    );

    // Clean env: prevent "nested session" detection when running inside Claude Code
    const cleanEnv: Record<string, string | undefined> = { ...process.env };
    delete cleanEnv.CLAUDECODE;

    try {
      const q = queryFn({
        prompt,
        options: {
          model,
          systemPrompt: opts.systemPrompt,
          abortController: internalController,
          tools: [],                // Disable all tools — pure text generation
          persistSession: false,    // Ephemeral: no session persistence needed
          maxTurns: 1,              // Single-turn: send prompt, get response
          settingSources: [],       // SDK isolation: don't load filesystem settings
          env: cleanEnv,
        },
      });

      // Consume the async generator and collect the result message.
      // The SDK yields various message types; we only need the final `result`.
      let resultText = '';
      let hasResult = false;

      for await (const msg of q) {
        if (!msg || typeof msg !== 'object') continue;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m = msg as any;

        if (m.type === 'result') {
          hasResult = true;
          if (m.subtype === 'success') {
            resultText = typeof m.result === 'string' ? m.result : '';
            const elapsed = Date.now() - startTime;
            console.log(
              `[ModelInvoker] Claude Agent SDK completed OK — elapsed=${elapsed}ms, ` +
              `resultLen=${resultText.length} chars, ` +
              `cost=$${m.total_cost_usd?.toFixed(4) ?? '?'}`,
            );
          } else {
            // result.subtype === 'error'
            const errors: string[] = Array.isArray(m.errors) ? m.errors : [];
            const errMsg = errors.length > 0
              ? errors.join('\n')
              : 'Claude Agent SDK returned error result';
            throw new ModelInvocationError('claude', undefined, new Error(errMsg), errMsg);
          }
        }
      }

      if (!hasResult) {
        throw new Error('Claude Agent SDK session ended without a result message');
      }

      return resultText;
    } catch (err: unknown) {
      // Distinguish between external abort and timeout
      if (opts.signal?.aborted) {
        throw new AbortError('claude');
      }

      if (internalController.signal.aborted) {
        // Internal abort not from external signal → timeout
        throw new Error(
          `Claude Agent SDK timed out after ${Date.now() - startTime}ms ` +
          `(limit=${opts.timeoutMs}ms, promptLen=${prompt.length})`,
        );
      }

      // Already classified errors — propagate as-is
      if (err instanceof AbortError || err instanceof ModelInvocationError) {
        throw err;
      }

      // Detect non-retryable configuration/auth errors from the SDK process
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isNonRetryableError(errMsg)) {
        throw new ModelInvocationError('claude', undefined, err,
          `Claude Agent SDK non-retryable error: ${errMsg}`,
        );
      }

      // All other errors — retryable (transient SDK/process failures)
      throw err;
    } finally {
      clearTimeout(timeoutTimer);
      if (opts.signal) {
        opts.signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }
}

// ── Private helpers ───────────────────────────────────────────────

/**
 * Heuristic patterns that indicate a non-retryable configuration or
 * authentication error from the Claude Agent SDK / child process.
 *
 * These errors will NOT be resolved by retrying the same request.
 */
const NON_RETRYABLE_PATTERNS = [
  /authenticat/i,
  /api[_\s-]?key/i,
  /auth[_\s-]?token/i,
  /not[_\s-]?found.*executable/i,
  /ENOENT/,
  /permission denied/i,
  /invalid.*model/i,
] as const;

/**
 * Check whether an error message matches known non-retryable patterns.
 *
 * @param message - The error message to inspect.
 * @returns `true` if the error should NOT be retried.
 */
function isNonRetryableError(message: string): boolean {
  return NON_RETRYABLE_PATTERNS.some((re) => re.test(message));
}
