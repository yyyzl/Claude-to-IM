import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { initBridgeContext } from '../../lib/bridge/context.js';
import { BaseChannelAdapter } from '../../lib/bridge/channel-adapter.js';
import { deliverResponse, retryResponseDelivery } from '../../lib/bridge/response-delivery.js';
import { JsonFileBridgeStore } from '../../../scripts/claude-to-im-bridge/store.js';
import type { BridgeStore, ResponseDeliveryRecord, GeneratedImage } from '../../lib/bridge/host.js';
import type { OutboundMessage, SendResult } from '../../lib/bridge/types.js';
import { createGeneratedImage } from '../../lib/bridge/internal/generated-image.js';
import { describePendingInlineImages, markdownImageSpans, snapshotInlineImages } from '../../lib/bridge/internal/inline-images.js';
import { hasComplexMarkdown, splitFeishuMarkdown, feishuPayloadBytes } from '../../lib/bridge/markdown/feishu.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const blocked = () => { throw new Error('测试禁止真实网络或模型'); };
mock.method(net.Socket.prototype, 'connect', blocked);
mock.method(globalThis, 'fetch', blocked);
class Adapter extends BaseChannelAdapter {
  readonly channelType = 'feishu';
  async start() {} async stop() {} isRunning() { return true; }
  async consumeOne() { return null; } validateConfig() { return null; } isAuthorized() { return true; }
  send = async (_message: OutboundMessage): Promise<SendResult> => ({ ok: true, messageId: 'sent' });
  uploadImage = async (_image: GeneratedImage) => ({ ok: true, imageKey: 'img_fixture' });
}
function fixture(t: { after(fn: () => void | Promise<void>): void }, persistent = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-inline-images-'));
  // 合成临时文件保留，由系统临时目录生命周期清理；测试不删除用户文件。
  fs.writeFileSync(path.join(root, 'one.png'), Buffer.from(PNG, 'base64'));
  fs.writeFileSync(path.join(root, 'two space.png'), Buffer.from(PNG, 'base64'));
  const rows = new Map<string, ResponseDeliveryRecord>();
  const snapshots: ResponseDeliveryRecord[] = [];
  const store = persistent ? new JsonFileBridgeStore({ projectRoot: root, dataPath: path.join(root, 'store.json') }) : {
    getSetting: () => null, saveResponseDelivery: (row: ResponseDeliveryRecord) => rows.set(row.id, structuredClone(row)),
    getResponseDelivery: (id: string) => rows.get(id) ?? null, listResponseDeliveries: () => [...rows.values()],
    flush: async () => { snapshots.push(...[...rows.values()].map(row => structuredClone(row))); }, insertAuditLog() {}, insertOutboundRef() {},
  } as unknown as BridgeStore;
  const setup = (value: BridgeStore) => {
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({ store: value, llm: { streamChat: blocked }, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
  };
  setup(store);
  t.after(() => { delete (globalThis as Record<string, unknown>).__bridge_context__; });
  const adapter = new Adapter(); const sent: OutboundMessage[] = []; const uploaded: GeneratedImage[] = [];
  adapter.send = async message => { sent.push(message); return { ok: true, messageId: `sent-${sent.length}` }; };
  adapter.uploadImage = async image => { uploaded.push(image); return { ok: true, imageKey: `img_fixture_${uploaded.length}` }; };
  const address = { channelType: 'feishu', chatId: root, userId: 'owner' };
  return { root, rows, snapshots, store, setup, adapter, sent, uploaded, address };
}

test('两图混排先保存快照和key，再用转换正文收尾原卡', async t => {
  const f = fixture(t); let final = '';
  const text = `**处理完成**\n![结果](<${f.root.replaceAll('\\', '/')}/one.png>)\n**等待回答**\n![问题](<two space.png>)\n收尾说明`;
  f.adapter.uploadImage = async image => {
    assert.ok(f.snapshots.at(-1)?.chunks.some(chunk => chunk.kind !== 'image' && 'inlineImages' in chunk), '上传前快照已落盘');
    f.uploaded.push(image); return { ok: true, imageKey: `img_fixture_${f.uploaded.length}` };
  };
  const result = await deliverResponse(f.adapter, f.address, text, 'session', undefined, {
    workingDirectory: f.root,
    finalize: async prepared => {
      final = prepared; assert.equal(f.uploaded.length, 2);
      const chunk = f.snapshots.at(-1)?.chunks[0];
      assert.ok(chunk && chunk.kind !== 'image');
      assert.deepEqual(chunk.inlineImages?.map(item => item.imageKey), ['img_fixture_1', 'img_fixture_2']);
      return true;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(final, '**处理完成**\n![结果](img_fixture_1)\n**等待回答**\n![问题](img_fixture_2)\n收尾说明');
  assert.equal(f.sent.length, 0); assert.equal([...f.rows.values()][0].status, 'delivered');
});

test('图片说明标题与 file URL 保留且转换成同卡key', async t => {
  const f = fixture(t);
  const { pathToFileURL } = await import('node:url');
  const text = `![说明](${pathToFileURL(path.join(f.root, 'one.png')).href} "图片标题")`;
  assert.equal((await deliverResponse(f.adapter, f.address, text, 'session', undefined, { workingDirectory: f.root })).ok, true);
  assert.equal(f.sent[0].text, '![说明](img_fixture_1 "图片标题")');
});

test('以img_开头的本地PNG仍须上传，不把文件名当作飞书key', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'img_preview.png'), Buffer.from(PNG, 'base64'));
  assert.equal((await deliverResponse(f.adapter, f.address, '![图](img_preview.png)', 'session', undefined, { workingDirectory: f.root })).ok, true);
  assert.equal(f.uploaded.length, 1); assert.equal(f.sent[0].text, '![图](img_fixture_1)');
});

test('图片说明已有的方括号与反斜杠转义保持原样，发送不重复转义', async t => {
  const f = fixture(t);
  const text = '![说明 \\[一\\] 与 \\\\ 路径](one.png)';
  assert.equal((await deliverResponse(f.adapter, f.address, text, 'session', undefined, { workingDirectory: f.root })).ok, true);
  assert.equal(f.sent[0].text, text.replace('one.png', 'img_fixture_1'));
});

test('第二图上传失败显示正文说明而不确认图文，补发复用第一张key和快照', async t => {
  const f = fixture(t, true); let fail = true;
  f.adapter.uploadImage = async image => {
    f.uploaded.push(image);
    return fail && f.uploaded.length === 2 ? { ok: false, imageKey: '', error: '合成上传故障' } : { ok: true, imageKey: `img_fixture_${f.uploaded.length}` };
  };
  const text = '开始\n![一](one.png)\n中间\n![二](<two space.png>)\n结束';
  let finalized = 0;
  assert.equal((await deliverResponse(f.adapter, f.address, text, 'session', undefined, {
    workingDirectory: f.root, finalize: async () => { finalized++; return false; },
  })).ok, false);
  assert.equal(finalized, 1); assert.match(f.sent[0].text, /开始[\s\S]*中间[\s\S]*结束/);
  assert.match(f.sent[0].text, /待补发/); assert.doesNotMatch(f.sent[0].text, /one\.png|two space\.png|bridge-inline/);
  const row = f.store.listResponseDeliveries?.('feishu', f.root)[0]; assert.ok(row);
  assert.ok(row.chunks.every(chunk => !chunk.sent));
  await f.store.close?.();
  // 移走源文件模拟它们已不在原路径；不删除文件或用户目录。
  fs.renameSync(path.join(f.root, 'one.png'), path.join(f.root, 'one.saved'));
  fs.renameSync(path.join(f.root, 'two space.png'), path.join(f.root, 'two.saved'));
  const reopened = new JsonFileBridgeStore({ projectRoot: f.root, dataPath: path.join(f.root, 'store.json') });
  f.setup(reopened); fail = false;
  assert.equal((await retryResponseDelivery(f.adapter, f.address, row.id)).ok, true);
  assert.equal(f.uploaded.length, 3); assert.equal(f.sent.at(-1)?.text, '开始\n![一](img_fixture_1)\n中间\n![二](img_fixture_3)\n结束');
  assert.equal(reopened.getResponseDelivery(row.id)?.status, 'delivered'); await reopened.close();
});

test('代码示例不读图，缺失/非PNG/越界在原位置解释，远程图不下载', async t => {
  const f = fixture(t);
  const text = '`![示例](one.png)`\n\n```md\n![示例](one.png)\n```\n\n![缺失](absent.png)\n![格式](one.jpg)\n![越界](../outside.png)\n![网络](https://example.invalid/a.png)\n尾部';
  assert.equal((await deliverResponse(f.adapter, f.address, text, 'session', undefined, { workingDirectory: f.root })).ok, true);
  assert.equal(f.uploaded.length, 0);
  const output = f.sent.map(message => message.text).join('');
  assert.match(output, /`!\[示例\]\(one\.png\)`/); assert.match(output, /```md\n!\[示例\]\(one\.png\)\n```/);
  assert.match(output, /缺失.*不存在|缺失.*读取失败/); assert.match(output, /格式.*PNG/); assert.match(output, /越界.*工作目录/);
  assert.match(output, /!\[网络\]\(https:\/\/example.invalid\/a.png\)/); assert.ok(output.endsWith('尾部'));
});

test('同一行/引用/列表/引用式图片正确定位，重复引用只上传一次', async t => {
  const f = fixture(t);
  const text = '`![一](one.png)` 与 ![一](one.png) 及 ![二](<two space.png>)\n\n> ![引用](one.png)\n\n- ![列表][id]\n\n[id]: one.png\n\n结尾';
  assert.equal((await deliverResponse(f.adapter, f.address, text, 'session', undefined, { workingDirectory: f.root })).ok, true);
  assert.equal(f.uploaded.length, 2);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, '`![一](one.png)` 与 ![一](img_fixture_1) 及 ![二](img_fixture_2)\n\n> ![引用](img_fixture_1)\n\n- ![列表](img_fixture_1)\n\n[id]: one.png\n\n结尾');
  const pending = describePendingInlineImages(text);
  assert.equal(markdownImageSpans(pending).length, 0);
  assert.match(pending, /`!\[一\]\(one.png\)`/); assert.match(pending, /等待上传/);
  assert.equal(hasComplexMarkdown('`![一](one.png)`'), false);
});

test('明确正文吸收原生同图，不重复独立发送；无引用原生图保持原路径', async t => {
  const f = fixture(t);
  const native = createGeneratedImage('native-fixture', PNG);
  assert.equal((await deliverResponse(f.adapter, f.address, '![正文图](one.png)', 'session', undefined, { workingDirectory: f.root, images: [native] })).ok, true);
  assert.equal(f.uploaded.length, 1); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].image, undefined);
  assert.equal((await deliverResponse(f.adapter, f.address, '原生图说明', 'session', undefined, { workingDirectory: f.root, images: [native] })).ok, true);
  assert.equal(f.uploaded.length, 2); assert.ok(f.sent.at(-1)?.image);
});

