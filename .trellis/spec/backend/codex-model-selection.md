# Codex 模型选择合同

## 1. 范围与触发条件

修改 Codex `/model`、目录发现、模型请求参数、聊天偏好、new/bind、状态回写或飞书配置卡片时使用。本合同只定义 Codex 行为，Claude 不消费 Codex 偏好。

## 2. 接口

- `LLMProvider.getModelCatalog?(options?: { refresh?: boolean }): Promise<ModelCatalog>`：完整且已校验的目录快照；refresh 请求重新获取，不重新初始化活跃连接。
- `ChannelBinding.codexModelPreferences?: { model: string; reasoningEffort: string | null; speed: 'normal' | 'fast' }`：聊天显式偏好。
- `ChannelBinding.lastModelRuntime?: { model: string; reasoningEffort?: string; serviceTier?: string }`：运行状态，不能反写偏好。
- `StreamChatParams.codexModelPreferences`：单次请求的偏好快照，优先于旧 model/effort/hint。
- `BaseChannelAdapter.sendModelSelection?(address, view, replyToMessageId?)`、`updateModelSelection?(address, messageId, view)`：可选原生卡片能力，返回 `SendResult`。
- `InboundMessage.modelSelectionResponse`：独立模型卡事件；不得借用权限或运行中问答事件。
- `/model` 打开选择器；`/model <id> [effort]`、`/model default` 复用目录验证和保存路径。

## 3. 数据与行为合同

### 目录与速度

模型目录须包含实际型号、默认项、支持的强度和 `serviceTiers`。列表分页完成、形状与重复项／游标验证成功后才替换缓存；并发刷新合并。刷新失败不停止其他会话的 app-server，也不把旧缓存伪装成刷新成功。

只有目录明确提供 Fast 才开放该选项；没有速度元数据不代表支持 Fast。采用显式偏好的新请求向 `turn/start.serviceTierForTurn` 传 `default`（正常）或目录支持的 `fast`。省略或 null 会继承线程档位，不能用于关闭 Fast。不能把线程设置方法中的 null 清除语义套用到 turn/start。

### 聊天偏好

偏好归属 `channelType + chatId`，整体保存并等待可用的 flush；不保存到历史 session，也不修改全局 config.toml。`/new` 清空 SDK 上下文而保留偏好，`/bind` 不从目标 session 覆盖偏好。

`model: default` 持续解析目录默认，`reasoningEffort: null` 持续解析所选模型默认。实际执行状态只能更新显示信息，不能把跟随状态固定到型号。显式组合失效应报错，不自动换模型、降低强度或关闭 Fast。未设置新字段的旧数据不伪装为用户已选择；速度未知时显示未指定。

### 卡片归属

两步原生表单：模型→强度／速度→应用。中间选择仅存在草稿；仅最终应用保存。回调来自真实平台 operator/context，核心草稿固定用户、聊天、session、binding、原卡 messageId、run epoch/chat generation、revision 和有效期。

异步目录/发送/保存前后重验归属。应用、消息准入和 new/bind/stop 串行化，正在执行任务时拒绝应用。旧卡、切走再切回、重复点击或上个进程的卡不能改变新会话。卡片 patch 失败不代表已保存偏好回滚；保存失败也不能先回显成功。

## 4. 校验与错误矩阵

| 场景 | 必须行为 |
| --- | --- |
| 目录为空／返回无效数据／重复游标 | 清楚报错，不发布半份目录 |
| 刷新失败且其他聊天正在执行 | 保留活跃连接，配置不变 |
| 模型、强度或 Fast 无目录支持 | 保存前拒绝，执行前也复验 |
| Fast→正常 | 下一轮显式 default，不继承旧 Fast |
| 目录默认型号变化 | 跟随偏好保持 default；显式强度冲突时明确提示 |
| new/bind/restart | 聊天偏好保留，旧卡失效 |
| 来源不符／旧 revision／重复提交 | 不写入配置；返回明确反馈 |
| flush 失败 | 不报告已持久保存，恢复本次修改且不覆盖他人更新 |
| 卡片更新失败但保存成功 | 保留已存配置，明确说明卡片显示未更新 |
| 真实服务拒绝 Fast | 显示真实错误，不擅自换档重试 |

## 5. 正常、边界与失败示例

- 正常：卡片选模型、high、Fast并应用；new后第一轮仍使用三项偏好，其他聊天不变。
- 边界：选择跟随默认；连续两轮 status 返回具体型号，但第三轮仍从最新目录选默认项。
- 边界：正在拉取目录时用户new；迟到卡片不能被登记为新会话可用草稿。
- 失败：模型A支持Fast、模型B不支持；文字命令保留Fast切到B时拒绝，提示用卡片重新选择。
- 失败：落盘失败时不会启动模型，也不会通过应用成功卡宣称已保存。

## 6. 必需测试断言

仅用离线目录、mock JSON-RPC、平台传输和故障注入。覆盖分页与并发刷新、目录错误后连接可用、model/effort/速度的真实请求参数、default不固定、new/bind/restart继承、聊天隔离、flush失败、卡片来源／代次／消息／过期、重复提交、忙碌及new/stop竞态。

验证单元测试、typecheck和build；每次后台单测总超时60秒。真实账号Fast授权和飞书客户端渲染必须与离线测试结论分开说明。

## 7. 错误与正确做法

- 错：status.model 写入显式偏好。正确：保存到运行信息，选择仍为default。
- 错：普通速度发送null。正确：每次新turn显式发送serviceTierForTurn=default。
- 错：回调只信任按钮里的chatId。正确：使用真实context/operator并匹配服务端草稿和原卡。
- 错：模型列表刷新失败后stop活跃client。正确：独立刷新状态，完整成功才替换目录。

来源：`10-05-codex-model-picker` 的协议研究、设计及回归要求。
