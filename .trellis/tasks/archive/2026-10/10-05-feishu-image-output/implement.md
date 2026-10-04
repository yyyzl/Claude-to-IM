# 图片回传实施计划

- [x] 用户经侧聊明确授权新增能力，作为父任务子项；前三项修复已独立提交推送main（ad3fb66）。
- [x] 固定Codex0.160.0协议与飞书SDK1.74.0上传返回值已核实；PRD/设计收敛。
- [x] GitNexus索引同步后逐符号impact：会话消费/manager/outbox为CRITICAL，渠道基类HIGH；root已向用户说明并安排回归。动态调用以源码补证。
- [x] A落共享类型/helper，贯通provider→conversation→manager，真实协议fixture与相关56/56测试通过（新增22）；独立check仍可修正安全边界。
- [x] B接通图文outbox、飞书上传发送、JSON恢复、安全日志，相关51/51测试通过（新增21）；未改delivery-layer。
- [x] 独立Trellis check通过：修复上游服务端错误与损坏JSON错误的媒体回显；相关83/83通过，无遗留缺陷。root更新契约/使用说明/README和父任务记录。
- [x] typecheck/build通过；完整单测748/748、140 suites、17.01秒（外层60秒）。diff check通过；GitNexus staged完整检测另行记录。
- [x] GitNexus刷新并完成staged结构化检测：108符号、46流程、CRITICAL，无partial/truncated，源码范围符合预期；图谱覆盖限制见final-verification。
- [x] 独立工作提交 `2dbfcc5` 已完成；代码与验证全部收尾。

后续由Trellis收尾脚本归档子/父任务并记录journal，再刷新索引、正常快进main推送；发布结果以journal与远端Git引用为准。

## 范围与回滚

不碰工作流补丁恢复、模型卡配置或启动脚本；A/B所有权见design，root不并行修改业务文件。遇到协议或持久化不一致先修当前模块，不引入第二套投递系统。新元数据与旧文本记录明确兼容，回滚保留未送达产物，不删除用户文件。
