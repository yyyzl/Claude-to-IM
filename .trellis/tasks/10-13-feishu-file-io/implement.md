# 飞书文件双向收发执行计划草案

## 前置条件

- [x] 用户授权推进文件回传与文件输入。
- [ ] 用户选择自然语言产物登记或显式 /sendfile 首版入口。
- [ ] 固定版本的工具协议、旧会话兼容、文件快照预算和保存形状收敛。
- [ ] 去重子任务验收通过；本任务最终计划获批准并通过 task.py validate 后才 start。

## 切片（不与去重并写共享文件）

1. **文件快照与契约**：host.ts、types.ts 及职责明确的 internal helper；先覆盖工作目录归属、空文件、超限、真实路径、内容变化和稳定摘要。上传输入不能从普通日志反推。
2. **平台上传/发送与 outbox**：channel-adapter.ts、feishu-adapter.ts、response-delivery.ts、store.ts。先覆盖真实固定 SDK 响应形状、上传/发送失败、持久重建、部分成功、取消晚到和 /retry 不重新生成。
3. **明确产物入口**：按用户已选入口接线。自然语言方案由 scripts/claude-to-im-bridge/llm.ts、codex-llm.ts 及核心登记回调处理；命令方案在 bridge-manager 独立内部命令接线。只实施一种已确认路径，不额外保留两套兜底。旧 thread 兼容未知不得越过验证。
4. **文本/CSV 输入**：feishu-adapter.ts、conversation-engine.ts 与两个 provider。实际 fake 回合断言内容/路径、同轮多附件、部分失败、重复推送不重新下载/执行，以及原图片正常。
5. **独立审查与整合**：必要帮助/使用说明和契约同步；trellis-check 验证完整范围；相关测试、typecheck/build、完整单测和 GitNexus/实际 diff 通过后再交付。

## 测试目标

建议 bridge-file-output.test.ts、bridge-feishu-file-io.test.ts、bridge-file-input.test.ts；扩展既有 bridge-delivery、image-output、codex/Claude fake 测试，避免复制生产逻辑。关键断言是原聊天得到原文件、补发不生成新文件、取消不继续发送、模型实际拿到已接收材料。

每批后台单测硬超时 60 秒，单测试 15 秒；禁止真实平台、模型和认证。真实账号与飞书文件权限仅在用户授权联调中确认。

## 提交与验收

文件回传和输入在本子任务内分别可验证；不将 PDF/Office 的未验证解析算作已完成。共享文件基于去重子任务最终版本，不整包 cherry-pick 上游或升级全局依赖。用户未选择入口时只能继续只读研究，不派实施代理。
