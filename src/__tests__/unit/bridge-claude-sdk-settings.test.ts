import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

type QueryCall = {
  prompt: string;
  options: Record<string, unknown>;
};

type SseEvent = {
  type: string;
  data: string;
};

async function readAll(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let output = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += value;
  }
  return output;
}

async function readSseEvents(stream: ReadableStream<string>): Promise<SseEvent[]> {
  const raw = await readAll(stream);
  const events: SseEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    events.push(JSON.parse(line.slice(6)) as SseEvent);
  }
  return events;
}

describe('ClaudeCodeLLMProvider', () => {
  it('passes filesystem setting sources to the Claude SDK', async () => {
    const { ClaudeCodeLLMProvider } = await import(
      new URL('../../../scripts/claude-to-im-bridge/llm.ts', import.meta.url).href
    );

    let queryCall: QueryCall | null = null;

    const query = ((args: QueryCall) => {
      queryCall = args;
      return (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sdk-session-1',
          usage: null,
        };
      })();
    }) as any;

    const provider = new ClaudeCodeLLMProvider({
      query,
      permissions: { waitFor: async () => ({ behavior: 'allow' }) } as any,
      keepAliveMs: 0,
    });

    await readAll(provider.streamChat({
      prompt: '/ccg:spec-init',
      sessionId: 'bridge-session-1',
      workingDirectory: 'G:\\project\\Claude-to-IM',
    }));

    assert.ok(queryCall, 'query should be invoked');
    const call = queryCall as QueryCall;
    assert.deepEqual(call.options.settingSources, ['user', 'project', 'local']);
    assert.equal(call.options.includePartialMessages, true);
  });

  it('streams text_delta events without duplicating the final result text', async () => {
    const { ClaudeCodeLLMProvider } = await import(
      new URL('../../../scripts/claude-to-im-bridge/llm.ts', import.meta.url).href
    );

    const query = (() => {
      return (async function* () {
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: '第一段' },
          },
          session_id: 'sdk-session-2',
        };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: '第二段' },
          },
          session_id: 'sdk-session-2',
        };
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '第一段第二段' }],
          },
          session_id: 'sdk-session-2',
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: '第一段第二段',
          session_id: 'sdk-session-2',
          usage: null,
        };
      })();
    }) as any;

    const provider = new ClaudeCodeLLMProvider({
      query,
      permissions: { waitFor: async () => ({ behavior: 'allow' }) } as any,
      keepAliveMs: 0,
    });

    const events = await readSseEvents(provider.streamChat({
      prompt: 'hello',
      sessionId: 'bridge-session-2',
    }));

    assert.deepEqual(
      events.filter((event) => event.type === 'text').map((event) => event.data),
      ['第一段', '第二段'],
    );
    assert.ok(events.some((event) => event.type === 'result'));
  });

  it('falls back to the assistant message text when result text is only a short summary', async () => {
    const { ClaudeCodeLLMProvider } = await import(
      new URL('../../../scripts/claude-to-im-bridge/llm.ts', import.meta.url).href
    );

    const query = (() => {
      return (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '这里是完整正文，不应该被结尾短句覆盖。' }],
          },
          session_id: 'sdk-session-3',
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: '已完成',
          session_id: 'sdk-session-3',
          usage: null,
        };
      })();
    }) as any;

    const provider = new ClaudeCodeLLMProvider({
      query,
      permissions: { waitFor: async () => ({ behavior: 'allow' }) } as any,
      keepAliveMs: 0,
    });

    const events = await readSseEvents(provider.streamChat({
      prompt: 'hello',
      sessionId: 'bridge-session-3',
    }));

    assert.deepEqual(
      events.filter((event) => event.type === 'text').map((event) => event.data),
      ['这里是完整正文，不应该被结尾短句覆盖。'],
    );
  });
});
