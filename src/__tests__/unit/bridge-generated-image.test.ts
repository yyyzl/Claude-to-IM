import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGeneratedImage, validateGeneratedImage, decodeGeneratedImage, checkGeneratedImageBudget } from '../../lib/bridge/internal/generated-image.js';

// 固定 Codex 0.160.0 imagegen 协议研究中的合成 1×1 PNG，不含用户数据。
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

test('合法 PNG 生成窄元数据并校验副本，编码不进入错误文本', () => {
  const image = createGeneratedImage('image-fixture', png);
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.byteLength, Buffer.from(png, 'base64').length);
  assert.deepEqual(decodeGeneratedImage(image), Buffer.from(png, 'base64'));
  assert.deepEqual(validateGeneratedImage(image), image);
  assert.notEqual(validateGeneratedImage(image), image);
  assert.throws(() => validateGeneratedImage({ ...image, sha256: '0'.repeat(64) }), /摘要/);
  assert.throws(() => validateGeneratedImage({ ...image, byteLength: 1 }), /字节/);
});

test('拒绝宽松 Base64、路径、非 PNG、截断、超限尺寸和超大数据', () => {
  for (const input of ['', png + '\n', `data:image/png;base64,${png}`, '/tmp/generated.png', '!!!!', 'a'.repeat(13_333_337), Buffer.from('not png').toString('base64')]) {
    assert.throws(() => createGeneratedImage('fixture', input), error => error instanceof Error && !error.message.includes(input || 'impossible-empty'));
  }
  const bytes = Buffer.from(png, 'base64');
  assert.throws(() => createGeneratedImage('fixture', bytes.subarray(0, -1).toString('base64')), /PNG/);
  const oversized = Buffer.from(bytes); oversized.writeUInt32BE(12001, 16);
  assert.throws(() => createGeneratedImage('fixture', oversized.toString('base64')), /尺寸/);
  const badEnd = Buffer.from(bytes); badEnd.writeUInt32BE(1, badEnd.length - 12);
  assert.throws(() => createGeneratedImage('fixture', badEnd.toString('base64')), /PNG/);
});

test('回合最多 8 张和 30 MB，边界可用，超限明确失败', () => {
  assert.doesNotThrow(() => checkGeneratedImageBudget(8, 30_000_000));
  assert.throws(() => checkGeneratedImageBudget(9, 1), /8/);
  assert.throws(() => checkGeneratedImageBudget(1, 30_000_001), /30/);
});
