/** 将锁定版本 Codex app-server 的公开双向协议适配为桥接 SSE。 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { LLMProvider, StreamChatParams, TokenUsage, UserInputQuestion } from '../../src/lib/bridge/host.js';
import type { CodexModelPreferences, ModelCatalog } from '../../src/lib/bridge/types.js';
import { findFastServiceTier } from '../../src/lib/bridge/internal/model-capabilities.js';
import type { InMemoryPermissionGateway } from './permissions.ts';
import { JsonRpcAppServerClient, redactSensitive } from './codex-jsonrpc.ts';
import type { JsonRpcMessage } from './codex-jsonrpc.ts';
import { buildTurnSandboxPolicy, parseCodexModelPage, resolveCodexBinary, selectCodexEffort, selectCodexModel } from './codex-utils.ts';
import type { CodexModelListItem } from './codex-utils.ts';

type CodexTransport = Pick<JsonRpcAppServerClient, 'request' | 'notify' | 'respond' | 'respondError' | 'onServerRequest' | 'onNotification' | 'onDisconnect' | 'drainBacklog' | 'stop' | 'isRunning'>;
type SendEvent = (type: string, data: unknown) => void;
type ActiveTurn = { emit: SendEvent; abort: AbortController; turnId?: string; onStatus?: (status: string) => void };
type TurnPolicy = { sandbox: string; approvalPolicy: string };
type ModelSelection = { model: CodexModelListItem; effort?: string; serviceTierForTurn?: string };
type TurnResult = { text: string; usage: TokenUsage | null; lastUsage: TokenUsage | null; contextWindow: number | null; contextTokens: number | null; emittedFinalText: boolean };

export interface CodexAppServerLLMProviderOptions {
  projectRoot: string;
  permissions: InMemoryPermissionGateway;
  codexBin?: string;
  cliConfig?: string;
  modelId?: string;
  modelHint?: string;
  sandboxMode?: string;
  approvalPolicy?: string;
  turnTimeoutMs?: number;
  turnIdleTimeoutMs?: number;
  keepAliveMs?: number;
  debug?: boolean;
  /** 可注入纯内存传输，测试不得调用已登录的真实运行时。 */
  client?: CodexTransport;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function pickString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0; }
function abortError(): Error { const error = new Error('任务已停止'); error.name = 'AbortError'; return error; }
function toErrorMessage(error: unknown): string { return redactSensitive(error instanceof Error ? error.message : String(error)); }
function normalizeTokenUsage(value: unknown): TokenUsage | null {
  const raw = record(value);
  if (typeof raw.inputTokens !== 'number' && typeof raw.outputTokens !== 'number') return null;
  const cached = number(raw.cachedInputTokens);
  const written = number(raw.cacheWriteInputTokens);
  return {
    input_tokens: Math.max(0, number(raw.inputTokens) - cached - written),
    output_tokens: number(raw.outputTokens),
    ...(cached ? { cache_read_input_tokens: cached } : {}),
    ...(written ? { cache_creation_input_tokens: written } : {}),
  };
}
function subtractUsage(total: TokenUsage, baseline: TokenUsage): TokenUsage {
  const result: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    const value = Math.max(0, (total[key] ?? 0) - (baseline[key] ?? 0));
    if (value || key === 'input_tokens' || key === 'output_tokens') result[key] = value;
  }
  return result;
}
function getNotifThreadId(message: JsonRpcMessage): string | null { return pickString(message.params?.threadId); }
function getNotifTurnId(message: JsonRpcMessage): string | null { return pickString(message.params?.turnId) ?? pickString(record(message.params?.turn).id); }
function parseCodexCliConfigOverrides(raw?: string): string[] {
  const values = (raw ?? '').split(/[\r\n;]+/).map(value => value.trim()).filter(value => value && !value.startsWith('#'));
  if (values.some(value => value.indexOf('=') <= 0)) throw new Error('bridge_codex_cli_config 每项必须是 key=value');
  return values;
}

