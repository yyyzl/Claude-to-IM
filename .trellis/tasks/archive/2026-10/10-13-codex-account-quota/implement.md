# Codex 额度查询执行计划

## 实施前条件

- [x] 用户明确同意创建任务并规划，任务状态 planning。
- [x] 核对固定 0.160.0 schema、官方文档和现有 app-server。
- [x] 既有入口已做 upstream impact，CRITICAL 已告知用户。
- [x] PRD 收敛、设计和 spec/research 清单完成。
- [x] 用户在最终规划总结后明确批准实施（2026-10-13：“我觉得没啥问题，可以开始实现”）。

## 实施切片

1. **协议与契约**：host.ts 添加可选能力和 DTO，新增宿主 codex-quota.ts。先补固定 schema 的 fake 响应测试：单/多桶、周期、空数据、比例错误/超额、可空时间与私有字段投影。
2. **app-server 读取**：CodexAppServerLLMProvider 新增 getAccountQuota；fake transport 验证准确 method/params、握手复用、超时/失败隔离和连接代际。断言没有模型线程/回合和账号写入。
3. **报告与命令**：新增 internal/quota-command.ts，接 `/quota`、@bot、参数校验和能力错误，帮助补入口；测试 HTML 转义、北京时间、账号范围、未知/到期表述，保持 `/usage`。
4. **控制消息隔离**：最小修改 runAdapterLoop；投递层接入可选 isCurrent，复用现有分块和 sendWithRetry。真正运行 fake manager 消费循环，挂起读取/发送，验证 stop/new/审批继续处理和停机/重启旧结果不发起新发送；覆盖首块已进入平台后停机、重试等待中停机，不改其它调用的成功记录、会话或统计。
5. **独立检查和收尾**：更新中文说明，按 Trellis 2.1/2.2 派发 implement/check 子代理；最小测试、typecheck/build、整合回归、实际 diff/未跟踪文件核对后再收尾。

## 验证命令

建议新增 bridge-codex-quota.test.ts、bridge-quota-command.test.ts、bridge-quota-manager.test.ts，命名可按现有测试工厂调整。

```powershell
node --test --import tsx --test-timeout=15000 src/__tests__/unit/bridge-codex-quota.test.ts src/__tests__/unit/bridge-quota-command.test.ts src/__tests__/unit/bridge-quota-manager.test.ts src/__tests__/unit/bridge-codex-model-catalog.test.ts src/__tests__/unit/bridge-codex-protocol.test.ts src/__tests__/unit/bridge-help.test.ts
npm run typecheck
npm run build
npm run test:unit
gitnexus detect-changes --scope all --repo .
git diff --check
git status --short
```

外层机制限制每批后台单测 60 秒，单测试使用仓库现有 15 秒。只使用 fake transport/model/platform，不读取用户认证，不查询真实账号，不发送飞书消息。

## 风险与后续检查

- 新修改的既有符号先补 impact，接口动态分派查所有实现，不以零调用方当安全。
- RPC 失败不能 client.stop/resetConnectionState；读取和发送不得阻塞控制消息。
- 不升级 CLI、改全局配置或重启桥接；真实联调/部署保持独立授权边界。
- 文件收发和跨重启去重在本任务之后安排。

## 执行结果（2026-10-13）

- [x] 切片 1–4：DTO、固定协议白名单解析、共享 app-server 读取、报告、命令和异步归属检查完成。
- [x] 独立全范围审查：补齐真实发送微任务与危险参数拒绝回执的停机边界，两项回归均先失败后通过；13 个文件、203 条相关测试通过，12.13 秒。
- [x] 整合验证：完整单测 790 条、140 个 suite 通过，约 17.86 秒；typecheck/build 通过；每批后台单测外层硬超时 60 秒。
- [x] 使用文档与七节执行合同同步；14 条 implement/check 清单及新文档本地链接有效。
- [x] 最终 GitNexus 与实际 diff 核对：tracked diff 映射 44 个符号、63 条执行流，完整结构化结果 partial/truncated 均为 false；新增文件另按实际清单核对，所有改动均属于本任务。
- [x] 按 Phase 3.4 展示一次提交计划并获得用户确认；用户追加授权提交并推送当前功能分支。
- [x] 工作提交完成：b43dc4f（feat: 支持飞书查询 Codex 账号额度）。
- [x] 归档与会话记录完成：a41a2f0、e58bd1d。
- [x] 用户确认实际飞书联调正常，并追加授权合回 main、普通推送 origin/main；本轮无需重复真实联调或重启。交付结果以远端 Git 引用核对为准。
