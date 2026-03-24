import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

import { ModelInvoker } from '../../lib/workflow/model-invoker.js';
import { TimeoutError, ModelInvocationError } from '../../lib/workflow/types.js';

class FakeWritable extends EventEmitter {
  constructor(private readonly onWrite?: () => void) {
    super();
  }

  write(_chunk: string, _encoding?: BufferEncoding, cb?: ((error: Error | null | undefined) => void)): boolean {
    queueMicrotask(() => {
      cb?.(undefined);
      this.onWrite?.();
    });
    return true;
  }

  end(cb?: (() => void)): void {
    queueMicrotask(() => cb?.());
  }
}

function createFakeChild(opts?: {
  stdout?: string;
  stderr?: string;
  closeCode?: number | null;
  stdinError?: Error;
}): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new FakeWritable(() => {
    if (opts?.stdinError) {
      stdin.emit('error', opts.stdinError);
    }
  });

  child.stdout = stdout as ChildProcessWithoutNullStreams['stdout'];
  child.stderr = stderr as ChildProcessWithoutNullStreams['stderr'];
  child.stdin = stdin as ChildProcessWithoutNullStreams['stdin'];
  child.kill = (() => true) as ChildProcessWithoutNullStreams['kill'];

  queueMicrotask(() => {
    if (opts?.stdout) {
      stdout.emit('data', Buffer.from(opts.stdout));
    }
    if (opts?.stderr) {
      stderr.emit('data', Buffer.from(opts.stderr));
    }
    child.emit('close', opts?.closeCode ?? 0, null);
  });

  return child;
}

describe('ModelInvoker.invokeCodex', () => {
  it('passes backend and stdin marker to codeagent-wrapper', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnImpl = ((command: string, args: string[]) => {
      calls.push({ command, args });
      return createFakeChild({ stdout: '{}' });
    }) as unknown as typeof spawn;

    const invoker = new ModelInvoker(spawnImpl);

    await invoker.invokeCodex('review prompt', {
      timeoutMs: 1000,
      maxRetries: 0,
      backend: 'gemini',
    });

    assert.deepEqual(calls, [
      {
        command: 'codeagent-wrapper',
        args: ['--backend', 'gemini', '-'],
      },
    ]);
  });

  it('rejects when child stdin emits EOF instead of crashing the process', async () => {
    const eof = Object.assign(new Error('write EOF'), { code: 'EOF' });
    const spawnImpl = (() => createFakeChild({
      stderr: 'task required',
      closeCode: 1,
      stdinError: eof,
    })) as unknown as typeof spawn;

    const invoker = new ModelInvoker(spawnImpl);

    // P1-2: exit code 1 is now detected as a non-retryable error pattern
    // ("exited with code 1"), so it throws ModelInvocationError instead of
    // TimeoutError. This is correct — deterministic process failures should
    // not be retried.
    await assert.rejects(
      invoker.invokeCodex('x'.repeat(100_000), {
        timeoutMs: 1000,
        maxRetries: 0,
      }),
      (err: unknown) => {
        assert.ok(err instanceof ModelInvocationError);
        return true;
      },
    );
  });
});
