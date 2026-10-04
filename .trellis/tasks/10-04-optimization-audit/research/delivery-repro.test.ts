// 审查复现：只使用内存 fake；断言当前缺陷，修复后这些断言应改成回归断言。
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import childProcess from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import type { BridgeStore } from '../../../../src/lib/bridge/host.ts';
import type { BaseChannelAdapter } from '../../../../src/lib/bridge/channel-adapter.ts';
import type { SendResult } from '../../../../src/lib/bridge/types.ts';

assert.ok(process.env.NODE_TEST_CONTEXT, '只允许 node:test 执行');
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  mock.method(childProcess, key, () => { throw new Error(`禁止真实子进程：${key}`); });
}
mock.method(net.Socket.prototype, 'connect', () => { throw new Error('禁止真实网络连接'); });
mock.method(globalThis, 'fetch', () => { throw new Error('禁止真实 fetch'); });
syncBuiltinESMExports();

const { initBridgeContext } = await import('../../../../src/lib/bridge/context.ts');
const { deliver, deliverRendered } = await import('../../../../src/lib/bridge/delivery-layer.ts');
const { forwardPermissionRequest } = await import('../../../../src/lib/bridge/permission-broker.ts');
const { InMemoryPermissionGateway } = await import('../../../../scripts/claude-to-im-bridge/permissions.ts');
const { FeishuAdapter } = await import('../../../../src/lib/bridge/adapters/feishu-adapter.ts');

function fixture() {
  const dedup = new Set<string>();
  const links: unknown[] = [];
  const gateway = new InMemoryPermissionGateway({ permissionTimeoutMs: 0 });
  initBridgeContext({
    store: {
      getSetting: () => null,
      checkDedup: (key: string) => dedup.has(key),
      insertDedup: (key: string) => dedup.add(key),
      cleanupExpiredDedup: () => {}, insertAuditLog: () => {}, insertOutboundRef: () => {},
      insertPermissionLink: (link: unknown) => links.push(link),
    } as unknown as BridgeStore,
    llm: { streamChat: () => { throw new Error('研究不调用模型'); } },
    permissions: gateway, lifecycle: {},
  });
  return { dedup, links, gateway };
}

test('契约缺陷：失败分块被记为已投递，相同去重键的重试直接成功', async () => {
  const { dedup } = fixture();
  let calls = 0;
  const adapter = { channelType: 'telegram', send: async () => {
    calls++; return { ok: false, httpStatus: 400, error: 'mock client failure' };
  } } as unknown as BaseChannelAdapter;
  const address = { channelType: 'telegram', chatId: 'audit-dedup' };
  const chunks = [{ html: '回答', text: '回答' }];
  const first = await deliverRendered(adapter, address, chunks, { dedupKey: 'audit-key' });
  assert.equal(first.ok, false);
  assert.equal(dedup.has('audit-key'), true);
  const second = await deliverRendered(adapter, address, chunks, { dedupKey: 'audit-key' });
  assert.equal(second.ok, true);
  assert.equal(calls, 1);
  // 当前 bridge-manager 没传 dedupKey；这是导出接口的潜在缺陷，不称为主链路已发生丢信。
});

test('HTML 降级后遇 429，仍按旧解析错误放弃重试', async () => {
  fixture();
  let calls = 0;
  const adapter = { channelType: 'telegram', send: async (): Promise<SendResult> => {
    calls++;
    if (calls === 1) return { ok: false, httpStatus: 400, error: "can't parse entities" };
    if (calls === 2) return { ok: false, httpStatus: 429, error: 'mock rate limit' };
    return { ok: true, messageId: 'would-succeed' };
  } } as unknown as BaseChannelAdapter;
  const result = await deliverRendered(adapter, { channelType: 'telegram', chatId: 'audit-html' }, [{ html: '<bad>', text: 'plain' }]);
  assert.equal(result.ok, false);
  assert.equal(calls, 2);
});

test('审批消息发送失败既不解开等待，也把同请求的再次转发去重', async () => {
  const { links, gateway } = fixture();
  let calls = 0;
  const adapter = { channelType: 'feishu', send: async () => {
    calls++; return { ok: false, httpStatus: 400, error: 'mock send failure' };
  } } as unknown as BaseChannelAdapter;
  const abort = new AbortController();
  let settled = false;
  const waiting = gateway.waitFor('audit-permission', abort.signal).then(() => { settled = true; });
  const address = { channelType: 'feishu', chatId: 'audit-permission-chat' };
  await forwardPermissionRequest(adapter, address, 'audit-permission', 'Read', { path: 'fake.txt' });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(links.length, 0);
  await forwardPermissionRequest(adapter, address, 'audit-permission', 'Read', { path: 'fake.txt' });
  assert.equal(calls, 1);
  abort.abort();
  await waiting;
});

test('飞书字符分块未限制 UTF-8 卡片尺寸，卡片降级仍发送整个长回答', async () => {
  fixture();
  const adapter = new FeishuAdapter();
  const calls: Array<{ msg_type: string; content: string }> = [];
  const fakeRestClient = { im: { message: { create: async ({ data }: { data: { msg_type: string; content: string } }) => {
    calls.push(data);
    return data.msg_type !== 'text'
      ? { code: 230025, msg: 'mock oversized card/post' }
      : { code: 0, data: { message_id: 'mock-text' } };
  } } } };
  (adapter as unknown as { restClient: unknown }).restClient = fakeRestClient;
  assert.equal((adapter as unknown as { restClient: unknown }).restClient, fakeRestClient);
  const body = '```text\n' + '中'.repeat(12000) + '\n```';
  assert.ok(body.length < 30000);
  const result = await deliver(adapter, { address: { channelType: 'feishu', chatId: 'audit-long' }, text: body, parseMode: 'Markdown' });
  assert.equal(result.ok, true); // 官方文档允许纯文本 150KB；这里仍然只有 fake API。
  assert.deepEqual(calls.map(c => c.msg_type), ['interactive', 'post', 'text']);
  assert.ok(Buffer.byteLength(calls[0].content, 'utf8') > 30000);
  assert.ok(Buffer.byteLength(calls[1].content, 'utf8') > 30000);
  assert.ok(calls[1].content.includes('中'.repeat(12000)));
});