export class CodexAppServerLLMProvider implements LLMProvider {
  private readonly client: CodexTransport;
  private readonly permissions: InMemoryPermissionGateway;
  private readonly options: CodexAppServerLLMProviderOptions;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private catalogPromise: Promise<void> | null = null;
  private catalogUpdatedAt = 0;
  private connectionEpoch = 0;
  private models: CodexModelListItem[] = [];
  private activeTurns = new Map<string, ActiveTurn>();
  private serverRequests = new Map<string | number, { permissionId: string; resolved: boolean }>();
  private previousUsage = new Map<string, TokenUsage>();
  private configuredEffort?: string;

  constructor(options: CodexAppServerLLMProviderOptions) {
    this.options = options;
    this.permissions = options.permissions;
    const overrides = parseCodexCliConfigOverrides(options.cliConfig);
    this.configuredEffort = overrides.find(value => /^model_reasoning_effort\s*=/.test(value))?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
    if (options.client) {
      this.client = options.client;
    } else {
      const binary = resolveCodexBinary(options.codexBin);
      const command = /\.[cm]?js$/i.test(binary) ? [process.execPath, binary] : [binary];
      command.push('app-server', '--listen', 'stdio://');
      for (const override of overrides) command.push('-c', override);
      this.client = new JsonRpcAppServerClient({ command, cwd: options.projectRoot, debug: options.debug });
    }
    this.client.onDisconnect(() => {
      this.resetConnectionState();
      for (const pending of this.serverRequests.values()) {
        pending.resolved = true;
        this.permissions.resolvePendingPermission(pending.permissionId, { behavior: 'deny', message: 'Codex 连接已断开' });
      }
    });
    this.client.onServerRequest(message => { void this.handleServerRequest(message).catch(error => console.warn('[codex-llm] 服务端请求已结束:', toErrorMessage(error))); });
    this.client.onNotification(message => {
      if (message.method !== 'serverRequest/resolved') return;
      const id = message.params?.requestId;
      if (typeof id !== 'string' && typeof id !== 'number') return;
      const pending = this.serverRequests.get(id);
      if (pending) {
        pending.resolved = true;
        this.permissions.resolvePendingPermission(pending.permissionId, { behavior: 'deny', message: '请求已由服务端结束' });
      }
    });
  }

  stop(): void {
    for (const active of this.activeTurns.values()) active.abort.abort();
    this.resetConnectionState();
    this.client.stop();
    this.previousUsage.clear();
  }

