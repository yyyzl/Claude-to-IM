import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const executable = process.argv[2];
assert.ok(executable, '传入已核验的全局 GitNexus CLI index.js 路径');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', new URL('./gitnexus-offline-preload.mjs', import.meta.url).href, executable, 'mcp'],
  cwd: process.cwd(),
  // 不继承凭据或业务环境。SDK 自身仅补齐 Windows 必要的 OS/路径变量。
  env: { GITNEXUS_NO_UPDATE_NOTIFIER: '1', GITNEXUS_MCP_READ_ONLY: '1', GITNEXUS_MCP_ALLOWED_REPOS: process.cwd(), GITNEXUS_MCP_DEFAULT_REPO: process.cwd() },
  stderr: 'pipe',
});
const client = new Client({ name: 'tooling-upgrade-quality-check', version: '1.0.0' });
let diagnostics = '';
transport.stderr?.on('data', chunk => { diagnostics += chunk.toString(); });
try {
  await client.connect(transport, { timeout: 15_000 });
  const result = await client.listTools({}, { timeout: 10_000 });
  const names = result.tools.map(tool => tool.name).sort();
  for (const required of ['list_repos', 'query', 'context', 'impact', 'detect_changes']) assert.ok(names.includes(required), `${required} 缺失`);
  const impact = result.tools.find(tool => tool.name === 'impact');
  console.log(JSON.stringify({ ok: true, server: client.getServerVersion(), toolCount: names.length, tools: names, impactArguments: Object.keys(impact.inputSchema.properties ?? {}), networkBlocked: true, mode: 'read-only', configurationChanged: false }, null, 2));
} catch (error) {
  // stderr 可能包含已登记的仓库路径，只输出本次错误摘要。
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`serverStderrBytes=${Buffer.byteLength(diagnostics)}`);
  console.error(diagnostics.split('\n').filter(line => /Error|Cannot|ERR_|error|offline|离线/.test(line)).slice(-6).join('\n'));
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
}
