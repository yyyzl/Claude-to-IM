# 技术设计与文件所有权

## 架构

保持平台 adapter -> bridge manager -> conversation engine -> LLMProvider 的结构。
厂商协议由 provider 转为 bridge 事件；平台卡片只消费规范化事件。

## 工作分工

- Codex 实现代理：codex-jsonrpc.ts / codex-llm.ts / codex-utils.ts；共享 host/types/channel-adapter/conversation-engine/bridge-manager/permission-broker；新 user-input-broker；permissions.ts 与这些文件的测试。
- Claude/依赖实现代理：package.json / lockfile / tsconfig* / scripts/claude-to-im-bridge/llm.ts / scripts/feishu-claude-bridge.ts / workflow model-invoker/types/cli/auto-fixer 及对应测试；运行时说明文档。
- 飞书实现代理：adapters/feishu-adapter.ts / markdown/feishu.ts 及对应测试；飞书使用文档。共同接口由 Codex 代理拥有，通过消息协调，避免同文件并发修改。
- 主线程负责 PRD、设计、计划、研究整合、质量门协调和用户更新。

## 跨代理契约

保持 PermissionResolution 的 allow/deny，可增加 scope 和 updatedInput 回传问答；仍由 InMemoryPermissionGateway 等待交互，取消与超时必须清理。
用户输入使用明确的 user_input_request 事件和独立 broker，不把问题伪装成允许执行工具。问答持有 requestId、问题/选项及 thread/turn 对应关系；回调校验聊天、消息、时效，拒绝重复答案。飞书可用 form；其他平台至少有文本回答入口。
commentary/任务状态需独立显示，避免污染最终回答及历史；SSE 可增明确的 progress 事件，adapter 的可选 onProgress 方法消费展示。
以上新增接口由 Codex 代理先定义并告知其余代理，再完成联动。使用既有共享 host 契约，删除脚本中的重复声明。

## 运行时策略

Codex 使用项目固定版本，显式配置的 executable 优先，其次项目 dependency，最后清晰报错；不暗中改全局安装。
Claude 使用目标 SDK 公共包入口与内置 runtime。workflow 继续保持受控 tools/settings，不直接复用 IM 的完整会话配置。
飞书现有代码已使用 schema 2.0 与 CardKit v1；不把 v1 API 路径误判为 1.0 卡片。依据官方文档完成有价值的协议/体验改进。
