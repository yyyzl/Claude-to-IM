# 升级质量检查（2026-10-04）

本轮按 PRD、info、check.jsonl 与后端规范检查实际调用链，分别接收 Claude / 飞书 / Codex owner 交接后修复。代码审查未遗留已确认的 P1 / P2 缺陷；未做真实账号联调，不能将纯 mock 通过解释为租户权限或模型套餐已经验证。

## Findings (fixed)

1. **Claude 会话授权可能持久化** — `scripts/claude-to-im-bridge/llm.ts` 原样返回 SDK 权限建议，建议允许 destination=user/project/localSettings，与“本会话允许”按钮不符。改为复制建议并限定 `destination: 'session'`，一次允许不返回权限更新。新增回归先失败、修复后通过，且断言不修改 SDK 原建议对象。
2. **Claude 忽略通用命令的 effort** — `/model <id> [effort]` 经共享契约传来 reasoningEffort，但 provider 未消费。按 SDK 0.3.289 的 `Options.effort` 映射 low/medium/high/xhigh/max，未知值在 query 前报错。回归验证 xhigh 真实传递及 ultra 不启动 SDK。实际模型是否支持仍由运行时校验。
3. **Codex 依赖根与任务 cwd 混淆** — runner 的 projectRoot 可以是任意目标仓库，不能据此找桥接的 `@openai/codex`。runner 现在从 claudeToImRoot 解析固定 CLI 并显式传入；Codex owner 同时将 provider 默认解析改为自身安装路径，补了切换至无 node_modules 目录的纯解析回归。
4. **Claude 默认模型污染 Codex** — 删除 runner 中 Claude default→Codex hint 的回退；通知 Codex owner 修复公开 createBinding 的同类遗漏；最后跨层检查又复现 standalone settings 的 default_model→bridge_default_model 回退会经 conversation-engine 误传 Claude 型号。修复集中在 settings resolver，Codex 只读取自己默认项，显式 default_model 仍优先；新增经过真实 resolver 与 conversation-engine 的 mock 回归，避免在核心引擎引入后端分支。
5. **残留依赖漏洞已有兼容修复** — Discord 14.27.0、tsx 4.23.15 均在现有主版本及 Node 20 基线内。更新 package/lock 后实际安装 rest 2.6.3、undici 6.29.0、esbuild 0.28.2，audit 从中间状态 4 项降为 0；未使用 overrides 或强制跨主版本修复。
6. **Codex 初始化失败不能可靠重试、迟到回复可能产生未捕获拒绝** — 审查发现 initialize 成功而 model/list 失败后进程仍存活，下次会重复 initialize；服务端请求在外层 try 之前回复也可能抛错。已交 Codex owner 修复 reset/stop、顶层 catch、断开时 pending 清理，并通过故障后重新握手、断开后的迟到回复回归。
7. **隔离保护和格式规范** — 检查确认真实模型默认 transport/spawn/query 在 NODE_TEST_CONTEXT 下硬拒，Codex RPC 用 PassThrough/EventEmitter 模拟进程；所有 provider 测试显式注入 fake。Codex owner 修正混合换行导致的 diff whitespace 失败。补充 backend testing/integration 规范，记录隔离、会话权限、SDK 入口与累计费用契约。

## 调用链和影响核验

- 本检查代理修改 `ClaudeCodeLLMProvider.streamChat` 与 runner `main` 前分别执行 GitNexus upstream：LOW。图未识别动态 DI 调用，额外检查 conversation-engine→provider→canUseTool→permission gateway 实际路径；runner 由脚本入口调用。
- settings resolver upstream LOW，图只显示直接测试调用；源码额外确认 JsonFileBridgeStore.getSetting→conversation-engine 的 fallback 路径。
- 同时对 processMessage 执行 impact，结果 CRITICAL（10 个上游符号、5 条流程、直接 handleMessage/mock-host main）。最终没有修改该核心函数，通过 host 设置解析收敛修复。
- 整体 detect-changes 中途结果为 40 文件 / 299 symbols / 80 processes / CRITICAL，与 RPC、权限、卡片及共享编排范围一致；该工具把部分 Markdown 标题记作 undefined symbols，且不覆盖新增未索引文件，不能把计数当作精确函数数。主线程在最终收尾再次结合 git diff/status 复核。
- 飞书实际链路核对：SDK 默认 HTTP 拦截器确实返回 resp.data，代理只设置本客户端 request 超时；1.74.0 WS handler 仍仅处理 type=event，原 card→event 补丁仍有依据。新增正文/进度分离、sequence、closing 屏障、业务错误码、失败关闭、原生表单均经 mock 请求形状和竞态回归。
- 问答经过 provider→SSE→conversation-engine→broker→adapter，回调以真实 chat/message/operator 验证；manager 在会话锁外处理 `/answer` / 卡片回答，结束时清理。模型/effort 在新会话、重建绑定及切换绑定时清理，目录模型字符串与展示名分离。

## Findings (not fixed)

没有未修复的已确认 P1 / P2 代码缺陷。以下是本轮明确保留的能力与验证边界：

- 真实飞书租户权限、客户端表单渲染、账号模型 entitlement、长任务平台时限及服务重启均未联调。前期误启动真实 Codex 回合的测试隔离事件另记于 `testing-isolation-incident.md`，不计作成功联调。
- Codex 精细 permissions 请求返回空授权；MCP elicitation 明确 decline；秘密问题拒绝经公开聊天降级。它们不会挂起或隐式扩大权限，但本轮不声称拥有完整对应 UI。
- Claude `total_cost_usd` 作为独立累计值发出，核心暂不将它落账；避免当作单轮 cost 重复累计。本轮不能表述为“完整成本统计已支持”。Token 统计、缓存子项与主代理最近上下文用量另行处理。
- 工作流仍使用外部 codeagent-wrapper，其帮助和 cwd 参数已核实，内部模型/版本选择没有通过真实执行验证。
- 桌面 Codex 的 Windows Store 更新资格检查不可用；本机 CLI 更新证据由主线程的 `software-updates.md` 记录。

## Verification

- Lint：仓库没有 lint 脚本或配置，不能声称 lint pass；`git diff --check` 最终通过（仅 Windows LF/CRLF 转换提示）。
- TypeCheck：`npm run typecheck` 通过，包含 src、scripts 与 tests 类型入口。
- Build：`npm run build` 通过，dist/lib 布局不变。
- Tests：最终 `npm run test:unit` **493/493 通过，140 suites，0 失败 / 跳过 / 取消，4.40 秒**；统一 `--test-timeout=15000`，每批总耗时均小于 60 秒。
- 关键新增问题均先以 mock 测试复现失败，再修复为通过。早先 491/491 为最后两条设置链回归加入前的中间结果，应使用最终 493。
- npm audit：最终 JSON 返回 `vulnerabilities: {}`，total=0。
- Discord：使用升级后的公开 Client/GatewayIntentBits/Partials 在离线下构造并 destroy 成功；未 login、未联网发送消息。
- 没有提交、重启运行中桥接、读取凭据或修改系统权限。

工具调用简报：GitNexus CLI 核查符号上游和变更范围；本地 SDK 类型/实现核对公开契约；npm registry 查询及局部依赖更新；apply_patch 修复代码、测试和规范；node:test、tsc、build、audit、diff-check 验证结果。
