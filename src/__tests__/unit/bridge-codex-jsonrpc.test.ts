import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { test } from 'node:test';
import { JsonRpcAppServerClient } from '../../../scripts/claude-to-im-bridge/codex-jsonrpc.ts';
import type { AppServerProcessFactory } from '../../../scripts/claude-to-im-bridge/codex-jsonrpc.ts';

function processMock(onMessage: (message: Record<string, unknown>, child: ReturnType<typeof processMock>) => void) {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false,
    kill: () => { child.killed = true; queueMicrotask(() => emitter.emit('exit', 0, null)); return true; },
  });
  child.stdin.on('data', data => onMessage(JSON.parse(data.toString()), child));
  return child;
}
function factory(child: ReturnType<typeof processMock>): AppServerProcessFactory { return () => child as unknown as ChildProcessWithoutNullStreams; }

test('测试环境禁止默认进程启动，即使漏写mock也不会连接真实后端', async () => {
  const client = new JsonRpcAppServerClient({ command: ['codex', 'app-server'] });
  await assert.rejects(client.request('probe'), /测试禁止启动真实/);
});

test('双向 RPC 的同号服务端请求不会冒充客户端响应', async () => {
  const child = processMock((message, child) => {
    if (message.method === 'probe') child.stdout.write(JSON.stringify({ id: message.id, method: 'approval', params: {} }) + '\n');
    else if (message.result) child.stdout.write(JSON.stringify({ id: message.id, result: message.result }) + '\n');
  });
  const client = new JsonRpcAppServerClient({ command: ['mock.exe'], spawnProcess: factory(child) });
  try {
    client.onServerRequest(message => client.respond(message.id, { accepted: true }));
    assert.deepEqual(await client.request('probe'), { accepted: true });
  } finally { client.stop(); }
});

test('未支持的服务端请求明确返回错误，日志遮盖 Bearer 和 JSON 凭据', async () => {
  const child = processMock((message, child) => {
    if (message.method === 'probe') {
      child.stderr.write('Authorization: Bearer fake-secret-credential\n' + JSON.stringify({ access_token: 'fake-access-credential' }) + '\n');
      child.stdout.write(JSON.stringify({ id: 'server-1', method: 'unknown', params: {} }) + '\n');
    } else if (message.error) child.stdout.write(JSON.stringify({ id: 1, result: message.error }) + '\n');
  });
  const client = new JsonRpcAppServerClient({ command: ['mock.exe'], spawnProcess: factory(child) });
  try {
    const result = await client.request('probe') as { code: number };
    assert.equal(result.code, -32601);
    assert.doesNotMatch(client.getRecentLogs(), /fake-secret-credential|fake-access-credential/);
  } finally { client.stop(); }
});

test('停止旧进程后迟到的 exit 不会拒绝新进程请求', async () => {
  const oldChild = processMock(() => {});
  const newChild = processMock((message, child) => { queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result: 'new process' }) + '\n')); });
  let count = 0;
  const client = new JsonRpcAppServerClient({ command: ['mock.exe'], spawnProcess: () => (++count === 1 ? oldChild : newChild) as unknown as ChildProcessWithoutNullStreams });
  client.start(); client.stop();
  try { assert.equal(await client.request('probe'), 'new process'); } finally { client.stop(); }
});
