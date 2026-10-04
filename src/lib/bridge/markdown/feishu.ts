import type { ModelSelectionResponse, ModelSelectionView, ToolCallInfo } from '../types.js';
import type { UserInputRequest } from '../host.js';
import { findFastServiceTier } from '../internal/model-capabilities.js';

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

/** 飞书选项必须有非空 value，核心仍使用空字符串表示跟随模型默认。 */
export const MODEL_DEFAULT_EFFORT_OPTION = '__model_default__';

/** 两步原生表单；只展示核心提供的目录页，最终提交前不改变聊天偏好。 */
export function buildModelSelectionCard(view: ModelSelectionView): string {
  const plain = (content: string) => ({ tag: 'plain_text', content });
  const shortLabel = (label: string) => Array.from(label).slice(0, 100).join('');
  const button = (action: ModelSelectionResponse['action'], label: string, submit = false) => ({
    tag: 'button', name: `model_${action}`, type: submit ? 'primary' : 'default', text: plain(label),
    ...(submit ? { form_action_type: 'submit' } : {}),
    behaviors: [{ type: 'callback', value: {
      model_selection_request_id: view.requestId,
      model_selection_revision: view.revision,
      model_selection_action: action,
    } }],
  });
  const select = (name: string, label: string, options: Array<{ value: string; label: string }>, selected: string) => ({
    tag: 'select_static', name, required: true, width: 'fill',
    placeholder: plain(label),
    options: options.map(option => ({ value: option.value, text: plain(shortLabel(option.label)) })),
    ...(options.some(option => option.value === selected) ? { initial_option: selected } : {}),
  });
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: view.summary },
    { tag: 'markdown', content: '当前聊天生效，/new 后保留；应用后从下一轮开始使用。', text_size: 'notation' },
  ];
  if (view.notice) elements.push({ tag: 'markdown', content: view.notice });
  if (view.step === 'model') {
    const models = [...view.models];
    // 翻页时仍保留当前已选项，不能把页外选择悄悄变成“跟随默认”。
    if (view.selectedModel !== 'default' && view.selectedModelEntry && !models.some(model => model.id === view.selectedModel)) {
      models.unshift(view.selectedModelEntry);
    }
    const options = [{ value: 'default', label: '跟随目录默认模型' }];
    for (const model of models) {
      if (!options.some(option => option.value === model.id)) options.push({ value: model.id, label: `${model.displayName} · ${model.model}${model.isDefault ? '（目录默认）' : ''}` });
    }
    elements.push({ tag: 'markdown', content: `**第一步：选择模型** · 第 ${view.page + 1} / ${view.pageCount} 页` });
    elements.push({ tag: 'form', name: 'model_selection', elements: [
      select('model', '请选择模型', options, view.selectedModel), button('next', '下一步：强度与速度', true),
    ] });
    if (view.page > 0) elements.push(button('previous_page', '上一页'));
    if (view.page + 1 < view.pageCount) elements.push(button('next_page', '下一页'));
    elements.push(button('refresh', '刷新模型目录'), button('cancel', '取消'));
  } else if (view.step === 'settings') {
    const model = view.selectedModelEntry;
    if (!model) throw new Error('所选模型不在目录中，请刷新后重新选择。');
    const efforts = [{ value: MODEL_DEFAULT_EFFORT_OPTION, label: `跟随模型默认（${model.defaultReasoningEffort}）` }];
    for (const effort of model.supportedReasoningEfforts) {
      if (!efforts.some(option => option.value === effort.reasoningEffort)) efforts.push({ value: effort.reasoningEffort, label: `${effort.reasoningEffort}${effort.description ? ` · ${effort.description}` : ''}` });
    }
    const speeds = [{ value: 'normal', label: '正常' }];
    if (findFastServiceTier(model)) speeds.push({ value: 'fast', label: 'Fast（更高用量）' });
    const selectedEffort = view.reasoningEffort || MODEL_DEFAULT_EFFORT_OPTION;
    if (!efforts.some(option => option.value === selectedEffort) || !speeds.some(option => option.value === view.speed)) {
      elements.push({ tag: 'markdown', content: '之前的强度或速度不在当前目录选项中，请刷新或重新选择后应用。' });
    }
    elements.push({ tag: 'markdown', content: `**第二步：强度与速度**\n模型：${model.model}${view.selectedModel === 'default' ? '（跟随目录默认）' : ''}` });
    elements.push({ tag: 'form', name: 'model_settings', elements: [
      { tag: 'markdown', content: '**思考强度**' },
      select('reasoning_effort', '请选择思考强度', efforts, selectedEffort),
      { tag: 'markdown', content: '**速度**' },
      select('speed', '请选择速度', speeds, view.speed),
      { tag: 'markdown', content: speeds.length > 1 ? 'Fast 会消耗更多用量；实际可用性由当前账号与服务端决定。' : '此模型的目录未提供 Fast 选项，可刷新目录后重试。', text_size: 'notation' },
      button('apply', '应用到当前聊天', true),
    ] });
    elements.push(button('back', '返回选择模型'), button('cancel', '取消'));
  }
  const title = { model: 'Codex 模型设置', settings: 'Codex 模型设置', applied: '模型设置已应用', cancelled: '模型设置已取消', expired: '模型设置已过期' }[view.step];
  return JSON.stringify({
    schema: '2.0', config: { wide_screen_mode: true },
    header: { title: plain(title), template: view.step === 'applied' ? 'green' : 'blue' },
    body: { elements },
  });
}
