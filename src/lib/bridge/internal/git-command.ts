/**
 * /git 命令的参数解析与 Conventional Commit 校验。
 *
 * 目标：
 * - 强制使用允许的 type（全小写）
 * - subject 使用中文、命令式（动词开头）
 * - 给出可操作的错误提示与示例
 */

export type GitSlashCommand =
  | { kind: 'help' }
  | { kind: 'push' }
  | { kind: 'auto' }
  | { kind: 'commit'; message: string };

const ALLOWED_TYPES = [
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
] as const;

export type ConventionalCommitType = typeof ALLOWED_TYPES[number];

const ALLOWED_TYPE_SET = new Set<string>(ALLOWED_TYPES);

// 常见中文动词（命令式）白名单：避免“我/我们/这个/修复了”等赘词
const SUBJECT_VERB_PREFIX = [
  '增加',
  '修复',
  '优化',
  '调整',
  '更新',
  '重构',
  '提升',
  '降低',
  '完善',
  '补充',
  '支持',
  '实现',
  '移除',
  '删除',
  '规范',
  '统一',
  '简化',
  '对齐',
  '合并',
  '拆分',
  '限制',
  '放宽',
  '启用',
  '禁用',
  '恢复',
  '修正',
  '改进',
  '整理',
] as const;

const SUBJECT_VERB_PREFIX_RE = new RegExp(`^(${SUBJECT_VERB_PREFIX.join('|')})`);

export function getGitCommitMessageExamples(): string[] {
  return [
    'feat(bridge): 增加 /git 命令用于提交',
    'fix(feishu): 修复流式卡片更新抖动',
    'chore: 优化本地开发脚本',
  ];
}

export function parseGitSlashCommandArgs(argsRaw: string): GitSlashCommand {
  const args = argsRaw.trim();
  if (!args) return { kind: 'auto' };
  if (args === 'help' || args === '--help' || args === '-h') return { kind: 'help' };
  if (args === 'push') return { kind: 'push' };
  return { kind: 'commit', message: args };
}

export function generateAutoConventionalCommitMessage(stagedFiles: string[]): string {
  const files = stagedFiles
    .map(f => f.replaceAll('\\', '/').trim())
    .filter(Boolean);

  // 兜底：确保永远能生成一个可通过校验的 message
  if (files.length === 0) return 'chore: 更新代码';

  const type = inferTypeFromFiles(files);
  const scope = inferScopeFromFiles(files);
  const subject = inferSubjectFromContext(type, scope);

  const candidate = `${type}${scope ? `(${scope})` : ''}: ${subject}`;
  const validated = validateAndNormalizeConventionalCommitMessage(candidate);
  if (validated.ok) return validated.normalized;

  const fallback = 'chore: 更新代码';
  const fallbackValidated = validateAndNormalizeConventionalCommitMessage(fallback);
  return fallbackValidated.ok ? fallbackValidated.normalized : fallback;
}

function inferTypeFromFiles(files: string[]): ConventionalCommitType {
  const lowered = files.map(f => f.toLowerCase());

  const isDocFile = (p: string) => p.endsWith('.md') || p.startsWith('docs/');
  if (lowered.every(isDocFile)) return 'docs';

  const isTestFile = (p: string) =>
    p.includes('/__tests__/')
    || p.startsWith('src/__tests__/')
    || p.endsWith('.test.ts');
  if (lowered.every(isTestFile)) return 'test';

  const isCiFile = (p: string) => p.startsWith('.github/') || p.startsWith('.gitlab/') || p.startsWith('.circleci/');
  if (lowered.some(isCiFile)) return 'ci';

  const isBuildFile = (p: string) =>
    p === 'package.json'
    || p === 'package-lock.json'
    || p === 'tsconfig.json'
    || p === 'tsconfig.build.json';
  if (lowered.some(isBuildFile)) return 'build';

  return 'chore';
}

function inferScopeFromFiles(files: string[]): string | undefined {
  const lowered = files.map(f => f.toLowerCase());
  const scopes = new Set<string>();

  for (const f of lowered) {
    if (f.includes('src/lib/bridge/adapters/feishu')) scopes.add('feishu');
    else if (f.includes('src/lib/bridge/adapters/telegram')) scopes.add('telegram');
    else if (f.includes('src/lib/bridge/adapters/discord')) scopes.add('discord');
    else if (f.includes('src/lib/bridge/adapters/qq')) scopes.add('qq');
    else if (f.includes('src/lib/bridge/markdown/')) scopes.add('markdown');
    else if (f.includes('src/lib/bridge/security/')) scopes.add('security');
    else if (f.includes('src/lib/bridge/')) scopes.add('bridge');
  }

  if (scopes.size === 1) return [...scopes][0];
  return undefined;
}

