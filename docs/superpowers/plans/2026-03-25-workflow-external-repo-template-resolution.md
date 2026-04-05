# Workflow 外部仓库模板解析问题分析与改造方案

> **For agentic workers:** 开发前先读完本文，再修改 `workflow-command.ts`、`workflow-store.ts`、`cli.ts`。这不是单点路径 bug，而是 `repoCwd`、运行产物目录、模板资源目录三种职责被历史实现耦合在一起。

**Goal:** 让 `/workflow spec-review`、`/workflow code-review`、`/workflow review-fix` 能在任意目标仓库中直接使用；目标仓库只负责提供代码、文档和 git diff，workflow 模板默认来自 Bridge 自带资源，同时保留 run artifact 的可恢复、可审计和按仓库隔离能力。

**Status:** 本文是问题沉淀与实现方案，不是已完成修复。当前主分支仍存在该缺陷。

---

## 1. 触发背景

用户在飞书中进入外部仓库：

```text
/new
```

会话状态显示：

```text
Session: d4058a6f
CWD: G:\RustProject\push-2-talk
Mode: code
```

随后执行：

```text
/workflow code-review --range 26411e2..1a28d91
```

系统反馈：

```text
正在启动 Code-Review 工作流...
范围：range (26411e2..1a28d91)
文件:42个（已排除75个）
工作流异常退出: [WorkflowStore] Template not found: code-review-pack.md
```

错误中的实际查找路径是：

```text
G:\RustProject\push-2-talk\.claude-workflows\templates\code-review-pack.md
```

但模板真实位于当前工具仓库：

```text
G:\project\Claude-to-IM\.claude-workflows\templates\code-review-pack.md
```

---

## 2. 用户预期与当前行为的落差

### 2.1 用户预期

用户的预期是合理的：

1. `/new` 或 `/cwd` 切到目标仓库后，`/workflow` 应该直接可用。
2. 目标仓库只需要是一个正常 git 仓库，不应该额外内置一份 workflow 模板。
3. 模板应该属于工具自身，而不是属于每个被审查项目。
4. 审查不同仓库时，默认应该复用同一套受控模板，而不是要求每个仓库自己维护 prompt 资源。

### 2.2 当前真实行为

当前 IM `/workflow` 的语义实际上是：

1. `cwd` 既是“被审查仓库目录”。
2. `cwd` 也是“workflow 运行产物目录”。
3. `cwd` 还是“workflow 模板目录”的父目录。

这三个角色被绑定到同一个路径上，导致：

1. `DiffReader` 能正确读取外部仓库的 git diff。
2. `WorkflowStore` 却会错误地假设模板也跟外部仓库放在一起。
3. 只要目标仓库没有 `.claude-workflows/templates/`，工作流就会在第一轮 prompt 组装阶段直接失败。

---

## 3. 当前实现调用链

### 3.1 IM 入口

`src/lib/bridge/internal/workflow-command.ts`

当前 `handleStartCodeReview()` 的关键路径是：

1. 从 chat binding 读取 `cwd`
2. `new DiffReader(cwd)` 读取目标仓库 git diff
3. `const basePath = path.join(cwd, '.claude-workflows')`
4. `createCodeReviewEngine(basePath)`

同样的模式还出现在：

1. `handleStartSpecReview()`
2. `handleStartReviewFix()`
3. `handleReport()`
4. `handleResume()`
5. `deliverRunStatus()`

也就是说，IM 层把所有 workflow 路径都收敛成了：

```text
{cwd}/.claude-workflows
```

### 3.2 WorkflowStore

`src/lib/workflow/workflow-store.ts`

`WorkflowStore` 当前只有一个 `basePath` 概念：

```text
{basePath}/templates
{basePath}/schemas
{basePath}/runs
```

这意味着一个路径同时承载三类完全不同的资源：

1. **模板资源**：版本化、只读、跟工具版本绑定
2. **schema 资源**：版本化、只读、跟工具版本绑定
3. **运行产物**：按 run 生成、可恢复、应按仓库或按会话隔离

