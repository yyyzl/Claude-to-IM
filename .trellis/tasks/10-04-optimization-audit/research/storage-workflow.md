# Research: 存储、工作流恢复与自动修复优化审计

- Query: 在已升级的工作区基线上，哪些存储、工作流与自动修复问题会影响可靠性、审查正确性和成本，如何最小范围优化？
- Scope: mixed；本地源码为主，Git 官方文档用于核对 worktree / diff 语义。
- Date: 2026-10-04
- Baseline: 当前工作区（包含尚未提交的运行时升级），不把已经修复的 AutoFixer `cwd`、Claude 默认模型、测试真实模型隔离再列成旧问题。
- Boundaries: 只读业务源码；仅本研究报告与同目录复现测试落盘。没有读取真实会话存储、凭据、生产日志，没有执行真实模型、IM API、git worktree、commit 或删除操作。

## Findings

现有架构有值得保留的基础：BridgeStore 契约把宿主存储与桥接核心分开；WorkflowStore 集中管理运行产物；code-review 持久化快照并在后续轮次复用；运行产物先于检查点写入；审查与修改有独立的 AutoFixer。优先补齐这些边界的正确性，无需先重做成微服务。

本审计收敛为六项，P1 表示下一批可靠性修复优先处理，P2 表示有明确收益的体验、性能与成本改进。本轮没有根据代码推测生产故障已发生，也没有 P0 的生产事故证据。

| 编号 | 优先级 | 结论 | 确定性 |
|---|---|---|---|
| SW-1 | P1，增长部分 P2 | 单文件存储会吞掉损坏和写失败，下一次保存可覆盖剩余恢复材料；历史无限增长放大全量同步写开销 | 故障逻辑确证，内存复现；实际数据规模未测 |
| SW-2 | P1 | 非正常退出留下 `running`，恢复入口拒绝；检查点写入也缺原子替换和唯一执行者 | 状态拒绝已复现；并发窗口源码确证 |
| SW-3 | P1 | 非 HEAD 审查可能混用目标 diff 与当前 HEAD 正文；修复工作树未沿用审查快照 | 非 HEAD 快照已 fake 复现；修复基线源码确证 |
| SW-4 | P1 | 重试相同修复 run 会强制移除旧 worktree 和删除分支 | 源码确证；未执行任何删除 |
| SW-5 | P1 | “有任意 diff”被当成修复成功，失败残留可被下一组提交，最终 diff 基线也算错 | fake 编排复现；未修改真实文件 |
| SW-6 | P2 | 工作流没有总耗时/费用预算，重试与轮次叠加，提示词预算仍有缺口 | 配置及控制流确证；未测真实账单或延迟 |

### SW-1：让 JSON 存储具备可恢复的写入语义

**触发场景与证据**

- `scripts/claude-to-im-bridge/store.ts:370` 的 `load()` 读取、解析唯一数据文件，`:396` 捕获所有异常后静默继续；损坏文件、权限错误等都会表现成“没有旧数据”。
- `store.ts:409` 的 `save()` 在 `:421` 直接 `writeFileSync(dataPath, JSON.stringify(...))` 覆盖原文件，没有临时文件、上一代备份或原子替换；`:422` 同样吞掉写失败。
- `store.ts:401` 延迟 200 ms 才保存。宿主 `scripts/feishu-claude-bridge.ts:518` 停桥接、`:522` 直接 `process.exit(0)`，未调用 Store 的 flush；Store 也没有公开 flush/close 契约。若退出发生在待保存窗口，最后一次变更没有落盘保证。
- `store.ts:221` 无限制追加消息；`:414` 每次序列化全部 sessions/bindings/messages/offsets，而且是同步磁盘操作。`src/lib/bridge/conversation-engine.ts:198` 只读取最近 50 条做上下文，并不能限制已保留的全部历史大小。

**调用链和用户影响**

`channel-router / conversation-engine → createSession / addMessage / updateSdkSessionId → scheduleSave → save`。受影响的是全部聊天绑定、SDK 会话 ID 和历史；坏文件后又创建新会话会覆盖唯一旧文件，用户可能感到突然“失忆”。历史量大时，同步 stringify/write 会阻塞消息处理、流式刷新和心跳，但没有读取生产文件，不能声称用户当前已经卡顿。

