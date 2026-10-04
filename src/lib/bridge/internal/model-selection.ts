import { randomUUID } from 'node:crypto';
import type { BaseChannelAdapter } from '../channel-adapter.js';
import type { BridgeStore, LLMProvider } from '../host.js';
import type { ChannelAddress, ChannelBinding, CodexModelPreferences, InboundMessage, ModelCatalog, ModelCatalogEntry, ModelSelectionView } from '../types.js';
import { abortable } from './abort.js';

/** 应用、消息准入与切换会话共用此门；不能持有它等待模型回合结束。 */
export class ChatAdmissionGate {
  private pending = new Map<string, Promise<unknown>>();

  run<T>(address: ChannelAddress, operation: () => T | Promise<T>): Promise<T> {
    const key = `${address.channelType}:${address.chatId}`;
    const previous = this.pending.get(key);
    const next = (previous ?? Promise.resolve()).catch(() => {}).then(operation);
    this.pending.set(key, next);
    void next.finally(() => {
      if (this.pending.get(key) === next) this.pending.delete(key);
    }).catch(() => {});
    return next;
  }
}

export function resolveModelPreference(catalog: ModelCatalog, preferences: CodexModelPreferences): ModelCatalogEntry {
  if (!preferences || typeof preferences.model !== 'string'
    || !(preferences.reasoningEffort === null || typeof preferences.reasoningEffort === 'string')
    || !['normal', 'fast'].includes(preferences.speed)) throw new Error('模型配置格式无效，请重新 /model 选择。');
  const entry = preferences.model === 'default'
    ? catalog.models.find(model => model.isDefault)
    : catalog.models.find(model => model.id === preferences.model);
  if (!entry) throw new Error(preferences.model === 'default' ? 'Codex 目录未提供默认模型，请明确选择型号。' : `当前目录没有模型 ${preferences.model}，请刷新后重新选择。`);
  const effort = preferences.reasoningEffort ?? entry.defaultReasoningEffort;
  if (!entry.supportedReasoningEfforts.some(option => option.reasoningEffort === effort)) {
    throw new Error(`模型 ${entry.displayName} 不支持思考强度 ${effort}，请重新选择。`);
  }
  if (preferences.speed === 'fast' && !entry.serviceTiers.some(tier => tier.id === 'fast')) {
    throw new Error(`模型 ${entry.displayName} 未提供 Fast，请打开 /model 重新选择速度。`);
  }
  return entry;
}

export function describeModelPreferences(binding: ChannelBinding, catalog?: ModelCatalog): string {
  const preferences = binding.codexModelPreferences;
  if (!preferences) return `当前模型：${binding.model || '由宿主配置决定'}\n思考强度：${binding.reasoningEffort || '由运行时决定'}\n速度：运行时默认／未指定`;
  const selected = preferences.model === 'default'
    ? catalog?.models.find(model => model.isDefault) : catalog?.models.find(model => model.id === preferences.model);
  const resolved = selected ? `（当前解析：${selected.model}）` : '';
  return [
    `模型：${preferences.model === 'default' ? '跟随 Codex 默认' : preferences.model}${resolved}`,
    `思考强度：${preferences.reasoningEffort ?? `跟随模型默认${selected ? `（${selected.defaultReasoningEffort}）` : ''}`}`,
    `速度：${preferences.speed === 'fast' ? 'Fast（用量更高）' : '正常'}`,
    '当前聊天生效，/new 后保留，下一次请求使用。',
    ...(binding.lastModelRuntime ? [`上次实际型号：${binding.lastModelRuntime.model}`] : []),
  ].join('\n');
}

interface SelectionOwner {
  bindingId: string;
  sessionId: string;
  generation: number;
  epoch: number;
}

interface Draft {
  id: string;
  address: ChannelAddress;
  owner: SelectionOwner;
  messageId?: string;
  revision: number;
  expiresAt: number;
  catalog: ModelCatalog;
  preferences: CodexModelPreferences;
  step: ModelSelectionView['step'];
  page: number;
  summary: string;
  notice?: string;
  abort: AbortController;
}

interface SelectionDependencies {
  store: BridgeStore;
  llm: LLMProvider;
  gate: ChatAdmissionGate;
  capture: (address: ChannelAddress) => SelectionOwner;
  isCurrent: (address: ChannelAddress, owner: SelectionOwner) => boolean;
  isBusy: (address: ChannelAddress) => boolean;
  now?: () => number;
  ttlMs?: number;
  ioTimeoutMs?: number;
}

