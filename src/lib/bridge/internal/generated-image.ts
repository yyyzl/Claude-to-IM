/** 生成图片的纯校验边界；错误只描述类别，绝不带原始媒体或模型路径。 */
import { createHash } from 'node:crypto';
import type { GeneratedImage } from '../host.js';

export const MAX_GENERATED_IMAGE_BYTES = 10_000_000;
export const MAX_GENERATED_IMAGES = 8;
export const MAX_GENERATED_IMAGES_TOTAL_BYTES = 30_000_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function decodePng(data: unknown): Buffer {
  if (typeof data !== 'string' || !data.length) throw new Error('生成图片没有可交付的数据');
  if (data.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4) throw new Error('生成图片超过单张 10 MB 限额');
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const bodyLength = data.length - padding;
  if (data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(data.slice(0, bodyLength))) throw new Error('生成图片 Base64 格式无效');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_GENERATED_IMAGE_BYTES) throw new Error('生成图片超过单张 10 MB 限额');
  if (bytes.toString('base64') !== data) throw new Error('生成图片 Base64 编码不规范');
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('生成图片不是完整 PNG');

  let offset = 8;
  let sawHeader = false;
  let sawData = false;
  let endedData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || length > bytes.length - offset - 12) throw new Error('生成图片 PNG 分块损坏');
    if (!sawHeader && type !== 'IHDR') throw new Error('生成图片 PNG 缺少头部');
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) throw new Error('生成图片 PNG 头部无效');
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width > 12000 || height > 12000) throw new Error('生成图片尺寸须在 1 至 12000 像素之间');
      const depth = bytes[offset + 16];
      const color = bytes[offset + 17];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) throw new Error('生成图片 PNG 头部参数无效');
      sawHeader = true;
    } else if (type === 'IDAT') {
      if (endedData) throw new Error('生成图片 PNG 数据分块无效');
      if (length) sawData = true;
    } else {
      if (sawData) endedData = true;
      if (type === 'IEND') {
        if (length !== 0 || !sawData || offset + 12 !== bytes.length) throw new Error('生成图片 PNG 结束标记无效');
        return bytes;
      }
    }
    offset += length + 12;
  }
  throw new Error('生成图片 PNG 截断或缺少结束标记');
}

function checkId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !id.trim() || id.length > 256) throw new Error('生成图片标识无效');
}

export function createGeneratedImage(id: string, data: unknown): GeneratedImage {
  checkId(id);
  const bytes = decodePng(data);
  return { id, mimeType: 'image/png', data: data as string, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function readGeneratedImage(value: unknown): { image: GeneratedImage; bytes: Buffer } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('生成图片记录无效');
  const row = value as Record<string, unknown>;
  checkId(row.id);
  if (row.mimeType !== 'image/png') throw new Error('生成图片只支持 PNG');
  const bytes = decodePng(row.data);
  if (row.byteLength !== bytes.length) throw new Error('生成图片字节数不一致');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (row.sha256 !== sha256) throw new Error('生成图片摘要不一致');
  return { image: { id: row.id, mimeType: 'image/png', data: row.data as string, byteLength: bytes.length, sha256 }, bytes };
}

export function validateGeneratedImage(value: unknown): GeneratedImage {
  return readGeneratedImage(value).image;
}

export function decodeGeneratedImage(image: GeneratedImage): Buffer {
  return readGeneratedImage(image).bytes;
}

export function checkGeneratedImageBudget(count: number, totalBytes: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_GENERATED_IMAGES) throw new Error('本回合最多交付 8 张生成图片');
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_GENERATED_IMAGES_TOTAL_BYTES) throw new Error('本回合生成图片总量超过 30 MB 限额');
}
