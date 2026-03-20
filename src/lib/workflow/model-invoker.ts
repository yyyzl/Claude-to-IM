/**
 * ModelInvoker — Unified invocation layer for Codex CLI and Claude API.
 *
 * Encapsulates child-process management (Codex) and HTTP API calls (Claude)
 * behind a consistent `Promise<string>` interface with timeout, retry, and
 * AbortSignal support.
 *
 * @module workflow/model-invoker
 */

import { spawn } from 'node:child_process';
import { TimeoutError, AbortError } from './types.js';

// Type declarations for @anthropic-ai/sdk are provided by vendor-types.d.ts
// in this directory. The package is loaded via dynamic import() at runtime
// to avoid a hard dependency when it is not installed.

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
}

// ── Constants ─────────────────────────────────────────────────────

/** Default Claude model used when `opts.model` is not specified. */
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-20250514';

/** Command invoked for Codex CLI calls. */
const CODEX_COMMAND = 'codeagent-wrapper';

/** Arguments passed to the Codex CLI command. */
const CODEX_ARGS = ['--backend', 'codex'];

// ── ModelInvoker ──────────────────────────────────────────────────

export class ModelInvoker {
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
      this.executeCodexProcess(prompt, opts.timeoutMs, opts.signal),
    );
  }

  /**
   * Invoke Claude API for decision-making.
   *
   * Uses `@anthropic-ai/sdk` via dynamic import (lazy-loaded to avoid hard
   * dependency when the package is not yet installed). Sends a single user
   * message and returns the full completion text.
   *
   * - Timeout and retry logic mirrors {@link invokeCodex}.
   * - AbortSignal is forwarded to the SDK's `signal` option.
   * - If the SDK does not support `signal`, a `Promise.race` with a timeout
   *   promise is used as a fallback.
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
   * - AbortError is never retried (immediately re-thrown).
   * - All other errors are retried up to `maxRetries` times.
   * - If retries are exhausted, throws {@link TimeoutError}.
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
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Check abort before each attempt
      if (signal?.aborted) {
        throw new AbortError(model);
      }

      try {
        return await fn();
      } catch (err: unknown) {
        // AbortError is never retried
        if (err instanceof AbortError) {
          throw err;
        }

        // Last attempt — throw TimeoutError
        if (attempt >= maxRetries) {
          throw new TimeoutError(model, maxRetries);
        }

        // Otherwise, retry (next iteration)
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
   * @returns Collected stdout as a string.
   */
  private executeCodexProcess(
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(CODEX_COMMAND, CODEX_ARGS, {
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
        child.kill('SIGTERM');
        settle('reject', new Error(`Codex process timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // ── AbortSignal handling ──

      const onAbort = (): void => {
        child.kill('SIGTERM');
        settle('reject', new AbortError('codex'));
      };

      if (signal) {
        if (signal.aborted) {
          // Already aborted before spawn — kill immediately
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
        settle('reject', err);
      });

      // ── Process exit ──

      child.on('close', (code: number | null) => {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();

        if (stderr.length > 0) {
          console.warn(`[ModelInvoker] Codex stderr: ${stderr}`);
        }

        if (code !== 0 && code !== null) {
          settle(
            'reject',
            new Error(
              `Codex process exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
            ),
          );
          return;
        }

        const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
        settle('resolve', stdout);
      });

      // ── Write prompt to stdin and close ──

      child.stdin.write(prompt, 'utf-8');
      child.stdin.end();
    });
  }

  // ── Private: Claude API execution ─────────────────────────────

  /**
   * Execute a single Claude API request via `@anthropic-ai/sdk`.
   *
   * The SDK is loaded dynamically to avoid hard dependency failures
   * when it is not installed. Timeout is enforced via `Promise.race`
   * with AbortController (forwarded to the SDK when supported).
   *
   * @param prompt - Prompt text to send as a user message.
   * @param opts   - Invocation options (timeout, model, signal).
   * @returns The full completion text extracted from the response.
   */
  private async executeClaudeRequest(
    prompt: string,
    opts: ModelInvokerOptions,
  ): Promise<string> {
    // Dynamic import — the package may not be installed at dev time.
    // Ambient types are provided by vendor-types.d.ts in this directory.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');

    const client = new Anthropic();
    const model = opts.model ?? DEFAULT_CLAUDE_MODEL;

    // Create an internal AbortController for timeout management.
    // If the caller also provides an external signal, we listen on
    // both and abort whichever fires first.
    const internalController = new AbortController();
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    // Link external signal to internal controller
    const onExternalAbort = (): void => {
      internalController.abort();
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        throw new AbortError('claude');
      }
      opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    // Set up timeout
    timeoutTimer = setTimeout(() => {
      internalController.abort();
    }, opts.timeoutMs);

    try {
      const response = await client.messages.create(
        {
          model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal: internalController.signal },
      );

      // Extract text from the response content blocks
      return extractTextFromResponse(response);
    } catch (err: unknown) {
      // Distinguish between external abort and timeout
      if (opts.signal?.aborted) {
        throw new AbortError('claude');
      }

      // Internal controller aborted means timeout (or external abort handled above)
      if (internalController.signal.aborted) {
        // If external signal is not aborted, this was a timeout
        throw new Error(`Claude request timed out after ${opts.timeoutMs}ms`);
      }

      // Re-throw other SDK errors (auth errors, rate limits, etc.)
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
 * Extract concatenated text from Claude API response content blocks.
 *
 * The Anthropic SDK returns an array of content blocks. We extract
 * all `text`-type blocks and join them into a single string.
 *
 * @param response - The raw message response from the Anthropic SDK.
 * @returns Concatenated text content.
 */
function extractTextFromResponse(
  response: { content: Array<{ type: string; text?: string }> },
): string {
  return response.content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
}
