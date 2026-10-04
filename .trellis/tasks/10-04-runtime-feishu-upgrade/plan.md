# 运行时与飞书升级执行计划

## 输入

- prd.md、info.md。
- .trellis/spec/backend/{module-boundaries,type-safety,integration-guidelines,testing-guidelines,workflow-engine,quality-guidelines}.md。
- 上轮两个运行时审计及本轮飞书研究。

## 切片 1：Codex 双向协议和核心交互

文件：scripts/claude-to-im-bridge/codex-{jsonrpc,llm,utils}.ts、permissions.ts，src/lib/bridge/{host,types,channel-adapter,conversation-engine,bridge-manager,permission-broker}.ts、新 user-input-broker.ts，相关 bridge 单测。

- [x] 对所有拟修改符号运行 upstream impact 并记录调用方。
- [x] 先写服务端请求分流/id冲突/握手、恢复中断/失败、模型权限、问答与现代事件的失败测试。
- [x] 运行 node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-codex-*.test.ts，确认失败符合目标。
- [x] 实现规范化协议及核心交互，清理旧用量/模型兼容逻辑。
- [x] 重跑以上测试，并运行共享核心相关的 bridge-conversation-engine、bridge-permission-broker、bridge-manager 测试。

## 切片 2：依赖、Claude 和工作流

文件：package.json、package-lock.json、tsconfig*.json、scripts/claude-to-im-bridge/llm.ts、scripts/feishu-claude-bridge.ts、src/lib/workflow/{model-invoker,types,cli,auto-fixer}.ts 及相关测试。

- [x] 先写模型覆盖、worktree cwd、Claude tool_result/输入/错误的失败测试，并运行对应文件确认失败。
- [x] 安装目标项目依赖与必要 peer，更新局部 Codex 运行时与 scripts 检查入口。
- [x] 使用共享契约与新版 SDK 实现适配；移除退役默认模型及失效配置。
- [x] 最终全局 typecheck/build 已通过；全量 mock 测试 493/493 通过（140 suites，4.40 秒）。

## 切片 3：飞书卡片

文件：src/lib/bridge/adapters/feishu-adapter.ts、src/lib/bridge/markdown/feishu.ts、bridge-feishu-* 和 bridge-markdown-feishu 相关测试。

- [x] 记录官方 CardKit 文档、字段与顺序约束，确认现有缺口。
- [x] 对目标符号运行 impact；写更新/收尾竞态、限流、审批/问答回调的失败测试。
- [x] 运行 node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-feishu-*.test.ts 确认预期失败。
- [x] 实现卡片更新与交互，接入切片 1 的共享输入/进度接口。
- [x] 重跑飞书测试，并用 mock SDK 检查发送与更新的真实请求形状。

## 切片 4：整体验证与文档

- [x] trellis-check 代理审查 PRD/规范并修复缺口。
- [x] npm run typecheck、npm run build；按相关组运行单测，后台每批最多 60 秒。
- [x] gitnexus detect-changes --scope all；以 git diff 补足未索引文件，核查无无关业务变更。
- [x] 更新 README/运行指南，记录项目版本、飞书额外能力配置、未做真实账号联调的边界。

## 风险

RPC分流、消息主流程、会话绑定与工作流调用为 HIGH / CRITICAL；修改保持模块边界，按协议与行为测试验收。生产联调与运行中服务切换在代码可审查后单独处理。

## 追加授权与验证记录

- 用户追加授权全局 CLI 更新；Codex 0.160.0、Claude Code 2.1.289 已通过命令核验。桌面 Store 更新资格检查不可用，见 research/software-updates.md。
- Codex RED 测试发生一次隔离失误，至少一个真实回合已启动；后续加入注入断言与运行时禁用保护。已向用户说明，见 research/testing-isolation-incident.md。这不计作成功联调。
- 飞书 18 项 mock 测试通过；trellis-check 已完成全链路审查与修复；最终 audit=0。

## 最终收尾

主线程独立执行 typecheck/build 成功，diff --check 无错误；GitNexus 最终为 43 文件 / 300 symbols / 80 flows / CRITICAL，含 Markdown 假阳性，以 git diff/status 补查范围。用户原有 .agents/skills/gitnexus 未修改。质量报告见 research/quality-check.md。运行中桥接未重启、代码未提交；生产联调与 Store 桌面更新仍未验证。