这种设计在单仓库、自包含运行时成立，但在“工具仓库审查外部仓库”的场景下天然不成立。

### 3.3 CLI 与 IM 的差异

`src/lib/workflow/cli.ts`

CLI 实际上已经“半解耦”：

1. `--cwd` 只用于 `DiffReader(cwd)` 读取目标仓库
2. `createCodeReviewEngine(args.basePath)` 读取 workflow store
3. 当 `args.basePath` 未传入时，`WorkflowStore` 默认使用当前进程工作目录下的 `.claude-workflows`

这意味着：

1. **CLI 在当前工具仓库根目录执行，并传 `--cwd` 指向外部仓库时，可以工作**
2. **IM `/workflow` 不行，因为 IM 把 `basePath` 强绑到了外部仓库 `cwd`**

所以现在的失败不是 workflow 引擎本身完全不支持外部仓库，而是 IM 路由层把路径策略写死了。

---

## 4. 根因分解

### 4.1 直接根因

IM `/workflow` 把：

1. 目标仓库目录
2. workflow 运行产物目录
3. workflow 模板目录

错误地绑定到了同一个 `cwd/.claude-workflows`。

### 4.2 更深层的设计根因

#### 根因 A：`basePath` 语义过载

`basePath` 当前并不是“一个简单目录”，而是混合承担了：

1. asset root
2. run storage root
3. template lookup root
4. schema lookup root

这让调用方无法只替换其中一部分职责。

#### 根因 B：历史修复把“产物路径统一”扩大成了“全部路径统一”

现有文档里明确记录过：

```text
Store 路径统一：start/resume/status 统一使用 cwd-based basePath
```

这条修复原本解决的是：

1. start 写到一个目录
2. resume/status 去另一个目录查
3. 导致运行中工作流无法恢复或报告路径不一致

这个修复在“运行产物路径统一”层面是正确的。

但它把“运行产物目录”进一步推广成了“模板目录也跟着 cwd 走”，从而引入了新的耦合问题。

#### 根因 C：模板被视为项目本地资源，而不是工具内置资源

当前工程文档明确写着：

```text
模板必须放在 {basePath}/templates/
```

这反映的是早期假设：

1. workflow 在当前仓库内开发
2. `.claude-workflows/templates` 是仓库的一部分
3. 被审查对象和 workflow 引擎属于同一个项目

但飞书 `/new` 审查外部仓库这个用法已经改变了假设：

1. workflow 工具和目标仓库分离
2. 模板应该属于工具，不属于目标仓库

文档假设与产品用法已经漂移。

#### 根因 D：发布形态尚未支持“全局内置模板”

`.claude/plan/workflow-engine-spec.md` 明确写过：

```text
.claude-workflows/ templates/schemas are NOT included in files for npm publish
```

这意味着即使我们决定“模板默认来自工具自身”，也不能简单依赖源代码仓库根目录：

1. 开发机本地源码仓库有模板
2. npm 发布产物默认不带模板
3. 未来如果离开源码仓库运行，直接 fallback 到仓库根目录会失效

所以“使用当前项目目录模板”这个思路方向是对的，但实现不能写死成：

```text
G:\project\Claude-to-IM\.claude-workflows
```

必须升级为“工具内置资源解析”。

---

## 5. 为什么这是一个产品级设计缺陷，而不是单纯路径 bug

### 5.1 可用性角度

如果用户必须先把模板复制进每个目标仓库，`/workflow` 就不具备“开箱即用审查任意仓库”的能力。

### 5.2 版本一致性角度

模板和引擎版本必须匹配。

如果把模板复制到多个外部仓库，会出现：

1. engine 已升级
2. 外部仓库里的模板还是旧版
3. 产生隐式漂移和难以诊断的 prompt 行为差异

### 5.3 安全角度

如果默认信任目标仓库里的 `.claude-workflows/templates`，外部仓库就可以修改 prompt。

这在“审查不受信任代码仓库”的场景里并不安全。

