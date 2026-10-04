# Research: 模型选择与任务准入的并发边界审查

- Query: 新增模型选择协调器与 bridge-manager 的 admission gate、stop/new/bind、异步保存和卡片更新是否会死锁、错误使用偏好快照或让旧操作影响新会话？
- Scope: internal；只读审查当前工作区，不重复 Codex runtime 和 Feishu API 内部审查，不修改业务代码。
- Date: 2026-10-05

## Findings

### 审查结果

发现并向核心实现代理报告两项具体问题；实现代理随后均已修改。本审查独立复验了第 1 项修复；第 2 项已独立复现原行为并核对修复接线，最终新增回归和全范围验证交由主 checker 与根代理执行。

未发现 admission gate 与 operations gate 之间的锁循环：respond 持有 operations 后取得 admission，而 admission 的短操作没有反向等待 operations。目录和卡片 I/O 已放在 admission 外；真实保存及其 flush 会持有 admission，以阻止请求使用尚未确认保存的偏好。

### 1. 保存失败时，无关字段更新阻止偏好回滚——已修复

**审查时证据**

- 原 `src/lib/bridge/internal/model-selection.ts:279`：回滚要求整个 binding 的 `updatedAt` 仍等于偏好写入后的时间戳，同时偏好值等于本次 next。
- `src/lib/bridge/bridge-manager.ts:1741`：`/cwd` 直接更新 workingDirectory；`:1752` 的 `/mode` 同理。这两条路径不持有模型选择 admission gate。
- 本次只追到现有 store 更新契约：更新其他字段也会改变 binding.updatedAt，因此不能把该时间戳当作“模型偏好是否又被修改”的版本。

**具体触发顺序**

1. 聊天偏好为模型 first。
2. `/model second` 或卡片 apply 将完整 next 偏好写入内存，开始等待 flush。
3. 同一聊天 `/cwd` 修改目录，偏好仍是 second，但 binding.updatedAt 改变。
4. 原 flush 失败。
5. 原逻辑因为 updatedAt 不符而跳过回滚，用户收到“保存失败”，内存却仍是 second；下一请求可能使用失败的配置。

**影响与判断**

这是故障期间的配置一致性问题，不是风格建议。不得通过回滚整个 binding 修复，否则又会覆盖用户新的目录/模式。

**当前修复接线**

- `src/lib/bridge/internal/model-selection.ts:297`—`303`：只比较 binding 身份和当前偏好是否仍等于本次 next，只回滚偏好字段，不再以无关字段的时间戳阻止回滚。
- `src/__tests__/unit/bridge-model-selection.test.ts:178`：新增“flush失败仍回滚偏好，同时保留并行的无关目录修改”。

**独立复验**

使用 `node --import tsx --input-type=module` 从 stdin 执行纯内存脚本，仅导入 model-selection 模块：fake store 的 flush 由 deferred promise 控制，其他字段更新递增合成 updatedAt，目录由 fake provider 返回，streamChat 一旦调用即抛错。模拟上述顺序后断言：

```json
{"rollbackFixed":true,"unrelatedSettingPreserved":true}
```

退出码 0，约 1.12 秒。第一次尝试运行时实现代理已完成修复，断言“失败偏好仍然存在”未成立；本记录因此不把第一次运行写成旧缺陷的动态复现。旧逻辑判断依据是实际读取到的原条件和调用边界，修复后行为已由反向断言确认。

### 2. 旧卡慢更新占据操作队列，新会话卡片不能继续——已修复接线，最终回归由主 checker 负责

**审查时证据**

- 原 `src/lib/bridge/internal/model-selection.ts:190`—`191`：respond 使用按 channel/chat 分组的 operations gate。
- 原 `:256`：同一次 operations 内等待卡片 patch 网络返回。
- 原 invalidate 仅删除草稿，不结束旧 respond 的本地等待。

**具体触发顺序**

1. 用户打开卡片 1，点击“下一步”；平台 updateModelSelection 请求已经发出但暂不返回。
2. 用户 `/new`，旧草稿失效；再次 `/model` 成功生成卡片 2。
3. 用户在卡片 2 点击“下一步”。
4. 因为两个 respond 共用 chat operations 队列，卡片 2 的操作仍等待卡片 1 的网络请求结束。
5. 释放旧 patch 后，旧操作因归属失效而退出，新操作才执行。

这不是 `/new` 本身被阻塞，也不是已证明的服务端死锁；是旧草稿的慢 I/O 会把新草稿继续排在后面的队首阻塞。

