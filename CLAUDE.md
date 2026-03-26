# Fusion Trellis — Project Instructions

## Context Compaction 行为指导

### 压缩时保留
当上下文被压缩时，务必在摘要中保留:
1. 当前活跃任务的标题和状态
2. 正在编辑的文件列表和行号范围
3. 本 session 已修改但未提交的文件
4. 关键的技术决策及其原因
5. 未解决的阻塞问题

### 压缩后恢复
Compact 完成后，你会看到 `<fusion-post-compact-guide>` 提醒。请按提醒操作:
1. 读取 `.fusion/recovery.json` 恢复执行态
2. 读取 `.fusion/handoff.md` 恢复交接摘要
3. 如果 `.fusion/` 数据已过时，运行 `/fusion:checkpoint` 更新

### 主动保存
不要等 compact 发生才保存。在以下时机**主动**运行 checkpoint:
- 上下文使用率接近 60%
- 每完成一个 plan slice
- 做出重要技术决策后
- 遇到 blocker 时
