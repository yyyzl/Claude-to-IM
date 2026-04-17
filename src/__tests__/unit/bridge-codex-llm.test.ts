import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

type CollectTurnTextResult = {
  text: string;
  usage: unknown;
  lastUsage?: unknown;
  contextWindow?: number | null;
  emittedFinalText?: boolean;
};

type JsonRpcMessage = {
  method?: string;
  params?: Record<string, unknown>;
};

async function createProvider() {
  const moduleUrl = pathToFileURL(
    path.resolve(process.cwd(), 'scripts/claude-to-im-bridge/codex-llm.ts'),
  ).href;
  const { CodexAppServerLLMProvider } = await import(moduleUrl);

  return new CodexAppServerLLMProvider({
    projectRoot: process.cwd(),
    permissions: {} as never,
    keepAliveMs: 0,
  }) as any;
}

function createBacklogClient(messages: JsonRpcMessage[]) {
  return {
    drainBacklog: (predicate: (msg: JsonRpcMessage) => boolean) => messages.filter(predicate),
    onNotification: () => () => {},
  };
}

async function readSseEvents(stream: ReadableStream<string>): Promise<Array<{ type: string; data: string }>> {
  const reader = stream.getReader();
  const events: Array<{ type: string; data: string }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    for (const line of value.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const parsed = JSON.parse(line.slice(6)) as { type: string; data: string };
      events.push(parsed);
    }
  }

  return events;
}

describe('CodexAppServerLLMProvider', () => {
  it('collectTurnText only forwards final_answer deltas', async () => {
    const provider = await createProvider();
    provider.client = createBacklogClient([
      {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'msg-commentary', text: '', phase: 'commentary' },
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'msg-commentary',
          delta: 'commentary ',
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'msg-commentary', text: 'commentary text', phase: 'commentary' },
        },
      },
      {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'msg-final', text: '', phase: 'final_answer' },
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'msg-final',
          delta: 'final ',
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'msg-final',
          delta: 'answer',
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'msg-final', text: 'final answer', phase: 'final_answer' },
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1' },
        },
      },
    ]);

    const deltas: string[] = [];
    const result = await provider.collectTurnText({
      threadId: 'thread-1',
      turnId: 'turn-1',
      onDelta: (delta: string) => deltas.push(delta),
      signal: new AbortController().signal,
    }) as CollectTurnTextResult;

    assert.deepEqual(deltas, ['final ', 'answer']);
    assert.equal(result.text, 'final answer');
  });

  it('collectTurnText falls back to final_answer completed text when final delta is missing', async () => {
    const provider = await createProvider();
    provider.client = createBacklogClient([
      {
        method: 'item/started',
        params: {
          threadId: 'thread-2',
          turnId: 'turn-2',
          item: { type: 'agentMessage', id: 'msg-commentary', text: '', phase: 'commentary' },
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-2',
          turnId: 'turn-2',
          itemId: 'msg-commentary',
          delta: 'commentary only',
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-2',
          turnId: 'turn-2',
          item: { type: 'agentMessage', id: 'msg-commentary', text: 'commentary only', phase: 'commentary' },
        },
      },
      {
        method: 'item/started',
        params: {
          threadId: 'thread-2',
          turnId: 'turn-2',
          item: { type: 'agentMessage', id: 'msg-final', text: '', phase: 'final_answer' },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-2',
          turnId: 'turn-2',
          item: { type: 'agentMessage', id: 'msg-final', text: 'final answer', phase: 'final_answer' },
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-2',
          turn: { id: 'turn-2' },
        },
      },
    ]);

    const deltas: string[] = [];
    const result = await provider.collectTurnText({
      threadId: 'thread-2',
      turnId: 'turn-2',
      onDelta: (delta: string) => deltas.push(delta),
      signal: new AbortController().signal,
    }) as CollectTurnTextResult;

    assert.deepEqual(deltas, []);
    assert.equal(result.text, 'final answer');
  });

  it('streamChat emits fallback text when only completed final_answer is available', async () => {
    const provider = await createProvider();
    provider.ensureInitialized = async () => {
      provider.selectedModelId = 'gpt-test';
      provider.selectedModelLabel = 'gpt-test';
    };
    provider.startThread = async () => 'thread-3';
    provider.startTurn = async () => 'turn-3';
    provider.collectTurnText = async (): Promise<CollectTurnTextResult> => ({
      text: 'final answer',
      usage: null,
      emittedFinalText: false,
    });

    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'session-1',
    });
    const events = await readSseEvents(stream);
    const textEvents = events.filter((event) => event.type === 'text');

    assert.deepEqual(textEvents.map((event) => event.data), ['final answer']);
    assert.ok(events.some((event) => event.type === 'result'), 'should emit result event');
  });

  it('collectTurnText backfills token_count from rollout file when notifications carry no thread/turn ids', async () => {
    const provider = await createProvider();
    const threadId = '019d9bd3-b5a7-7213-9a6c-4fcb03ca7cdc';
    const turnId = 'turn-rollout-1';
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
    const oldCodexHome = process.env.CODEX_HOME;

    try {
      process.env.CODEX_HOME = tmpRoot;

      const rolloutDir = path.join(tmpRoot, 'sessions', '2026', '04', '17');
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        path.join(rolloutDir, `rollout-2026-04-17T22-23-56-${threadId}.jsonl`),
        [
          JSON.stringify({
            timestamp: '2026-04-17T22:23:56.000Z',
            type: 'session_meta',
            payload: { id: threadId, cwd: 'G:\\project\\Claude-to-IM' },
          }),
          JSON.stringify({
            timestamp: '2026-04-17T22:24:01.000Z',
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: {
                  input_tokens: 6708,
                  cached_input_tokens: 1234,
                  output_tokens: 51,
                  reasoning_output_tokens: 0,
                  total_tokens: 7993,
                },
                total_token_usage: {
                  input_tokens: 661504,
                  cached_input_tokens: 2048,
                  output_tokens: 153,
                  reasoning_output_tokens: 64,
                  total_tokens: 663721,
                },
                model_context_window: 258400,
              },
            },
          }),
        ].join('\n'),
        'utf8',
      );

      provider.client = createBacklogClient([
        {
          method: 'item/started',
          params: {
            threadId,
            turnId,
            item: { type: 'agentMessage', id: 'msg-final', text: '', phase: 'final_answer' },
          },
        },
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId,
            turnId,
            itemId: 'msg-final',
            delta: 'final answer',
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId,
            turnId,
            item: { type: 'agentMessage', id: 'msg-final', text: 'final answer', phase: 'final_answer' },
          },
        },
        {
          method: 'turn/completed',
          params: {
            threadId,
            turn: { id: turnId },
          },
        },
      ]);

      const result = await provider.collectTurnText({
        threadId,
        turnId,
        onDelta: () => {},
        signal: new AbortController().signal,
      }) as CollectTurnTextResult;

      assert.equal(result.text, 'final answer');
      assert.deepEqual(result.lastUsage, {
        input_tokens: 6708,
        output_tokens: 51,
        cache_read_input_tokens: 1234,
      });
      assert.deepEqual(result.usage, {
        input_tokens: 661504,
        output_tokens: 153,
        cache_read_input_tokens: 2048,
      });
      assert.equal(result.contextWindow, 258400);
    } finally {
      if (oldCodexHome == null) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = oldCodexHome;
      }
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
