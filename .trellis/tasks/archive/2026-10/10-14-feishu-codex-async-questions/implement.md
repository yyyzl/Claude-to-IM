# 执行与验收

详细 TDD 切片见 [plan.md](./plan.md)。技术设计使用本项目的 design.md，不再生成重复 info.md。

- [x] 上游协议及内存诊断完成，用户随后批准范围与实施。
- [x] 新建父任务第四子项，已完成主要符号影响分析并告知 HIGH/CRITICAL。
- [x] 补齐研究边界与上下文清单，validate/start。
- [x] trellis-implement 按 S1–S4 先 RED 后 GREEN，限定业务与测试文件。
- [x] trellis-check 独立检查，冻结后复核状态、归属、网络阻塞和实际 diff。
- [x] 更新必要合同与使用文档，保存最终验证结果。
- [x] detect-changes 与真实 diff 对照，具体待确认提交计划如下。
- [x] 用户于真实验收后明确授权“提交推送”；采用下述工作提交、当前子任务归档、日志三笔顺序，随后合回main推送。父任务、去重和文件保持未完成。

普通单测 15 秒；每批启动 npm/node 测试必须使用外层 60 秒 process-tree timeout。单测及代理检查禁止调用真实模型、生产飞书、重启服务、升级依赖或删除用户截图。主会话真实联调按用户后续授权，仅在原项目聊天发送非敏感测试题；不扩权限，不打印凭据。

## S5 实际联调发现与待补齐

用户已授权原聊天非敏感真实验收，首次触发发现原生 async/questions 消息只显示文字，没有表单。旧 872 测试只覆盖 RPC 生产者；当前重新进入实施和检查，提交计划暂挂。新增研究文件 research/live-native-async.md 归入本任务材料。

S5 代码与独立检查完成：原生 producer、消息答案通道及闭合/取消/普通异步正文边界已实现，新增行为均有 RED→GREEN。问答 86/86、全量 892/892（18.12 秒）、typecheck/build/diff 通过；12 个业务/测试文件哈希与检查冻结一致。最终刷新后 detect_changes(all) 为 126 符号、60 流，partial/truncated/error 均无；结合真实 diff 和未跟踪文件核对，本批共 30 文件，仍 8 业务＋4 测试，原用户图片排除。证据为 .fusion/s5-check-review.json、s5-final-receipt.json。

真实状态仍待验收：当前 Codex bridge 进程 14:56 启动，新的构建为 15:48，运行时尚未重新加载。主会话由该进程自托管，本轮不直接重启来中断当前模型；完成本轮后由用户重新加载再触发表单、选择/输入回传及原卡追加。重启前旧题没有可提交的新卡，不能从纯内存测试宣称生产通过。

## S6 第二次真实联调与格式修正

以上为 S5 检查时的进程记录。用户 16:22 重启已启动 PID 48480 并加载 16:22 构建，主会话核对 S5 冻结的 12 个源码/测试哈希一致。16:48 原生选择/输入提问仍无独立表单，浏览器原聊天也只显示过程卡；其他通知 bot 的“正在等你回答”不算问答卡。

当前应用 CardKit 校验原样 buildUserInputCard 输出返回 code=11310：`max_length exceed the default maximum 1000`。仅将自由/其他两输入 max_length 从4000改1000的同一JSON，校验 code=0 并取得 card_id。无需同时改选择框 behaviors。上游影响 LOW，直接调用方为 adapter.sendUserInputRequest/updateUserInputRequest。S6只修 renderer 两处与真实发送/更新出口的格式合同回归；记录见 plan.md 与 research/live-native-async.md。

该格式验证不等于 IM 投递或答案回传通过。仍需加载 S6 构建后，在原当前线程触发真实选择/文字题，看到主 bot 独立表单并回传原卡；当前不提交、归档或推送。

S6实施/独立审查已冻结：原样重建dist CardKit校验code=0；问答88/88、既有追加/lifecycle/delivery74/74、全量894/894（141 suites，17.94秒），typecheck/build/diff通过。完整6926行全量日志无notok/失败/取消/跳过/todo；12业务/测试哈希复核一致，相对S5只变更renderer与streaming-test。审查加强真实create/reply/patch字段数值断言、other/free非法4000负面自检及patch11310失败行为，无额外生产修改。图刷新为09:10UTC、detect_changes(all)126符号/60流，无partial/truncated/error，实际diff仍8业务+4测试、本任务总30文件，原PNG排除。证据s6-check-review.json、s6-final-receipt.json。

当前运行PID48480为16:22启动，新的S6构建17:12生成；本轮由该进程自托管，实际问答重试需本轮结束后用户一键重启加载。该项仍未验收，不归档当前子任务。

