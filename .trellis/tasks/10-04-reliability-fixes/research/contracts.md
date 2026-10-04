# 最小可靠投递 / 持久化合同

owner：delivery（host.ts、response-delivery.ts）；storage 实现可选 Store 能力；lifecycle 接 manager。

## Host

`ResponseDeliveryRecord`：id / sessionId / address:ChannelAddress / responseText / replyToMessageId? / chunks:{text,parseMode,plainFallback?,sent:boolean,messageId?}[] / status:'pending'|'failed'|'delivered' / attempts:number / lastError? / createdAt / updatedAt。

`BridgeStore` 新增可选方法：

```ts
saveResponseDelivery(record: ResponseDeliveryRecord): void;
getResponseDelivery(id: string): ResponseDeliveryRecord | null;
listResponseDeliveries(channelType: string, chatId: string): ResponseDeliveryRecord[];
flush(): Promise<void>;
close(): Promise<void>;
```

`saveResponseDelivery` 应复制输入；读取返回隔离快照。旧文件缺失记录集合视为空，无迁移。新的记录先 save+await flush 后才发送，成功每块更新 sent/messageId 并 flush，失败保持 failed+lastError。flush失败必须可见。具备全部四项 save/get/list/flush 才称 durable；其他宿主仅有本进程内存待发记录，状态明确“不持久，重启可能丢失”。不得宣称跨系统 exactly-once，发送后保存崩溃存在平台不确定窗口。

## response-delivery 导出

```ts
deliverResponse(adapter, address, responseText, sessionId, replyToMessageId?, options?: {
  turnId?: string;
  isCurrent?: () => boolean;
  finalize?: () => Promise<boolean>;
}): Promise<SendResult>;
retryResponseDelivery(adapter, address, id?: string): Promise<SendResult>;
getResponseDeliveryStatus(address): string;
```

前五个参数保持 manager 旧签名。options.finalize 为现有 onStreamEnd 闭包：先保存pending，再尝试finalize；返回true即标全部sent/delivered；false或throw降为分块发送。isCurrent在网络操作前检查，过时代际保留failed，不操作新卡或主动补发。重试只发送记录中未成功分块，不调用模型；id可省略表示该聊天最新未完成记录，显式id也必须校验channel/chat/user来源。最终结果沿用SendResult，error带投递ID和保存/发送原因。

manager 删除原有私有deliverResponse，改import同名；把onStreamEnd合并到options.finalize交给模块调用，避免成功流式路径绕过pending记录。`/retry [id]`调用retryResponseDelivery，`/status`附getResponseDeliveryStatus。/retry必须在会话锁外处理，但应拒绝当前聊天有模型任务或其它retry时操作；模块也做记录级inFlight去重。

## 审批 / 飞书

channel-adapter新增可选`updateInteractionMessage(address,messageId,status:'allowed'|'denied'|'expired'|'failed'|'answered'): Promise<void>`。PermissionGateway可选`onResolution(requestId,listener):()=>void`，只观察真实网关resolve/timeout/abort；PermissionResolution增reason:'expired'|'cancelled'|'delivery_failed'。permission/user-input broker订阅真实终态后回写原消息，不另写猜测定时器。权限发送/登记失败立即deny并清转发去重；更新失败不改变已确定的授权结果。

已送达记录清空responseText/chunks，仅保留ID、来源、状态及时间，避免永久重复存储完整回答；宿主可限定最近100条已送达元数据。save/flush失败不能回退发送假装具备持久保证。

附件警告先由飞书发送明确告知；成功图片继续进入模型，部分失败列明未收到的材料；全部失败不进入模型。无需扩展InboundMessage或host文件合同。
