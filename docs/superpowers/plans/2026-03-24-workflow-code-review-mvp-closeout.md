# Workflow Code-Review MVP Closeout Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 code-review review-only MVP 的真实输入链路、报告产物与文档状态，使 IM 主链路达到可用收尾标准。

**Architecture:** 保持现有 `WorkflowProfile` 和 `DiffReader` 设计不变，仅把 snapshot 驱动的真实 diff / blob 内容接回 `WorkflowEngine` 主链路，并在 workflow 完成后落地报告 artifact。文档层明确区分“IM MVP 已闭环”与“独立 CLI 未实现”。

**Tech Stack:** TypeScript, node:test, Workflow Engine, DiffReader, WorkflowStore, Bridge `/workflow` 命令

---

## Chunk 1: 测试锁定主链路缺口

### Task 1: 为真实 diff / 文件内容注入补失败测试

**Files:**
- Modify: `src/__tests__/unit/workflow-code-review.test.ts`

- [ ] **Step 1: 写失败测试**
- [ ] **Step 2: 运行定向测试并确认失败**
- [ ] **Step 3: 断言 pack / claude 输入不再是空 diff 和空 content**

### Task 2: 为报告 artifact 落地补失败测试

**Files:**
- Modify: `src/__tests__/unit/workflow-code-review.test.ts`
- Modify: `src/lib/workflow/workflow-store.ts`

- [ ] **Step 1: 写失败测试**
- [ ] **Step 2: 运行定向测试并确认失败**
- [ ] **Step 3: 断言 workflow 完成后存在 Markdown / JSON 报告产物**

## Chunk 2: 实现 MVP 收尾修复

### Task 3: 接入真实 code-review 上下文

**Files:**
- Modify: `src/lib/workflow/workflow-engine.ts`
- Modify: `src/lib/workflow/diff-reader.ts`（仅当必须暴露辅助 API）

- [ ] **Step 1: 最小实现 snapshot -> diff / changed_files 真实读取**
- [ ] **Step 2: 复用 DiffReader，避免重复 git 逻辑**
- [ ] **Step 3: 运行定向测试确认通过**

### Task 4: 落地报告产物并补 IM 完成提示

**Files:**
- Modify: `src/lib/workflow/workflow-engine.ts`
- Modify: `src/lib/workflow/workflow-store.ts`
- Modify: `src/lib/bridge/internal/workflow-command.ts`

- [ ] **Step 1: 生成并持久化 Markdown / JSON 报告**
- [ ] **Step 2: 在完成事件中增加报告路径信息**
- [ ] **Step 3: 更新 IM 完成提示**
- [ ] **Step 4: 运行定向测试确认通过**

## Chunk 3: 验证与文档同步

### Task 5: 跑验证

**Files:**
- Modify: `package.json`（无改动预期）

- [ ] **Step 1: 运行 `npm run typecheck`**
- [ ] **Step 2: 运行 `npm run test:unit -- workflow-code-review` 或等效定向命令**
- [ ] **Step 3: 如有必要运行全量 `npm run test:unit`**

### Task 6: 更新文档

**Files:**
- Modify: `.claude/plan/code-review-workflow-spec.md`
- Modify: `docs/workflow-conclusions-summary.md`
- Modify: `.trellis/tasks/03-24-workflow-code-review-mvp-closeout/prd.md`

- [ ] **Step 1: 明确 IM MVP 已闭环**
- [ ] **Step 2: 明确独立 CLI `code-review` 未实现，不属于本次收尾范围**
- [ ] **Step 3: 修复文档状态漂移**