默认更合理的策略应该是：

1. 使用工具自带模板
2. 项目本地模板覆盖只在显式启用时生效

### 5.4 审计与复现角度

审查结果应该能回答：

1. 当时审查的是哪份代码
2. 当时用的是哪版模板
3. 模板是否来自内置资源，还是来自项目 override

如果模板来源不清晰，后续复盘困难。

### 5.5 部署角度

写死开发机绝对路径没有可移植性：

1. 换机器失效
2. CI 失效
3. 打包分发失效
4. 多开发者协作失效

---

## 6. 方案对比

### 方案 A：保持现状，要求每个目标仓库都自带 `.claude-workflows`

优点：

1. 改动最小
2. `WorkflowStore` 无需重构

缺点：

1. 用户体验差
2. 模板复制和升级成本高
3. 不适合审查第三方仓库
4. 存在模板漂移
5. 默认信任目标仓库模板有安全隐患

结论：不推荐。

### 方案 B：首次运行时自动把模板复制到目标仓库

优点：

1. 对用户透明
2. 兼容现有 `WorkflowStore` 结构

缺点：

1. 会污染目标仓库
2. 容易形成模板副本漂移
3. 审查第三方仓库时越权写入
4. 仍未真正解决职责耦合

结论：只适合作为临时 hack，不适合作为正式设计。

### 方案 C：目标仓库只放 run artifact，模板默认使用工具内置资源

优点：

1. 符合用户直觉
2. 模板版本与引擎天然同步
3. 不污染目标仓库
4. 保持 run artifact 可按仓库隔离
5. 安全边界更清晰

缺点：

1. 需要拆分路径职责
2. 需要解决模板在发布产物中的打包问题

结论：推荐作为正式方向。

### 方案 D：在方案 C 基础上允许“项目级模板 override”

优点：

1. 同时满足统一模板和项目定制
2. 对少数高级用法更灵活

缺点：

1. 需要定义优先级和安全策略
2. 会增加路径解析复杂度

结论：可作为方案 C 的增强层，但不应该作为默认行为。

---

## 7. 推荐目标设计

### 7.1 路径职责拆分

至少拆成三个概念：

1. `repoCwd`
   - 目标仓库根目录
   - 用于 `DiffReader`
   - 用于读取 context 文件
   - 用于 git 命令

2. `runBasePath`
   - 运行产物目录根
   - 默认建议仍为 `path.join(repoCwd, '.claude-workflows')`
   - 用于 `runs/`
   - 用于 `resume/status/report`

3. `assetBasePath`
   - 工具内置 workflow 资源目录
   - 提供 `templates/`
   - 未来如有运行时 schema 校验，也提供 `schemas/`

### 7.2 默认策略

默认应采用：

1. `repoCwd = 当前 chat/session 的 workingDirectory`
2. `runBasePath = path.join(repoCwd, '.claude-workflows')`
3. `assetBasePath = Bridge 内置资源目录`

也就是说：

1. **代码从目标仓库读**
2. **运行产物写回目标仓库旁边**
3. **模板从工具自身读**

这是最符合当前产品形态的默认行为。

### 7.3 推荐的模板解析优先级

建议显式定义，而不是继续隐式耦合：

1. 显式传入的模板目录
2. 显式开启的项目级 override 目录
3. 工具内置模板目录

默认情况下不要自动信任项目本地模板。

原因：

1. 更安全
2. 更稳定
3. 更符合“工具模板是平台能力”的定位

### 7.4 对 `WorkflowStore` 的建议演进

当前构造器：

```ts
new WorkflowStore(basePath?: string)
```

建议升级为兼容式接口：

```ts
new WorkflowStore(
  basePathOrPaths?: string | {
    runBasePath?: string;
    templateBasePath?: string;
    schemaBasePath?: string;
  }
)
```

兼容规则建议：