  /** 目录与握手分开管理：刷新失败不能断开其他聊天正在使用的连接。 */
  async getModelCatalog(options: { refresh?: boolean } = {}): Promise<ModelCatalog> {
    const epoch = this.connectionEpoch;
    await this.ensureInitialized();
    this.assertConnectionEpoch(epoch);
    await this.refreshModelCatalog(options.refresh === true);
    this.assertConnectionEpoch(epoch);
    return {
      models: this.models.filter(model => !model.hidden).map(model => ({
        id: model.id, model: model.model, displayName: model.displayName, isDefault: model.isDefault,
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: model.supportedReasoningEfforts.map(effort => ({ ...effort })),
        serviceTiers: model.serviceTiers.map(tier => ({ ...tier })),
        defaultServiceTier: model.defaultServiceTier,
      })),
    };
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    // 外部对象之后的变更不能把本轮模型、强度和速度拆成不同版本。
    params = { ...params, codexModelPreferences: params.codexModelPreferences ? { ...params.codexModelPreferences } : undefined };
    const epoch = this.connectionEpoch;
    const abort = new AbortController();
    const externalSignal = params.abortController?.signal;
    const onAbort = () => abort.abort(externalSignal?.reason);
    if (externalSignal?.aborted) onAbort();
    else externalSignal?.addEventListener('abort', onAbort, { once: true });
    let cancelled = false;
    return new ReadableStream<string>({
      start: async controller => {
        const send: SendEvent = (type, data) => {
          if (!cancelled) controller.enqueue(`data: ${JSON.stringify({ type, data: typeof data === 'string' ? data : JSON.stringify(data) })}\n`);
        };
        let threadId: string | undefined;
        let active: ActiveTurn | undefined;
        let keepAlive: NodeJS.Timeout | undefined;
        try {
          if (abort.signal.aborted) throw abortError();
          const keepAliveMs = this.options.keepAliveMs ?? 15_000;
          if (keepAliveMs > 0) keepAlive = setInterval(() => send('keep_alive', ''), keepAliveMs);
          await this.getModelCatalog({ refresh: Boolean(params.codexModelPreferences) });
          this.assertConnectionEpoch(epoch);
          if (abort.signal.aborted) throw abortError();
          const selection = this.selectModel(params.model, params.reasoningEffort, params.codexModelPreferences);
          const policy = this.turnPolicy(params.permissionMode);
          const input = this.buildInput(params, selection.model);
          if (params.sdkSessionId?.trim()) {
            threadId = params.sdkSessionId.trim();
            await this.client.request('thread/resume', {
              threadId, excludeTurns: true, model: selection.model.model,
              cwd: params.workingDirectory || this.options.projectRoot, ...policy,
            }, 30_000);
          } else {
            threadId = await this.startThread(params, selection, policy);
          }
          this.assertConnectionEpoch(epoch);
          // 线程已建立，但配置是否被接受要等 turn/start，不能提前报告为实际使用。
          send('status', { session_id: threadId });
          if (abort.signal.aborted) throw abortError();
          active = { emit: send, abort, onStatus: params.onRuntimeStatusChange };
          this.activeTurns.set(threadId, active);
          params.onRuntimeStatusChange?.('running');
          const turnId = await this.startTurn({ threadId, input, params, selection, policy });
          active.turnId = turnId;
          this.assertConnectionEpoch(epoch);
          if (!abort.signal.aborted) send('status', { session_id: threadId, model: selection.model.model, reasoning_effort: selection.effort, service_tier: selection.serviceTierForTurn });
          const result = await this.collectTurnText({
            threadId, turnId, signal: abort.signal, onDelta: delta => send('text', delta), onProgress: text => send('progress', text),
            onToolEvent: (id, name, status, item) => {
              if (status === 'running') send('tool_use', { id, name, input: item ?? {} });
              else send('tool_result', { tool_use_id: id, content: pickString(item?.aggregatedOutput) ?? '', is_error: status === 'error' });
            },
          });
          if (result.text && !result.emittedFinalText) send('text', result.text);
          send('result', { usage: result.usage, last_usage: result.lastUsage, context_window: result.contextWindow, context_tokens: result.contextTokens, is_error: false, session_id: threadId });
        } catch (error) {
          send('error', toErrorMessage(error));
          send('result', { is_error: true, error_code: error instanceof Error && error.name === 'AbortError' ? 'abort' : 'error', session_id: threadId ?? null });
        } finally {
          if (keepAlive) clearInterval(keepAlive);
          abort.abort();
          externalSignal?.removeEventListener('abort', onAbort);
          if (threadId && active && this.activeTurns.get(threadId) === active) this.activeTurns.delete(threadId);
          params.onRuntimeStatusChange?.('idle');
          if (!cancelled) controller.close();
        }
      },
      cancel: () => { cancelled = true; abort.abort(); },
    });
  }

  private selectModel(explicit?: string, effort?: string, preferences?: CodexModelPreferences): ModelSelection {
    if (preferences) {
      const model = preferences.model === 'default'
        ? this.models.find(model => !model.hidden && model.isDefault)
        : this.models.find(model => !model.hidden && model.id === preferences.model);
      if (preferences.model === 'default' && !model) throw new Error('Codex 模型目录未指定默认模型；请在 /model 中明确选择型号。');
      if (!model) throw new Error(`Codex 模型目录中没有 ${preferences.model}；请重新打开 /model 选择。`);
      const selectedEffort = preferences.reasoningEffort ?? model.defaultReasoningEffort;
      if (!model.supportedReasoningEfforts.some(option => option.reasoningEffort === selectedEffort)) {
        throw new Error(`模型 ${model.model} 不支持思考强度 ${selectedEffort}；请重新打开 /model 选择。`);
      }
      if (preferences.speed !== 'normal' && preferences.speed !== 'fast') throw new Error('Codex 速度设置无效；请重新打开 /model 选择。');
      let serviceTierForTurn = 'default';
      if (preferences.speed === 'fast') {
        const fastTier = findFastServiceTier(model);
        if (!fastTier) throw new Error(`模型 ${model.model} 的目录未提供 Fast 选项，可刷新 /model 后重新选择。`);
        serviceTierForTurn = fastTier.id;
      }
      return { model, effort: selectedEffort, serviceTierForTurn };
    }
    const selection = explicit?.trim() || this.options.modelId || this.options.modelHint;
    const model = selectCodexModel(this.models, { explicitId: selection });
    if (!model) throw new Error('Codex model/list 返回空目录；请检查本机登录、网络或运行时配置。');
    return { model, effort: selectCodexEffort(model, selection, effort || this.configuredEffort) };
  }

