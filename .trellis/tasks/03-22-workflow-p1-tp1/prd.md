# Workflow Engine P1+TP1: 安全网补全 + 去重上下文

## Goal

补全 P0 未覆盖的代码安全网（DecisionValidator、accept_and_resolve 一致性、ContextCompressor 数据、Spec-Code 对齐），并优化 Codex prompt 的去重上下文（减少跨轮重复 findings）。

## Requirements

### 代码修复 P1

1. **H-NEW-2: accept_and_resolve 绕过 hasPatchFailure**
   - 文件: `workflow-engine.ts`
   - 当前：decisions 处理中 `accept_and_resolve` 直接设 resolved，不检查 hasPatchFailure
   - 修复：调整执行顺序 — 先 apply patches 计算 hasPatchFailure，再处理 decisions 中的 status
   - 或：在 accept_and_resolve 分支加 hasPatchFailure 守卫（降级为 accepted）

2. **H-NEW-3: ContextCompressor 收到空 rounds**
   - 文件: `pack-builder.ts`
   - 当前：`tryCompress()` 传 `rounds: []`（TODO 遗留）
   - 修复：异步加载历史 round 数据（pack.json, codex-review.md, claude-raw.md）传给 compressor

3. **H-NEW-4: DecisionValidator 代码缺失**
   - 新文件: `src/lib/workflow/decision-validator.ts`
   - 实现 5 项校验：
     1. issue_id 存在于 ledger
     2. issue_id 无重复
     3. action 值合法
     4. resolves_issues 引用的 ID 都有 accept decision
     5. resolves_issues 引用的 ID 存在于 ledger
   - 集成到 workflow-engine.ts 的 Claude decision 处理流程中
   - 更新 index.ts 导出

4. **元问题: Spec-Code 断裂修复**
   - `types.ts`: Issue 接口增加 `last_processed_round?: number` 字段
   - `issue-matcher.ts`: processFindings 中使用 last_processed_round 保证幂等
   - `workflow-engine.ts`: switch default 分支处理非法 action
   - `termination-judge.ts`: 检查 `auto_terminate` 和 `human_review_on_deadlock` 配置

### 模板优化 TP1

5. **T3+T6: 去重上下文**
   - `types.ts`: SpecReviewPack 接口增加 `resolved_issues` 和 `accepted_issues` 字段
   - `pack-builder.ts`: buildSpecReviewPack 返回值增加 resolved/accepted issues
   - `prompt-assembler.ts`: renderSpecReviewPrompt 新增 resolved/accepted 渲染
   - `spec-review-pack.md`: 添加 "Already Resolved" + "Previously Accepted" 章节 + 去重指令

## Acceptance Criteria

- [ ] accept_and_resolve 在 hasPatchFailure 时降级为 accepted
- [ ] round >= 4 时 ContextCompressor 收到真实的 rounds 数据
- [ ] DecisionValidator 拦截非法 decisions 并记录事件日志
- [ ] Issue 类型含 last_processed_round，IssueMatcher 使用它保证幂等
- [ ] switch 有 default 分支处理非法 action
- [ ] auto_terminate=false 时终止条件触发后暂停而非直接终止
- [ ] Codex prompt 包含 resolved/accepted issues 上下文
- [ ] Codex prompt 有明确的去重指令
- [ ] TypeScript 编译零错误
- [ ] 现有测试不回归

## Technical Notes

- DecisionValidator 是新文件，需要更新 index.ts 导出和 workflow-engine.ts 构造函数
- ContextCompressor 的 rounds 加载需要 tryCompress 改为 async
- T3 的 resolved/accepted issues 渲染需要新增模板占位符