**独立复现**

同样使用 stdin + `node --import tsx --input-type=module`，全部内存对象：第 1 个原卡 patch 返回 deferred promise，第二张卡使用不同合成 messageId；通过 generation++ 和 invalidate 模拟 new 的归属变化。新卡 next 在旧 patch 未返回时不能完成，释放后完成。输出：

```json
{"newCardBlockedByOldPatch":true,"newCardRecoveredAfterOldPatch":true}
```

退出码 0，约 1.19 秒。未调用平台网络。

**当前修复接线**

- `src/lib/bridge/internal/model-selection.ts:99`—`105`：invalidate abort 旧 draft，随后移除草稿。
- `:119`—`126`：目录/卡片 I/O 的本地等待有 30 秒 deadline，并响应 draft abort。
- `:163`：patch 使用 draft.signal；`:172` 重新 open 会先使旧草稿失效；`:182` 的目录读取同样受取消约束。
- `src/__tests__/unit/bridge-model-selection.test.ts:315`：新增“原卡patch永不返回时失效立即解锁，新卡仍能完成选择”。

实现代理报告新增回归通过；本审查仅核对上述修复代码，不把该报告当作本代理执行的测试。平台请求已发出后是否在服务端实际取消不由本地 abort 证明；当前 waitFor 注释正确保留这一限制。

### 其他已核对的边界

- **队列快照**：`bridge-manager.ts:387`—`394` 的 captureTurn 固定绑定与 generation/epoch；`:1285`—`1294` 在 admission 内注册 active task并复制 codexModelPreferences，未把执行中的偏好替换成最新聊天配置。应用检查 active、collecting、append、queued 和 session locks（`:309`—`312`），因此已排队消息会阻止应用。
- **控制入口**：`:1003`—`1007` 将模型目录/卡片处理作为受跟踪的异步任务，使单纯目录获取不再直接阻塞 adapter 消费循环；new/bind/stop 的状态改变分别在 admission 内串行化（`:1661`、`:1714`、`:1898`）。
- **切换失效**：cancelChat 在 `:418` 失效模型草稿并推进 generation；核心 stop 在 `:880`—`882` 关闭准入、推进 epoch、失效全部草稿。
- **旧卡影响范围**：草稿匹配 requestId/revision/user/chat/session/binding/messageId/generation/epoch；patch 使用固定旧 messageId，不以 chatId 查找新卡。晚到的发送结果不会重新登记为有效新草稿。上述第 2 项解决的是本地操作等待，不能把它误写成已经复现旧卡覆盖新卡。

## Files found

| 文件 | 一行说明 |
| --- | --- |
| `src/lib/bridge/internal/model-selection.ts` | 新增协调器、两种 gate、偏好保存回滚与草稿归属 |
| `src/lib/bridge/bridge-manager.ts` | 消息准入、控制命令、turn 快照、取消和生命周期接线 |
| `src/__tests__/unit/bridge-model-selection.test.ts` | 模型选择回归与本次两项新增故障测试 |
| `.trellis/tasks/10-05-codex-model-picker/prd.md` | R6/R9/R10 的归属、继承及忙碌限制 |
| `.trellis/tasks/10-05-codex-model-picker/design.md` | admission 串行、await 后重验与持久化失败回滚设计 |
| `.trellis/tasks/10-05-codex-model-picker/research/impact-core.md` | 实现代理已做的影响范围检查，本审查未重复冷启动索引 |

## Related specs

- `.trellis/spec/backend/reliability-contracts.md`：任务快照、generation/epoch、取消与等待有界。
- `.trellis/spec/backend/codex-model-selection.md`：配置整体保存，失败不得生效；旧卡和异步等待不能改变新会话。

## External references

无。本次为本地并发行为审查，没有依赖外部厂商 API 版本结论。

## Caveats / Not Found

- 当前子代理 `task.py current --source` 返回 none；使用根代理明确指定的任务目录写入，未自行建立或切换任务。
- 本次没有改业务代码，没有运行真实模型、IM、用户配置/会话或生产日志，也没有执行 git 操作。
- 两段独立脚本均为纯内存协调器故障注入，总耗时远小于 60 秒。没有写入新的测试代码文件，避免与核心实现代理的测试所有权冲突。
- 实现代理仍在更新文件，行号是本审查最后读取时的当前值；最终全范围验证由主 checker/根代理完成。
- 本报告只说明本次窄范围审查所得，不代替运行时、Feishu API 或完整项目质量检查。
