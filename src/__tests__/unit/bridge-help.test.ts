import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildClaudePassthroughHelp } from '../../lib/bridge/internal/passthrough-help.js';
import { buildBridgeCommandHelp } from '../../lib/bridge/internal/bridge-help.js';

describe('bridge help text', () => {
  it('includes finish-work in Claude passthrough help', () => {
    const help = buildClaudePassthroughHelp();

    assert.match(help, /\/\/trellis:finish-work/);
  });

  it('includes finish-work in bridge /help output', () => {
    const help = buildBridgeCommandHelp();

    assert.match(help, /\/\/trellis:finish-work/);
  });
});
