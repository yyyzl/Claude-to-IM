import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMProvider, StreamChatParams } from '../../lib/bridge/host';
import { generateGitCommitMessageWithLLM } from '../../lib/bridge/internal/git-llm';

function sse(type: 'text' | 'error', data: string): string {
  return `data: ${JSON.stringify({ type, data })}\n`;
}

function streamFromChunks(chunks: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('internal/git-llm', () => {
  it('parses JSON output from SSE text events', async () => {
    let seenParams: StreamChatParams | null = null;
    const llm: LLMProvider = {
      streamChat: (params) => {
        seenParams = params;
        const json = JSON.stringify({
          commitMessage: 'feat(bridge): 增加 /git 的 LLM 提交信息',
          summary: ['生成 Conventional Commit 信息', '生成语义摘要'],
        });
        return streamFromChunks([sse('text', json)]);
      },
    };

    const out = await generateGitCommitMessageWithLLM({
      llm,
      sessionId: 's:git',
      model: 'gpt-test',
      workingDirectory: 'G:\\project\\demo',
      stagedFiles: ['src/a.ts', 'README.md'],
      diffStat: '2 files changed, 3 insertions(+)',
      timeoutMs: 5_000,
    });

    assert.ok(seenParams, 'should call llm.streamChat');
    assert.equal((seenParams as any)?.sdkSessionId, undefined);
    assert.deepStrictEqual(out.commitMessage, 'feat(bridge): 增加 /git 的 LLM 提交信息');
    assert.deepStrictEqual(out.summaryLines, ['生成 Conventional Commit 信息', '生成语义摘要']);
  });

  it('extracts JSON even when wrapped in code fences', async () => {
    const llm: LLMProvider = {
      streamChat: () => {
        const payload = [
          '```json\n',
          '{"commitMessage":"fix(bridge): 修复 /git 输出","summary":["补齐变更摘要","增加语义摘要"]}',
          '\n```',
        ].join('');
        return streamFromChunks([sse('text', payload)]);
      },
    };

    const out = await generateGitCommitMessageWithLLM({
      llm,
      sessionId: 's:git',
      stagedFiles: ['src/a.ts'],
      diffStat: '1 file changed',
      timeoutMs: 5_000,
    });

    assert.equal(out.commitMessage, 'fix(bridge): 修复 /git 输出');
    assert.deepStrictEqual(out.summaryLines, ['补齐变更摘要', '增加语义摘要']);
  });

  it('supports alternative field names (commit_message / summary_lines)', async () => {
    const llm: LLMProvider = {
      streamChat: () => {
        const json = JSON.stringify({
          commit_message: 'chore: 更新脚本',
          summary_lines: ['调整默认配置', '优化提示信息'],
        });
        return streamFromChunks([sse('text', `好的：\n${json}\n`)]); // 模拟模型加了前后缀
      },
    };

    const out = await generateGitCommitMessageWithLLM({
      llm,
      sessionId: 's:git',
      stagedFiles: ['scripts/a.ts'],
      diffStat: '1 file changed',
      timeoutMs: 5_000,
    });

    assert.equal(out.commitMessage, 'chore: 更新脚本');
    assert.deepStrictEqual(out.summaryLines, ['调整默认配置', '优化提示信息']);
  });

  it('throws when SSE emits an error event', async () => {
    const llm: LLMProvider = {
      streamChat: () => streamFromChunks([sse('error', 'boom')]),
    };

    await assert.rejects(
      () => generateGitCommitMessageWithLLM({
        llm,
        sessionId: 's:git',
        stagedFiles: ['a.ts'],
        diffStat: '1 file changed',
        timeoutMs: 5_000,
      }),
      (err) => err instanceof Error && /boom/.test(err.message),
    );
  });
});
