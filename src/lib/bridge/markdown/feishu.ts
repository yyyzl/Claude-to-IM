import type { ToolCallInfo } from '../types.js';
import type { UserInputRequest } from '../host.js';

/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 *
 * Schema 2.0 cards render code blocks, tables, bold, italic, links properly.
 * Post messages with md tag render bold, italic, inline code, links.
 */

/**
 * Detect complex markdown (code blocks / tables).
 * Used by send() to decide between card and post rendering.
 */
export function hasComplexMarkdown(text: string): boolean {
  // Fenced code blocks
  if (/```[\s\S]*?```/.test(text)) return true;
  // Tables: header row followed by separator row with pipes and dashes
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

/**
 * Preprocess markdown for Feishu rendering.
 * Only ensures code fences have a newline before them.
 * Does NOT touch the text after ``` to preserve language tags like ```python.
 */
export function preprocessFeishuMarkdown(text: string): string {
  // Ensure ``` has newline before it (unless at start of text)
  return text.replace(/([^\n])```/g, '$1\n```');
}

/**
 * Build Feishu interactive card content (schema 2.0 markdown).
 * Renders code blocks, tables, bold, italic, links, inline code properly.
 * Aligned with Openclaw's buildMarkdownCard().
 */
export function buildCardContent(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  });
}

/**
 * Build Feishu post message content (msg_type: 'post') with md tag.
 * Used for simple text without code blocks or tables.
 * Aligned with Openclaw's buildFeishuPostMessagePayload().
 */
export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

/** 将完整请求体的 UTF-8 体积计入预算，包含 content 字符串的再次转义。 */
export function feishuPayloadBytes(text: string): number {
  const content = hasComplexMarkdown(text) ? buildCardContent(preprocessFeishuMarkdown(text)) : buildPostContent(text);
  return Buffer.byteLength(JSON.stringify({ receive_id: 'x'.repeat(256), msg_type: 'interactive', content }), 'utf8');
}

/** 保留原始字符并为跨片代码块补围栏；不拆开 UTF-16 代理对。 */
export function splitFeishuMarkdown(text: string, budget = 28_000): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let rest = text;
  let fence: { marker: string; language: string } | undefined;
  const nextFence = (part: string) => {
    let current = fence;
    for (const line of part.split('\n')) {
      const match = line.match(/^\s*(`{3,}|~{3,})([^\r\n]*)$/);
      if (!match) continue;
      if (!current) current = { marker: match[1], language: match[2] };
      else if (match[1][0] === current.marker[0] && match[1].length >= current.marker.length && !match[2].trim()) current = undefined;
    }
    return current;
  };
  while (rest) {
    const prefix = fence ? `${fence.marker}${fence.language}\n` : '';
    const render = (raw: string) => prefix + raw + (nextFence(raw) ? '\n' + nextFence(raw)!.marker : '');
    const points = Array.from(rest);
    let low = 1; let high = points.length; let best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const end = points.slice(0, mid).join('').length;
      if (end > 0 && feishuPayloadBytes(render(rest.slice(0, end))) <= budget) { best = end; low = mid + 1; }
      else high = mid - 1;
    }
    if (!best) throw new Error('飞书消息封装超过字节预算');
    if (best < rest.length) {
      const boundary = rest.lastIndexOf('\n', best - 1) + 1;
      if (boundary > best / 2) best = boundary;
    }
    const raw = rest.slice(0, best);
    chunks.push(render(raw));
    fence = nextFence(raw);
    rest = rest.slice(best);
  }
  return chunks;
}

/**
 * Convert simple HTML (from command responses) to markdown for Feishu.
 * Handles common tags: <b>, <i>, <code>, <br>, entities.
 */
export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build tool progress markdown lines.
 * Each tool shows an icon based on status: 🔄 Running, ✅ Complete, ❌ Error.
 */
export function buildToolProgressMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map((tc) => {
    const icon = tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
    return `${icon} \`${tc.name}\``;
  });
  return lines.join('\n');
}

/**
 * Format elapsed time for card footer.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

/**
 * Build the final card JSON (schema 2.0) with text, tool progress, and footer.
 */
export function buildFinalCardJson(
  text: string,
  tools: ToolCallInfo[],
  footer: { status: string; elapsed: string; ctx?: string } | null,
): string {
  const elements: Array<Record<string, unknown>> = [];

  // Main text content
  let content = preprocessFeishuMarkdown(text);
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    content = content ? `${content}\n\n${toolMd}` : toolMd;
  }

  if (content) {
    elements.push({
      tag: 'markdown',
      content,
      text_align: 'left',
      text_size: 'normal',
    });
  }

  // Footer
  if (footer) {
    const parts: string[] = [];
    if (footer.status) parts.push(footer.status);
    if (footer.elapsed) parts.push(footer.elapsed);
    if (footer.ctx) parts.push(footer.ctx);
    if (parts.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'markdown',
        content: parts.join(' · '),
        text_size: 'notation',
      });
    }
  }

  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      streaming_mode: false,
      summary: { content: `${footer?.status || ''} ${text.replace(/\s+/g, ' ').trim()}`.trim().slice(0, 120) || '任务已结束' },
    },
    body: { elements },
  });
}

// ── Workflow progress card ────────────────────────────────────

/**
 * Build a workflow progress card JSON (schema 2.0).
 *
 * Layout:
 *   [header]  — title with coloured template
 *   [markdown] — progress content (rounds, events)
 *   [column_set] — optional action buttons (Pause/Stop/Report)
 *   [hr + notation] — optional footer (elapsed / status)
 *
 * Used by workflow-command.ts to create & update the single progress card.
 */
