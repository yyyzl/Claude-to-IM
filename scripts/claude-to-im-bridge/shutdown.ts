/** 有界排空运行时后仍尝试落盘；一个停止步骤挂起不能跳过存储。 */
export async function drainAndFlush(deps: {
  stopBridge: () => Promise<void>;
  stopRuntime: () => void | Promise<void>;
  closeStore: () => Promise<void>;
}, timeoutMs = 5_000): Promise<string[]> {
  const failures: string[] = [];
  for (const [name, action] of [
    ['bridge', deps.stopBridge], ['runtime', deps.stopRuntime], ['store', deps.closeStore],
  ] as const) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} stop timeout`)), timeoutMs); }),
      ]);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { if (timer) clearTimeout(timer); }
  }
  return failures;
}
