import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildFinalCardJson } from '../../lib/bridge/markdown/feishu.js';

/**
 * 集成测试: 覆盖 buildFinalCardJson 的 ctx footer 渲染链路。
 *
 * 这一层紧挨着 adapter 的 onStreamEnd → finalizeCard 出口，
 * 因此是 bridge-manager → adapter → card JSON 链路中最易验证、信号最强的一环。
 */
describe('buildFinalCardJson — ctx footer integration', () => {
  it('appends ctx as the third · segment after status and elapsed', () => {
    const json = buildFinalCardJson('Hello world', [], {
      status: '✅ Completed',
      elapsed: '3.2s',
      ctx: 'ctx 42% (84k/200k)',
    });

    const parsed = JSON.parse(json);
    const elements = parsed.body.elements as Array<Record<string, unknown>>;

    // 至少应包含: [正文 markdown] + [hr] + [footer markdown]
    assert.ok(elements.length >= 3, `expected >= 3 elements, got ${elements.length}`);

    const footerEl = elements[elements.length - 1];
    assert.equal(footerEl.tag, 'markdown');
    assert.equal(footerEl.text_size, 'notation');

    const content = String(footerEl.content);
    // 顺序: status · elapsed · ctx
    assert.equal(content, '✅ Completed · 3.2s · ctx 42% (84k/200k)');
  });

  it('omits ctx segment when not provided (backward compatible)', () => {
    const json = buildFinalCardJson('Hello', [], {
      status: '✅ Completed',
      elapsed: '1s',
    });

    const parsed = JSON.parse(json);
    const elements = parsed.body.elements as Array<Record<string, unknown>>;
    const footerEl = elements[elements.length - 1];

    assert.equal(String(footerEl.content), '✅ Completed · 1s');
    assert.ok(!String(footerEl.content).includes('ctx'));
  });

  it('skips ctx when string is empty (treated as absent)', () => {
    const json = buildFinalCardJson('Hello', [], {
      status: '✅ Completed',
      elapsed: '1s',
      ctx: '',
    });

    const parsed = JSON.parse(json);
    const elements = parsed.body.elements as Array<Record<string, unknown>>;
    const footerEl = elements[elements.length - 1];

    assert.equal(String(footerEl.content), '✅ Completed · 1s');
  });

  it('renders footer with only ctx when status/elapsed are empty', () => {
    const json = buildFinalCardJson('', [], {
      status: '',
      elapsed: '',
      ctx: 'ctx 5% (10k/200k)',
    });

    const parsed = JSON.parse(json);
    const elements = parsed.body.elements as Array<Record<string, unknown>>;

    // 只有一行 ctx 时，仍应产出 hr + notation markdown（不是空卡）
    const footerEl = elements[elements.length - 1];
    assert.equal(footerEl.tag, 'markdown');
    assert.equal(footerEl.text_size, 'notation');
    assert.equal(String(footerEl.content), 'ctx 5% (10k/200k)');

    // 倒数第二个元素应是分隔线
    const beforeFooter = elements[elements.length - 2];
    assert.equal(beforeFooter.tag, 'hr');
  });

  it('does not render footer block when footer object is null', () => {
    const json = buildFinalCardJson('Just text', [], null);

    const parsed = JSON.parse(json);
    const elements = parsed.body.elements as Array<Record<string, unknown>>;

    // 仅正文 markdown，无 hr / 无 notation footer
    const hasHr = elements.some((e) => e.tag === 'hr');
    const hasNotation = elements.some((e) => e.text_size === 'notation');
    assert.equal(hasHr, false);
    assert.equal(hasNotation, false);
  });

  it('does not render footer block when all fields are empty', () => {
    const json = buildFinalCardJson('Body', [], { status: '', elapsed: '' });

    const parsed = JSON.parse(json);
    const elements = parsed.body.elements as Array<Record<string, unknown>>;

    const hasHr = elements.some((e) => e.tag === 'hr');
    assert.equal(hasHr, false);
  });
});
