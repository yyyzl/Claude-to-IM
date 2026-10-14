# S6 / S6b 独立增量检查

最终结论：**S6b代码复查PASS**。首轮发现的30,797字节中间实体超限已修复；原实际Adapter反例保持逐事件manager累计输入重新执行，完整正文成功、最近进展为空、历史保留，全部请求和每一步实体均≤30KB。没有未修复源码问题。当前现场的真实视觉复验仍未进行，代码通过不代表现场根因已确认。

## Findings (fixed)

本代理未修改业务或维护测试。仅新增忽略目录内的独立纯内存预算探针与实际Adapter复现，硬阻断网络、模型和子进程，未start适配器、调用真实API、重启、提交或推送。原失败probe及冻结证据原样保留，修复后复跑另存为check-s6b-*。

S6b修复及独立核验：

- viewUncertain仅初建为false，运行batch异常/非零后置true；后续普通差异ACK不会误清标记。
- 不确定收尾先串行清6个非正文Markdown，tool_progress优先，每步只缩减/保持，原正文及panel/config不动。
- 第一批成功后检查原state及generation，取消或换代则不再发第二批，也不删除新卡。
- 第二批正文首条明确写入，再从已确认空白基线恢复非空目标；每一后续步骤只增长至已预算实体。两批独立计请求预算；失败false不确认全文。
- 正常路径仍单批；已恢复错误completed仅留历史，error/interrupted恢复必要提示。超长目标恢复已确认预览并false交回完整投递。
- 定向测试覆盖非零/频控/异常、普通diff成功后不确定仍保持、长短正文及历史增长、清理/目标两批部分失败、两批间取消/换代、错误/中断、超长preview。29/29、相关152/152通过，未增加无理由全量。

原反例复跑：reset请求825B，六步从26,957B单调缩小到15,925B；目标请求27,871B，正文首条后26,425B，最终恢复到28,268B（本次整个复现最大值）。finalize=true、25,200B全文逐字符相等、tool_progress单空格、历史非空、最多1个实际在途。外层1.203秒，无超时或真实网络；证据`.fusion/check-s6b-adapter-budget.ts/.json`与`.fusion/check-s6b-counter.log/.json`。

已核验：

- `fitProgressView` 的completed外显列表为空，旧工具错误只留历史；error/interrupted仍显示必要失败。
- `finalizeCard` 对completed同一batch首条明确写tool_progress单空格，过滤差异中的同元素动作，既清空又去重；不凭旧sentView为空省略。
- 收尾等待旧operation且提前清timer；固定panel/config不动；超长正文仍false交回完整投递。
- S6维护测试覆盖顺序前缀应用后200860/99991400、成功清理、已恢复错误归档、超长预览false和错误/中断保留。其17/17、相关140/140及新鲜全量911/911通过。

## 首轮发现及修复证据

### 首轮HIGH发现（S6b已修复）：部分运行失败后的历史缩减遗漏

- 位置：`src/lib/bridge/adapters/feishu-adapter.ts` 的`finalizeCard`计算终态progressActions；`markdown/feishu-progress.ts`的差异/预算规则仍依据旧缓存。
- 归类：部分失败状态恢复及逐步实体预算的设计问题，需要主会话批准最小恢复方案，不是可直接机械自修的问题。根机制是S4已有的“仅全batch成功更新sentView”；S6只显式恢复tool_progress，未覆盖不确定历史。未对精确旧S4同fixture执行对照，不声称这个具体字节反例首次由S6引入。
- 可达性：使用真实FeishuAdapter，正文14,500→14,700 ASCII严格前缀增长，两次预览均小于20KB。manager形态的工具事件逐个累计tool1→tool8，每个先running，再在同一对象原地写complete/error后发布；250ms节流合并最新视图。tool8不同ID但与原tool0同名/status，表示重复执行同一命令。

实际顺序及体积：

| 阶段 | 顺序/结果 |
| --- | --- |
| 已确认缓存 | 正文14,500B；history_content一条、原文1,687B；tool_progress原文502B |
| 运行请求 | 实际请求26,562B；task_status→history_summary→append_notice→streaming_content→history_content→tool_progress；严格应用至tool_progress后注入200860；实体26,957B |
| 不确定平台状态 | 正文14,700B；history_content两条、原文3,374B；tool_progress原文3,576B；sentView仍是旧缓存 |
| 完成目标 | 正文“最终完整回答”重复1,400次，共25,200B，目标卡可容纳；历史裁成一条，渲染文字与旧缓存恰好相同 |
| 实际终态 | 请求26,183B；tool_progress→task_status→history_summary→task_footer→append_notice→streaming_content；没有history_content缩减动作 |
| 违规点 | 清摘要后实体20,360B；写完整正文前20,297B；streaming_content动作后30,797B，内存平台返回200860，finalize=false；最大实际在途1 |

因此不能只验证最终视图或请求，也不能简单对全部字段按旧缓存差值排序强制重写。主会话已完成新鲜影响分析、风险及历史短暂空白取舍告知；implement将这个可达fixture加入维护测试，采用两批空白基线恢复。独立复查确认正文完整成功、摘要为空、历史仍在、panel/config不动、每一步实体和请求都≤30KB，原阻断解决。

证据：`.fusion/check-s6-adapter-budget.ts/.json`、`.fusion/check-s6-adapter.log/.json`。最新实际Adapter复现外层1.172秒，无超时；正文、工具顺序、动作、每步体积及最多1实际在途均记录在JSON。纯helper先行探针失败记录只作发现线索，以实际Adapter结果为依据。

## Findings (not fixed)

无未修复源码问题。恢复路径在两个请求之间可能短暂显示空白历史子文本，这是已批准的失败恢复取舍，父面板展开状态不会被服务端重写。

### 现场复验限制

以上是已证实源码边界，不证明用户现场确实发生了部分应用或200860。真实终态回执、单空格呈现和当前原卡视觉复验仍受浏览器/读取权限限制。不能把内存通过或失败当作真实现场唯一根因，不更换空白字符或删节点试错。

## Verification

- TypeCheck：S6b独立`npm run typecheck`通过，5.906秒；`.fusion/check-s6b-typecheck.*`。
- Tests：S6b定向29/29、相关152/152；主会话冻结后新鲜全量923/923、141 suites、17.532秒。新增独立实际Adapter原反例复跑通过，外层1.203秒。首轮失败记录保留，不再代表当前代码。
- Build：主会话S6b新鲜收据通过，9.406秒。
- Lint：项目没有lint脚本，未执行；主会话diff检查通过。
- GitNexus：主会话已刷新并detect30 changed/41 affected，partial=false、truncated=false。实际8源码/测试与图diff由主会话核对；本代理未启动索引或长期LocalBackend。FTS和全局枚举限制仍由源码及测试补证。
- 规范：最新reliability-contracts的成功清空、非原子batch/旧缓存、不确定两批恢复合同与代码一致。
- 最新源码与探针冻结：`.fusion/check-s6b-freeze.json`包含3源码/测试精确SHA，全部匹配s6b-freeze，业务未被独立代理修改。首轮失败冻结仍见`.fusion/check-s6-blocker-freeze.json`。

工具调用简报：只读检查规范、研究、实际源码及收据；在外层60秒进程树截止下运行独立类型检查与隔离内存探针。未调用真实飞书/模型、改业务或重启。
