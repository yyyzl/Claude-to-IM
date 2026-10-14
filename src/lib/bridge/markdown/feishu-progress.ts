/** 飞书过程卡的固定布局与有界展示；不收集工具日志，也不改变完整回答。 */
import type { ToolCallInfo } from '../types.js';

export const FEISHU_CARD_BYTES = 30_000;
const RECENT_TOOLS = 3;
const ACTIVE_PREVIEWS = 2;
const MAX_HISTORY_TOOLS = 80;
const MAX_HISTORY_NAME = 2_400;
const MAX_LIVE_NAME = 160;
const MAX_PROGRESS = 1_200;
export type ProgressView = Record<'streaming_content' | 'task_status' | 'history_content', string>;
export interface ProgressViewInput {
  text: string;
  /** 由适配器按最近实际字段变化排序的不可变快照。 */
  tools: ToolCallInfo[];
  progress: string;
  notice: string;
  elapsed?: string;
  ctx?: string;
  status?: 'completed' | 'interrupted' | 'error';
  /** 预览或最终回答需要后续分段时的可见说明，与普通追加详情分开。 */
  continuation?: string;
}

function shorten(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join('') + '…（摘要）';
}
function toolLine(tool: ToolCallInfo, limit: number): string {
  const icon = tool.status === 'running' ? '🔄' : tool.status === 'complete' ? '✅' : '❌';
  const name = shorten(tool.name.replace(/\s+/g, ' ').replace(/`/g, 'ˋ'), limit);
  return `${icon} \`${name}\``;
}

/** 父面板仅初建时出现，后续写入只定位 Markdown 的 content。 */
export function buildProgressCardJson(view: ProgressView): string {
  const markdown = (id: keyof ProgressView) => ({ tag: 'markdown', element_id: id, content: view[id] || ' ', text_size: id === 'streaming_content' ? 'normal' : 'notation', margin: '0px' });
  return JSON.stringify({
    schema: '2.0',
    config: {
      // 配置更新会重置客户端展开状态；摘要从创建起保持中性且不再更新。
      streaming_mode: false, wide_screen_mode: true, summary: { content: '任务回复' },
    },
    body: { vertical_spacing: '8px', elements: [
      markdown('streaming_content'), markdown('task_status'),
      { tag: 'collapsible_panel', element_id: 'progress_history', expanded: false,
        header: { title: { tag: 'plain_text', content: '执行过程' }, icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' }, icon_position: 'right', icon_expanded_angle: -180 },
        elements: [markdown('history_content')] },
    ] },
  });
}

/** 先缩小内容，再增长内容；不依赖 batch 的事务原子性。 */
export function progressActions(previous: ProgressView, next: ProgressView): Array<{ action: 'partial_update_element'; params: { element_id: keyof ProgressView; partial_element: { content: string } } }> {
  return (Object.keys(next) as Array<keyof ProgressView>)
    .filter(id => previous[id] !== next[id])
    .sort((a, b) => progressContentBytes(next[a]) - progressContentBytes(previous[a])
      - (progressContentBytes(next[b]) - progressContentBytes(previous[b])))
    .map(id => ({ action: 'partial_update_element', params: { element_id: id, partial_element: { content: next[id] || ' ' } } }));
}

/** content 在实体/请求中作为 JSON 字符串再次转义后的预算。 */
export function progressContentBytes(content: string): number {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(content)), 'utf8');
}

function fits(view: ProgressView): boolean {
  // 包括固定配置、完整实体和actions字符串再次转义；平台ID/sequence按保守上界计算。
  const entity = { type: 'card_json', data: buildProgressCardJson(view) };
  const request = { path: { card_id: 'x'.repeat(256) }, data: { actions: JSON.stringify(progressActions(Object.fromEntries(Object.keys(view).map(id => [id, ''])) as ProgressView, view)), sequence: Number.MAX_SAFE_INTEGER } };
  return Math.max(Buffer.byteLength(JSON.stringify(entity)), Buffer.byteLength(JSON.stringify(request))) <= FEISHU_CARD_BYTES;
}

/** 历史优先让出预算，实时摘要其次；最终正文始终原样，否则返回 null 交回完整分段。 */
export function fitProgressView(input: ProgressViewInput): ProgressView | null {
  const running = input.tools.filter(tool => tool.status === 'running');
  const errors = input.tools.filter(tool => tool.status === 'error');
  const completed = input.tools.filter(tool => tool.status === 'complete').length;
  const recent = input.status ? [] : input.tools.slice(0, RECENT_TOOLS);
  const visible = input.status === 'completed' ? []
    : [...new Map([...errors.slice(0, ACTIVE_PREVIEWS), ...(input.status ? [] : running.slice(0, ACTIVE_PREVIEWS)), ...recent].map(tool => [tool.id, tool])).values()];
  const labels = { completed: '✅ 已完成', interrupted: '⚠️ 已中断', error: '❌ 出错' };
  const currentStatus = input.status ? labels[input.status] : running.length ? '🔄 正在执行，等待工具结果' : '⏳ 任务进行中';
  const counts = `执行中 ${running.length} · 已完成 ${completed} · 失败 ${errors.length}`;
  let historyCount = Math.min(input.tools.length, MAX_HISTORY_TOOLS);
  let historyName = MAX_HISTORY_NAME;
  let progressLimit = MAX_PROGRESS;
  let liveName = MAX_LIVE_NAME;
  for (;;) {
    const history = input.tools.slice(0, historyCount).map(tool => toolLine(tool, historyName)).join('\n');
    const compact = historyCount < input.tools.length || input.tools.slice(0, historyCount).some(tool => Array.from(tool.name).length > historyName);
    const view: ProgressView = {
      streaming_content: input.text || ' ',
      task_status: [
        input.status
          ? `${labels[input.status]}${input.elapsed ? ` · ${input.elapsed}` : ''}`
          : `${currentStatus}${input.elapsed ? ` · 已用时 ${input.elapsed}` : ''}${input.tools.length ? ` · ${counts}` : ''}`,
        input.status ? '' : shorten(input.progress, progressLimit),
        ...visible.map(tool => toolLine(tool, liveName)),
        input.status ? '' : input.notice,
        input.continuation,
      ].filter(Boolean).join('\n'),
      history_content: [
        input.tools.length ? counts : '',
        compact ? `历史已精简，显示最近 ${historyCount} 个步骤摘要。` : '',
        input.ctx,
        input.notice,
        history,
      ].filter(Boolean).join('\n') || ' ',
    };
    if (fits(view)) return view;
    if (historyCount > 1) { historyCount = Math.floor(historyCount / 2); continue; }
    if (historyCount && historyName > 80) { historyName = Math.floor(historyName / 2); continue; }
    if (historyCount) { historyCount = 0; continue; }
    if (progressLimit > 80) { progressLimit = Math.floor(progressLimit / 2); continue; }
    if (liveName > 20) { liveName = Math.floor(liveName / 2); continue; }
    return null;
  }
}
