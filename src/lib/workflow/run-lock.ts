import * as fs from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface RunOwner { pid: number; host: string; token: string }

function isOwnerAlive(owner: RunOwner): boolean {
  if (owner.host !== hostname()) throw new Error('无法确认其他主机上的工作流执行者是否退出');
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(owner.token)) throw new Error('工作流锁格式损坏，拒绝自动抢占');
  try { process.kill(owner.pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}

/** 单机进程锁。PID 仍存活（包括 PID 复用）时保守拒绝，绝不按超时抢占。 */
export async function acquireRunLock(file: string): Promise<() => Promise<void>> {
  const owner: RunOwner = { pid: process.pid, host: hostname(), token: randomUUID() };
  const acquire = async () => {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
    finally { await handle.close(); }
  };
  try { await acquire(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let stale: RunOwner;
    try { stale = JSON.parse(await fs.readFile(file, 'utf8')) as RunOwner; }
    catch { throw new Error('无法读取工作流执行者锁；请确认所有相关进程退出后保留并移走损坏锁文件'); }
    if (isOwnerAlive(stale)) throw new Error('工作流已有活跃执行者，不能并发恢复');
    // 恢复锁按旧 owner token 分代。恢复者自己崩溃后，下一代继续争抢
    // 新名字，避免两个恢复者同时删除/替换正在使用的恢复锁。
    let recoveryFile = `${file}.recover-${stale.token}`;
    let guard: Awaited<ReturnType<typeof fs.open>> | undefined;
    for (let generation = 0; generation < 32; generation++) {
      try {
        guard = await fs.open(recoveryFile, 'wx', 0o600);
        await guard.writeFile(JSON.stringify(owner));
        await guard.sync();
        break;
      } catch (guardError) {
        if (guard) { await guard.close(); guard = undefined; }
        if ((guardError as NodeJS.ErrnoException).code !== 'EEXIST') throw guardError;
        let previous: RunOwner;
        try { previous = JSON.parse(await fs.readFile(recoveryFile, 'utf8')) as RunOwner; }
        catch { throw new Error('工作流恢复锁损坏；请确认相关进程退出后保留并移走该恢复锁'); }
        if (isOwnerAlive(previous)) throw new Error('工作流正在由另一个请求恢复');
        recoveryFile = `${file}.recover-${stale.token}-after-${previous.token}`;
      }
    }
    if (!guard) throw new Error('恢复锁链过长，请人工检查保留的锁记录');
    try {
      let existing: RunOwner;
      try { existing = JSON.parse(await fs.readFile(file, 'utf8')) as RunOwner; }
      catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
        await acquire();
        return release;
      }
      if (existing.token !== stale.token || isOwnerAlive(existing)) throw new Error('工作流执行者已变化，拒绝抢占');
      await fs.rename(file, `${file}.stale-${existing.token}`);
      await acquire();
    } finally { await guard.close(); await fs.unlink(recoveryFile); }
  }
  async function release(): Promise<void> {
    const current = JSON.parse(await fs.readFile(file, 'utf8')) as RunOwner;
    if (current.token !== owner.token) throw new Error('工作流执行者锁已变化');
    await fs.unlink(file);
  }
  return release;
}
