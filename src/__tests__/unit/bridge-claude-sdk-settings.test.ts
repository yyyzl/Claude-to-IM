import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

type QueryCall = {
  prompt: string;
  options: Record<string, unknown>;
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
  });
});