function inferSubjectFromContext(type: ConventionalCommitType, scope?: string): string {
  if (type === 'docs') return '更新文档';
  if (type === 'test') return '补充单元测试';
  if (type === 'ci') return '更新 CI 配置';
  if (type === 'build') return '更新构建配置';

  switch (scope) {
    case 'feishu': return '更新飞书适配器';
    case 'telegram': return '更新 Telegram 适配器';
    case 'discord': return '更新 Discord 适配器';
    case 'qq': return '更新 QQ 适配器';
    case 'markdown': return '更新 Markdown 渲染';
    case 'security': return '更新安全校验';
    case 'bridge': return '更新桥接逻辑';
    default: return '更新代码';
  }
}

export type ConventionalCommitValidation =
  | {
    ok: true;
    normalized: string;
    type: ConventionalCommitType;
    scope?: string;
    subject: string;
  }
  | {
    ok: false;
    error: string;
    hint?: string;
  };

/**
 * 校验并规范化 Conventional Commit message。
 *
 * 支持两种输入：
 * - `type(scope): subject`
 * - `type(scope) subject`（会自动补上 `: `）
 */
export function validateAndNormalizeConventionalCommitMessage(raw: string): ConventionalCommitValidation {
  const input = raw.trim();

  if (!input) {
    return {
      ok: false,
      error: '提交信息不能为空。',
      hint: formatExampleHint(),
    };
  }

  if (input.includes('\n') || input.includes('\r')) {
    return {
      ok: false,
      error: '提交信息不能包含换行。',
      hint: formatExampleHint(),
    };
  }

  // 1) 标准格式：type(scope?): subject
  const standard = input.match(/^([a-zA-Z]+)(\(([^)]+)\))?:\s*(.+)$/);
  if (standard) {
    const [, typeRaw, , scopeRaw, subjectRaw] = standard;
    return validateParts(typeRaw, scopeRaw, subjectRaw);
  }

  // 2) 容错格式：type(scope?) subject  -> type(scope?): subject
  const tolerant = input.match(/^([a-zA-Z]+)(\(([^)]+)\))?\s+(.+)$/);
  if (tolerant) {
    const [, typeRaw, , scopeRaw, subjectRaw] = tolerant;
    return validateParts(typeRaw, scopeRaw, subjectRaw);
  }

  return {
    ok: false,
    error: '提交信息格式不正确，需要符合 Conventional Commits（type(scope): subject）。',
    hint: formatExampleHint(),
  };
}

function validateParts(
  typeRaw: string,
  scopeRaw: string | undefined,
  subjectRaw: string,
): ConventionalCommitValidation {
  const type = typeRaw.toLowerCase();
  if (!ALLOWED_TYPE_SET.has(type)) {
    return {
      ok: false,
      error: `不支持的提交类型：${typeRaw}（允许：${ALLOWED_TYPES.join(' / ')}）。`,
      hint: formatExampleHint(),
    };
  }

  const scope = typeof scopeRaw === 'string' ? scopeRaw.trim() : undefined;
  if (scope && !/^[a-z0-9][a-z0-9._/-]*$/i.test(scope)) {
    return {
      ok: false,
      error: `scope 不合法：${scopeRaw}（建议使用模块名，如 bridge / feishu / telegram）。`,
      hint: formatExampleHint(),
    };
  }

  const subject = subjectRaw.trim();
  if (!subject) {
    return {
      ok: false,
      error: 'subject 不能为空。',
      hint: formatExampleHint(),
    };
  }

  // 禁止赘词开头
  if (/^(我|我们|这个|本次|此次)/.test(subject)) {
    return {
      ok: false,
      error: 'subject 请避免以“我/我们/这个/本次/此次”等赘词开头。',
      hint: formatExampleHint(),
    };
  }

  // 禁止过去式赘词（“修复了/增加了/优化了 ...”）
  if (/^(增加了|修复了|优化了)/.test(subject)) {
    return {
      ok: false,
      error: 'subject 请使用命令式表达，避免“增加了/修复了/优化了”等过去式。',
      hint: formatExampleHint(),
    };
  }

  // 需要中文（至少包含一个中文字符）
  if (!/[\u4e00-\u9fff]/.test(subject)) {
    return {
      ok: false,
      error: 'subject 需要使用中文描述，并以动词开头（如“增加/修复/优化”）。',
      hint: formatExampleHint(),
    };
  }

  if (!SUBJECT_VERB_PREFIX_RE.test(subject)) {
    return {
      ok: false,
      error: `subject 建议以命令式动词开头（如：${SUBJECT_VERB_PREFIX.slice(0, 3).join(' / ')}）。`,
      hint: formatExampleHint(),
    };
  }

  const normalized = `${type}${scope ? `(${scope})` : ''}: ${subject}`;
  return {
    ok: true,
    normalized,
    type: type as ConventionalCommitType,
    scope: scope || undefined,
    subject,
  };
}

function formatExampleHint(): string {
  return `示例：\n- ${getGitCommitMessageExamples().join('\n- ')}`;
}