test('表格图片精确映射单元格，保留代码示例、转义竖线与重复内容', async t => {
  const f = fixture(t);
  const text = '| ![一](one.png) | `![一](one.png)` |\n| --- | --- |\n| 转义\\|说明 ![二](<two space.png>) | ![一](one.png) |';
  assert.equal(markdownImageSpans(text).length, 3);
  const pending = describePendingInlineImages(text);
  assert.equal(markdownImageSpans(pending).length, 0);
  assert.ok(pending.includes('`![一](one.png)`'));
  let prepared = '';
  assert.equal((await deliverResponse(f.adapter, f.address, text, 'session', undefined, {
    workingDirectory: f.root, finalize: async value => { prepared = value; return true; },
  })).ok, true);
  assert.equal(f.uploaded.length, 2);
  assert.equal(prepared, '| ![一](img_fixture_1) | `![一](one.png)` |\n| --- | --- |\n| 转义\\|说明 ![二](img_fixture_2) | ![一](img_fixture_1) |');
});

test('表格图片说明与标题中的转义竖线在运行态和最终态均不破坏单元格', async t => {
  const f = fixture(t);
  const text = '> | 图片 | 说明 |\n> | --- | --- |\n> | ![一\\|二](one.png "标题\\|名称") | 保留 |';
  const pending = describePendingInlineImages(text);
  assert.ok(pending.includes('一\\|二'));
  let prepared = '';
  assert.equal((await deliverResponse(f.adapter, f.address, text, 'session', undefined, {
    workingDirectory: f.root, finalize: async value => { prepared = value; return true; },
  })).ok, true);
  assert.equal(f.uploaded.length, 1);
  assert.equal(prepared, '> | 图片 | 说明 |\n> | --- | --- |\n> | ![一\\|二](img_fixture_1 "标题\\|名称") | 保留 |');
  assert.equal(markdownImageSpans(prepared).length, 1);
  assert.equal((await deliverResponse(f.adapter, f.address, text, 'session', undefined, {
    workingDirectory: f.root, finalize: async () => false,
  })).ok, true);
  assert.equal(f.sent[0].text, prepared.replace('img_fixture_1', 'img_fixture_2'));
});

