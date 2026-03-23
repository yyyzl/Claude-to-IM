import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

type CollectTurnTextResult = {
  text: string;
  usage: unknown;
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
});
