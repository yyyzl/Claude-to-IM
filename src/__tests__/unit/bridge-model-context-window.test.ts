import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONTEXT_WINDOW,
  resolveContextWindow,
  totalInputTokens,
  formatTokenShort,
  formatCtxFooter,
} from '../../lib/bridge/internal/model-context-window.js';

describe('resolveContextWindow', () => {
  it('matches claude-sonnet-4 prefix with date suffix', () => {
    assert.equal(resolveContextWindow('claude-sonnet-4-5-20250929'), 1_000_000);
  });

  it('matches claude-opus-4 prefix case-insensitive', () => {
    assert.equal(resolveContextWindow('Claude-Opus-4-1'), 1_000_000);
  });

  it('matches claude-3-5-sonnet before generic claude-3', () => {
    assert.equal(resolveContextWindow('claude-3-5-sonnet-20240620'), 1_000_000);
  });

  it('returns null for unknown model', () => {
    assert.equal(resolveContextWindow('gpt-4o-mini'), null);
  });

  it('returns null for empty / nullish input', () => {
    assert.equal(resolveContextWindow(''), null);
    assert.equal(resolveContextWindow(null), null);
    assert.equal(resolveContextWindow(undefined), null);
  });

  it('exposes a sane default (>= 100k)', () => {
    assert.ok(DEFAULT_CONTEXT_WINDOW >= 100_000);
  });
});

describe('totalInputTokens', () => {
  it('sums input + cache_creation + cache_read', () => {
    const n = totalInputTokens({
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 4000,
    });
    assert.equal(n, 5200);
  });

  it('treats missing cache fields as 0', () => {
    const n = totalInputTokens({ input_tokens: 1000, output_tokens: 50 });
    assert.equal(n, 1000);
  });

  it('clamps negative / non-finite numbers to 0', () => {
    const n = totalInputTokens({
      input_tokens: -10,
      output_tokens: 0,
      cache_creation_input_tokens: Number.NaN,
      cache_read_input_tokens: Number.POSITIVE_INFINITY,
    });
    assert.equal(n, 0);
  });

  it('returns 0 for null / undefined usage', () => {
    assert.equal(totalInputTokens(null), 0);
    assert.equal(totalInputTokens(undefined), 0);
  });
});

describe('formatTokenShort', () => {
  it('passes through values < 1000 (rounded)', () => {
    assert.equal(formatTokenShort(0), '0');
    assert.equal(formatTokenShort(42), '42');
    assert.equal(formatTokenShort(999), '999');
    assert.equal(formatTokenShort(999.4), '999');
  });

  it('formats >= 1000 as k with 1 decimal, stripping trailing .0', () => {
    assert.equal(formatTokenShort(1000), '1k');
    assert.equal(formatTokenShort(6708), '6.7k');
    assert.equal(formatTokenShort(84_000), '84k');
    assert.equal(formatTokenShort(200_000), '200k');
    assert.equal(formatTokenShort(258_400), '258.4k');
  });

  it('returns "0" on non-finite / negative input', () => {
    assert.equal(formatTokenShort(Number.NaN), '0');
    assert.equal(formatTokenShort(-5), '0');
    assert.equal(formatTokenShort(Number.POSITIVE_INFINITY), '0');
  });
});

describe('formatCtxFooter', () => {
  it('renders canonical footer string', () => {
    const out = formatCtxFooter(
      { input_tokens: 6708, output_tokens: 51, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      258_400,
    );
    assert.equal(out, 'ctx 3% (6.7k/258.4k)');
  });

  it('rounds percentage to nearest integer', () => {
    // 84_000 / 200_000 = 42% exact
    const exact = formatCtxFooter(
      { input_tokens: 84_000, output_tokens: 0 },
      200_000,
    );
    assert.equal(exact, 'ctx 42% (84k/200k)');

    // 85_500 / 200_000 = 42.75 → rounds to 43
    const rounded = formatCtxFooter(
      { input_tokens: 85_500, output_tokens: 0 },
      200_000,
    );
    assert.equal(rounded, 'ctx 43% (85.5k/200k)');
  });

  it('includes cache tokens in the ratio', () => {
    const out = formatCtxFooter(
      {
        input_tokens: 10_000,
        output_tokens: 0,
        cache_creation_input_tokens: 10_000,
        cache_read_input_tokens: 80_000,
      },
      200_000,
    );
    // total = 100_000 → 50%
    assert.equal(out, 'ctx 50% (100k/200k)');
  });

  it('caps percentage at 999% to avoid overflow', () => {
    const out = formatCtxFooter(
      { input_tokens: 5_000_000_000, output_tokens: 0 },
      200_000,
    );
    assert.ok(out && out.startsWith('ctx 999%'), `expected cap, got ${out}`);
  });

  it('returns null when usage is empty / total input is 0', () => {
    assert.equal(formatCtxFooter(null, 200_000), null);
    assert.equal(formatCtxFooter(undefined, 200_000), null);
    assert.equal(formatCtxFooter({ input_tokens: 0, output_tokens: 0 }, 200_000), null);
  });

  it('returns null when window is non-positive / non-finite', () => {
    const usage = { input_tokens: 1000, output_tokens: 0 };
    assert.equal(formatCtxFooter(usage, 0), null);
    assert.equal(formatCtxFooter(usage, -1), null);
    assert.equal(formatCtxFooter(usage, Number.NaN), null);
  });
});
