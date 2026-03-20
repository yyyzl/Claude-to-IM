/**
 * Help text generators for passthrough commands.
 *
 * - `//xxx`          → Claude passthrough (message forwarded to Claude session)
 * - `//trellis:xxx`  → Trellis passthrough (透传给 Claude，由 skill 处理)
 * - `/codex:xxx`     → Codex passthrough (dispatched to codeagent-wrapper)
 */

// ── // Claude passthrough help ───────────────────────────────────

export function buildClaudePassthroughHelp(): string {
  return [
    '<b>// Claude 透传命令</b>',
    '',
    '双斜杠 <code>//</code> 开头的消息会直接发送给 Claude 会话处理。',
    '',
    '<b>🔧 代码工程</b>',
    '//review - 审查当前 git diff 中的代码变更',
    '//debug &lt;描述&gt; - 调试问题，定位根因',
    '//test &lt;文件/模块&gt; - 为指定模块生成测试',
    '//fix &lt;bug描述&gt; - 修复 Bug',
    '//bugfix &lt;描述&gt; - 快速 Bug 修复工作流',
    '//refactor &lt;目标&gt; - 代码重构',
    '//optimize &lt;目标&gt; - 性能优化',
    '//code &lt;需求&gt; - 多模型协作写代码',
    '//explain &lt;文件/函数&gt; - 解释代码逻辑',
    '//docs &lt;目标&gt; - 生成或更新文档',
    '//security &lt;目标&gt; - 安全审查',
    '',
    '<b>💡 思考与规划</b>',
    '//ask &lt;问题&gt; - 多专家技术咨询',
    '//think &lt;问题&gt; - 深度思考复杂问题',
    '//brainstorm &lt;主题&gt; - 头脑风暴',
    '//plan &lt;需求&gt; - 需求分析 + 实施规划',
    '',
    '<b>📋 CCG 多模型协作</b> <i>(需 CCG skills 环境)</i>',
    '//ccg:analyze &lt;目标&gt; - Codex+Gemini 并行技术分析',
    '//ccg:plan &lt;需求&gt; - 多模型协作规划',
    '//ccg:execute &lt;计划文件&gt; - 执行计划（Claude 实施+多模型审计）',
    '//ccg:review - 多模型代码审查（双模型交叉验证）',
    '//ccg:feat &lt;需求&gt; - 智能功能开发全流程',
    '//ccg:debug &lt;问题&gt; - Codex+Gemini 交叉调试',
    '//ccg:test &lt;目标&gt; - 多模型测试生成',
    '//ccg:optimize &lt;目标&gt; - 多模型性能优化',
    '//ccg:commit - 智能 Git 提交（Conventional Commits）',
    '//ccg:workflow &lt;需求&gt; - 完整开发工作流',
    '//ccg:backend &lt;需求&gt; - 后端专项（Codex 主导）',
    '//ccg:frontend &lt;需求&gt; - 前端专项（Gemini 主导）',
    '//ccg:codex-exec &lt;计划文件&gt; - Codex 全权执行',
    '//ccg:enhance &lt;需求&gt; - Prompt 增强',
    '',
    '<b>📋 CCG 规范驱动</b> <i>(需 CCG skills 环境)</i>',
    '//ccg:spec-init - 初始化 OpenSpec 环境',
    '//ccg:spec-research &lt;需求&gt; - 需求→约束集',
    '//ccg:spec-plan &lt;需求&gt; - 多模型→零决策计划',
    '//ccg:spec-impl &lt;规范&gt; - 按规范执行+归档',
    '//ccg:spec-review - 双模型交叉审查',
    '',
    '<b>📋 CCG Agent Teams</b> <i>(需 CCG skills 环境)</i>',
    '//ccg:team-research &lt;需求&gt; - 并行探索代码库',
    '//ccg:team-plan &lt;需求&gt; - Lead 调用多模型规划',
    '//ccg:team-exec &lt;计划&gt; - Builder 并行实施',
    '//ccg:team-review - 双模型交叉审查',
    '',
    '<b>📋 CCG 辅助</b> <i>(需 CCG skills 环境)</i>',
    '//ccg:init - 初始化项目 AI 上下文',
    '//ccg:context - 项目上下文管理',
    '//ccg:clean-branches - 安全清理 Git 分支',
    '//ccg:rollback - 交互式 Git 回滚',
    '//ccg:worktree - Git Worktree 管理',
    '',
    '<b>🌳 Trellis 开发工作流</b> <i>(需 .trellis/ 环境)</i>',
    '//trellis:start - 初始化 Trellis 开发会话（读取上下文+指南）',
    '//trellis:parallel &lt;task-dir&gt; - 启动多 Agent 并行（Worktree 模式）',
    '//trellis:finish-work - 提交前收尾检查（代码/测试/规范同步）',
    '//trellis:record-session - 记录工作进度并归档已完成任务',
    '',
    '<b>💬 自由形式</b>',
    '<code>//</code> 后可跟任意自然语言，Claude 都会理解：',
    '<code>//帮我把 handleCommand 改成命令注册表模式</code>',
  ].join('\n');
}

// ── /codex: Codex passthrough help ───────────────────────────────

export function buildCodexPassthroughHelp(): string {
  return [
    '<b>/codex: Codex 透传命令</b>',
    '',
    '<code>/codex:</code> 前缀的命令会附加专业角色提示词，由当前会话处理。',
    '',
    '<b>专业角色</b>',
    '/codex:analyze &lt;目标&gt; - 系统架构评估、技术债分析、可扩展性审查',
    '/codex:architect &lt;需求&gt; - API 设计、数据库方案、架构蓝图',
    '/codex:debug &lt;问题&gt; - 根因分析、日志诊断、性能排查',
    '/codex:optimize &lt;目标&gt; - 算法优化、缓存策略、数据库调优',
    '/codex:review - 代码审查 + 安全检查 + 质量评分',
    '/codex:test &lt;目标&gt; - 生成单元测试、集成测试',
    '',
    '<b>全能模式</b>',
    '/codex:exec &lt;任务&gt; - 全权执行（代码搜索+实现+测试+验证）',
    '',
    '<b>通用</b>',
    '/codex:help - 显示本帮助',
    '/codex: &lt;自然语言&gt; - 任意任务发给 Codex',
  ].join('\n');
}

// ── Codex role → prompt file mapping ─────────────────────────────

/** Known Codex roles. */
export const CODEX_ROLES: Record<string, { description: string }> = {
  analyze:   { description: 'system architecture assessment' },
  architect: { description: 'API / database / architecture design' },
  debug:     { description: 'root cause analysis & diagnostics' },
  optimize:  { description: 'performance optimization' },
  review:    { description: 'code review & quality scoring' },
  test:      { description: 'unit / integration test generation' },
};