export function buildWorkflowCardJson(
  content: string,
  opts: {
    headerTitle?: string;
    headerTemplate?: string;
    footer?: { status: string; elapsed: string } | null;
    /** Run ID for action button callbacks. If set, adds interactive buttons. */
    runId?: string;
    /** Whether the workflow is still running (controls which buttons to show). */
    isRunning?: boolean;
    /** Whether a report is available (shows "View Report" button). */
    hasReport?: boolean;
  } = {},
): string {
  const {
    headerTitle = '🔄 工作流',
    headerTemplate = 'blue',
    footer = null,
    runId,
    isRunning = false,
    hasReport = false,
  } = opts;

  const elements: Array<Record<string, unknown>> = [];

  if (content) {
    elements.push({
      tag: 'markdown',
      content,
      text_align: 'left',
      text_size: 'normal',
    });
  }

  // Action buttons — shown when runId is provided
  if (runId) {
    const buttons: Array<Record<string, unknown>> = [];

    if (isRunning) {
      // Running → show Stop button
      buttons.push({
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '⏹ 停止' },
          type: 'danger',
          size: 'small',
          value: { callback_data: `workflow:stop:${runId}` },
        }],
      });
    }

    if (hasReport) {
      // Report available → show Report button
      buttons.push({
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '📊 查看报告' },
          type: 'primary',
          size: 'small',
          value: { callback_data: `workflow:report:${runId}` },
        }],
      });
    }

    if (!isRunning && runId) {
      // Completed/paused → show Resume button
      buttons.push({
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '▶️ 恢复' },
          type: 'default',
          size: 'small',
          value: { callback_data: `workflow:resume:${runId}` },
        }],
      });
    }

    if (buttons.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_align: 'left',
        columns: buttons,
      });
    }
  }

  if (footer) {
    const parts: string[] = [];
    if (footer.status) parts.push(footer.status);
    if (footer.elapsed) parts.push(footer.elapsed);
    if (parts.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'markdown',
        content: parts.join(' · '),
        text_size: 'notation',
      });
    }
  }

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: headerTitle },
      template: headerTemplate,
      icon: { tag: 'standard_icon', token: 'project-and-task_filled' },
    },
    body: { elements },
  });
}

/**
 * Build a permission card with real action buttons (column_set layout).
 * Structure aligned with CodePilot's working Feishu outbound implementation.
 * Returns the card JSON string for msg_type: 'interactive'.
 */
export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
): string {
  const buttons = [
    { label: '允许一次', type: 'primary', action: 'allow' },
    { label: '本会话允许', type: 'default', action: 'allow_session' },
    { label: '拒绝', type: 'danger', action: 'deny' },
  ];

  const buttonColumns = buttons.map((btn) => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.type,
      size: 'medium',
      value: { callback_data: `perm:${btn.action}:${permissionRequestId}`, ...(chatId ? { chatId } : {}) },
    }],
  }));

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '需要授权' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'lock-chat_filled' },
      padding: '12px 12px 12px 12px',
    },
    body: {
      elements: [
        { tag: 'markdown', content: text, text_size: 'normal' },
        { tag: 'markdown', content: '请在请求有效期间操作。取消、超时或已处理的请求不能重复批准。', text_size: 'notation' },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_align: 'left',
          columns: buttonColumns,
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: '也可回复：`1` 允许一次 · `2` 本会话允许 · `3` 拒绝',
          text_size: 'notation',
        },
      ],
    },
  });
}

/** JSON 2.0 原生表单：用户一次提交全部问题，答案只经回调回传。 */
export function buildUserInputCard(request: UserInputRequest): string {
  const elements: Array<Record<string, unknown>> = [];
  const fields: Record<string, string> = {};
  const multiSelectFields: string[] = [];
  request.questions.forEach((question, index) => {
    const name = `q${index}`;
    fields[name] = question.id;
    elements.push({ tag: 'markdown', content: question.header ? `**${question.header}**\n${question.question}` : question.question });
    if (question.options?.length) {
      if (question.multiSelect) multiSelectFields.push(name);
      elements.push({
        tag: question.multiSelect ? 'multi_select_static' : 'select_static',
        name, required: !question.allowOther,
        placeholder: { tag: 'plain_text', content: question.multiSelect ? '请选择，可多选' : '请选择' },
        options: question.options.map(option => ({ text: { tag: 'plain_text', content: option.label }, value: option.label })),
        width: 'fill',
      });
      const descriptions = question.options.filter(option => option.description).map(option => `**${option.label}**：${option.description}`);
      if (descriptions.length) elements.push({ tag: 'markdown', content: descriptions.join('\n'), text_size: 'notation' });
      if (question.allowOther) elements.push({ tag: 'input', name: `${name}_other`, placeholder: { tag: 'plain_text', content: '其他答案（选填）' }, width: 'fill', max_length: 4_000 });
    } else {
      elements.push({ tag: 'input', name, required: true, placeholder: { tag: 'plain_text', content: '请输入答案' }, width: 'fill', max_length: 4_000 });
    }
  });
  elements.push({
    tag: 'button', name: 'submit_answers', type: 'primary', text: { tag: 'plain_text', content: '提交答案' },
    form_action_type: 'submit',
    behaviors: [{ type: 'callback', value: { user_input_request_id: request.requestId, fields, multi_select_fields: multiSelectFields } }],
  });
  return JSON.stringify({
    schema: '2.0', config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '需要你的选择' }, template: 'blue' },
    body: { elements: [{ tag: 'form', name: 'answers', elements }] },
  });
}
