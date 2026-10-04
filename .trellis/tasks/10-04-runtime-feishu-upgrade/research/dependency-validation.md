# 依赖与运行时验证（2026-10-04）

## 安装结果

仅在仓库中执行 npm install；版本锁定 Claude Agent SDK 0.3.289、Anthropic SDK 0.131.0、飞书 SDK 1.74.0、Codex CLI 0.160.0、MCP SDK 1.32.0、Zod 4.6.5。`npm ls` peer 依赖均成功解析，无 invalid 或 missing。

package-lock.json 中所有 engines.node 约束均兼容 Node 20，现有项目最低版本不变。安装没有改系统环境变量或权限，也没有启动桥接。

初次 audit：10 项（1 low / 4 moderate / 4 high / 1 critical）。对飞书传输、protobuf 与 Markdown 渲染涉及的现有兼容范围依赖执行定向更新后，protobufjs 7.6.6、ws 8.22.0、lodash 4.18.1、markdown-it 14.3.2、linkify-it 5.0.2；critical 清零。没有执行 audit fix --force，也没有通过 overrides 强改上游依赖约束。

## 质量复核后的最终 audit：0 项

初始实施报告后的同日复核确认：Discord SDK 14.27.0 在同一 major 内将 undici 改为 ^6.27.0、@discordjs/rest 改为 ^2.6.2；tsx 4.23.15 将 esbuild 改为 ~0.28.0。两者 engines 均兼容 Node 20。项目已完成这两个上游更新，无需覆盖传递依赖约束，`npm audit --json` 返回 vulnerabilities={}、total=0。

## 中间状态 audit（以下 4 项已经由质量复核修复）

共 4 项（1 low / 2 moderate / 1 high），实际来源为以下两条链：

| 包/安装版本 | 影响与使用路径 | 未直接修改的原因 |
| --- | --- | --- |
| discord.js 14.25.1 / @discordjs/rest 2.6.0 / undici 6.21.3 | Discord 运行时 HTTP/WebSocket 客户端，audit 报告 undici high（异常响应、WebSocket 子协议/碎片等 DoS 和其它 HTTP 处理问题）；两个上游包为传播项，不能当成互不相关的三个漏洞。飞书 SDK 走另一条传输依赖。 | discord.js 与 rest **精确指定** undici 6.21.3，`npm update undici` 无变更。需要单独升级 Discord SDK 并验证其版本与 Node 约束，或审查显式 override；本次不强改上游约束。 |
| tsx 4.21.0 / esbuild 0.27.3 | 开发与启动 TS 转译依赖；audit low 针对 Windows esbuild 开发服务器文件读取。项目用 tsx 转译，未配置 esbuild dev server，因此不能直接等同生产桥接可利用。 | tsx 指定 `esbuild: ~0.27.0`，安全修复在 >=0.28.1，超出当前依赖约束；需另行升级 tsx 工具链。 |

以上是依赖路径与使用形态判断，不是漏洞不可利用的证明。更新代码前后的平台权限与输入边界仍适用。

## 验证与隔离

- Claude provider 使用公开 query 参数与 SDKMessage/SDKResultMessage 类型；新增 tool_result、图片、问答、同步启动错误、context/cost mock 回归。
- 工作流测试注入 fake spawn 或 fake query；AutoFixer 在执行前替换 git/存储/模型边界，无真实工作树、提交或模型调用。
- 最终 37 项 Claude/CLI/ModelInvoker/AutoFixer 回归全部通过（3 文件，约 0.4 秒）；ModelInvoker 增加 NODE_TEST_CONTEXT 下拒绝默认真实 spawn/query 的保护，并测试漏注入必失败。
- `npm run build` 通过。中途 `npm run typecheck` 仅余并行开发的 Codex 文件导入/新测试契约错误；最终全局类型检查由主线程在各 owner 收尾后重跑。
- `codeagent-wrapper --help` 只读核验：有 --model / --reasoning-effort 和位置参数 workdir，没有显式 CLI 可执行文件参数。工作流继续使用外部 wrapper，其内部版本选择未联调；修复 cwd 已通过 mock 验证。
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 的官方依据：https://code.claude.com/docs/en/env-vars 。子进程配置保持正整数，SDK 会按模型上限裁剪；不更改全局环境。

## 影响分析

GitNexus upstream：invokeCodex 为 HIGH（直接 AutoFixer，间接 CLI/IM 审查）；executeCodexProcess 为 HIGH（invokeCodex → AutoFixer）；applyFixes 为 HIGH（CLI handleCodeReview、IM handleStartReviewFix）；上述范围修改前已告知。Claude provider streamChat、权限规范化与文本提取仅 provider 内部链，runner main 由脚本入口调用，CLI handleSpecReview 由 main 调用；图对动态接口调用漏边，源码补充其 conversation-engine 消费路径。修改保持 provider/shared DI 边界。