test('损坏/单图/数量/总量预算拒绝项显式说明，链接逃逸不读取', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'bad.png'), 'not-a-png');
  const large = fs.openSync(path.join(f.root, 'large.png'), 'w'); fs.ftruncateSync(large, 10_000_001); fs.closeSync(large);
  for (let index = 0; index < 9; index++) fs.writeFileSync(path.join(f.root, `${index}.png`), Buffer.from(PNG, 'base64'));
  const data = await snapshotInlineImages('![坏](bad.png)\n![大](large.png)\n' + Array.from({ length: 9 }, (_, index) => `![${index}](${index}.png)`).join('\n'), f.root);
  assert.equal(data.images.length, 8); assert.match(data.text, /坏.*PNG/); assert.match(data.text, /大.*10 MB/); assert.match(data.text, /8.*最多.*8/);
  assert.match((await snapshotInlineImages('![总量](one.png)', f.root, { count: 0, bytes: 30_000_000 })).text, /总量.*30 MB/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-inline-outside-')); fs.writeFileSync(path.join(outside, 'escape.png'), Buffer.from(PNG, 'base64'));
  // Windows junction 无需管理员符号链接权限，同样检验 realpath 边界。
  fs.symlinkSync(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const escaped = await snapshotInlineImages('![越界](escape/escape.png)', f.root);
  assert.equal(escaped.images.length, 0); assert.match(escaped.text, /越界.*工作目录/);
});

