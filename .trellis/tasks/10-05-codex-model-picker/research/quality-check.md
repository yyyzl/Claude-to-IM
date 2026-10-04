# 独立质量审查：Codex 模型选择

日期：2026-10-05。角色：本任务直接派发的 trellis-check，未再派发实现或检查代理。

## 结论

审查 PRD、design、implement/check 上下文、协议研究及各实现影响记录后，核对本任务全部业务改动和新增文件。已发现的问题均已修复并有离线回归覆盖，当前没有未解决的 P1/P2。真实飞书客户端渲染及账号 Fast 授权仍需实际环境验证，不能由本报告的离线结果代替。

本检查负责最终相关回归、类型检查和构建；主代理负责最后一次全量单元测试及 GitNexus 变更范围检查。未调用真实模型或 IM，没有修改全局配置、重启服务或提交代码。

## Findings（已修复）

### 1. 失效档位被自动改成默认或正常

- 文件：`src/lib/bridge/internal/model-selection.ts`、`src/__tests__/unit/bridge-model-selection.test.ts`。
- 问题：目录刷新移除当前强度或 Fast 后，下一步曾自动把草稿改成默认强度和正常速度，绕过了要求用户明确重选的设计。核心 owner 修复了同型号场景；最终审查又发现切换型号的分支仍有同样的两行重置。
- 修复：同型号刷新及切型号都保留原选择。兼容项继续选中，不兼容项在原生必填表单中没有 initial 值；服务端即使收到缺字段的伪造 apply 也拒绝保存，直到用户明确给出合法组合。
- 验证：本 checker 对 small-model 用例先运行 RED，正确复现原实现返回默认强度而非保留 high；删除切型号时两行自动重置后，core + card 共 40 项回归通过。取消仍不落盘。

### 2. 旧卡网络更新永不返回会堵住新卡操作

- 文件：`src/lib/bridge/internal/model-selection.ts`。
- 问题：同 chat 的 operations gate 等待旧卡 patch；失效只删除草稿，无法释放本地等待，新卡下一步因此也一直排队。
- 修复：核心 owner 为目录、发送和更新加入 30 秒本地 deadline，并给每张草稿配置 AbortController。invalidate/reopen 会立即结束旧草稿的本地等待；迟到发送只尝试把固定旧消息改为过期，不会重新登记到新会话。
- 验证：本 checker 已核对实际接线，并在最终 40 项中执行“原卡 patch 永不返回时失效立即解锁，新卡仍能完成选择”。独立生命周期审查的复现过程见 `lifecycle-review.md`。
- 边界：本地 abort 不证明平台已经取消收到的请求；旧请求固定旧 messageId，不能改到新卡。

### 3. 无关字段更新曾阻止保存失败回滚

- 文件：`src/lib/bridge/internal/model-selection.ts`。
- 问题：等待 flush 时 `/cwd` 更新 binding.updatedAt，会让原先比较整个时间戳的回滚条件失效；用户收到保存失败但内存仍留下新偏好。
- 修复：生命周期交叉审查提出、核心 owner 修复。只比较绑定身份及本次写入的完整偏好，只回滚偏好字段，不覆盖并发目录等无关字段，也不覆盖另一份更新后的偏好。
- 验证：最终相关回归包含 flush 失败、并行 `/cwd`、另一份更新偏好及无 flush 宿主的诚实降级；均通过。

## 跨层核对

| PRD 范围 | 当前代码与回归依据 |
| --- | --- |
| AC1、AC2：动态目录与选择 | 完整分页和形状验证后发布目录；目录 ID 与实际协议型号分离；模型、强度、Fast 在保存前及执行前均验证。两步原生表单、分页、刷新、返回、取消只改草稿。 |
| AC3、AC6：速度及默认 | 新显式偏好每轮向 turn/start 发送 serviceTierForTurn=default 或 fast；普通速度不会继承线程 Fast。default 和空强度持续跟随目录默认，实际执行状态只写 lastModelRuntime。 |
| AC4：归属与错误 | 真实 Feishu operator/context 进入独立模型卡事件；固定 chat、用户、session、binding、messageId、revision、generation、epoch、TTL。目录/发送/更新后重验，失败不发布半份目录或虚报保存成功。 |
| AC7：持久性及隔离 | 完整 codexModelPreferences 按 chat 保存，等待可用 flush；new/bind 保留，临时 JSON store 重新打开验证恢复，其他 chat 不继承。旧卡不能作用到新会话。 |
| AC8：运行边界 | 应用、新消息准入和 new/bind/stop 使用 admission gate；忙碌时拒绝应用，每轮复制完整偏好快照；Claude 不消费 Codex 专用偏好。 |
| AC5：工程质量 | 相关纯 mock 回归、typecheck、build 和 diff 格式检查通过；全量测试由根代理执行并单独记录。 |