1. 传字符串时保持旧行为，三个目录都落在同一个 basePath 下
2. 传对象时：
   - run 相关 API 走 `runBasePath`
   - `loadTemplate()` 走 `templateBasePath ?? runBasePath`
   - 未来 schema API 走 `schemaBasePath ?? templateBasePath ?? runBasePath`

这样可以最小化重构面积，同时保留向后兼容。

---

## 8. 推荐实施路径

### Phase 0：先把问题修通，不改产品语义

目标：

1. 外部仓库 `/workflow` 能直接跑
2. run artifact 仍写到目标仓库 `.claude-workflows/runs`
3. 模板缺失时自动回退到内置模板

最小改动建议：

1. 给 `WorkflowStore` 增加 `templateBasePath`
2. IM `/workflow` 入口传入：
   - `runBasePath = path.join(cwd, '.claude-workflows')`
   - `templateBasePath = builtinWorkflowAssetRoot`
3. `resume/status/report` 只依赖 `runBasePath`

这是最小、最稳、最符合用户诉求的一步。

### Phase 1：统一 CLI 和 IM 的路径解析

目标：

1. CLI 和 IM 使用同一套解析策略
2. 不再依赖“当前 shell 启动目录”这种隐式行为

建议：

1. 新增共享 helper，例如 `resolveWorkflowPaths()`
2. CLI `--cwd` 只表示目标仓库
3. CLI `--base-path` 明确改成 run artifact 目录
4. 如有必要新增 `--template-base-path`

### Phase 2：处理“内置模板如何分发”

这是正式方案中最容易被忽略的点，也是必须解决的点。

当前 npm `files` 不包含 `.claude-workflows/templates`，所以未来必须做下面二选一：

#### 方案 2A：把模板和 schema 作为运行时资源打进 `dist`

例如：

```text
dist/lib/workflow/assets/templates
dist/lib/workflow/assets/schemas
```

运行时通过 `import.meta.url` 相对定位。

优点：

1. 资源和代码版本同步
2. 不依赖源码仓库根目录
3. 适合发布

#### 方案 2B：把模板编译成内置字符串常量

优点：

1. 绝对不会丢资源
2. 部署简单

缺点：

1. 模板编辑体验变差
2. prompt 变更 diff 可读性下降

综合考虑，更推荐 **2A：打包为 dist 资源文件**。

### Phase 3：可选支持项目级模板 override

只有在明确需要项目定制 prompt 时再做。

建议默认关闭，开启方式必须显式：

1. CLI flag
2. config 开关
3. 受控环境变量

不要默认自动信任项目本地模板。

---

## 9. 需要修改的代码点

### 核心代码

1. `src/lib/workflow/workflow-store.ts`
   - 拆分 run/template/schema 路径职责
   - `loadTemplate()` 支持单独模板根目录

2. `src/lib/workflow/index.ts`
   - `createSpecReviewEngine()` / `createCodeReviewEngine()` 接收新路径结构，或至少能接收升级后的 `WorkflowStore`

3. `src/lib/bridge/internal/workflow-command.ts`
   - IM 入口改为：
     - `DiffReader(repoCwd)`
     - `WorkflowStore({ runBasePath, templateBasePath })`
   - `start/resume/status/report/review-fix` 统一走同一套 path resolver

4. `src/lib/workflow/cli.ts`
   - 跟 IM 统一路径策略
   - 避免当前“`cwd` 指向 repo，store 却默认相对进程 cwd”的隐式差异

### 可能涉及的补充代码

1. 新增 `src/lib/workflow/path-resolver.ts`
2. 或在 `workflow-store.ts` / `index.ts` 中内聚路径解析逻辑

---

## 10. 测试清单

### 单元测试

1. **外部仓库 code-review 成功启动**
   - 目标 repo 没有 `.claude-workflows/templates`
   - 仍能用内置模板跑通

2. **review-fix 也能跑通**
   - 路径策略不能只修 code-review，必须覆盖 review-fix

3. **spec-review 外部仓库可用**
   - 同样不能要求目标仓库自带模板

