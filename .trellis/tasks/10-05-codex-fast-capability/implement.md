# 执行清单

- [x] 用户授权创建任务并排查修复；产品范围沿用上一任务，无新增决策。
- [x] 定位本机缓存、上游实现和仓库四处错误判定；只读内存复现已成功。
- [x] 修改前完成4个既有业务符号upstream impact，CRITICAL已向用户说明。
- [x] 补真实priority目录fixture，先运行目标回归证明RED（外层60秒）。
- [x] 统一Fast识别helper，更新卡片/协调器/运行时；保持原始目录ID透传。
- [x] 相关回归GREEN；覆盖大小写、非Fast名但id=fast、原始ID、Fast→正常、缺失及空目录。
- [x] 同步docs及spec，清除错误的serviceTierForTurn=fast假设。
- [x] 独立trellis-check全范围审查，typecheck/build及全量单测通过。
- [x] GitNexus detect_changes和git diff --check；不宣称图索引等同精确测试覆盖。
- [ ] 交付修复及验证边界，提交/推送仍以用户授权为准，目标主分支沿用用户明确偏好。

## 验收结果

- 旧实现Fast定向RED：10项，4通过/6失败/0取消。修复后相关84/84；最终文案卡片RED 15/16→GREEN16/16。
- 最终完整suite：48个文件、648 tests/140 suites，648 pass，失败/取消/跳过均0，约7.5秒；外层60秒、单项15秒。
- 独立全范围审查无开放P1/P2；typecheck、build和diff格式检查通过。
- GitNexus scope=all：10 files/9 symbols/13 processes/HIGH，均属预期调用链；新增helper未入基线图，以源码和跨层回归补证。
- 用户已授权排查修复；交付沿用同一功能会话中已明确的提交/推送origin/main要求，不推送新的开发分支。未调用真实账号或飞书、未重启服务。
