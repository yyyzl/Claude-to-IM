import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexAppServerLLMProvider } from '../../../scripts/claude-to-im-bridge/codex-llm.ts';
import { InMemoryPermissionGateway } from '../../../scripts/claude-to-im-bridge/permissions.ts';
import type { JsonRpcMessage } from '../../../scripts/claude-to-im-bridge/codex-jsonrpc.ts';

export class FakeClient {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  replies: unknown[] = [];
  emitter = new EventEmitter();
  backlog: JsonRpcMessage[] = [];
  running = false;
  onTurn: (params: Record<string, unknown>) => void = () => this.publish('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  async request(method: string, params: Record<string, unknown> = {}) {
    this.running = true;
    this.calls.push({ method, params });
    if (method === 'model/list') return { data: [{ id: 'catalog-id', model: 'model-next', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }], inputModalities: ['text', 'image'] }], nextCursor: null };
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' } };
    if (method === 'turn/start') { this.onTurn(params); return { turn: { id: 'turn' } }; }
    return {};
  }
  notify(method: string) { this.calls.push({ method, params: {} }); }
  respond(id: string | number, result: unknown) { this.replies.push({ id, result }); }
  respondError(id: string | number, code: number, message: string) { this.replies.push({ id, error: { code, message } }); }
  onNotification(fn: (m: JsonRpcMessage) => void) { this.emitter.on('notification', fn); return () => { this.emitter.off('notification', fn); }; }
  onServerRequest(fn: (m: JsonRpcMessage & { id: string | number }) => void) { this.emitter.on('request', fn); return () => { this.emitter.off('request', fn); }; }
  onDisconnect(fn: (e: Error) => void) { this.emitter.on('disconnect', fn); return () => { this.emitter.off('disconnect', fn); }; }
  drainBacklog(predicate: (m: JsonRpcMessage) => boolean) { const found = this.backlog.filter(predicate); this.backlog = this.backlog.filter(m => !predicate(m)); return found; }
  isRunning() { return this.running; }
  getRecentLogs() { return ''; }
  stop() { this.running = false; }
  publish(method: string, extra: Record<string, unknown> = {}) { const m = { method, params: { threadId: 'thread', turnId: 'turn', ...extra } }; this.backlog.push(m); this.emitter.emit('notification', m); }
}

export async function read(stream: ReadableStream<string>, onEvent?: (event: { type: string; data: string }) => void) {
  const events: Array<{ type: string; data: string }> = [];
  for await (const chunk of stream) for (const line of chunk.trim().split('\n')) {
    const event = JSON.parse(line.slice(6)); events.push(event); onEvent?.(event);
  }
  return events;
}
export function setup() {
  const client = new FakeClient();
  const permissions = new InMemoryPermissionGateway();
  const provider = new CodexAppServerLLMProvider({ projectRoot: process.cwd(), permissions, client, keepAliveMs: 0, turnTimeoutMs: 2000 });
  assert.equal((provider as unknown as { client: unknown }).client, client, 'mock 必须在调用 streamChat 前注入，禁止连接真实后端');
  return { client, permissions, provider };
}
