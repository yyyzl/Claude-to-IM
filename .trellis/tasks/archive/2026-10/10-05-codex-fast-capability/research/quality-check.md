# Fast 能力修复独立质量审查

日期：2026-10-05。本任务 trellis-check；直接复用本任务前期仓库研究，不重新派发代理。已读取 check.jsonl、PRD、design、implement、所列后端规范、上游协议及修改前影响记录。

## 结论

当前修复符合已确认的最小设计。Fast 的用户偏好与真实服务档位 ID 已分开；四处判定采用同一纯函数，正常速度仍明确覆盖为 default。未发现开放的 P1/P2 或任务范围外的业务重构。

本 checker 只读审查业务，向主代理报告一处剩余文案，由原实现者修复并回归。最终仅写此质量报告，没有并发修改业务/测试，没有提交、推送、重启或真实 API 调用。

## Findings（已修复）

### 旧偏好警告仍把目录缺项表述为模型不支持

- 文件：`src/lib/bridge/markdown/feishu.ts:504`、`src/__tests__/unit/bridge-model-card.test.ts:126`。
- 问题：第一次修复虽已将速度旁的说明改为“目录未提供”，但旧 speed=fast 配合空目录时，前面的通用警告仍显示“之前的强度或速度不受此模型支持”。这会继续把当前目录缺少选项扩大为模型能力结论。
- 修复：原实现者将通用提示改为“之前的强度或速度不在当前目录选项中，请刷新或重新选择后应用”。测试在旧速度和空目录/名称反例下断言新提示，并排除原先三类绝对化提示。
- 验证归属：实现者报告针对卡片用例先 RED（16 项中 15 pass、1 fail），后 GREEN（16/16）。本 checker 独立核对最终源文件与测试断言一致，没有再次重复已通过的测试。

## 跨层与契约核对

| 检查点 | 实际代码证据与结论 |
| --- | --- |
| Fast 名称识别 | 新 `internal/model-capabilities.ts` 的 `findFastServiceTier` 只依赖 ModelCatalogEntry 类型；使用 name.toLowerCase()===fast 查找并返回原始条目，符合本任务已核实的官方规则。没有硬编码 priority 或 fast 为唯一 ID。 |
| 四处统一调用 | renderer、resolveModelPreference、respond 的旧档位检查、provider.selectModel 都调用同一 helper；原先四处 id===fast 已移除。 |
| 原始 ID 透传 | provider.selectModel 取返回条目的 id；startTurn 继续传入 serviceTierForTurn，不发送聊天 speed 枚举。目录中的 priority 和其他 ID 均不被改名。 |
| 正常速度 | selectModel 仍从 serviceTierForTurn=default 开始，仅用户显式 speed=fast 时解析 Fast 条目；不会把正常提升为目录默认 Fast，不使用省略/null退出 Fast。 |
| 不凭未知信息猜能力 | 没有新加 additionalSpeedTiers、模型名称、订阅或全局配置 fallback。空目录及没有匹配名称时不给 Fast 选项，提示目录未提供/可刷新，不声称账号不支持。 |
| 偏好和生命周期 | speed 的 normal/fast JSON 合同未改；协调器只换能力谓词和错误文案。没有改 admission gate、保存/flush、session、generation/epoch、revision、TTL、任务取消或调度。 |
| 强度与错误 | reasoningEffort 验证及选择没有改变；服务端真实错误继续向上传递，不自动退回正常或改模型。 |
| 模块/编译边界 | helper 为无副作用的小纯函数，不引入宿主状态、I/O 或第二套配置存储；库构建和 scripts 类型检查均覆盖其导入。 |
| 文档与规范 | runner 文档准确描述目录选项和刷新边界；模型选择规范明确 name/ID 分离；测试规范补充真实字段含义与最终请求值断言，未把离线测试写成真实账号授权验证。 |

## 测试质量核对

不再只靠同一错误 mock 假设自证：

- 三组原正向 fixture 均改为正式 `id: priority, name: Fast` 形状，上游公开 fixture 和映射依据见 `fast-protocol.md`。
- 新贯通用例由 FakeClient 的 raw model/list 开始，经过真实 parser、provider 的 ModelCatalog、renderer、resolveModelPreference 到 fake turn/start，断言卡片和偏好仍是 fast、出站为 priority。实际持久保存仍由协调器 apply/临时 JSON store 用例覆盖；不把纯 resolve 函数称为完整落盘。
- 混合名称大小写、不同实际 ID `accelerated-v2` 均在 renderer、保存和运行时被覆盖，避免新实现再次只认 priority。
- `id: fast, name: Economy` 反例验证不会把请求 ID 当能力名称；运行时不会发起 turn/start。
- 原 Fast→正常测试现在断言 `[priority, default]`，状态也保留真实 priority；原目录刷新失效、偏好快照、服务端拒绝等用例继续使用修正后的目录。
- 缺失 serviceTiers 的旧字段反例仍明确归一为 [] 且不采用 additionalSpeedTiers；空目录文案回归不再作账号能力承诺。
- 运行时显式 FakeClient 注入并有身份断言，默认真实 Codex spawn 在 NODE_TEST_CONTEXT 下硬拒；卡片测试阻断网络、fetch 和子进程。协调器使用临时 JSON store，不读取真实用户数据。

实现者在本次最终提示调整前报告三文件 84/84 GREEN；初始 Fast 选择子集 RED 为 10 项中 4 pass、6 fail。整组旧逻辑 RED 的 9 个 cancel 来自 deferred 等待未进入 flush 路径，不能把它们计为独立业务断言失败。最终卡片调整再以 16/16 GREEN 单独验证。此处明确这些是实现者执行证据；本 checker 未无必要重复同一组测试。

## Verification

- 本 checker：最终 `npm run typecheck` exit 0，包含 src 及 `tsconfig.scripts.json`。
- 本 checker：最终 `npm run build` exit 0，约 9.16 秒。
- 本 checker：`git diff --check` exit 0。
- Lint：项目没有独立 lint script；没有声称运行不存在的检查。
- 主代理：最终完整单元测试覆盖 48 文件，648 tests / 140 suites，648 pass，fail/cancel/skip/todo 全 0，exit 0，约 7.5 秒；外层 60 秒、Node 单项 15 秒，日志位于本任务 `.fusion/unit-full-final.log`。
- 主代理：最终 `git diff --check` exit 0；新 helper 以 intent-to-add 纳入后，GitNexus `detect-changes --scope all` 返回 10 files / 9 symbols / 13 processes / HIGH。

## 影响范围和检查限制

前期独立 GitNexus 查询确认 main=5e39918、索引与全部 99 个覆盖文件一致。`research/impact.md` 记录修改前四符号 upstream 分析：respond 为 CRITICAL（已先告知用户），其他三个为 LOW。实际 diff 仅替换这些入口的 Fast 识别和提示，没有修改图中关联的 manager/调度调用方。

最终源文件核对包括 9 个已有业务/测试/规范/文档文件及新增纯 helper；另有当前任务记录。未见凭据、缓存、构建产物或无关业务文件被列入改动。最终图中的 respond/selectModel/buildModelSelectionCard/resolveModelPreference 均属预期范围；新增 helper 尚未进入基线图，不能用旧图无调用方证明其无影响，四处源码调用和跨层回归已补证。图统计不等同于测试覆盖数量。

## Findings（未修复）

没有已知未修复的任务内问题。仍未运行真实收费请求、真实飞书渲染或账号 Fast 授权验证；本地模型缓存不等同于生产桥接的一次 model/list 响应，不能据此宣称生产已验证。正常部署和重启不属于此次检查操作。
