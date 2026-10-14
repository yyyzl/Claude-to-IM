# 实现验证记录

## 根因与修复边界

原正文的本地 Markdown 图片路径没有经过资源上传，原完成卡成功回执又把原始正文记作已送达。现通过真实 Markdown 节点解析、绑定工作目录 realpath 边界、受限 PNG 快照、上传检查点与转换后的正文确认修复。原生 `imageGeneration` 准入、savedPath 与目录扫描均未扩展。

产品代码于本记录保存时冻结，下一阶段由独立 check 接管。没有提交、推送、生产发送、服务重启或修改 `.codepilot-uploads/`。

## RED → GREEN

最初先新增 `bridge-inline-images.test.ts` 的 3 项失败回归，再修改产品：

- 两图混排：原实现零上传，finalize 收不到转换正文。
- 第二图上传失败：原实现直接报告成功，将带本地图片的原文误确认送达。
- 缺失/非 PNG/越界：原实现保留损坏图片语法。

初始运行 0/3，通过修复后 3/3。后续新增图片标题与 file URL 回归先发现标题丢失，再修复到 GREEN；新增 `img_` 前缀 PNG 回归先发现文件名被误认为图片 key，再修复到 GREEN。

首批与原 media-delivery/media-store 合跑 22/22，通过边界补充后 32/32。广回归发现额外 save 改变纯文本检查点，使既有“发送成功后 flush 失败”在发送前失败；将分块 save 限定于未确认的内嵌图文后，该原回归与完整批均通过。

真实 manager 集成 fixture 初次使用两个不同 agentMessage ID 导致模拟重复正文，随后按原 item ID 精确完成。该测试最终验证：绑定目录传递 → 运行态零上传且文字说明 → 上传 → 同一原卡转换 key，模型回合和卡片均只有一次。

## 最终检查

- 13 个相关文件共 **163/163 单测通过**，最终批 duration 10.120 秒。
- `npm run typecheck`：通过（主库与脚本 TypeScript）。
- `npm run build`：通过。
- `git diff --check`：通过；仅 Git 的 LF/CRLF 提示，无 whitespace 错误。

单测文件：

```text
bridge-inline-images
bridge-media-delivery
bridge-media-store
bridge-feishu-media
bridge-feishu-final-card
bridge-feishu-streaming
bridge-feishu-progress
bridge-delivery-reliability
bridge-feishu-live-append
bridge-image-manager
bridge-image-conversation
bridge-codex-image-output
bridge-generated-image
```

实际使用外层 Python `subprocess.run(..., timeout=60, capture_output=True)`，执行 Node `--test --import tsx --test-timeout=15000`，每批外层 60 秒、Node 单例 15 秒。新增测试阻断 net/fetch；真实 manager fixture 另阻断子进程并只注入 FakeClient 与 fake 飞书传输。所有图片为临时目录合成 PNG，不扫描用户图片目录。

可复现命令：

```python
import subprocess
files = [
    'bridge-inline-images', 'bridge-media-delivery', 'bridge-media-store',
    'bridge-feishu-media', 'bridge-feishu-final-card', 'bridge-feishu-streaming',
    'bridge-feishu-progress', 'bridge-delivery-reliability', 'bridge-feishu-live-append',
    'bridge-image-manager', 'bridge-image-conversation', 'bridge-codex-image-output',
    'bridge-generated-image',
]
result = subprocess.run(
    ['node', '--test', '--import', 'tsx', '--test-timeout=15000']
    + ['src/__tests__/unit/' + name + '.test.ts' for name in files],
    timeout=60, capture_output=True,
)
print(result.stdout.decode('utf-8', errors='replace'))
print(result.stderr.decode('utf-8', errors='replace'))
raise SystemExit(result.returncode)
```

## 关键断言

- 上传前媒体快照 flush；finalize 前两 imageKey 均已 flush；持久化失败不上传/发送，key 保存失败也不发说明预览。
- 按解析节点处理尖括号/空格/相对/绝对/file URL/同一行/列表/引用/引用式；排除代码块、行内代码；标题与说明保留。
- 缺失、坏 PNG、非 PNG、单图/数量/总字节限制、越界、Windows junction 逃逸均有对应位置说明。
- 同图多处只上传一次；正文吸收同内容的原生图，未引用原生图仍独立发送。
- 第二图上传失败保留第一 key，说明预览不标记 sent；真实 JSON store 关闭重建、源文件移走后仍可 /retry。
- 卡片选择为 interactive；非零回执、缺 ID 或缺 code 不确认图文，也不转 post/text 假成功。
- 以真实 key 的序列化体积分块，不拆图片节点；失败后只补未确认块；成功记录清空正文与媒体。
- 取消后迟到上传 key 可以保存到原记录，但不收尾、不发送、不启动第二图。
- 原生生图、纯图、其它渠道、流卡、已确认进度与纯文本检查点通过相关回归。

## 修改前影响分析

- `attempt` CRITICAL，直接 `deliverResponse` / `retryResponseDelivery`，首次投递和补发共享路径。
- `deliverResponse` CRITICAL，直接 `handleMessage`，回答与完成卡链路。
- `handleMessage` HIGH，源码直接 `runAdapterLoop` / `scheduleMessages`，入站调度与最终回答。
- `hasComplexMarkdown` CRITICAL，直接 `feishuPayloadBytes` / `send`，卡片选择与预算。
- `splitFeishuMarkdown` CRITICAL，直接 `deliver` / `chunks` / `updateCardContent`，普通与流卡分块。
- `validateResponseChunks` LOW，直接 `parsePersistedData`。
- `FeishuAdapter.send` LOW（图直接 `processIncomingEvent`），抽象 `deliverSingle` 调用另以源码补证。
- `sendAsCard` 精确名称查询 LOW，直接 `send`。最初传错 UID 的 UNKNOWN 已用 context 和正确查询恢复，没有当作安全结论。

以上 HIGH/CRITICAL 均已由主会话告知用户后才修改。FTS 仍不可用，使用精确图查询加源码与测试补证，没有改全局依赖。

## 剩余验收

fake 成功证明请求结构与恢复/取消语义，尚未验证真实飞书客户端图片显示。生产联调、发送和重启仍待用户单独授权。最终 GitNexus 刷新、detect-changes 与独立 check 由主会话协调。

## 主会话最终补证

独立检查修复表格图片、说明转义与上传失败原卡收尾；最终167项相关测试、typecheck/build通过，报告见check-report.md。先前950项全量快照通过，未将两批数量相加。

主会话用截图对应的assistant文本块和明确引用的两张实际PNG做离线诊断，阻断net/fetch、fake上传、原卡收尾：两张图都校验成功并按顺序使用模拟imageKey，未进行生产发送。断言仅要求图片节点src被替换；正文或代码中普通路径文字按合同保留。
