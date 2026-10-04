# Fast 服务档位修复设计

## 根因与边界
服务档位的id是请求值，name是能力显示名称，两者不能互换。`{id: priority, name: Fast}`经解析后保持正确，但渲染、协调器和运行时只查找id=fast，故全部拒绝。

## 最小设计
新增无副作用共享helper（建议internal/model-capabilities.ts），从ModelCatalogEntry.serviceTiers查找name.toLowerCase()===fast，返回整个原始条目。renderer、resolveModelPreference、respond的失效档位检查以及CodexAppServerLLMProvider.selectModel调用同一helper；只在运行时取返回的id发给serviceTierForTurn。

聊天偏好speed=fast是稳定用户意图，保持JSON合同不变；不新增数据库字段或迁移。正常请求显式default。目录没有Fast时仍不开放，但提示“目录未提供Fast选项，可刷新”，不误报账号能力。不新增旧additionalSpeedTiers兜底、不硬编码priority作为唯一ID、不根据模型名字推测支持。

## 风险与回归
respond的图影响CRITICAL（直接handleMessage，关联消息调度）；其他3入口LOW。只替换能力谓词，不重构调度、保存、卡片归属、TTL或请求生命周期。测试用priority真实形状先RED再GREEN，另验证任意目录ID的透传、名称大小写和ID假阳性，防止新一轮相同假设。

## 回退
若出现失败，保留任务及证据，修复具体映射；不通过关闭Fast选项掩盖根因。部署/重启及真实API不在本次验证范围。
