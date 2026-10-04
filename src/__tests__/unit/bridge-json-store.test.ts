import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonFileBridgeStore } from '../../../scripts/claude-to-im-bridge/store.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-store-test-'));
  return { root, file: path.join(root, 'synthetic.json') };
}

it('损坏存储不能静默按空数据启动', () => {
  const { root, file } = fixture();
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new JsonFileBridgeStore({ projectRoot: root, dataPath: file }), /存储|persist|corrupt/i);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

it('flush 保证待保存会话已落盘，保留上一代有效快照', async () => {
  const { root, file } = fixture();
  const store = new JsonFileBridgeStore({ projectRoot: root, dataPath: file });
  const session = store.createSession('synthetic', 'model');
  await store.flush();
  store.updateSdkSessionId(session.id, 'synthetic-sdk');
  await store.close();
  const reopened = new JsonFileBridgeStore({ projectRoot: root, dataPath: file });
  assert.equal(reopened.getSession(session.id)?.sdk_session_id, 'synthetic-sdk');
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).sessions[session.id].name, 'synthetic');
  await reopened.close();
});

it('替换失败可见且原始快照仍有效，随后可以重试 flush', async (t) => {
  const { root, file } = fixture();
  const store = new JsonFileBridgeStore({ projectRoot: root, dataPath: file });
  const session = store.createSession('synthetic', 'model');
  await store.flush();
  const before = fs.readFileSync(file, 'utf8');
  const rename = fs.promises.rename;
  const fake = t.mock.method(fs.promises, 'rename', async (source: fs.PathLike, target: fs.PathLike) => {
    if (target === file) throw new Error('synthetic disk failure');
    return rename(source, target);
  });
  store.updateSdkSessionId(session.id, 'new');
  await assert.rejects(store.flush(), /synthetic disk failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fake.mock.restore();
  await store.close();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions[session.id].sdk_session_id, 'new');
});

it('并发 flush 等待其调用前发生的全部写入，不能在下一份快照保存期间提前成功', async (t) => {
  const { root, file } = fixture();
  const store = new JsonFileBridgeStore({ projectRoot: root, dataPath: file });
  const session = store.createSession('synthetic', 'model');
  const rename = fs.promises.rename;
  let firstReady!: () => void, secondReady!: () => void, firstRelease!: () => void, secondRelease!: () => void;
  const ready1 = new Promise<void>(resolve => { firstReady = resolve; });
  const ready2 = new Promise<void>(resolve => { secondReady = resolve; });
  const gate1 = new Promise<void>(resolve => { firstRelease = resolve; });
  const gate2 = new Promise<void>(resolve => { secondRelease = resolve; });
  let writes = 0;
  t.mock.method(fs.promises, 'rename', async (source: fs.PathLike, target: fs.PathLike) => {
    if (target === file) {
      writes++;
      if (writes === 1) { firstReady(); await gate1; }
      if (writes === 2) { secondReady(); await gate2; }
    }
    return rename(source, target);
  });
  const first = store.flush(); await ready1;
  store.updateSdkSessionId(session.id, 'newer');
  let flushed = 0;
  const second = store.flush().then(() => { flushed++; });
  const third = store.flush().then(() => { flushed++; });
  firstRelease(); await ready2;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flushed, 0);
  secondRelease(); await Promise.all([first, second, third]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions[session.id].sdk_session_id, 'newer');
  await store.close();
});

it('损坏主文件从有效备份恢复，保存前保留损坏原件', async () => {
  const { root, file } = fixture();
  fs.writeFileSync(file, '{broken');
  fs.writeFileSync(file + '.bak', JSON.stringify({ sessions: {}, bindings: {}, messages: {}, channelOffsets: { one: '1' } }));
  const store = new JsonFileBridgeStore({ projectRoot: root, dataPath: file });
  assert.equal(store.getChannelOffset('one'), '1');
  store.setChannelOffset('two', '2');
  await store.close();
  const savedCorrupt = fs.readdirSync(root).find(name => name.includes('.corrupt-'));
  assert.ok(savedCorrupt);
  assert.equal(fs.readFileSync(path.join(root, savedCorrupt), 'utf8'), '{broken');
});

it('投递记录隔离复制并能重启恢复；坏记录拒绝空载启动', async () => {
  const { root, file } = fixture();
  const store = new JsonFileBridgeStore({ projectRoot: root, dataPath: file });
  const record = {
    id: 'synthetic', sessionId: 'session', address: { channelType: 'feishu', chatId: 'chat' },
    responseText: 'answer', chunks: [{ text: 'answer', parseMode: 'plain' as const, sent: false }],
    status: 'failed' as const, attempts: 1, createdAt: '', updatedAt: '',
  };
  store.saveResponseDelivery(record);
  record.chunks[0].sent = true;
  assert.equal(store.getResponseDelivery('synthetic')?.chunks[0].sent, false);
  const copy = store.getResponseDelivery('synthetic')!; copy.chunks[0].sent = true;
  assert.equal(store.getResponseDelivery('synthetic')?.chunks[0].sent, false);
  await store.close();
  const reopened = new JsonFileBridgeStore({ projectRoot: root, dataPath: file });
  assert.equal(reopened.listResponseDeliveries('feishu', 'chat').length, 1);
  await reopened.close();
  const other = fixture();
  fs.writeFileSync(other.file, JSON.stringify({ sessions: {}, bindings: {}, messages: {}, channelOffsets: {}, responseDeliveries: { invalid: {} } }));
  assert.throws(() => new JsonFileBridgeStore({ projectRoot: other.root, dataPath: other.file }), /存储损坏/);
});

it('close 开始后拒绝新变更，不接受后再静默丢弃或修改内存', async () => {
  const { root, file } = fixture();
  const store = new JsonFileBridgeStore({ projectRoot: root, dataPath: file });
  const session = store.createSession('synthetic', 'model');
  await store.flush();
  const closing = store.close();
  assert.throws(() => store.addMessage(session.id, 'user', 'late'), /关闭/);
  assert.throws(() => store.updateSessionModel(session.id, 'late-model'), /关闭/);
  assert.equal(store.getMessages(session.id).messages.length, 0);
  assert.equal(store.getSession(session.id)?.model, 'model');
  await closing;
});
