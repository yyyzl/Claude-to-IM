/**
 * /git：调用大模型生成提交信息与语义摘要。
 *
 * 设计目标：
 * - 让 /git 的产出“像人写的”，而不是纯工程规则兜底
 * - 默认不上传完整 diff patch，尽量降低敏感信息外泄风险
 *
 * 约束：LLMProvider.streamChat() 输出为 SSE 文本流，每行形如：
 * `data: {"type":"text","data":"..."}`
 */

import type { LLMProvider } from '../host.js';

export type GitLlmGenerateInput = {
  llm: LLMProvider;
  sessionId: string;
  model?: string;
  workingDirectory?: string;
  /** 可选：用户提供的意图提示（建议不包含代码/敏感信息）。 */
  userHint?: string;
  /** git diff --cached --name-only */
  stagedFiles: string[];
  /** git diff --cached --stat */
  diffStat: string;
  /** 可选：git diff --cached patch（已在上游截断/脱敏）。 */
  diffPatch?: string;
  /** LLM 调用总超时（毫秒）。 */
  timeoutMs: number;
};

export type GitLlmGenerateOutput = {
  rawText: string;
  commitMessage: string | null;
  summaryLines: string[];
};

type ParsedJson = {
  commitMessage?: unknown;
  commit_message?: unknown;
  summary?: unknown;
  summary_lines?: unknown;
};

function stripCodeFences(text: string): string {
  // 移除常见 ```json ... ``` 代码围栏，让解析更鲁棒（模型偶尔会无视“只输出 JSON”的要求）。
  return text
    .replace(/```[a-zA-Z]*\r?\n?/g, '')
    .replace(/```/g, '')
    .trim();
}

function tryExtractJsonObject(text: string): ParsedJson | null {
  const cleaned = stripCodeFences(text);
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last < 0 || last <= first) return null;
  const candidate = cleaned.slice(first, last + 1);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as ParsedJson;
  } catch {
    return null;
  }
}

function normalizeSummaryLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    // 兼容 "a\nb\nc" 或 "- a\n- b" 的降级输出。
    return value
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
      .filter(Boolean);
  }
  return [];
}

function redactSensitive(text: string): string {
  let out = text;

  // 常见 OpenAI 风格 key
  out = out.replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-***');

  // Bearer token
  out = out.replace(/(Authorization:\s*Bearer)\s+\S+/gi, '$1 ***');
  out = out.replace(/\bBearer\s+\S+/gi, 'Bearer ***');

  // AWS Access Key Id
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***');

  // PEM 区块
  out = out.replace(
    /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
    '-----BEGIN ***-----\n***\n-----END ***-----',
  );

  // 通用 key/value secrets
  out = out.replace(
    /(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|token|secret)\s*[:=]\s*([^\s,;]+)/gi,
    '$1=***',
  );

  return out;
}

function buildPrompt(input: Omit<GitLlmGenerateInput, 'llm' | 'timeoutMs'>): string {
  const files = input.stagedFiles.slice(0, 200);
  const diffStat = redactSensitive(input.diffStat || '');
  const diffPatch = input.diffPatch ? redactSensitive(input.diffPatch) : '';
  const userHint = (input.userHint || '').trim();

  const allowedTypes = [
    'feat',
    'fix',
    'refactor',
    'perf',
    'style',
    'docs',
    'test',
    'chore',
    'build',
    'ci',
  ].join(' / ');

  const subjectVerbExamples = ['增加', '修复', '优化', '调整', '更新', '重构', '支持', '移除', '删除'].join(' / ');

  return [
    '你是一个严格的 Git 提交信息与摘要生成器。请基于 staged 变更生成 JSON：',
    '',
    '输出必须是严格 JSON（不要 Markdown、不要代码块、不要多余解释）：',
    '{"commitMessage":"type(scope): subject","summary":["要点1","要点2"]}',
    '',
    '约束：',
    `- commitMessage 必须符合 Conventional Commits：type(scope): subject（不能换行）`,
    `- type 仅允许：${allowedTypes}`,
    '- scope 可选；建议用模块名/顶层目录；必须是 ASCII 字母数字与 . _ / - 组成，且以字母或数字开头',
    `- subject 必须中文且命令式动词开头（如：${subjectVerbExamples}），不要“我/我们/本次/此次/这个”开头`,
    '- summary 输出 2~5 条中文要点，每条一句话；不要贴代码；不要输出敏感 token',
    '',
    ...(userHint ? ['用户提示（可选）：', userHint, ''] : []),
    `staged files（${input.stagedFiles.length}）：`,
    files.join('\n') || '(none)',
    files.length < input.stagedFiles.length ? `...（已省略 ${input.stagedFiles.length - files.length} 个文件）` : '',
    '',
    'git diff --cached --stat：',
    diffStat || '(empty)',
    '',
    ...(diffPatch ? ['git diff --cached（节选，可能已截断）：', diffPatch] : []),
  ].filter(Boolean).join('\n');
}

async function collectSseText(stream: ReadableStream<string>): Promise<{ text: string; errorText: string | null }> {
  const reader = stream.getReader();
  let merged = '';
  let errorText: string | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = String(value || '');
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6);
        let evt: { type?: unknown; data?: unknown } | null = null;
        try {
          evt = JSON.parse(json) as any;
        } catch {
          continue;
        }
        const t = typeof evt?.type === 'string' ? evt.type : '';
        if (t === 'text') {
          merged += String(evt?.data ?? '');
        } else if (t === 'error') {
          errorText = String(evt?.data ?? 'LLM error');
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* 忽略 */ }
  }
  return { text: merged.trim(), errorText };
}

export async function generateGitCommitMessageWithLLM(input: GitLlmGenerateInput): Promise<GitLlmGenerateOutput> {
  const abortController = new AbortController();
  const timeoutMs = Math.max(1000, input.timeoutMs);
  const timer = setTimeout(() => {
    try { abortController.abort(); } catch { /* 忽略 */ }
  }, timeoutMs);

  try {
    const prompt = buildPrompt({
      sessionId: input.sessionId,
      model: input.model,
      workingDirectory: input.workingDirectory,
      stagedFiles: input.stagedFiles,
      diffStat: input.diffStat,
      diffPatch: input.diffPatch,
    });

    const stream = input.llm.streamChat({
      prompt,
      sessionId: input.sessionId,
      // 不恢复既有对话：/git 应与聊天上下文隔离，避免“带入上一轮对话”导致偏离。
      sdkSessionId: undefined,
      model: input.model,
      systemPrompt: '只输出严格 JSON，不要使用任何工具，不要请求权限，不要输出解释文字。',
      workingDirectory: input.workingDirectory,
      abortController,
      permissionMode: 'default',
      conversationHistory: [],
    });

    const { text: rawText, errorText } = await collectSseText(stream);
    if (errorText) {
      throw new Error(errorText);
    }

    const parsed = tryExtractJsonObject(rawText);
    const commitMessageRaw = parsed?.commitMessage ?? parsed?.commit_message;
    const commitMessage = typeof commitMessageRaw === 'string' ? commitMessageRaw.trim() : null;

    const summaryLinesRaw = parsed?.summary ?? parsed?.summary_lines;
    const summaryLines = normalizeSummaryLines(summaryLinesRaw).slice(0, 8);

    return { rawText, commitMessage, summaryLines };
  } finally {
    clearTimeout(timer);
  }
}