**复现**

将 fs 边界替换成内存 fake，加载截断的 synthetic JSON 后 `getSession('previous') === null`；新建一条 synthetic session 并等待保存定时器后，fake write 收到的 JSON 只包含新 session。证明的是损坏后的覆盖行为；未刻意使真实磁盘损坏。

**最小改法**

1. 提供一个串行的写入队列，写到同目录临时文件、完成后替换正式文件，并保留最后一份有效快照；替换失败必须保持旧数据。
2. 只把 ENOENT 当成“首次启动”；格式损坏应报可操作的诊断并停止覆盖，允许从已校验备份恢复。持久化失败需进入可观测的 degraded 状态，不能回复已经持久保存。
3. 加 `flush()/close()` 并在有序停机时 await；重要会话绑定和 SDK ID 落盘可比普通历史采用更强保证。
4. 消息与元数据分开：先做每会话历史保留/归档与写入计时，再按需要改成追加日志。归档与删除应保留用户控制，不在本次审计中清理现有数据。

**长期选择与边界**

单进程、单写入者、少量活跃会话时，原子 JSON 快照加追加历史足够，SQLite 不是前置条件。若要两个 runner 共享存储、跨进程去重、按历史搜索、可靠事务提交，或合成基准显示全量写明显拖慢交互，才迁移到 SQLite 等本地事务存储。现有内存锁和 dedup（`:114-115`、`:236`、`:303`）只满足单进程；数据库应解决已明确的并发/查询需求，而不是装饰架构。

**回归验证**

故障注入：截断文件、写失败、临时文件落盘后中断、替换失败、退出前不足 200 ms；重启后验证绑定/SDK ID/消息一致。另用合成 1 千、1 万、10 万条消息量测保存耗时、事件循环延迟、内存和重启耗时，不使用真实聊天记录。本轮搜索未发现 JsonFileBridgeStore 的直接单元测试。

### SW-2：把“可恢复”扩展到真正的进程崩溃

**触发场景与证据**

- `src/lib/workflow/workflow-engine.ts:153` 创建的状态为 `running`，`:204-209` 的 resume 只接受 `paused / failed / human_review`。断电、进程强杀或某些非模型步骤抛错，来不及改状态就会留下无法 resume 的 run。
- `workflow-store.ts:119-133` 对 meta 执行 read–merge–write；`:199-201` 覆盖 ledger，均非原子替换。事件日志支持跳过坏行（`:322-344`）不能挽救损坏的 meta/ledger。
- `workflow-engine.ts:240-251` 的 pause 发出 abort 后立即更新 meta，没有 await 正在执行的 runLoop 退出。runLoop 同时也在写检查点。若随后恢复或并发调用，存在旧执行者覆盖新状态的窗口。
- 引擎没有 run 级 owner/lease/revision；`resume` 的读状态与写 running 之间没有 compare-and-set。宿主按聊天维护的活动列表不能保证同一个 run 只被一个 CLI 或聊天恢复。

**调用链和用户影响**

`CLI handleResume / workflow-command.handleResume → WorkflowEngine.resume → WorkflowStore.getMeta/updateMeta → runLoop`。用户需要继续一项已跑很久的评审，却得到 “Cannot resume ... running”；并发恢复则可能重复调用模型、交叉写 ledger。GitNexus 确认了两个 resume 调用入口，实际行号以当前源码为准。

**最小改法**

持久化 run owner 与租约/心跳，恢复前检查旧执行者存活；只有确认失联才把遗留 running 标为 interrupted/可恢复，不能简单把所有 running 放行。按 run 串行写入，关键文件采用原子替换，检查点写 revision。`pause()` 等待当前执行结束和检查点写完后再宣告已暂停。把“步产物已提交”和“步骤重放幂等”作为故障测试断言。

**长期选择**