运行时重点核对：刷新不重新初始化或停止活跃连接；connection epoch 防止旧初始化、断线及清理影响新连接；并发刷新合并；返回目录深拷贝；Fast 服务拒绝不自动降档且不提前虚报实际型号/速度。真实默认子进程在 NODE_TEST_CONTEXT 下有硬拒保护，协议测试显式注入 fake client。

飞书重点核对：事件仅排队，不占用业务请求等待；选择与审批/问答路径分离；目录 ID 跨层原样保留；表单 default 哨兵有明确映射；响应验证业务 code 及 messageId；调用 REST 前验证完整 JSON 的 UTF-8 预算。真实能力未知时不提供 Fast，终态卡片没有可应用按钮。

已核对 `docs/bridge-runner.zh-CN.md`、help 和新增 `.trellis/spec/backend/codex-model-selection.md` 与实际接口一致。存储文件只合并正式共享类型，没有新增第二份偏好存储实现。

## 影响分析与范围补证

- 既有符号的 HIGH/CRITICAL 影响分析及修改前提示见 `impact-core.md`、`impact-runtime.md`、`impact-feishu.md`。本次 checker 没有重新构建索引，避免与根代理并行分析。
- 自修前运行 `gitnexus impact respond --direction upstream --repo .` 命中旧 RPC 同名方法，不能作为新协调器的安全证据；随后使用精确新方法 UID 及 `--file src/lib/bridge/internal/model-selection.ts` 均返回 not found/UNKNOWN。新模块尚未进入基线图，不能据此称零影响。
- 源码补证：新 `ModelSelectionCoordinator.respond` 的业务直接调用方是 manager 模型卡回调分支；本次自修只删除 next 阶段两项草稿重置，不改变 admission/save/协议契约。最终 core/card 回归覆盖直接入口与 renderer 的缺省值处理。
- 根代理首次 detect-changes 输出为 17 个 tracked 文件、113 个符号、83 个流程、CRITICAL；旧索引行号偏移把部分变更误映射到 Feishu 旧 streaming helpers，且未计入当时 untracked 的新模块和测试。这些图数字不作为精确修改范围。根随后以 intent-to-add 纳入新文件；本 checker 的最终源 diff 核对为 22 个业务、测试和规范文件，均在本任务范围；任务研究文件另计。
- 根代理最终执行 `gitnexus detect-changes --scope all --repo . --limit 30`，exit 0，返回 22 files、113 symbols、83 processes、CRITICAL，日志为任务 `.fusion/detect-changes-final.log`。文件纳入完整 diff，但旧索引行号偏移及新模块尚未进入图的限制仍在；以当前源码和回归补证，不能把图符号数字当精确覆盖数量。

## Verification

- 相关测试：本 checker 执行 `node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-model-selection.test.ts src/__tests__/unit/bridge-model-card.test.ts`，通过 Python subprocess 设置外层 60 秒；40/40，0 失败/跳过，Node 约 1.17 秒。模型、平台、目录均为 fake；JSON 持久化仅使用临时测试目录。
- TypeCheck：本 checker 执行 `npm run typecheck`，exit 0，包含库源码及 scripts 编译入口。
- Build：本 checker 执行 `npm run build`，exit 0。
- Lint：项目没有独立 lint script，未宣称运行不存在的 lint；`git diff --check` exit 0，仅 Git autocrlf 提示。
- 先前分域证据：运行时 owner 报告 59 项、飞书 owner 报告 25 项通过；这些是实施者执行结果，不写成本 checker 重复执行。
- 最终全量：根代理在本 checker 最后一次切型号修复后执行 48 个测试文件，643 tests / 140 suites，643 pass，fail/cancel/skip/todo 全 0，exit 0，约 5.3 秒，外层上限 60 秒；日志为任务 `.fusion/unit-full-final.log`。根代理最终 `git diff --check` 亦 exit 0。

## Findings（未修复）与边界

没有已知但未修复的任务内 P1/P2。尚未运行真实账号模型请求、Fast 服务授权或飞书客户端人工渲染；这属于 PRD 明示的验证边界。目录能力来自运行时，最终是否获服务接受以实际返回为准。本地 I/O deadline 释放等待，不等于取消远端已经收到的请求。
