# 独立 Trellis 检查报告

## 检查范围与方法

检查代理读取本任务 PRD/check.jsonl 和后端规范，按源码核对 lifecycle → manager/engine/adapter、BridgeStore → runner 停机、工作流 ID/执行锁与存储入口。投递/飞书由本代理实施，已另由根与 lifecycle owner 交叉检查；本报告不把自审称作独立审查。未访问真实模型、IM、凭据、运行中 store、runner 或用户工作流数据；没有提交、重启或删除用户文件。

## Findings (fixed)

1. `bridge-manager.ts`：空回答错误分支和空成功分支直接等待 finalizer，绕过 outbox 的超时保护，卡片永不返回会占会话锁。检查代理向 lifecycle owner 指出两处分支，owner 统一到分支前使用 `settleWithin + abortable`，读取 `bridge_delivery_timeout_ms` / 默认 15 秒；已读到错误/成功两个纯 fake 回归，均验证下一回合能启动。
2. `scripts/claude-to-im-bridge/store.ts`：`close()` 先等待 flush、最后才 closed，期间新写会被接受，而 close 可能先返回。检查代理向 storage owner 指出同步复现，owner 先设置 closing，并在所有持久化变更入口修改内存前 `assertWritable()`；已读到 close 后 addMessage/updateModel 均拒绝且内存不变的回归。
3. `response-delivery.ts / delivery-layer.ts`：交叉检查补齐最终卡、发送及限流等待的有界结束、未知结果提示与记录锁释放；保留 QQ 三段策略、audit/outbound refs；失败与部分成功不误去重，补发只处理未确认块。save/flush 失败不进行无记录发送；当前进程的发送成功/进度 flush 失败不会重复已确认块。
4. `permissions.ts / interaction-lifecycle.ts / brokers`：审批投递/登记失败及时 deny、清理转发状态；按真实网关终态回写卡片。补齐终态先于订阅的竞态：有界保留最近 100 条 behavior/reason 元数据并同步回放，broker 在 Map 登记前判断 settled；不保留答案正文、不另外猜测有效期。
5. `feishu-adapter.ts / markdown/feishu.ts`：generation 隔离创建、正文、进度与收尾；typing reaction 使用创建时 messageId；全请求 UTF8 分块保代码围栏、emoji/中文；原审批卡终态移除按钮；图片缺失序号明确提示，全失败/不支持材料不交模型；异常不提前写入站去重。

## 源码复核结果

- 生命周期：入队固定 binding/session/generation/runEpoch；执行只刷新同一会话最新 SDK ID；stop/new/bind 取消合并、append、排队与运行；旧回调和旧 consumeOne 无权进入新代际。reader cancel 不等待外部实现，释放本地 reader/会话租约。空回答超时修复已落盘。
- 存储：同目录临时文件写入、sync、rename；有效备份与损坏原件保留；仅 ENOENT 是首次运行；并发 flush 等待新 dirty 快照；outbox 输入/输出隔离复制；成功元数据最多 100 条。close 开始拒写修复已落盘。
- runner：`drainAndFlush` 按 bridge/runtime/store 有界执行，前一步挂起仍尝试存储；fatal handler 带退出码 1，保存或排空失败非零退出。仅源码与纯函数测试验证，没有启动真实 runner。
- 工作流：runDir 在任何读写/创建锁前约束 run ID；executor 采用 hostname/PID/token，PID 活跃/主机未知拒绝抢占，不按耗时判断失联；旧版 running 缺执行者证据保守拒绝。专用临时目录测试覆盖穿越拒绝、并发恢复、旧恢复者崩溃与检查点字段保留。详细快照/auto-fix 审核由根及 lifecycle 的独立检查补充。
- 新 `.trellis/spec/backend/reliability-contracts.md` 的 outbox/flush/onResolution/取消边界与实际 API 一致；docs/feishu-v2-streaming-cards.md 同步能力、配置、附件限制与重投边界。

## Findings (not fixed)

本次已授权范围内暂未发现未修复的 P1/P2。保留的明确边界：平台实际送达与本地进度落盘之间崩溃仍存在重复窗口；超时无法证明远端已取消，需人工确认后补发；缺少完整 Store 能力的宿主仅内存待发，缺少 onResolution 的宿主不保证主动过期回写；真实客户端展示与租户配置未联调。

## Verification

- TypeCheck：本代理检查通过；所有 owner 冻结后根再次运行 `npm run typecheck`，退出 0。
- Lint：项目没有 lint 脚本；`git diff --check` 通过（Git autocrlf 提示不属于错误）。
- 局部测试：本代理最终 delivery + permission + user-input 28/28，1.52 秒；之前 delivery + Feishu 全组 40/40，3.79 秒（其后新增一条终态先于订阅回归已在 28 项中通过）。新增测试硬阻断网络/子进程并使用显式 fake。
- storage/workflow owner 最新 26 项回归通过；lifecycle owner 最终相关 41/41（含 23 项新生命周期回归）通过，包括空正文收尾、append 与 ABA 绑定切换。
- GitNexus：每个修改既有 symbol 先 upstream impact，HIGH/CRITICAL 编辑前告知；`detect-changes --scope all` 已执行，含上一轮未提交升级与本轮协作改动，整体 CRITICAL 符合跨桥接/工作流范围；`git status` 补查新模块，未碰用户 `.agents/skills/gitnexus/`。
- 全量整合（根独立执行）：`npm run typecheck`、`npm run build` 均退出 0；`npm run test:unit` **564/564** 通过，139 suites、0 fail、0 skip，测试 4.67 秒、命令总 5.41 秒。没有重复运行全库或越过 60 秒测试预算。
- 最后 lifecycle owner 将非正超时配置的默认值与投递模块对齐（`??` 改为 `||`）。根随后补跑完整生命周期回归 23/23（2.84 秒）及最终 build，均通过；其余代码保持全量验证时的版本。
- 根完成最终 diff/GitNexus 范围确认；详细结果见 `final-verification.md`。所有业务代码已冻结。