test('上传key保存失败不发送说明预览，取消后的迟到上传不触发卡片/后图', async t => {
  const f = fixture(t); let flushes = 0;
  f.store.flush = async () => { if (++flushes >= 2) throw new Error('合成磁盘故障'); };
  let finalizeCount = 0;
  assert.equal((await deliverResponse(f.adapter, f.address, '![图](one.png)', 'session', undefined, { workingDirectory: f.root, finalize: async () => { finalizeCount++; return true; } })).ok, false);
  assert.equal(f.sent.length, 0); assert.equal(finalizeCount, 0);
  const other = fixture(t); let current = true; let resolve!: (value: { ok: boolean; imageKey: string }) => void;
  let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
  other.adapter.uploadImage = async image => { other.uploaded.push(image); entered(); return new Promise(r => { resolve = r; }); };
  const delivery = deliverResponse(other.adapter, other.address, '![一](one.png)\n![二](<two space.png>)', 'session', undefined, { workingDirectory: other.root, isCurrent: () => current, finalize: async () => { finalizeCount++; return true; } });
  await started; current = false; resolve({ ok: true, imageKey: 'img_late' });
  assert.equal((await delivery).ok, false); assert.equal(other.sent.length, 0); assert.equal(other.uploaded.length, 1); assert.equal(finalizeCount, 0);
  const row = [...other.rows.values()][0]; assert.ok(row.chunks[0].kind !== 'image' && row.chunks[0].inlineImages?.[0].imageKey === 'img_late');
});

test('转换图文按实际JSON字节分块且图片节点不跨块，失败后只补未确认块', async t => {
  const f = fixture(t); let fail = true;
  f.adapter.send = async message => {
    f.sent.push(message); assert.ok(feishuPayloadBytes(message.text) <= 28_000);
    return fail && f.sent.length === 2 ? { ok: false, httpStatus: 400, error: '合成卡片拒绝' } : { ok: true, messageId: `sent-${f.sent.length}` };
  };
  const text = '中文\\"😀'.repeat(3000) + '\n![一](one.png)\n' + '后半正文'.repeat(5000) + '\n![二](<two space.png>)';
  let prepared = '';
  assert.equal((await deliverResponse(f.adapter, f.address, text, 'session', undefined, { workingDirectory: f.root, finalize: async value => { prepared = value; return false; } })).ok, false);
  const row = [...f.rows.values()][0]; assert.equal(row.chunks[0].sent, true); assert.equal(row.chunks[1].sent, false);
  fail = false; assert.equal((await retryResponseDelivery(f.adapter, f.address, row.id)).ok, true);
  assert.equal(f.uploaded.length, 2);
  const confirmed = [f.sent[0], ...f.sent.slice(2)].map(message => message.text).join('');
  assert.equal(confirmed, prepared); assert.equal(markdownImageSpans(confirmed).length, 2);
  const onBoundary = 'x'.repeat(1500) + '![a](img_' + 'k'.repeat(1000) + ')' + 'y'.repeat(2000);
  const parts = splitFeishuMarkdown(onBoundary, 2500);
  assert.equal(parts.join(''), onBoundary); assert.equal(parts.reduce((sum, part) => sum + markdownImageSpans(part).length, 0), 1);
});