4. **resume/status/report 仍能找到 run artifact**
   - 不能因模板解耦破坏已有恢复链路

5. **缺失内置模板时报错更清晰**
   - 错误信息应同时说明：
     - 当前模板解析策略
     - 尝试过的路径
     - 建议修复动作

6. **项目级 override 的优先级测试**
   - 如果后续支持 override，需要验证优先级和开关条件

### 集成测试

1. 构造临时 git repo 作为外部仓库
2. 用 IM handler 风格入口启动 code-review
3. 断言生成 run artifact
4. 断言 pack/prompt 真实使用模板

### 回归测试

1. 现有本仓库内 workflow 用法不回归
2. CLI 直接在本仓库执行的旧用法不回归
3. `report`、`resume`、`status` 命令不回归

---

## 11. 文档需要同步的点

修复完成后，至少要同步以下文档：

1. `docs/development.zh-CN.md`
   - 明确 `/workflow` 可以直接审查外部仓库
   - 明确模板默认来自工具内置资源

2. `docs/workflow-conclusions-summary.md`
   - 修正“Store 路径统一”的表述
   - 明确“run 路径统一”和“模板路径策略”是两件不同的事

3. `.trellis/spec/backend/workflow-engine.md`
   - 更新 `WorkflowStore` 的路径契约
   - 不再把“模板必须位于 `{basePath}/templates`”写成唯一合法形态

4. `.claude/plan/workflow-engine-spec.md`
   - 补充发布形态下模板资源分发方案

---

## 12. 关键决策建议

### 建议 1

**默认使用工具内置模板，不默认信任目标仓库模板。**

这是安全性和一致性最好的默认值。

### 建议 2

**run artifact 继续默认放在目标仓库的 `.claude-workflows/runs`。**

原因：

1. 便于按仓库恢复
2. 便于审计
3. 不破坏当前 status/report/resume 设计直觉

### 建议 3

**不要把“当前开发机源码目录”当作正式的内置模板定位方案。**

开发期可以临时 fallback，但正式方案必须指向：

1. 安装产物内的 assets
2. 或显式配置的全局工具目录

### 建议 4

**优先做最小修复，再做完整重构。**

先修通外部仓库可用性，再处理模板打包和 override。

---

## 13. 推荐的开发顺序

- [ ] Step 1: 提炼 `resolveWorkflowPaths()`，明确 `repoCwd`、`runBasePath`、`templateBasePath`
- [ ] Step 2: 升级 `WorkflowStore`，支持分离模板根目录
- [ ] Step 3: 修复 IM `/workflow` 的 `start/review-fix/resume/status/report`
- [ ] Step 4: 修复 CLI 的默认路径策略，避免与 IM 行为分裂
- [ ] Step 5: 补齐外部仓库场景测试
- [ ] Step 6: 更新中文开发文档与 workflow 结论文档
- [ ] Step 7: 设计并实现模板资源打包方案

---

## 14. 本文要回答的新上下文问题

如果下一个上下文只看一页内容，应该先回答这几个问题：

1. 为什么 `/new` 到外部仓库后 `/workflow` 会报模板缺失？
   - 因为 IM 把模板目录也绑到了 `cwd/.claude-workflows`

2. 为什么 CLI 有时能跑，IM 不能跑？
   - 因为 CLI 已经部分分离了 `cwd` 和 `basePath`

3. 真正该修哪里？
   - 修路径职责模型，不是只改一个 hard-coded 路径

4. 推荐默认行为是什么？
   - 代码从目标仓库读，产物写目标仓库，模板从工具内置资源读

5. 最容易遗漏的点是什么？
   - npm / dist 产物目前不带模板资源，正式方案必须处理分发

---

## 15. 一句话结论

当前问题的本质不是“飞书没切到正确目录”，而是 **IM `/workflow` 把目标仓库路径、运行产物路径、模板资源路径错误地视为同一个路径**。正确修复方向是 **保留 run artifact 的仓库隔离，同时把模板解析切回工具内置资源，并为发布形态补上资源分发方案**。
