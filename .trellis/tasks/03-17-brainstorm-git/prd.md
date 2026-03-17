# brainstorm: 增加 /git 提交命令

## Goal

在 IM 侧新增一个斜杠命令（暂定 `/git`），用于把“暂存区 + 工作区”的改动一次性提交，并且强制校验提交信息符合本项目 Conventional Commits 规范；提交成功后，继续询问是否需要推送到远端。

## What I already know

* 项目是一个 Claude Code SDK → IM 平台的桥接库，IM 斜杠命令由 `bridge-manager.ts` 的 `handleCommand()` 统一处理。
* 目前已支持 `/new`、`/cwd`、`/mode`、`/status`、`/sessions`、`/stop`、`/perm`、`/help` 等命令。
* 项目使用 Angular 风格 Conventional Commits，类型集合（全小写）：
  * feat / fix / refactor / perf / style / docs / test / chore / build / ci
* 描述要求：中文、简洁、准确、命令式（如“增加 / 修复 / 优化”开头），避免“我/我们/这个/修复了”等赘词。

## Assumptions (temporary)

* `/git` 作为“显式用户指令”，可以直接在宿主进程里执行固定的 `git` 命令（不走 LLM 工具调用），并复用现有授权白名单与审计日志能力。
* Git 命令的执行目录使用当前聊天绑定的 `workingDirectory`（`/cwd` 可修改），并在执行前检查是否处于 git 仓库内。

## Open Questions

* `/git` 的交互形态：提交信息由用户在命令参数中直接提供，还是拆成“先输入 /git，再让机器人追问 message”？

## Requirements (evolving)

* 新增 `/git` 命令：
  * 把工作区改动自动加入暂存（等价 `git add -A`），并执行 `git commit -m "<message>"`。
  * 提交信息必须通过 Conventional Commits 格式校验（类型白名单 + 可选 scope + `: ` + subject）。
  * subject 要求中文、命令式（至少校验以常见动词开头，或提供清晰的错误提示与示例）。
  * 没有可提交改动时给出明确提示。
  * 成功提交后提示是否需要推送到远端（给出明确下一步命令）。
* 更新 `/help` 与 `/start` 的命令列表，包含 `/git` 的用法。
* 记录审计日志（至少：触发 `/git`、提交成功/失败、错误摘要）。

## Acceptance Criteria (evolving)

* [ ] `/git <message>` 在 git 仓库内可完成 add+commit，并返回提交摘要（至少包含 commit hash 的前 7-8 位）。
* [ ] message 不合规时返回可操作的错误信息与示例。
* [ ] 无改动时不会创建空提交。
* [ ] 提交成功后会提示“是否推送”，并给出可复制的推送命令。

## Definition of Done (team quality bar)

* 单元测试：关键解析/校验逻辑覆盖（不依赖真实 git 环境，必要时 mock）。
* `npm run typecheck` 与 `npm run test:unit` 通过。
* `/help` 文案同步更新。

## Out of Scope (explicit)

* 自动生成提交信息（基于 diff 归纳）——除非后续明确提出。
* 在一次命令里做复杂交互式问答（多轮追问 message）——优先保持无状态命令。

## Technical Notes

* 斜杠命令入口：`src/lib/bridge/bridge-manager.ts` → `handleCommand()`。
* 输入安全：`src/lib/bridge/security/validators.ts` → `isDangerousInput()` 已对命令文本做注入检测。
* 现有提交约定可参考 `git log -5 --oneline`（多为 `type(scope): 中文动词...`）。