保留现有文件化产物，增加小型 manifest/提交检查点即可；只有多执行器协同时才考虑事务状态表和任务队列。模型输出、审查报告仍可留文件，不必全部塞数据库。

**回归验证**

本轮 fake Store 返回 running，真实 `resume()` 确实拒绝，未调用模型。后续应在每个写入边界注入中断并重新构造引擎；同时恢复同一 run 应只启动一个 fake 模型；pause 返回后不再出现旧执行者的新写入。现有 workflow-engine 测试包含正常 pause/resume，不能替代强杀遗留状态测试。

### SW-3：让审查证据与修复目标使用同一个冻结版本

**触发场景与证据**

- `src/lib/workflow/diff-reader.ts:345-358` 按 scope 使用指定 commit/range/branch 生成 diff；但 `:191` 统一 `getBlobSha(filePath, 'HEAD', scope)`。
- `diff-reader.ts:370-381` 只对 staged/unstaged 特判，其他模式直接读传入的 HEAD。因此审查旧 commit 或另一个 head_ref 时，diff 来自目标版本，全文却来自当前 checkout 的 HEAD；`:106` 记录的 head_commit 也是当前 HEAD。
- `src/lib/workflow/auto-fixer.ts:76-104` 只加载 ledger，没有读取 snapshot；`:207` 从执行时的 HEAD 新建 worktree。审查 staged/unstaged 变更，或者长审查期间 HEAD 前进，修复目标不是刚才被审查的版本。此前升级已正确把模型 cwd 指向 worktree（`:123`），但 cwd 正确不代表其基线正确。

**调用链和用户影响**

`CLI handleCodeReview / workflow-command handleStartCodeReview 或 handleStartReviewFix → DiffReader.createSnapshot → WorkflowEngine.start → AutoFixer.applyFixes`。模型可能根据互相冲突的代码给出错误结论；未提交的新增文件在修复 worktree 里还可能根本不存在。

**复现**

仅 fake git 输出：请求 `commit_range(BASE..REVIEW_TARGET)`，实际记录到了 `git diff BASE..REVIEW_TARGET` 和 `git ls-tree HEAD -- src/a.ts`；生成快照的正文为 synthetic `CURRENT_HEAD_CONTENT`，而 diff 是 `review-target`。没有运行真实 Git。

**最小改法**

将 review scope 解析成明确的 base/head 对象 ID；diff、正文 blob 和 snapshot 元数据统一引用这些 ID。staged/unstaged 快照需要物化为可复现的 tree/patch，再从该基线创建修复 worktree。实施前先增加基线校验：如果无法安全重建审查状态，清晰拒绝自动修复并输出报告，不在另一个版本上猜修。

**长期选择**

定义不可变的 `ReviewBaseline`，由 DiffReader 创建，Engine 持久化，AutoFixer 消费；摘要、diff、提交范围和 apply 操作均引用同一个 baselineId。仍可全部使用 Git 对象与本地 manifest。

**回归验证**

fake 覆盖 HEAD 以外的 commit、commit_range、branch tip，以及 staged 新文件、unstaged 修改、审查期间 HEAD 改动。断言每个 snapshot blob 与 diff 的 head 一致、每个修复 worktree 的 tree 与被审快照一致。新增真实 Git 测试也必须使用专门的临时仓库，不触碰用户仓库。

### SW-4：修复重跑必须保留上次结果

**触发场景与证据**

- `auto-fixer.ts:101-102` 由 runId 决定固定 branch/worktree 名。
- `auto-fixer.ts:188-207` 若目录存在，直接 `git worktree remove --force`；随后无条件尝试 `git branch -D`，并把异常统统当“不存在”。
- 这与文件顶部 `:17-18` “失败后保留 worktree 供人工检查”不一致。库调用方再次执行同一 runId，或者将来增加重试按钮，便会触发这条路径。

**调用链和用户影响**

