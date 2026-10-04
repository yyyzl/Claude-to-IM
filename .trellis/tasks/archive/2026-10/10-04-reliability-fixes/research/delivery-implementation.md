# 投递 / 飞书实施与检查

## 已修复

- 最终回答保存 pending + flush 后才发送；逐块记录 sent/messageId，失败保留正文与投递 ID；/retry 校验 channel/chat/user、记录级互斥，仅重发未确认块，不调用模型。manager 已由 lifecycle owner 接线。
- 发送、限流等待与 finalize 有界；超时释放记录锁，状态明确平台结果未确认，不自动 fallback 制造重复。保存失败不继续发送；宿主无完整持久能力时诚实提示内存边界。成功记录去正文并限制 100 条元数据。
- 保留 QQ 三段上限、出站引用和审计；普通/HTML分块仅成功写去重，部分失败补发跳过成功块；HTML降级429以最新结果重试 plain。
- 审批发送/登记/flush失败及时deny并清转发去重。真实网关 resolution 驱动审批/问答终态回写，无猜测有效期计时器；迟到发送不登记有效权限链接。网关保留最近 100 条终态元数据（不保留答案），订阅时同步回放，防止事件尚未消费就已过期仍发等待卡。
- 飞书 UTF8 预算包含完整 JSON content 二次转义，保留 emoji/中文及跨块代码围栏；流式长回答显示分段提示。创建/正文/进度/收尾按 generation 隔离；typing reaction 绑定原用户消息；stop 清理 generation。
- 图片部分失败提示缺失序号，成功材料继续；全部失败与已知不支持类型不进入模型。处理异常不提前入站去重。

## 验证

- 新 delivery reliability 最终 16/16、新 Feishu reliability 7/7；此前合并既有 Feishu 三组 40/40，3.79 秒。新增终态先于订阅回归后，delivery + permission + user-input 28/28，1.52 秒。
- 既有 delivery / permission / user-input 与上一批新回归合计 39/39，1.60 秒（之后补充一条进度 flush 失败回归包含在上项）。
- `npm run typecheck` 通过；项目没有 lint 脚本，`git diff --check` 无空白错误（仅 autocrlf 提示）。
- 新回归显式 fake Store/gateway/REST/LLM，阻断 net.Socket.connect/fetch/child_process；未读取真实数据、调用真实模型/IM、提交或重启。
- 根最终独立整合：typecheck/build 均退出 0，全量单测 564/564（139 suites，0 fail/skip；4.67 秒，命令总 5.41 秒）。本代理没有重复全库运行。

## 边界

- 平台送达后本地进度保存前崩溃仍存在重复窗口；超时不可宣称外部已取消。人工先确认聊天，再 /retry。
- 未提供 onResolution 的宿主没有主动到期卡片通知；回调已处理仍能回写。回写失败不改变权限终态。
- 宿主 flush 自身应保证最终完成/报错；本模块不允许 flush 超时后绕过持久化发送。
- 线上卡片外观和租户权限仅由后续测试聊天验证；本轮全为隔离 mock。
