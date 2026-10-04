# 图片投递实现报告（B）

## 文件与边界

- `src/lib/bridge/channel-adapter.ts`：新增 `ImageUploadResult` 及默认明确 unsupported 的 `uploadImage(GeneratedImage)`。
- `src/lib/bridge/response-delivery.ts`：接收 `options.images`，生成文字在前、图片在后的同一 outbox；上传、保存 key、发送、保存 sent 各阶段独立。
- `src/lib/bridge/adapters/feishu-adapter.ts`：实现 PNG 上传和原聊天原生图片消息；REST client 注入安全 SDK logger。
- `scripts/claude-to-im-bridge/store.ts`：恢复时区分旧文本和新图片块，复用 A 的 PNG、摘要和资源预算校验。
- 新测试：`bridge-media-delivery.test.ts`、`bridge-feishu-media.test.ts`、`bridge-media-store.test.ts`。

未修改 producer、manager、工作流、依赖、数据库、全局设置或真实账号；未修改 delivery-layer。图片使用既有 `deliverSingle`，通过 image 字段提前在飞书适配器分派，parseMode 为 plain，不经过 HTML 文字降级。

## 交付行为

1. 接收处使用共享 helper 验证图片，按生成 ID 去重并验证同 ID 内容一致，检查 8 张/30 MB 总预算。outbox ID 包含图片 ID 和摘要，不包含 Base64；纯文本的原 ID 算法保持一致。
2. 任何上传或发送之前先保存完整图文记录并 flush。图片块在首次建记录时生成稳定 UUID，之后补发复用。
3. 流卡 finalize 成功只确认文字块并立即 flush，继续投递图片；纯图也执行 finalize，但不构造空文字块。finalize 超时沿现有 fail-fast 保留图片供手动补发。
4. 每图上传有本地有界等待。返回有效 image_key 后保存到原块并 flush，再复检当前回合；取消期间迟到上传不会继续发消息。
5. 发送成功先记录原 outbox 的 sent/messageId，再检查取消，避免丢失确认进度。下一次补发只处理未确认块，不再生图、不重复成功文字/图片，不重复已确认上传。
6. 不支持图片的平台保留正常文字，图片返回明确能力错误；不会把空文字的成功当成图片成功。失败提示沿 outbox 的记录 ID，manager 可提示 `/retry`。
7. 全部送达后沿现有逻辑清空正文与块数据，仅保留有限元数据。

## 飞书协议与日志

- 已锁定 SDK 1.74.0 的 `im.image.create` 返回扁平 `{image_key}` 或 null；上传使用 `image_type:'message'` 和校验后的 Buffer。
- 原生消息使用 `msg_type:'image'`、`content:{image_key}`、原 chat ID 和稳定 uuid。只有严格 `code === 0` 且非空 `data.message_id` 才成功；错误绝不降级成空 post/text。
- 上传与发送分开，SDK REST 请求保持既有 15 秒网络超时，上层投递保持可配置本地截止时间。
- SDK 自身会在业务 catch 前记录 Axios multipart 错误，因此 REST client 注入 `feishuSdkLogger`。error/warn 仅输出固定类别与数值 code/status，info/debug/trace 不输出原始数据；业务图片错误也不拼接原始 message/config。
- 已通过真实 SDK + fake HttpInstance 构造 Axios multipart 错误验证 SDK 内部 logger 路径，输出中无 PNG Base64、Buffer、Authorization 或合成秘密标记。

## 修改前影响分析

索引由根代理刷新到 `ad3fb66` 后逐项执行 `gitnexus impact <symbol> --direction upstream --repo . --file <file>`；HIGH/CRITICAL 在修改前已报根并由根向用户告知。

| 符号 | 图风险 | 影响/流程 | 直接调用或引用 |
| --- | --- | --- | --- |
| response-delivery.chunks | CRITICAL | 6 / 5 | deliverResponse |
| response-delivery.attempt | CRITICAL | 9 / 8 | deliverResponse、retryResponseDelivery |
| deliverResponse | CRITICAL | 10 / 6 | handleMessage |
| BaseChannelAdapter | HIGH | 17 / 0 | 4 个平台实现及 manager、delivery、交互等共 16 引用 |
| FeishuAdapter.send | LOW（图未覆盖多态投递） | 2 / 1 | processIncomingEvent；源码补证 boundedSend→adapter.send |
| FeishuAdapter.start | UNKNOWN | 0 / 0 | 已追加 context 精确命中 start；源码补证 manager createAdapter→adapter.start |
| parsePersistedData | LOW | 2 / 0 | JsonFileBridgeStore.load |

`start` UNKNOWN 未被当成安全结论：context 返回准确方法及 4 条下游执行流，当前源码在 manager 启动循环动态调用，因此按初始化入口评估；实际只新增 REST logger 参数。其他新增 helper 无旧调用方。

## RED → GREEN 与验证

- outbox 首轮 RED：4 项断言失败，3 项因旧实现不进入图片上传而取消。错误表现为图片未发、流卡吞掉图片、图片上传持久化边界不存在。
- 飞书 RED：3/3 失败，分别为缺上传能力、图片错误被空文字成功掩盖、缺安全 SDK logger。
- JSON RED：正常混合记录重启恢复失败；8 种损坏记录原本已被旧纯文本校验拒绝。
- 最终新增 21 项：outbox 9、飞书 3、JSON 9；包括纯图/多图、流卡、上传 key 保存失败、取消与超时晚到、确认发送后取消、重复补发互斥、默认 unsupported、JSON 重启后复用 key/uuid 只补图片、成功后清理数据、坏记录保留原件。
- 全部 fake transport/adapter/model；真实 SDK 仅在 fake HttpInstance 上运行，测试阻断真实网络；JSON 数据使用测试独享系统临时目录，删除前验证路径及固定前缀。

验证命令由 Python `subprocess.run(..., timeout=60)` 设置外层总限时：

```text
node --test --import tsx --test-timeout=15000
  src/__tests__/unit/bridge-media-delivery.test.ts
  src/__tests__/unit/bridge-feishu-media.test.ts
  src/__tests__/unit/bridge-media-store.test.ts
  src/__tests__/unit/bridge-delivery-reliability.test.ts
  src/__tests__/unit/bridge-feishu-reliability.test.ts
  src/__tests__/unit/bridge-json-store.test.ts
```

最终 **51/51 通过，约 1.6 秒**；所属文件 `git diff --check` 通过。typecheck/build/整合测试、独立 check、最终 GitNexus 范围检查及提交推送由根代理统一执行。

## 保留的边界

- 超过本地上传截止时间后才返回的 key 不再异步写回记录，避免与随后手动重试竞争；可能产生一个未发消息的上传资源，下次可重新上传。截止前取消但成功返回的 key 会保存，消息不会继续发送。
- 发送请求超过本地截止时间时，远端结果仍可能未知；持久化 uuid 可用于平台去重，但不承诺永久 exactly-once。
- 建立 outbox 前的内存图片不承诺进程崩溃恢复；PNG 校验不解压像素，最终仍可能被平台拒绝。
- 未调用真实生图、飞书上传/发送、用户账号或额度接口，也未重启服务、提交、推送或刷新索引。