`applyFixes → createWorktree → git`；直接上游为 CLI/IM review-fix。会丢掉上次失败后的未提交修改，删除分支引用也使已提交结果失去正常入口。不能把“Git 可能还能找回部分提交”等同于保留用户成果。Git 官方文档确认 force 允许移除不干净的 worktree：[git-worktree](https://git-scm.com/docs/git-worktree)。

**最小改法**

给每次 attempt 独立 ID，旧路径存在就返回已有结果或明确提示，默认不清理。持久化 worktree ownership、baseline、尝试状态；只有独立的显式清理动作才处理已确认不需要的旧产物。检查失败与“不存在”分开，不能吞掉权限或 Git 错误。

**长期选择**

修复 attempt 作为可列出、可继续、可归档的实体；清理属于生命周期管理，不属于 `createWorktree` 的隐式副作用。本轮不建议/执行任何真实目录删除。

**回归验证**

fake fs/git：相同 run 再次执行、有旧 worktree 未提交内容、已有同名分支、目录存在但不属于本工具；断言不存在 force remove/branch -D 调用，旧记录仍可读。源码证据充分，未冒险做真实删除复现。

### SW-5：自动修复结果要验证到问题与提交层

**触发场景与证据**

- `auto-fixer.ts:128-139` 仅判断工作树 `git diff --stat` 是否非空，然后 `git add -A`、commit，并把本组全部问题标为 fixed；没有确认目标文件、问题回归测试、类型检查或最小允许变更范围。
- `auto-fixer.ts:154-161` 一组失败后保留所有修改并继续下一组；下一组的全量 add 可能提交上组失败残留。
- `auto-fixer.ts:275-290` fallback 取模型输出最后一个 fenced code block，直接写成整个目标文件；示例片段也可能被当成完整文件。目标 `source_file` 来自 ledger，写入前没有 worktree 路径边界与符号链接校验。
- `auto-fixer.ts:165-167` 用 `issuesByFile.size` 推算 `HEAD~N`，不是实际提交数；任意组失败时，预览可能包含开始修复之前的提交，或祖先不存在后被 catch 成空 diff。
- `src/lib/workflow/cli.ts:415` 提示用户在修复 worktree 中执行 `git diff | git apply`，但修复已提交时通常没有 unstaged diff，而且命令没有切回目标仓库。[git-diff](https://git-scm.com/docs/git-diff) 明确区分工作树/索引比较与提交间比较。

**调用链和用户影响**

`review-fix → applyFixes → invokeCodex → git diff/add/commit 或 tryApplyCodexOutput → FixResult → CLI/IM“已修复”`。用户可能收到不正确的成功统计，审核预览不完整，或下一组夹带失败代码。这是可信度问题，不只是输出文案。

**复现**

真实 `applyFixes` 编排、fake store/model/git：两文件组中 A 模型失败，B 返回 DONE，fake diff 只有 `unrelated.ts`；结果仍将 B 计为 fixed，执行 add -A；只产生一次 fake commit，却请求 `git diff HEAD~2 HEAD`。所有边界在调用前显式替换，没有真实文件/Git/模型操作。

**最小改法**

1. 每组记录开始的精确 commit/tree 和工作区状态；失败组隔离，禁止被后组无条件 add -A 捕获。
2. 把 `proposed / validated / failed` 分开；至少验证路径范围、补丁可应用、配置的检查结果，不能凭有 diff 宣布问题已修复。不能验证时报告“已生成修复候选”。
3. 删除“最后一个代码块就是整文件”的兜底，使用明确结构化补丁；限制目标在 worktree 内，并检查最终解析路径。
4. 持久化 fixBaseSha、实际 commit 列表、验证结果和完整 patch；预览只裁剪显示，计算使用 `fixBaseSha..fixHeadSha`。CLI apply 提示从该真实产物生成。

**长期选择**

修复产物是可审阅的 candidate patch 加检查报告；“允许应用”和“应用后验证”可以独立于模型执行。测试只验证与目标相关的行为，不要求每个修复都跑耗时全库测试。

**回归验证**

覆盖无关文件变化、失败后残留、仅新增/已暂存文件变化、模型只给片段、路径越界、部分成功、零提交、浅历史，以及正确补丁但测试不通过。现有 `workflow-cli-and-fix.test.ts:19-40` 验证 cwd 接线，不能证明修复正确。

### SW-6：给工作流加总预算，再优化重试与上下文

**触发场景与证据**

- `types.ts:494-506` 默认 3 轮，Codex/Claude 每次 5,400,000 ms（90 分钟），每步最多 2 次重试；`model-invoker.ts:132-149` 即一次调用最多 3 次尝试。
- `workflow-engine.ts:390-419` Codex 耗尽重试后进入下一轮，又从相同审查上下文调用；`:710-747` Claude 超时也把整轮推进，下一轮重新开始 Codex 审查。仅 Codex 连续超时路径，配置允许 3 × 3 × 90 分钟 = 13.5 小时等待。两模型都接近各自上限的理论等待更长；这不是已发生延迟统计。
- `model-invoker.ts:194-199` 重试没有 backoff/jitter；`:525` Claude 费用仅写日志，公开方法返回 `Promise<string>`（`:71`、`:95`），上层没有结构化 usage/cost 可做累计预算。
- `types.ts:316-341` 没有 run 总耗时、模型调用次数、token/金额预算，也没有 Codex 精确模型/effort 字段；当前只能配置 backend。
- `prompt-assembler.ts:182-211` Codex 的 full→hunks→截断只压 `pack.diff`；`:232-240` 仍可保留巨大的 changed_files hunks 或 context_files，最后没有总长度兜底。因此某些大输入降级后仍超预算。Claude 有额外 hard-truncate，但字符上限也不能替代按模型输入能力评估。

**调用链和用户影响**

`WorkflowEngine.runLoop → PackBuilder/PromptAssembler → ModelInvoker.withRetry → model runtime`。网络故障可能占住任务很久并重复消耗调用；大审查信息被重复发给两个模型，用户不知道当前成本和还会等多久。不能据此推算实际花费金额或套餐计费。

**最小改法**

为 run 加 deadline、最大尝试数与可选 token/费用预算，持久化实际 usage 和已耗预算；把瞬态错误重试留在当前步骤，使用有上限的退避，明确“重试”和“进入新审查轮次”的不同含义。保留已成功的 Codex 产物，仅重试失败的 Claude 决策。提示词预算计算所有区块，无法容纳时按文件/问题拆成明确批次，报告实际审查覆盖范围。

**长期选择**

先以真实使用数据确定“快速审查/深度审查”配置，再给低风险问题较低 effort、复杂问题较高 effort；不根据模型名称猜价格/能力，不盲目默认最强模型。模型调用返回结构化结果 `{text, usage, elapsedMs, attempts, model}`，UI、预算和审计共用，保留 invoker 统一边界。

**回归验证**

fake clock/query/spawn：429/网络短故障、总预算触底、重启恢复后预算不归零、Codex 已完成但 Claude 临时失败、大 changed_files hunks 与 context_files 单独超限。断言不再因决策层超时重新付费跑完整审查，且最终输入有真实上界。生产费用、延迟和用户可接受预算本轮未测，默认数值应在后续实施中单独选择。

## Files found

| 路径 | 职责 |
|---|---|
| `scripts/claude-to-im-bridge/store.ts` | 单进程内存状态、JSON 持久化与会话锁 |
| `scripts/feishu-claude-bridge.ts` | Store 装配与停机流程 |
| `src/lib/workflow/workflow-store.ts` | meta、ledger、快照、版本文档与事件文件 |
| `src/lib/workflow/workflow-engine.ts` | 审查状态机、检查点、恢复、重试后的轮次推进 |
| `src/lib/workflow/diff-reader.ts` | Git 审查范围、blob 读取及快照生成 |
| `src/lib/workflow/auto-fixer.ts` | 修复 worktree、模型写入、提交与 diff 汇总 |
| `src/lib/workflow/model-invoker.ts` | 子进程/SDK 调用、超时、重试及结果输出 |
| `src/lib/workflow/types.ts` | 状态与默认预算配置 |
| `src/lib/workflow/prompt-assembler.ts` | 提示词装配与大输入降级 |
| `src/lib/workflow/cli.ts` | CLI 审查、修复、恢复与操作提示 |
| `src/lib/bridge/internal/workflow-command.ts` | IM 的工作流入口与活动运行记录 |
| `src/__tests__/unit/workflow-{store,engine,code-review,model-invoker,cli-and-fix}.test.ts` | 现有存储、流程、模型隔离与 worktree cwd 覆盖 |

## Related specs

- `.trellis/workflow.md`：Phase 1.2 研究成果必须 task-local 落盘。
- `.trellis/spec/backend/index.md`、`module-boundaries.md`：DI 与宿主存储/核心编排边界。
- `.trellis/spec/backend/workflow-engine.md`：文件化产物、冻结快照、检查点、恢复、独立审查 profile；SW-2/SW-3 是实现与这些目标的具体差距。
- `.trellis/spec/backend/integration-guidelines.md`：宿主装配及脚本集成。
- `.trellis/spec/backend/testing-guidelines.md`：外部服务必须 fake，真实模型入口在测试环境下拒绝默认传输。

## External references

- [Git 官方 git-worktree 文档](https://git-scm.com/docs/git-worktree)，2026-10-04 核对：force remove 可以移除非干净工作树，因此不能把删除既有修复产物当无副作用的初始化。
- [Git 官方 git-diff 文档](https://git-scm.com/docs/git-diff)，2026-10-04 核对：无 commit 参数的 diff 与明确两个 commit 的比较语义不同，已提交修复必须以保存的基线计算补丁。
- 本轮不推荐第三方持久化产品版本，也未基于未核实的模型价格估算费用；范围主要是现有实现的行为证据。

## Verification performed

- 执行 `python ./.trellis/scripts/task.py current --source` 确认当前任务。
- 使用 GitNexus exploring skill；`query` 本轮再次返回 FTS indexes missing，无有效流程结果；未重建索引。`context` 成功核对 save、resume、applyFixes、createSnapshot、withRetry、updateMeta。图中的行号来自提交基线，报告引用的行号全部按当前源码读取。
- 单个临时内存脚本（stdin → `node --import tsx --input-type=module`）在约 1.4 秒内完成四组行为断言：损坏 JSON 覆盖、running 恢复拒绝、非 HEAD 快照错配、修复成功/预览计算错配。fs、git、模型边界均在目标调用前显式替换成 fake，没有新建测试文件或实际运行 Git。
- 随后按审计要求把相同四组验证持久化为 `research/storage-workflow-repro.test.ts`。测试加载业务模块前阻断 `child_process` 所有常用启动入口、`fetch`、`net.connect/createConnection/Socket.connect` 和 HTTP(S) request/get，并自检阻断生效；存储、Git、模型调用均显式 fake。
- 可复核命令：`node --test --import tsx --test-timeout=15000 .trellis/tasks/10-04-optimization-audit/research/storage-workflow-repro.test.ts`。2026-10-04 运行一次，4/4 通过、0 失败，node:test 报告约 573 ms，工具总耗时约 1.57 秒。
- **这些是当前缺陷的复现测试，测试通过表示缺陷被确认，不表示生产行为正确。** 后续修复时应将对应断言改为预期正确行为并移入正常测试目录。
- 没有为纯研究再次跑全量 493 个测试；源码中已有正常路径测试并不覆盖本报告这些故障边界。

## Caveats / Not Found

- 未读取真实 store 的大小、消息内容、workflow 运行记录、凭据或账单，所以数据增长与成本结论是结构性风险，不是生产负载测量。
- 没有执行自动修复、强制移除工作树、提交或回滚；worktree 删除风险来自确定的代码分支和官方命令语义。
- fake 复现定位编排错误，不能替代后续在专用临时仓库与合成文件上的故障注入测试。
- 单机 JSON 的问题在于当前写入和恢复契约，不是文件格式本身。优先完成 P1，再用可观测数据决定是否引入数据库、队列或更多部署组件。
- 工具调用简报：PowerShell/rg 读取相关源码与规范，GitNexus context 核对调用链，内存 fake 与 node:test 确认四类问题，web 查询 Git 官方语义；只写本研究报告与同目录复现测试。
