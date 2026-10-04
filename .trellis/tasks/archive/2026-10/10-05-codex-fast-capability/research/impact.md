# 修改前影响分析

基线main=5e39918，索引最新。2026-10-05由根代理分别运行gitnexus impact <symbol> --direction upstream --repo . --file <path>。

| 符号 | 风险 | 直接调用方 | 相关执行流 |
| --- | --- | --- | --- |
| buildModelSelectionCard | LOW，2直接 | FeishuAdapter.sendModelSelection/updateModelSelection | 模型卡发送/更新 |
| resolveModelPreference | LOW，1直接、5关联 | ModelSelectionCoordinator.save | respond/setText→save→resolve；manager命令和卡回调 |
| ModelSelectionCoordinator.respond | CRITICAL，1直接、10关联 | bridge-manager.handleMessage | 消息回调/调度，6个相关入口；不修改这些调用方 |
| CodexAppServerLLMProvider.selectModel | LOW，1直接 | streamChat.start | 模型目录、选择、回合开始 |

CRITICAL已在修改前向用户告知；此次只替换Fast能力谓词，不更改调用签名或生命周期。新增纯helper没有既有调用方；调用链由上述4入口建立，并通过跨层测试补证。实现者如需修改其他既有函数（包括具名测试helper），须先补impact；索引不收测试函数时明确UNKNOWN并用测试内引用补证。

## 实现者补充

具名测试fixture `model`（bridge-codex-model-catalog.test.ts）及 `entry`（bridge-model-card.test.ts）已执行限定文件的upstream impact，均为Target not found/UNKNOWN。源码补证：仅各自测试内部引用，前者构造raw目录/FakeClient输入，后者构造卡片view；不涉及生产调用方，不把UNKNOWN当作零风险。
