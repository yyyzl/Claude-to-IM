/**
 * Unit tests for bridge-manager.
 *
 * Tests cover:
 * - Session lock concurrency: same-session serialization
 * - Session lock concurrency: different-session parallelism
 * - Bridge start/stop lifecycle
 * - Auto-start idempotency
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import {
  processWithSessionLock as processWithSessionLockInternal,
  SessionQueueTimeoutError,
} from '../../lib/bridge/internal/session-lock';
import { computeSessionQueueTimeoutMs } from '../../lib/bridge/internal/timeouts';
import type { BridgeStore, LifecycleHooks } from '../../lib/bridge/host';

// ── Test the session lock mechanism directly ────────────────
// We test the real session lock implementation (including queue timeout semantics).

function createSessionLocks(queueTimeoutMs = 0) {
  const locks = new Map<string, Promise<void>>();

  function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
    return processWithSessionLockInternal(locks, sessionId, fn, queueTimeoutMs);
  }

  return { locks, processWithSessionLock };
}

describe('bridge-manager session locks', () => {
  it('serializes same-session operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, [1, 2], 'Same-session operations should be serialized');
  });

  it('allows different-session operations to run concurrently', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const started: string[] = [];
    const completed: string[] = [];

    const p1 = processWithSessionLock('session-A', async () => {
      started.push('A');
      await new Promise(r => setTimeout(r, 50));
      completed.push('A');
    });

    const p2 = processWithSessionLock('session-B', async () => {
      started.push('B');
      await new Promise(r => setTimeout(r, 10));
      completed.push('B');
    });

    await Promise.all([p1, p2]);
    // Both should start before either completes (concurrent)
    assert.equal(started.length, 2);
    // B should complete first since it has shorter delay
    assert.equal(completed[0], 'B');
    assert.equal(completed[1], 'A');
  });

  it('continues after errors in locked operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      order.push(1);
      throw new Error('test error');
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await p1.catch(() => {});
    await p2;
    assert.deepStrictEqual(order, [1, 2], 'Should continue after error');
  });

  it('cleans up completed locks', async () => {
    const { locks, processWithSessionLock } = createSessionLocks();

    await processWithSessionLock('session-1', async () => {});

    // Allow microtask to complete for finally() cleanup
    await new Promise(r => setTimeout(r, 0));
    assert.equal(locks.size, 0, 'Lock should be cleaned up after completion');
  });

  it('does not treat long-running execution as queue timeout', async () => {
    const { processWithSessionLock } = createSessionLocks(20);
    const p = processWithSessionLock('session-1', async () => {
      await new Promise(r => setTimeout(r, 60));
    });
    await assert.doesNotReject(p);
  });

  it('times out queued operations and skips execution', async () => {
    const { processWithSessionLock } = createSessionLocks(20);
    let ran = false;

    const p1 = processWithSessionLock('session-1', async () => {
      await new Promise(r => setTimeout(r, 60));
    });

    const p2 = processWithSessionLock('session-1', async () => {
      ran = true;
    });

    await assert.rejects(p2, (err) => err instanceof SessionQueueTimeoutError);
    await p1;
    await new Promise(r => setTimeout(r, 0));
    assert.equal(ran, false, 'Timed-out queued fn should be skipped');
  });
});

describe('bridge-manager timeout defaults', () => {
  it('uses explicit queue timeout setting (including 0=disabled)', () => {
    assert.equal(computeSessionQueueTimeoutMs(123, 5400000), 123);
    assert.equal(computeSessionQueueTimeoutMs(0, 5400000), 0);
  });

  it('defaults queue timeout to turn_timeout + 10 minutes when not configured', () => {
    // 90min + 10min = 100min
    assert.equal(computeSessionQueueTimeoutMs(null, 90 * 60_000), 100 * 60_000);
  });

  it('uses default turn timeout when turn timeout is not configured', () => {
    // 默认 turn 超时为 90min，因此队列超时默认应为 100min
    assert.equal(computeSessionQueueTimeoutMs(null, null), 100 * 60_000);
  });

  it('falls back to 5 minutes when turn timeout is disabled', () => {
    assert.equal(computeSessionQueueTimeoutMs(null, 0), 5 * 60_000);
  });
});

// ── Lifecycle tests ─────────────────────────────────────────

describe('bridge-manager lifecycle', () => {
  beforeEach(() => {
    // Clear bridge manager state
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('getStatus returns not running when bridge has not started', async () => {
    const store = createMinimalStore({ remote_bridge_enabled: 'false' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    // Import dynamically to get fresh module state
    const { getStatus } = await import('../../lib/bridge/bridge-manager');
    const status = getStatus();
    assert.equal(status.running, false);
    assert.equal(status.adapters.length, 0);
  });
});

function createMinimalStore(settings: Record<string, string> = {}): BridgeStore {
  return {
    getSetting: (key: string) => settings[key] ?? null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: '1', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}
