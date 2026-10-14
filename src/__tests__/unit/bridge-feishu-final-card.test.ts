/** 终态回答为主，唯一状态行与折叠过程承担不同的信息层级。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgressCardJson, fitProgressView } from '../../lib/bridge/markdown/feishu-progress.js';

import type { ProgressViewInput } from '../../lib/bridge/markdown/feishu-progress.js';

function completed(input: Partial<ProgressViewInput> = {}) {
  const view = fitProgressView({ text: '完整答复', tools: [], progress: '', notice: '', status: 'completed', elapsed: '3.2s', ...input });
  assert.ok(view);
  return view;
}

describe('简洁的完成态卡片', () => {
  it('答复下只一处完成状态和耗时，统计、ctx和追加详情均收进过程', () => {
    const view = completed({ ctx: 'ctx 42% (84k/200k)', notice: '📎 **+2 追加** 补充测试', tools: [
      { id: 'old', name: '已恢复的失败', status: 'error' }, { id: 'done', name: '完成的检查', status: 'complete' },
    ] });
    assert.equal(view.streaming_content, '完整答复');
    assert.equal(view.task_status, '✅ 已完成 · 3.2s');
    assert.match(view.history_content, /已完成 1 · 失败 1/);
    assert.match(view.history_content, /ctx 42%/); assert.match(view.history_content, /\+2 追加/);
    assert.match(view.history_content, /已恢复的失败/); assert.match(view.history_content, /完成的检查/);
    assert.deepEqual(Object.keys(view), ['streaming_content', 'task_status', 'history_content']);
  });
  it('ctx缺省或为空不产生占位行，无可读过程保持空白以供收尾删除入口', () => {
    for (const ctx of [undefined, '']) {
      const view = completed({ ctx });
      assert.equal(view.task_status, '✅ 已完成 · 3.2s');
      assert.equal(view.history_content.trim(), '');
      assert.doesNotMatch(JSON.stringify(view), /尚无工具|执行详情|执行中 0|失败 0/);
    }
  });
  it('即使空正文或缺耗时也有唯一明确终态，ctx只有过程内可见', () => {
    const view = completed({ text: '', elapsed: undefined, ctx: 'ctx 5% (10k/200k)' });
    assert.equal(view.streaming_content, ' '); assert.equal(view.task_status, '✅ 已完成');
    assert.equal(view.history_content, 'ctx 5% (10k/200k)');
  });
  it('固定树只预留3个Markdown，正文大小正常，其余低调且间距明确', () => {
    const card = JSON.parse(buildProgressCardJson(completed({ ctx: 'ctx 5%' })));
    assert.equal(card.body.vertical_spacing, '8px');
    assert.deepEqual(card.body.elements.map((element: { element_id: string }) => element.element_id), ['streaming_content', 'task_status', 'progress_history']);
    const [body, status, panel] = card.body.elements;
    assert.equal(body.text_size, 'normal'); assert.equal(status.text_size, 'notation');
    for (const leaf of [body, status, ...panel.elements]) assert.equal(leaf.margin, '0px');
    assert.equal(panel.header.title.content, '执行过程'); assert.equal(panel.expanded, false);
    assert.equal(panel.elements[0].element_id, 'history_content');
    assert.doesNotMatch(JSON.stringify(card), /tool_progress|history_summary|append_notice|task_footer/);
  });
  it('运行实时信号仍常显，结束后普通追加归档但超限分段提醒仍常显', () => {
    const running = fitProgressView({ text: '', tools: [{ id: 'run', name: '实际运行的检查', status: 'running' }], progress: '正在核对结果', notice: '追加已接收', elapsed: '5s' });
    assert.ok(running); assert.match(running.task_status, /正在执行/); assert.match(running.task_status, /实际运行的检查/);
    assert.match(running.task_status, /正在核对结果/); assert.match(running.task_status, /追加已接收/);
    const view = completed({ notice: '追加已接收', continuation: '完整回答将在下方分段发送。' });
    assert.equal(view.task_status, '✅ 已完成 · 3.2s\n完整回答将在下方分段发送。');
    assert.equal(view.history_content, '追加已接收');
  });
});
