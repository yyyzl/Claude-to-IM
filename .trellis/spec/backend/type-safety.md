# 后端类型安全规范

> 当前仓库依赖 TypeScript 严格类型，但真正的风险来自外部输入边界。类型声明不能替代运行时校验。

---

## 共享类型放置规则

- 跨模块共享的消息、绑定、状态类型放在 `src/lib/bridge/types.ts`
- 宿主接口契约放在 `src/lib/bridge/host.ts`
- 某个文件私有的小类型，优先留在本文件附近

不要把明显只在单文件使用的类型过度上提到全局。

---

## 当前仓库的稳定模式

- 接口优先：如 `BridgeStore`、`LLMProvider`
- 联合类型优先：如 `SSEEventType`、`MessageContentBlock`
- 共享结构集中在 `types.ts` 与 `host.ts`
- 运行时入口配合 `security/validators.ts` 做收窄与校验

---

## 边界输入一律视为不可信

以下输入必须做运行时校验，而不能只靠类型声明：

- IM 文本消息
- 工作目录
- 会话模式
- 命令参数
- 配置项值
- 外部回调数据

推荐做法：

- 先用 `unknown` 或原始字符串接收
- 再用显式校验函数收窄
- 校验失败时返回明确错误，而不是沉默兜底

---

## 推荐模式

- 优先复用已有校验函数，例如 `validateWorkingDirectory`、`validateMode`
- 修改共享类型时，同时检查测试、帮助文案和上下游调用
- 让类型名称表达边界语义，而不是仅表达数据形状
- 对可选字段保持诚实，不要为了省事强行声明为必填

---

## 禁止事项

- 滥用 `any`
- 用无依据的 `as` 断言掩盖真实不确定性
- 让字符串魔法值在多个文件里散落
- 只改类型定义，不检查对应的运行时验证和测试

---

## 真实示例

- `src/lib/bridge/types.ts`：集中定义消息、绑定、状态与平台限制
- `src/lib/bridge/host.ts`：集中定义宿主契约与 SSE 事件结构
- `src/lib/bridge/security/validators.ts`：对工作目录、会话 ID、模式和输入危险性做显式校验
- `src/lib/bridge/bridge-manager.ts`：从配置中读取字符串后再解析为布尔值或数字

---

## 修改共享类型前的检查清单

- [ ] 是否真的属于共享类型，而不是局部类型
- [ ] `host.ts` / `types.ts` / 校验函数是否需要同步修改
- [ ] 单元测试中的 mock 或 fixture 是否需要同步更新
- [ ] 帮助文案、README 或脚本装配是否依赖这个字段
