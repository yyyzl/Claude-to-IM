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
  it('passes supported reasoning effort and rejects unsupported values before starting the SDK', async () => {
    const { ClaudeCodeLLMProvider } = await import(new URL('../../../scripts/claude-to-im-bridge/llm.ts', import.meta.url).href);
    const calls: QueryCall[] = [];
    const query = (args: QueryCall) => {
      calls.push(args);
      return (async function* () { yield { type: 'result', subtype: 'success', result: 'ok' }; })();
    };
    const provider = new ClaudeCodeLLMProvider({ query, permissions: {}, keepAliveMs: 0 });
    await readSseEvents(provider.streamChat({ prompt: 'hi', sessionId: 'effort', reasoningEffort: 'xhigh' }));
    assert.equal(calls[0].options.effort, 'xhigh');
    const events = await readSseEvents(provider.streamChat({ prompt: 'hi', sessionId: 'effort', reasoningEffort: 'ultra' }));
    assert.equal(calls.length, 1);
    assert.ok(events.some(event => event.type === 'error' && event.data.includes('ultra')));
  });

  it('limits session approval suggestions to session settings and leaves one-time approval unchanged', async () => {
    const { ClaudeCodeLLMProvider } = await import(new URL('../../../scripts/claude-to-im-bridge/llm.ts', import.meta.url).href);
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status' }], behavior: 'allow', destination: 'projectSettings' }];
    for (const scope of ['session', undefined]) {
      let resolution: any;
      const query = (args: QueryCall) => (async function* () {
        resolution = await (args.options.canUseTool as Function)('Bash', { command: 'git status' }, { signal: new AbortController().signal, toolUseID: 'scope-test', suggestions });
        yield { type: 'result', subtype: 'success', result: 'ok' };
      })();
      const provider = new ClaudeCodeLLMProvider({ query, permissions: { waitFor: async () => ({ behavior: 'allow', scope }) }, keepAliveMs: 0 });
      await readSseEvents(provider.streamChat({ prompt: '状态', sessionId: 'scope-test' }));
      assert.deepEqual(resolution.updatedPermissions, scope ? [{ ...suggestions[0], destination: 'session' }] : undefined);
      assert.equal(suggestions[0].destination, 'projectSettings', '不能修改 SDK 原建议对象');
    }
  });

  it('forwards SDK user tool results, task progress, context and cost', async () => {
    const { ClaudeCodeLLMProvider } = await import(new URL('../../../scripts/claude-to-im-bridge/llm.ts', import.meta.url).href);
    const query = () => (async function* () {
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'done' }], is_error: false }] } };
      yield { type: 'system', subtype: 'task_progress', task_id: 'task1', description: '正在检查' };
      yield { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 2 }, modelUsage: { sonnet: { contextWindow: 200000 } }, total_cost_usd: 0.02 };
    })();
    const provider = new ClaudeCodeLLMProvider({ query, permissions: {}, keepAliveMs: 0 });
    const events = await readSseEvents(provider.streamChat({ prompt: 'hello', sessionId: 'b1' }));
    assert.deepEqual(JSON.parse(events.find(e => e.type === 'tool_result')?.data ?? '{}'), { tool_use_id: 't1', content: 'done', is_error: false });
    assert.ok(events.some(e => e.type === 'progress' && e.data === '正在检查'));
    const result = JSON.parse(events.find(e => e.type === 'result')?.data ?? '{}');
    assert.equal(result.context_window, 200000);
    assert.equal(result.total_cost_usd, 0.02);
    assert.equal(result.usage.cost_usd, undefined, '累计会话成本不能伪装成单轮费用');
  });

  it('passes images as SDK input blocks and rejects unsupported attachments explicitly', async () => {
    const { ClaudeCodeLLMProvider } = await import(new URL('../../../scripts/claude-to-im-bridge/llm.ts', import.meta.url).href);
    const messages: unknown[] = [];
    const query = (args: { prompt: AsyncIterable<unknown> }) => (async function* () {
      for await (const message of args.prompt) messages.push(message);
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
    const provider = new ClaudeCodeLLMProvider({ query, permissions: {}, keepAliveMs: 0 });
    await readSseEvents(provider.streamChat({ prompt: '看图', sessionId: 'b1', files: [{ id: 'f1', name: 'a.png', type: 'image/png', size: 1, data: 'eA==' }] }));
    assert.deepEqual((messages[0] as any).message.content, [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eA==' } }]);
    const events = await readSseEvents(provider.streamChat({ prompt: '看文件', sessionId: 'b1', files: [{ id: 'f2', name: 'a.zip', type: 'application/zip', size: 1, data: 'eA==' }] }));
    assert.ok(events.some(e => e.type === 'error' && e.data.includes('a.zip')));
  });

  it('returns actual answers to AskUserQuestion instead of treating it as permission', async () => {
    const { ClaudeCodeLLMProvider } = await import(new URL('../../../scripts/claude-to-im-bridge/llm.ts', import.meta.url).href);
    let resolution: any;
    const query = (args: QueryCall) => (async function* () {
      resolution = await (args.options.canUseTool as Function)('AskUserQuestion', { questions: [{ question: '选择颜色', header: '颜色', options: [{ label: '蓝色', description: '蓝' }], multiSelect: false }] }, { signal: new AbortController().signal, toolUseID: 'ask1' });
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
    const permissions = { waitFor: async () => ({ behavior: 'allow', updatedInput: { answers: { '0': ['蓝色'] } } }) };
    const provider = new ClaudeCodeLLMProvider({ query, permissions, keepAliveMs: 0 });
    const events = await readSseEvents(provider.streamChat({ prompt: 'hello', sessionId: 'b1' }));
    assert.ok(events.some(e => e.type === 'user_input_request'));
    assert.ok(!events.some(e => e.type === 'permission_request'));
    assert.deepEqual(resolution.updatedInput.answers, { '选择颜色': '蓝色' });
  });

  it('reports a synchronous SDK startup failure as an error result', async () => {
    const { ClaudeCodeLLMProvider } = await import(new URL('../../../scripts/claude-to-im-bridge/llm.ts', import.meta.url).href);
    const provider = new ClaudeCodeLLMProvider({ query: () => { throw new Error('startup failed'); }, permissions: {}, keepAliveMs: 0 });
    const events = await readSseEvents(provider.streamChat({ prompt: 'hello', sessionId: 'b1' }));
    assert.ok(events.some(e => e.type === 'error' && e.data === 'startup failed'));
    assert.equal(JSON.parse(events.find(e => e.type === 'result')?.data ?? '{}').is_error, true);
  });
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
