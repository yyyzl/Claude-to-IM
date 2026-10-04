import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** 同目录临时文件落盘后替换，失败时旧检查点保持完整。 */
export async function atomicWriteFile(target: string, content: string): Promise<void> {
  const temporary = `${target}.tmp-${randomUUID()}`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, target);
}