## 第3轮实时问答真实验收通过

以上为S6检查时的运行记录。用户再次重启后PID53100于17:53:48启动，dist于17:53:46重建，12业务/测试哈希与独立检查冻结完全一致。主会话在原线程调用request_user_input_async两题，浏览器确认原项目主机器人新增独立原生表单，具有单选、其他输入、自由输入及提交按钮。

用户实际提交后，本模型在当前运行任务收到原题与两项答案：报告选择有效，自由输入为用户提交的整句题目文字并包含QA标记，按原内容回传；不把它记为只输入标记。原回复卡UI ID7696459718377638907保留并显示“+1追加”及答案接收说明；独立问答卡UI ID7696460020594052081更新为“✓ 已作为任务补充接收”，入口移除。原用户消息下共2条回复，对应过程卡和问答卡，未新增过程卡。

本轮实时原生提问→独立表单→用户选择/自由输入→原任务追加的真实验收通过。未直接捕获app-server stdout/HTTP，不声称已取得wire逐条日志；正常闭合后显式补充、主动取消/换绑等边界保持894自动化测试证据，本轮未额外扩大生产故障实测。当前等待本批提交授权；不自动提交、推送或归档。

## S1–S4 基准验证

- 独立检查修复初始化期旧 turn 转发、空准入消费资格、原型答案三个已复现缺口，无未解决代码发现。
- 872/872 全量单测通过，141 suites，18.39 秒；typecheck/build/diff 检查通过，JSONL 验证通过。
- 当前 feature 索引刷新成功；detect_changes(all) 返回 51 符号、53 执行流、CRITICAL，无 partial/truncated/error。18 为图工具读取的 tracked diff 文件数，另核对 11 个未跟踪任务/测试文件，当前工作范围共 29 文件；原用户两张截图排除。
- 全局流程枚举预算截断及 FTS 不可用已用直接源码、完整结构化检测及实际间接/传递测试补证，不声称整个仓库图无遗漏。
- 业务 8 文件、测试 4 文件，其他 17 文件为使用文档/规范、父任务关联和本子任务规划材料。证据在 .fusion/execution.md、check-review.json、check-final-unit.log、detect-changes.json。

## 已获用户授权的提交计划

1. `feat: 支持飞书 Codex 非阻塞问答与迟到补充`

   业务文件：
   - scripts/claude-to-im-bridge/codex-llm.ts
   - src/lib/bridge/host.ts
   - src/lib/bridge/types.ts
   - src/lib/bridge/channel-adapter.ts
   - src/lib/bridge/user-input-broker.ts
   - src/lib/bridge/bridge-manager.ts
   - src/lib/bridge/adapters/feishu-adapter.ts
   - src/lib/bridge/markdown/feishu.ts

   测试文件：src/__tests__/unit/ 下的 bridge-codex-protocol.test.ts、bridge-user-input-broker.test.ts、bridge-feishu-streaming.test.ts、bridge-feishu-async-questions.test.ts。

   文档/规范：docs/feishu-v2-streaming-cards.md；.trellis/spec/backend/index.md、reliability-contracts.md。

   父任务 .trellis/tasks/10-13-feishu-reliability-files/：task.json、prd.md、design.md、implement.md。

   本任务 .trellis/tasks/10-14-feishu-codex-async-questions/：task.json、prd.md、design.md、implement.md、plan.md、implement.jsonl、check.jsonl、research/upstream-protocol.md、research/implementation-boundaries.md、research/impact-before.json、research/live-native-async.md。

2. `chore(task): archive 10-14-feishu-codex-async-questions`：工作提交后仅将本子任务的上述 11 个文件归档到 .trellis/tasks/archive/2026-10/，记录工作提交；父任务、去重和文件保持未完成。
3. `chore: record journal`：随后使用 add_session.py 更新 .trellis/workspace/yyyzl/index.md 和 journal 文件，引用工作提交。是否换 journal 文件由脚本的 2000 行上限控制。

未纳入提交：.codepilot-uploads/ 下用户原两张截图；任务 .fusion/ 与原上游下载/诊断 .ccg/ 均被忽略。当前任务在 feature 分支；本计划为本地工作提交、当前子任务归档与会话记录，合入/推送按本批后续明确授权执行。

2026-10-14用户在第3轮真实验收通过后明确要求提交推送，本批授权已取得，继续完成上述收尾并合回既定主分支main。提交前已核对12个冻结哈希、894单测与typecheck/build收据和真实问答回传；规范已记录原生notification/RPC区别、闭合与原任务准入、平台input上限及分层验收，未产生新的代码修改。origin/main与本地main/feature基点相同，可按fast-forward整合，不改写历史。