/** 只持有短期配置草稿，独立于正在运行的模型问答与审批。 */
export class ModelSelectionCoordinator {
  private drafts = new Map<string, Draft>();
  private operations = new ChatAdmissionGate();
  private now: () => number;

  constructor(private deps: SelectionDependencies) { this.now = deps.now ?? Date.now; }

  invalidate(address?: ChannelAddress): void {
    if (!address) {
      for (const draft of this.drafts.values()) draft.abort.abort(new Error('模型卡已失效，请重新 /model。'));
      this.drafts.clear(); return;
    }
    this.drafts.get(this.key(address))?.abort.abort(new Error('模型卡已失效，请重新 /model。'));
    this.drafts.delete(this.key(address));
  }

  private key(address: ChannelAddress): string { return `${address.channelType}:${address.chatId}`; }

  private current(draft: Draft): boolean {
    return this.drafts.get(this.key(draft.address)) === draft
      && !draft.abort.signal.aborted && draft.expiresAt > this.now() && this.deps.isCurrent(draft.address, draft.owner);
  }

  private requireCurrent(draft: Draft): void {
    if (!this.current(draft)) throw new Error('模型卡已过期或会话已切换，请重新发送 /model。');
  }

  /** 限制本地等待并释放控制队列；不能声称平台已经取消请求。 */
  private async waitFor<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await abortable(Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('模型目录或卡片操作超时，请重新 /model。')), this.deps.ioTimeoutMs ?? 30_000);
      })]), signal);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async catalog(refresh = false, signal?: AbortSignal): Promise<ModelCatalog> {
    if (!this.deps.llm.getModelCatalog) throw new Error('当前 Codex 宿主没有提供模型目录能力。');
    const catalog = await this.waitFor(this.deps.llm.getModelCatalog({ refresh }), signal);
    if (!catalog.models.length) throw new Error('Codex 当前没有可用模型，请稍后刷新。');
    return catalog;
  }

  private view(draft: Draft): ModelSelectionView {
    // 兼顾选项数和 JSON 二次转义后的字节数；完整目录仍保留在草稿中。
    let currentPage: ModelCatalogEntry[] = [];
    const pages: ModelCatalogEntry[][] = [currentPage];
    let bytes = 0;
    for (const model of draft.catalog.models) {
      const size = Buffer.byteLength(JSON.stringify(JSON.stringify({ value: model.id, label: model.displayName })), 'utf8') + 200;
      if (size > 10_000) throw new Error('模型目录包含超过卡片字节限制的单个选项，请使用文字命令或修复目录。');
      if (currentPage.length >= 20 || bytes + size > 10_000) { currentPage = []; pages.push(currentPage); bytes = 0; }
      currentPage.push(model); bytes += size;
    }
    const pageCount = pages.length;
    draft.page = Math.min(draft.page, pageCount - 1);
    const selected = draft.preferences.model === 'default'
      ? draft.catalog.models.find(model => model.isDefault)
      : draft.catalog.models.find(model => model.id === draft.preferences.model);
    return {
      requestId: draft.id, revision: draft.revision, step: draft.step, summary: draft.summary,
      notice: draft.notice, models: pages[draft.page],
      page: draft.page, pageCount, selectedModel: draft.preferences.model, selectedModelEntry: selected,
      reasoningEffort: draft.preferences.reasoningEffort ?? '', speed: draft.preferences.speed,
    };
  }

  private async patch(adapter: BaseChannelAdapter, draft: Draft): Promise<void> {
    this.requireCurrent(draft);
    if (!draft.messageId || !adapter.updateModelSelection) throw new Error('当前平台不支持更新模型选择卡。');
    const result = await this.waitFor(adapter.updateModelSelection(draft.address, draft.messageId, this.view(draft)), draft.abort.signal);
    this.requireCurrent(draft);
    if (!result.ok) throw new Error(`模型卡更新失败：${result.error || '未知错误'}；请重新 /model。`);
  }

  async open(adapter: BaseChannelAdapter, msg: InboundMessage, binding: ChannelBinding): Promise<void> {
    if (!msg.address.userId) throw new Error('缺少操作者身份，无法建立模型选择卡。');
    if (!adapter.sendModelSelection || !adapter.updateModelSelection) throw new Error('当前平台不支持模型卡，请使用 /model <model-id> [effort]。');
    for (const value of this.drafts.values()) if (value.expiresAt <= this.now()) this.invalidate(value.address);
    this.invalidate(msg.address);
    const draft: Draft = {
      id: randomUUID(), address: { ...msg.address }, owner: this.deps.capture(msg.address), revision: 0,
      expiresAt: this.now() + (this.deps.ttlMs ?? 600_000), catalog: { models: [] },
      preferences: binding.codexModelPreferences ? { ...binding.codexModelPreferences }
        : { model: 'default', reasoningEffort: null, speed: 'normal' },
      step: 'model', page: 0, summary: '', abort: new AbortController(),
    };
    this.drafts.set(this.key(msg.address), draft);
    try {
      draft.catalog = await this.catalog(false, draft.abort.signal);
      this.requireCurrent(draft);
      await this.deps.gate.run(msg.address, () => {
        this.requireCurrent(draft);
        const current = this.deps.store.getChannelBinding(msg.address.channelType, msg.address.chatId);
        if (!current) throw new Error('聊天绑定已失效。');
        draft.preferences = current.codexModelPreferences ? { ...current.codexModelPreferences }
          : { model: 'default', reasoningEffort: null, speed: 'normal' };
        draft.summary = describeModelPreferences(current, draft.catalog);
      });
      this.requireCurrent(draft);
      const sending = adapter.sendModelSelection(msg.address, this.view(draft), msg.messageId);
      // 即便本地取消先返回，平台迟到的卡片仍尽力移除按钮，不注册为新草稿。
      void sending.then(async result => {
        if (!this.current(draft) && result.ok && result.messageId && adapter.updateModelSelection) {
          await this.waitFor(adapter.updateModelSelection(msg.address, result.messageId, { ...this.view(draft), step: 'expired', notice: '会话已改变，请重新 /model。' }));
        }
      }).catch(() => {});
      const result = await this.waitFor(sending, draft.abort.signal);
      this.requireCurrent(draft);
      if (!result.ok || !result.messageId) throw new Error(`模型卡发送失败：${result.error || '没有消息 ID'}`);
      draft.messageId = result.messageId;
    } catch (error) {
      if (this.drafts.get(this.key(msg.address)) === draft) this.invalidate(msg.address);
      throw error;
    }
  }

  async respond(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<string | null> {
    return this.operations.run(msg.address, async () => {
      const response = msg.modelSelectionResponse;
      const draft = this.drafts.get(this.key(msg.address));
      if (!response || !draft || response.requestId !== draft.id || response.revision !== draft.revision
        || msg.address.userId !== draft.address.userId || !msg.callbackMessageId || msg.callbackMessageId !== draft.messageId
        || !adapter.isAuthorized(msg.address.userId || '', msg.address.chatId)) {
        throw new Error('模型卡无效、已更新或不属于当前操作者，请重新 /model。');
      }
      this.requireCurrent(draft);
      if (!['model', 'settings'].includes(draft.step)) throw new Error('模型卡已处理，请勿重复提交。');
      if (response.action === 'apply') {
        if (draft.step !== 'settings') throw new Error('请先选择模型，再设置强度和速度。');
        const preferences: CodexModelPreferences = {
          model: draft.preferences.model,
          reasoningEffort: response.reasoningEffort === '' ? null : response.reasoningEffort ?? draft.preferences.reasoningEffort,
          speed: response.speed === 'normal' || response.speed === 'fast' ? response.speed : draft.preferences.speed,
        };
        if (response.speed !== undefined && !['normal', 'fast'].includes(response.speed)) throw new Error('速度选项无效。');
        const catalog = await this.catalog(true, draft.abort.signal);
        this.requireCurrent(draft);
        const persisted = await this.deps.gate.run(msg.address, () => this.save(msg.address, draft.owner, preferences, catalog, () => this.requireCurrent(draft)));
        draft.preferences = preferences;
        draft.catalog = catalog;
        draft.step = 'applied';
        draft.revision++;
        const binding = this.deps.store.getChannelBinding(msg.address.channelType, msg.address.chatId);
        draft.summary = binding ? describeModelPreferences(binding, catalog) : '';
        draft.notice = persisted ? '配置已持久保存。' : '宿主已接受配置；未提供落盘确认，重启保留由宿主保证。';
        try { await this.patch(adapter, draft); }
        catch { return `${draft.notice}\n${draft.summary}\n原卡更新失败或会话已切换，请用 /status 查看当前配置。`; }
        return null;
      }
      if (response.action === 'cancel') draft.step = 'cancelled';
      else if (response.action === 'refresh') {
        draft.catalog = await this.catalog(true, draft.abort.signal);
        this.requireCurrent(draft);
        draft.step = 'model'; draft.page = 0; draft.notice = '模型目录已刷新，请重新确认型号。';
        const binding = this.deps.store.getChannelBinding(msg.address.channelType, msg.address.chatId);
        if (binding) draft.summary = describeModelPreferences(binding, draft.catalog);
      } else if (response.action === 'next') {
        if (draft.step !== 'model' || !response.model) throw new Error('请选择模型后继续。');
        const selected = response.model === 'default' ? draft.catalog.models.find(model => model.isDefault)
          : draft.catalog.models.find(model => model.id === response.model);
        if (!selected) throw new Error('所选模型已不可用，请刷新目录。');
        const changed = draft.preferences.model !== response.model;
        draft.preferences.model = response.model;
        if (changed) {
          draft.notice = '已切换模型，请确认本模型的强度和速度；尚未保存。';
        }
        // 保留兼容选择；失效值由必填表单要求重选，不能自动降档。
        if (draft.preferences.reasoningEffort && !selected.supportedReasoningEfforts.some(value => value.reasoningEffort === draft.preferences.reasoningEffort)) {
          draft.notice = '原强度已不可用，请重新选择；不会自动降低档位。';
        }
        if (draft.preferences.speed === 'fast' && !selected.serviceTiers.some(tier => tier.id === 'fast')) {
          draft.notice = '原 Fast 档位已不可用，请重新选择速度；不会自动切换正常。';
        }
        draft.step = 'settings';
      } else if (response.action === 'back') { draft.step = 'model'; }
      else if (response.action === 'next_page' || response.action === 'previous_page') {
        if (draft.step !== 'model') throw new Error('此步骤不支持翻页。');
        draft.page = Math.max(0, draft.page + (response.action === 'next_page' ? 1 : -1));
      } else throw new Error('未知的模型卡操作。');
      draft.revision++;
      await this.patch(adapter, draft);
      return null;
    });
  }

  private async save(address: ChannelAddress, owner: SelectionOwner, preferences: CodexModelPreferences, catalog: ModelCatalog, check?: () => void): Promise<boolean> {
    check?.();
    if (!this.deps.isCurrent(address, owner)) throw new Error('会话已切换，请重新 /model。');
    if (this.deps.isBusy(address)) throw new Error('请等待当前任务及排队消息完成，或先 /stop，再应用模型配置。');
    resolveModelPreference(catalog, preferences);
    const binding = this.deps.store.getChannelBinding(address.channelType, address.chatId);
    if (!binding) throw new Error('聊天绑定已失效。');
    const previous = binding.codexModelPreferences;
    const next = { ...preferences };
    this.deps.store.updateChannelBinding(binding.id, { codexModelPreferences: next });
    try {
      await this.flushWithin(5000);
      check?.();
      if (!this.deps.isCurrent(address, owner)) throw new Error('保存期间会话已切换，本次配置未应用。');
      return Boolean(this.deps.store.flush);
    } catch (error) {
      const current = this.deps.store.getChannelBinding(address.channelType, address.chatId);
      // 只回滚仍为本次值的偏好字段；并行 /cwd、mode 等无关更新必须保留。
      if (current?.id === binding.id
        && JSON.stringify(current.codexModelPreferences) === JSON.stringify(next)) {
        this.deps.store.updateChannelBinding(binding.id, { codexModelPreferences: previous });
        // 保存失败时首先撤销内存修改；flush 成功但归属失效时也补写回滚。
        try { await this.flushWithin(1000); } catch { /* 保留原始错误，不宣称持久成功。 */ }
      }
      throw new Error(`模型配置保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async flushWithin(timeoutMs: number): Promise<void> {
    if (!this.deps.store.flush) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.deps.store.flush(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('等待持久保存超时')), timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async setText(address: ChannelAddress, model: string, effort?: string): Promise<string> {
    const owner = this.deps.capture(address);
    const catalog = await this.catalog(true);
    return this.deps.gate.run(address, async () => {
      const binding = this.deps.store.getChannelBinding(address.channelType, address.chatId);
      const preferences: CodexModelPreferences = { model, reasoningEffort: effort || null, speed: binding?.codexModelPreferences?.speed ?? 'normal' };
      const persisted = await this.save(address, owner, preferences, catalog);
      this.invalidate(address);
      const current = this.deps.store.getChannelBinding(address.channelType, address.chatId);
      return `${persisted ? '配置已持久保存。' : '宿主已接受配置；未提供落盘确认。'}\n${current ? describeModelPreferences(current, catalog) : ''}`;
    });
  }

  async textView(binding: ChannelBinding): Promise<string> {
    const catalog = await this.catalog();
    return `${describeModelPreferences(binding, catalog)}\n可用模型：\n${catalog.models.map(model => `${model.id}（${model.displayName}）`).join('\n')}\n用法：/model <model-id> [effort]；/model default 跟随 Codex 默认。`;
  }
}
