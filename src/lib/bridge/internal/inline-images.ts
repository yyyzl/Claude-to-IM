/** 只处理正文真实 Markdown 图片；文件访问限定在当前工作目录。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import type { GeneratedImage, InlineResponseImage } from '../host.js';
import { createGeneratedImage, checkGeneratedImageBudget, MAX_GENERATED_IMAGE_BYTES } from './generated-image.js';

export interface MarkdownImageSpan { start: number; end: number; source: string; alt: string; title?: string }
const markdown = new MarkdownIt({ html: false });
const validateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = url => /^file:/i.test(url) || validateLink(url);
const imageRule = markdown.inline.ruler.getRules('').find(rule => rule.name === 'image');
if (!imageRule) throw new Error('Markdown 图片解析器不可用');
markdown.inline.ruler.at('image', (state, silent) => {
  const start = state.pos;
  const accepted = imageRule(state, silent);
  if (accepted && !silent) {
    const token = state.tokens.at(-1);
    if (token?.type === 'image') token.meta = { start, end: state.pos };
  }
  return accepted;
});

// 表格 inline 没有行号，且块解析会去掉转义竖线前的反斜杠；在块规则处保存单元格来源。
const tableRule = markdown.block.ruler.getRules('').find(rule => rule.name === 'table');
if (!tableRule) throw new Error('Markdown 表格解析器不可用');
markdown.block.ruler.at('table', (state, startLine, endLine, silent) => {
  const firstToken = state.tokens.length;
  const accepted = tableRule(state, startLine, endLine, silent);
  if (!accepted || silent) return accepted;
  let row = 0; let column = 0; let rowLineStart = 0; let cells: number[][] = [];
  for (const token of state.tokens.slice(firstToken)) {
    if (token.type === 'tr_open' && token.map) {
      row = token.map[0]; column = 0; cells = [[]];
      const begin = state.bMarks[row] + state.tShift[row];
      const raw = state.src.slice(begin, state.eMarks[row]);
      const trimmed = raw.trim();
      rowLineStart = state.src.lastIndexOf('\n', begin - 1) + 1;
      const offset = begin + raw.length - raw.trimStart().length - rowLineStart;
      for (let index = 0; index < trimmed.length; index++) {
        if (trimmed[index] === '|') {
          if (trimmed[index - 1] !== '\\') { cells.push([]); continue; }
          cells.at(-1)!.pop();
        }
        cells.at(-1)!.push(offset + index);
      }
      if (!cells[0].length) cells.shift();
      if (!cells.at(-1)?.length) cells.pop();
    } else if (token.type === 'inline') {
      const positions = cells[column++] ?? [];
      while (positions.length && /\s/.test(state.src[rowLineStart + positions[0]])) positions.shift();
      token.meta = { tableLine: row, tableOffsets: positions.slice(0, token.content.length) };
    }
  }
  return accepted;
});

/** 将解析器中的行内位置映射回原文，代码节点不会进入图片规则。 */
export function markdownImageSpans(text: string): MarkdownImageSpan[] {
  const lines = text.split('\n'); const lineStarts = [0];
  for (let index = 0; index < lines.length; index++) lineStarts.push(lineStarts[index] + lines[index].length + 1);
  const spans: MarkdownImageSpan[] = [];
  for (const token of markdown.parse(text, {})) {
    if (token.type !== 'inline' || !token.children?.some(child => child.type === 'image')) continue;
    const table = token.meta as { tableLine: number; tableOffsets: number[] } | null;
    const offsets: number[] = table?.tableOffsets ? table.tableOffsets.map(offset => lineStarts[table.tableLine] + offset) : [];
    if (!table?.tableOffsets && token.map) {
      let cursor = lineStarts[token.map[0]]; const limit = lineStarts[token.map[1]] ?? text.length;
      for (const line of token.content.split('\n')) {
        const found = text.indexOf(line, cursor);
        if (found < cursor || found + line.length > limit) break;
        for (let index = 0; index < line.length; index++) offsets.push(found + index);
        offsets.push(found + line.length); cursor = found + line.length + 1;
      }
    }
    for (const child of token.children) {
      if (child.type !== 'image' || !child.meta) continue;
      const { start, end } = child.meta as { start: number; end: number };
      if (offsets[start] === undefined || offsets[end - 1] === undefined) continue;
      // 表格块规则反转义竖线；图片说明取原始标签范围，避免重建时破坏分列。
      const alt = table?.tableOffsets && child.content.length
        ? text.slice(offsets[start + 2], offsets[start + 1 + child.content.length] + 1) : child.content;
      spans.push({ start: offsets[start], end: offsets[end - 1] + 1, source: child.attrGet('src') || '', alt, title: child.attrGet('title') || undefined });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

function localSource(source: string): boolean {
  if (/^(?:img_|bridge-inline-)[A-Za-z0-9_-]+$/.test(source)) return false;
  if (/^[a-z]:[/\\]/i.test(source) || /^file:/i.test(source)) return true;
  return !/^[a-z][a-z\d+.-]*:/i.test(source) && !source.startsWith('//');
}
function description(alt: string, reason: string): string {
  return `[图片${alt ? `：${alt.replace(/\\([\\\[\]|])/g, '$1').replace(/[\[\]\\\r\n]/g, ' ').replace(/\|/g, '\\|')}` : ''}（${reason}）]`;
}
function titleSuffix(title?: string): string {
  return title ? ` "${title.replace(/([\\"|])/g, '\\$1').replace(/[\r\n]/g, ' ')}"` : '';
}
function replaceSpans(text: string, replacements: Array<{ start: number; end: number; value: string }>): string {
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) text = text.slice(0, replacement.start) + replacement.value + text.slice(replacement.end);
  return text;
}

/** 运行态只隐藏本地图片语法，不访问磁盘，也不隐藏代码示例。 */
export function describePendingInlineImages(text: string): string {
  return replaceSpans(text, markdownImageSpans(text).filter(span => localSource(span.source)).map(span => ({ ...span, value: description(span.alt, '等待上传') })));
}

export async function snapshotInlineImages(text: string, workingDirectory?: string, budget: { count: number; bytes: number; images?: GeneratedImage[] } = { count: 0, bytes: 0 }): Promise<{ text: string; images: InlineResponseImage[] }> {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const images = new Map<string, InlineResponseImage>();
  let root: string | undefined;
  try { if (workingDirectory) root = await fs.realpath(workingDirectory); } catch { /* 对应图片以工作目录说明替代。 */ }
  for (const span of markdownImageSpans(text)) {
    if (!localSource(span.source)) continue;
    let replacement: string;
    try {
      if (!root) throw new Error('缺少有效工作目录');
      let source: string;
      try { source = /^file:/i.test(span.source) ? fileURLToPath(span.source) : decodeURIComponent(span.source); }
      catch { throw new Error('图片路径无效'); }
      const target = path.resolve(root, source);
      const within = (file: string) => { const relative = path.relative(root, file); return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
      if (!within(target)) throw new Error('图片超出工作目录');
      if (path.extname(target).toLowerCase() !== '.png') throw new Error('仅支持 PNG 图片');
      let resolved: string;
      try { resolved = await fs.realpath(target); } catch { throw new Error('文件不存在或读取失败'); }
      if (!within(resolved)) throw new Error('图片超出工作目录');
      const handle = await fs.open(resolved, 'r');
      let data: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('图片不是普通文件');
        if (stat.size > MAX_GENERATED_IMAGE_BYTES) throw new Error('图片超过单张 10 MB 限额');
        // 限定实际读取长度，文件增长也不能导致无界内存读取。
        const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_GENERATED_IMAGE_BYTES + 1));
        let length = 0;
        while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
        if (length > stat.size) throw new Error('图片读取期间发生变化');
        data = bytes.subarray(0, length);
      } finally { await handle.close(); }
      const digest = createHash('sha256').update(data).digest('hex');
      const id = createHash('sha256').update(resolved).update(digest).digest('hex');
      const image = createGeneratedImage(`inline-${id}`, data.toString('base64'));
      let item = images.get(image.id);
      if (!item) {
        const accepted = [...images.values()].map(value => value.image).concat(image);
        const absorbed = (budget.images ?? []).filter(value => accepted.some(item => item.sha256 === value.sha256));
        checkGeneratedImageBudget(budget.count - absorbed.length + accepted.length, budget.bytes - absorbed.reduce((sum, item) => sum + item.byteLength, 0) + accepted.reduce((sum, item) => sum + item.byteLength, 0));
        item = { image, marker: `bridge-inline-${id}` }; images.set(image.id, item);
      }
      const alt = span.alt.replace(/[\r\n]/g, ' ');
      replacement = `![${alt}](${item.marker}${titleSuffix(span.title)})`;
    } catch (error) {
      replacement = description(span.alt, error instanceof Error && !('code' in error) ? error.message : '文件读取失败');
    }
    replacements.push({ ...span, value: replacement });
  }
  return { text: replaceSpans(text, replacements), images: [...images.values()] };
}

/** marker 来自快照；按解析出的节点替换，不改代码或普通文本中的同名标记。 */
export function renderInlineImages(text: string, images: InlineResponseImage[], pending = false): string {
  const byMarker = new Map(images.map(image => [image.marker, image]));
  return replaceSpans(text, markdownImageSpans(text).flatMap(span => {
    const image = byMarker.get(span.source); if (!image) return [];
    if (pending) return [{ ...span, value: description(span.alt, '图片待补发') }];
    if (span.source === image.imageKey) return [];
    // 快照统一使用行内图片；只替换节点中的目的地，保留 alt/title 的原始转义。
    const raw = text.slice(span.start, span.end);
    const sourceStart = raw.lastIndexOf(`](${span.source}`) + 2;
    if (sourceStart < 2) throw new Error('正文图片标记格式无效');
    return [{ ...span, value: raw.slice(0, sourceStart) + image.imageKey + raw.slice(sourceStart + span.source.length) }];
  }));
}