  private turnPolicy(mode?: string): TurnPolicy {
    if (mode === 'plan') return { sandbox: 'read-only', approvalPolicy: 'on-request' };
    if (mode === 'default' || mode === 'acceptEdits') return { sandbox: 'workspace-write', approvalPolicy: 'on-request' };
    if (mode === 'bypassPermissions') return { sandbox: 'danger-full-access', approvalPolicy: 'never' };
    return { sandbox: this.options.sandboxMode || 'workspace-write', approvalPolicy: this.options.approvalPolicy || (mode === 'dontAsk' ? 'never' : 'on-request') };
  }

  private buildInput(params: StreamChatParams, model: CodexModelListItem): Record<string, unknown>[] {
    let prompt = params.prompt;
    if (!params.sdkSessionId && params.conversationHistory?.length) {
      prompt = `以下是之前的对话记录（作为上下文）：\n${params.conversationHistory.map(message => `${message.role}: ${message.content}`).join('\n\n')}\n\n当前用户消息：\n${prompt}`;
    }
    const input: Record<string, unknown>[] = [{ type: 'text', text: prompt, text_elements: [] }];
    for (const file of params.files ?? []) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error(`Codex 暂不支持附件类型 ${file.type}（${file.name}）`);
      if (model.inputModalities && !model.inputModalities.includes('image')) throw new Error(`模型 ${model.model} 不支持图片输入`);
      if (!file.data && !file.filePath) throw new Error(`图片 ${file.name} 没有可用内容`);
      input.push(file.data ? { type: 'image', url: `data:${file.type};base64,${file.data}` } : { type: 'localImage', path: path.resolve(file.filePath!) });
    }
    return input;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.client.isRunning()) return;
    if (this.initPromise) return this.initPromise;
    const epoch = this.connectionEpoch;
    const pending = (async () => {
      await this.client.request('initialize', { clientInfo: { name: 'claude-to-im', version: '1.0.0' }, capabilities: { experimentalApi: true } }, 30_000);
      this.assertConnectionEpoch(epoch);
      this.client.notify('initialized');
      this.initialized = true;
    })();
    this.initPromise = pending;
    try { await pending; } catch (error) {
      if (epoch === this.connectionEpoch) {
        this.resetConnectionState();
        this.client.stop();
      }
      throw error;
    } finally { if (this.initPromise === pending) this.initPromise = null; }
  }

  private resetConnectionState(): void {
    this.connectionEpoch += 1;
    this.initialized = false;
    this.initPromise = null;
    this.catalogPromise = null;
    this.catalogUpdatedAt = 0;
    this.models = [];
  }

  private assertConnectionEpoch(epoch: number): void {
    if (epoch !== this.connectionEpoch) throw new Error('Codex 连接已结束，请重试。');
  }

  private async refreshModelCatalog(force: boolean): Promise<void> {
    if (this.catalogPromise) return this.catalogPromise;
    if (!force && this.models.length && Date.now() - this.catalogUpdatedAt < 1_000) return;
    const epoch = this.connectionEpoch;
    const pending = (async () => {
      const models: CodexModelListItem[] = [];
      const ids = new Set<string>();
      let cursor: string | null = null;
      const cursors = new Set<string>();
      do {
        const response = parseCodexModelPage(await this.client.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, 30_000));
        this.assertConnectionEpoch(epoch);
        for (const model of response.models) {
          if (ids.has(model.id)) throw new Error(`Codex 模型目录包含重复 ID ${model.id}`);
          ids.add(model.id);
          models.push(model);
        }
        cursor = response.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('Codex 模型目录返回重复分页游标');
        if (cursor) cursors.add(cursor);
        if (cursors.size > 100 || models.length > 10_000) throw new Error('Codex 模型目录超过合理分页范围');
      } while (cursor);
      const visible = models.filter(model => !model.hidden);
      if (!visible.length) throw new Error('Codex model/list 返回空目录；请检查本机登录、网络或运行时配置。');
      if (visible.filter(model => model.isDefault).length > 1) throw new Error('Codex 模型目录包含多个默认模型');
      this.models = models;
      this.catalogUpdatedAt = Date.now();
    })();
    this.catalogPromise = pending;
    try { await pending; } finally { if (this.catalogPromise === pending) this.catalogPromise = null; }
  }

  private async startThread(params: StreamChatParams, selection: ModelSelection, policy: TurnPolicy): Promise<string> {
    const response = record(await this.client.request('thread/start', {
      model: selection.model.model, cwd: params.workingDirectory || this.options.projectRoot, ...policy,
      ...(params.systemPrompt ? { baseInstructions: params.systemPrompt } : {}),
    }, 30_000));
    const id = pickString(record(response.thread).id);
    if (!id) throw new Error('thread/start 未返回 thread.id');
    return id;
  }

  private async startTurn(opts: { threadId: string; input: Record<string, unknown>[]; params: StreamChatParams; selection: ModelSelection; policy: TurnPolicy }): Promise<string> {
    const response = record(await this.client.request('turn/start', {
      threadId: opts.threadId, input: opts.input, model: opts.selection.model.model,
      effort: opts.selection.effort, cwd: opts.params.workingDirectory || this.options.projectRoot,
      ...(opts.selection.serviceTierForTurn ? { serviceTierForTurn: opts.selection.serviceTierForTurn } : {}),
      approvalPolicy: opts.policy.approvalPolicy, sandboxPolicy: buildTurnSandboxPolicy(opts.policy.sandbox),
    }, 30_000));
    const id = pickString(record(response.turn).id);
    if (!id) throw new Error('turn/start 未返回 turn.id');
    return id;
  }

  private async handleServerRequest(message: JsonRpcMessage & { id: string | number }): Promise<void> {
    const params = message.params ?? {};
    const active = this.activeTurns.get(pickString(params.threadId) ?? '');
    const method = message.method;
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'];
    if (!supported.includes(method ?? '')) { this.client.respondError(message.id, -32601, `不支持的服务端请求: ${method}`); return; }
    // 精细权限和 MCP elicitation 需要更专门的界面，明确拒绝而不是挂起或扩大授权。
    if (method === 'item/permissions/requestApproval') { this.client.respond(message.id, { permissions: {}, scope: 'turn' }); active?.emit('progress', '精细权限请求已拒绝，请在本地 Codex 完成授权。'); return; }
    if (method === 'mcpServer/elicitation/request') { this.client.respond(message.id, { action: 'decline', content: null }); active?.emit('progress', '此 MCP 交互需要在本地 Codex 完成。'); return; }
    if (!active || active.abort.signal.aborted || (active.turnId && params.turnId !== active.turnId)) {
      this.client.respond(message.id, method === 'item/tool/requestUserInput' ? { answers: {} } : { decision: 'cancel' }); return;
    }
    const pending = { permissionId: randomUUID(), resolved: false };
    this.serverRequests.set(message.id, pending);
    try {
      const resolutionPromise = this.permissions.waitFor(pending.permissionId, active.abort.signal);
      active.onStatus?.('waiting_for_input');
      if (method === 'item/tool/requestUserInput') {
        const questions: UserInputQuestion[] = [];
        for (const value of Array.isArray(params.questions) ? params.questions : []) {
          const question = record(value);
          const id = pickString(question.id); const text = pickString(question.question);
          if (!id || !text) continue;
          questions.push({ id, question: text, header: pickString(question.header) ?? undefined, allowOther: question.isOther === true, isSecret: question.isSecret === true,
            options: Array.isArray(question.options) ? question.options.flatMap(value => { const option = record(value); return typeof option.label === 'string' ? [{ label: option.label, description: pickString(option.description) ?? undefined }] : []; }) : undefined });
        }
        if (!questions.length) this.permissions.resolvePendingPermission(pending.permissionId, { behavior: 'deny', message: '服务端问题格式无效' });
        else active.emit('user_input_request', { requestId: pending.permissionId, questions });
        const resolution = await resolutionPromise;
        const supplied = record(resolution.updatedInput?.answers);
        const answers: Record<string, { answers: string[] }> = {};
        if (resolution.behavior === 'allow') for (const question of questions) {
          const values = supplied[question.id];
          if (Array.isArray(values) && values.every(value => typeof value === 'string')) answers[question.id] = { answers: values };
        }
        if (!pending.resolved) this.client.respond(message.id, { answers });
      } else {
        active.emit('permission_request', { permissionRequestId: pending.permissionId, toolName: method === 'item/fileChange/requestApproval' ? 'fileChange' : 'commandExecution', toolInput: params });
        const resolution = await resolutionPromise;
        const decision = resolution.behavior === 'allow' ? resolution.scope === 'session' ? 'acceptForSession' : 'accept' : active.abort.signal.aborted ? 'cancel' : 'decline';
        if (!pending.resolved) this.client.respond(message.id, { decision });
      }
    } catch (error) {
      this.permissions.resolvePendingPermission(pending.permissionId, { behavior: 'deny', message: '交互请求失败' });
      if (!pending.resolved && this.client.isRunning()) this.client.respondError(message.id, -32603, toErrorMessage(error));
    } finally {
      this.serverRequests.delete(message.id);
      active.onStatus?.('running');
    }
  }

  private async collectTurnText(opts: {
    threadId: string; turnId: string; signal: AbortSignal; onDelta: (delta: string) => void;
    onProgress?: (text: string) => void;
    onToolEvent?: (id: string, name: string, status: 'running' | 'complete' | 'error', item?: Record<string, unknown>) => void;
  }): Promise<TurnResult> {
    let text = ''; let emittedFinalText = false;
    let usage: TokenUsage | null = null; let lastUsage: TokenUsage | null = null; let contextWindow: number | null = null; let contextTokens: number | null = null;
    let baseline = this.previousUsage.get(opts.threadId) ?? null;
    let finalTotal: TokenUsage | null = null;
    const items = new Map<string, { phase: string; buffered: string; emitted: string }>();
    const toolIds = new Set<string>();
    let completed = false;
    let timeout: NodeJS.Timeout | undefined; let idleTimer: NodeJS.Timeout | undefined;
    let off = () => {}; let offDisconnect = () => {};
    let rejectTurn: (error: Error) => void = () => {};
    const onAbort = () => rejectTurn(abortError());
    const matches = (message: JsonRpcMessage) => getNotifThreadId(message) === opts.threadId && getNotifTurnId(message) === opts.turnId;
    try {
      await new Promise<void>((resolve, reject) => {
        rejectTurn = reject;
        const idleMs = this.options.turnIdleTimeoutMs ?? 0;
        const refreshIdle = () => { if (idleTimer) clearTimeout(idleTimer); if (idleMs > 0) idleTimer = setTimeout(() => reject(new Error('Codex 长时间没有进展，已请求中断')), idleMs); };
        const flush = (id: string) => {
          const item = items.get(id);
          if (!item?.buffered || !item.phase) return;
          const delta = item.buffered; item.buffered = ''; item.emitted += delta;
          if (item.phase === 'commentary') opts.onProgress?.(item.emitted);
          else { text += delta; emittedFinalText = true; opts.onDelta(delta); }
        };
        const handle = (message: JsonRpcMessage) => {
          if (!matches(message) || completed) return;
          refreshIdle();
          const params = message.params ?? {}; const item = record(params.item);
          if (message.method === 'thread/tokenUsage/updated') {
            const raw = record(params.tokenUsage);
            lastUsage = normalizeTokenUsage(raw.last);
            const total = normalizeTokenUsage(raw.total);
            if (total) {
              if (!baseline) baseline = lastUsage ? subtractUsage(total, lastUsage) : total;
              usage = subtractUsage(total, baseline); finalTotal = total;
            }
            contextWindow = number(raw.modelContextWindow) || null;
            const last = record(raw.last);
            if (typeof last.totalTokens === 'number' && last.totalTokens >= 0) contextTokens = last.totalTokens;
          } else if (message.method === 'item/agentMessage/delta') {
            const id = pickString(params.itemId); if (!id) return;
            const state = items.get(id) ?? { phase: '', buffered: '', emitted: '' };
            state.buffered += typeof params.delta === 'string' ? params.delta : '';
            items.set(id, state); flush(id);
          } else if (message.method === 'item/started' || message.method === 'item/completed') {
            const id = pickString(item.id); if (!id) return;
            const done = message.method === 'item/completed';
            if (item.type === 'agentMessage') {
              const state = items.get(id) ?? { phase: '', buffered: '', emitted: '' };
              state.phase = pickString(item.phase) ?? (done ? 'final_answer' : ''); items.set(id, state); flush(id);
              if (done && typeof item.text === 'string') {
                if (state.phase === 'commentary') { if (item.text !== state.emitted) opts.onProgress?.(item.text); }
                else if (!state.emitted && item.text) { text += item.text; emittedFinalText = true; opts.onDelta(item.text); }
                else if (item.text.startsWith(state.emitted) && item.text.length > state.emitted.length) { const delta = item.text.slice(state.emitted.length); text += delta; opts.onDelta(delta); }
              }
            } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'collabAgentToolCall'].includes(String(item.type))) {
              const name = pickString(item.tool) ?? pickString(item.command) ?? String(item.type);
              if (!toolIds.has(id)) { toolIds.add(id); opts.onToolEvent?.(id, name, 'running', item); }
              if (done) opts.onToolEvent?.(id, name, item.status === 'failed' || item.status === 'declined' || number(item.exitCode) > 0 || Boolean(item.error) ? 'error' : 'complete', item);
            }
          } else if (message.method === 'item/mcpToolCall/progress') {
            if (typeof params.message === 'string') opts.onProgress?.(params.message);
          } else if (message.method === 'error' && params.willRetry !== true) {
            reject(new Error(toErrorMessage(pickString(record(params.error).message) ?? JSON.stringify(params.error))));
          } else if (message.method === 'turn/completed') {
            const turn = record(params.turn); completed = true;
            if (turn.status === 'failed') reject(new Error(toErrorMessage(pickString(record(turn.error).message) ?? 'Codex turn 执行失败')));
            else if (turn.status === 'interrupted') reject(abortError());
            else resolve();
          }
        };
        off = this.client.onNotification(message => { try { handle(message); } catch (error) { reject(error); } });
        offDisconnect = this.client.onDisconnect(error => reject(error));
        opts.signal.addEventListener('abort', onAbort, { once: true });
        if (opts.signal.aborted) { reject(abortError()); return; }
        const timeoutMs = this.options.turnTimeoutMs ?? 90 * 60_000;
        if (timeoutMs > 0) timeout = setTimeout(() => reject(new Error('Codex turn 执行超时，已请求中断')), timeoutMs);
        refreshIdle();
        for (const message of this.client.drainBacklog(matches)) handle(message);
      });
      if (finalTotal) this.previousUsage.set(opts.threadId, finalTotal);
      return { text, usage, lastUsage, contextWindow, contextTokens, emittedFinalText };
    } catch (error) {
      if (!completed && this.client.isRunning()) {
        try { await this.client.request('turn/interrupt', { threadId: opts.threadId, turnId: opts.turnId }, 5000); } catch { /* 保留原始错误 */ }
      }
      throw error;
    } finally {
      off(); offDisconnect(); opts.signal.removeEventListener('abort', onAbort);
      if (timeout) clearTimeout(timeout); if (idleTimer) clearTimeout(idleTimer);
      this.client.drainBacklog(matches);
    }
  }
}
