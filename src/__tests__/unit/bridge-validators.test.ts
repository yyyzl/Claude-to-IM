/**
 * Unit tests for bridge security validators.
 *
 * Focus:
 * - validateWorkingDirectory() path rules and character restrictions
 * - validateSessionId() format checks
 * - sanitizeInput() control-char stripping and truncation
 * - isDangerousInput() detection of obviously dangerous patterns
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
  validateWorkingDirectory,
  validateSessionId,
  sanitizeInput,
  isDangerousInput,
} from '../../lib/bridge/security/validators';

describe('security/validators', () => {
  describe('validateWorkingDirectory()', () => {
    it('rejects relative paths', () => {
      assert.equal(validateWorkingDirectory('not/absolute'), null);
    });

    it('rejects traversal segments', () => {
      // 注意：path.join 会把 '..' 归一化掉，因此这里要构造“原始包含 .. 段”的字符串
      const p = process.cwd() + path.sep + 'a' + path.sep + '..' + path.sep + 'b';
      assert.equal(validateWorkingDirectory(p), null);
    });

    it('accepts absolute paths with parentheses', () => {
      const p = path.join(process.cwd(), 'my project (2026)');
      const out = validateWorkingDirectory(p);
      assert.ok(out);
      assert.equal(out, path.normalize(p));
    });

    it('rejects shell metacharacters', () => {
      const p = path.join(process.cwd(), 'a&b');
      assert.equal(validateWorkingDirectory(p), null);
    });

    it('rejects null bytes', () => {
      const p = path.join(process.cwd(), 'ok') + '\0';
      assert.equal(validateWorkingDirectory(p), null);
    });
  });

  describe('validateSessionId()', () => {
    it('accepts UUID-like ids', () => {
      assert.equal(validateSessionId('550e8400-e29b-41d4-a716-446655440000'), true);
    });

    it('accepts 32-hex ids', () => {
      assert.equal(validateSessionId('0123456789abcdef0123456789abcdef'), true);
    });

    it('rejects short or non-hex ids', () => {
      assert.equal(validateSessionId('abc'), false);
      assert.equal(validateSessionId('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), false);
    });
  });

  describe('sanitizeInput()', () => {
    it('strips control characters but keeps newline and tab', () => {
      const raw = `a\u0001b\nc\td`;
      const { text, truncated } = sanitizeInput(raw, 100);
      assert.equal(text, 'ab\nc\td');
      assert.equal(truncated, false);
    });

    it('truncates long input', () => {
      const raw = 'x'.repeat(10);
      const { text, truncated } = sanitizeInput(raw, 5);
      assert.equal(text.length, 5);
      assert.equal(truncated, true);
    });
  });

  describe('isDangerousInput()', () => {
    it('flags null bytes', () => {
      const r = isDangerousInput('ok\0no');
      assert.equal(r.dangerous, true);
      assert.ok(r.reason);
    });

    it('flags path traversal patterns', () => {
      const r = isDangerousInput('../etc/passwd');
      assert.equal(r.dangerous, true);
      assert.ok(r.reason);
    });

    it('does not flag normal short text', () => {
      const r = isDangerousInput('hello world');
      assert.equal(r.dangerous, false);
    });
  });
});
