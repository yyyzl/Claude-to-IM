# Codex 模型选择执行清单

## 开始条件

- [x] 用户已确认当前聊天持续记住配置，/new 继承。
- [x] PRD、design、协议与集成研究已准备。
- [x] 独立规划审查通过，无阻塞问题（research/plan-review.md）；不代表实现或生产验证通过。
- [x] 用户审核完整方案后明确批准开发（2026-10-05：“那你现在开始开发吧”）。
- [x] implement.jsonl/check.jsonl 已配置并校验文件存在。
- [x] 执行 task.py start，状态为 in_progress；工作分支 codex/model-picker。

## 1. 契约与目录（Trellis implement）

所有分派以 `Active task: .trellis/tasks/10-05-codex-model-picker` 开头，明确文件所有权；优先原生上下文注入，缺失时子代理读取清单。代理共享工作区，不回退其他人的改动。

- [x] 对实际将修改的函数／方法执行 GitNexus upstream impact，记录直接调用方和流程；HIGH/CRITICAL 先告知用户。索引过期先刷新，不以未找到当零风险。
- [x] 增加正式目录、聊天偏好、模型选择卡／回调类型；runner 引用正式 binding 类型。
- [x] Codex 暴露目录并拆分初始化／刷新，完整分页后替换缓存，保留并发与连接生命周期约束。
- [x] 增加强度和速度元数据解析／验证，明确 default model 与宿主 hint 的优先级。
- [x] 通过 serviceTierForTurn 显式传正常／Fast，覆盖 resume 和后续回合。
- [x] 核实锁定版本是否需要 fast_mode feature flag；若确需开关，只在桥接子进程层覆盖，不改全局配置。无可用能力时明确拒绝，不伪造支持或自动降级。
- [x] 最小测试：分页、空目录、非法类型、刷新失败／并发、模型和强度校验、Fast支持检查、Fast→正常参数。

## 2. 聊天偏好与执行链（Trellis implement，契约完成后）

- [x] 一次保存完整偏好对象，flush 成功才显示持久保存，失败不留下有效半套配置。
- [x] new/bind 保留当前聊天偏好，其他聊天／Claude 不使用此配置。
- [x] conversation-engine 分开用户偏好与 status 实际结果，每个请求取得一致快照；default 不再变成具体型号。
- [x] 文字 /model 同样即时目录校验、回执说明范围与速度；/status/help 同步。
- [x] 最小测试：new/bind/restart继承、聊天隔离、默认连续两轮、真实目录默认变化、无效文字设置不写入、flush故障、请求快照。

## 3. 飞书卡与协调（接口稳定后可独立分派）

- [x] 独立模型选择协调模块，持有草稿/TTL/revision/归属，不借用模型运行中的问答请求。
- [x] 两步卡片构造、模型列表分页、刷新／返回／取消、真实支持强度／速度和应用成功态。
- [x] 适配器独立回调字段、来源校验、快速返回及发送／更新能力，保留字节预算与发送错误处理。
- [x] manager 仅接线 /model 和控制消息分支，确保不进入对话队列。
- [x] 所有 await 后检查归属，应用与消息准入／new／bind／stop 串行化；失败和重复提交不误写。
- [x] 最小测试：原卡、operator、chat、session、generation、revision、过期、重复、忙碌、切走再切回、异步发送晚到、投递／patch失败。

## 4. 独立检查与文档（Trellis check）

- [x] 阅读 PRD/design/implement 逐项检查，无新增模糊兼容或全局副作用。
- [x] 核实所有新增字段都跨 JSON store→binding→请求→Codex 参数，展示与实际值一致。
- [x] 更新 docs/bridge-runner.zh-CN.md 及必要帮助说明；记录正式偏好合同到相关 spec。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run build`。
- [x] 运行最小相关 `node --test --import tsx --test-timeout=15000 <files>`；每次外层进程总超时60秒。
- [x] 整合后执行 `test:unit` 对应的完整 48 个测试文件，Node 单项上限15秒、外层总超时60秒；643/643通过，0失败/跳过。
- [x] 执行 GitNexus detect_changes(scope=all) 检查预期影响，结合 git diff --check 与差异审阅；staged 检查留到用户确认提交后。

## 5. 交付与回退边界

- [x] 报告完成的行为和测试结果，区分离线测试与未执行的真实账号／飞书验证。
- [ ] 依据任务届时的用户授权进行提交／推送；本次规划不执行生产重启、真实消息或全局配置修改。
- [ ] 若提交则刷新 GitNexus 索引，原始schema缓存保持忽略；不提交凭据和会话数据。
- [x] 实现检查失败时保留任务上下文，修复具体问题，不用重启生产来代替验证。

## 关键文件与归属建议

| 层 | 文件／范围 | 主要风险 |
| --- | --- | --- |
| 公共契约／状态 | host.ts、types.ts、channel-router.ts、conversation-engine.ts、runner store类型 | 默认语义、状态回写、new/bind继承 |
| Codex宿主 | codex-llm.ts、codex-utils.ts及对应离线测试 | 并发目录、连接重置、速度显式覆盖 |
| 核心协调 | 新internal模型选择模块、bridge-manager最小接线 | CRITICAL入口、归属和准入竞态 |
| 飞书 | channel-adapter.ts、markdown/feishu.ts、feishu-adapter.ts及对应测试 | 表单协议、快速回调、字节预算 |

共享契约先由单一代理完成；之后Codex宿主与飞书呈现可并行。manager/router/conversation-engine 由同一核心代理负责，避免跨代理相互改状态机。

## 最终验收记录（2026-10-05）

- 开发及独立全范围审查完成，没有开放 P1/P2。证据见 `research/quality-check.md`。
- 最后业务修复后的全量：48个文件、643 tests、140 suites、643 pass，失败/取消/跳过均0，约5.3秒；单项15秒、外层60秒。
- `npm run typecheck`、`npm run build`、`git diff --check` 均通过。项目没有独立 lint script。
- GitNexus 最终 scope=all：22 files、113 symbols、83 processes、CRITICAL；基线索引存在行偏移且未收新模块，已以源码调用链及测试补证，未宣称精确图覆盖。
- 原始协议缓存和任务 `.fusion/` 验证日志保持忽略；没有真实模型/飞书请求、服务重启或全局配置修改。
- 当前分支 `codex/model-picker`，实现已验收，用户已确认 Phase 3.4 的本次提交计划，并追加授权推送；进入提交收尾，成功后归档。
