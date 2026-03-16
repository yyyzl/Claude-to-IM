import fs from "node:fs";
import path from "node:path";

export type CodexModelListItem = {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  [k: string]: unknown;
};

function findFirstExistingOnPath(names: string[]): string | null {
  const pathVar = process.env.PATH || "";
  const dirs = pathVar.split(path.delimiter).map((d) => d.trim()).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 解析 codex 可执行文件路径。
 *
 * 设计目标：尽量模拟 session-orchestrator 的 resolve_codex_binary 行为，
 * 在 Windows 下优先 codex.cmd，并在 PATH 缺失时回退到 %APPDATA%\\npm。
 */
export function resolveCodexBinary(userSpecified?: string): string {
  const specified = (userSpecified || "").trim();
  if (specified) return specified;

  const names = process.platform === "win32"
    ? ["codex.exe", "codex.cmd", "codex"]
    : ["codex"];

  const found = findFirstExistingOnPath(names);
  if (found) return found;

  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || "";
    if (appdata) {
      const npmDir = path.join(appdata, "npm");
      for (const name of ["codex.cmd", "codex.exe", "codex"]) {
        const candidate = path.join(npmDir, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  throw new Error(
    [
      "未找到 codex 可执行文件。",
      "请确认已安装 codex-cli，并满足其一：",
      "1) codex 在 PATH 中可用；或",
      "2) Windows 下 %APPDATA%\\npm 中存在 codex.cmd；或",
      "3) 显式配置 bridge_codex_bin 指向 codex 可执行文件。",
    ].join("\n"),
  );
}

export function buildTurnSandboxPolicy(sandboxMode: string): Record<string, unknown> {
  if (sandboxMode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (sandboxMode === "workspace-write") {
    return {
      type: "workspaceWrite",
      readOnlyAccess: { type: "fullAccess" },
    };
  }
  if (sandboxMode === "read-only") {
    return {
      type: "readOnly",
      access: { type: "fullAccess" },
    };
  }
  throw new Error(`不支持的 sandbox_mode: ${sandboxMode}`);
}

function normalizeModelHaystack(model: CodexModelListItem): string {
  const parts = [
    String(model.id || ""),
    String(model.model || ""),
    String(model.displayName || ""),
    String(model.description || ""),
  ];
  return parts.join(" ").toLowerCase();
}

function scoreWithHint(haystack: string, hint: string): number {
  if (!hint) return 0;

  const h = hint.toLowerCase();
  let score = 0;

  // Strong preferences
  if (h.includes("xhigh") && haystack.includes("xhigh")) score += 2000;
  if (h.includes("gpt-5.2") && haystack.includes("gpt-5.2")) score += 1500;

  // Weaker, token-based matching
  const tokens = h.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (haystack.includes(t)) score += 120;
  }

  if (h.includes("codex") && haystack.includes("codex")) score += 600;
  if (h.includes("gpt-5") && haystack.includes("gpt-5")) score += 250;

  return score;
}

function baseScore(model: CodexModelListItem, haystack: string): number {
  let score = 0;
  // Mirror the python helper's intent: prefer newer Codex models if no hint.
  if (haystack.includes("gpt-5.3-codex")) score += 3000;
  if (haystack.includes("5.3") && haystack.includes("codex")) score += 2000;
  if (haystack.includes("gpt-5.2") && haystack.includes("codex")) score += 1700;
  if (haystack.includes("gpt-5") && haystack.includes("codex")) score += 900;
  if (haystack.includes("codex")) score += 600;
  if (haystack.includes("gpt-5")) score += 200;
  if (model.isDefault) score += 50;
  return score;
}

/**
 * 从 Codex app-server 的 model/list 返回中选择一个最合适的模型。
 *
 * - explicitId：完全匹配优先
 * - hint：支持 "gpt-5.2 xhigh" 这类模糊提示，按相似度打分
 */
export function selectCodexModel(
  models: CodexModelListItem[],
  opts: { explicitId?: string; hint?: string } = {},
): CodexModelListItem | null {
  if (!Array.isArray(models) || models.length === 0) return null;

  const explicit = (opts.explicitId || "").trim();
  if (explicit) {
    const exact = models.find((m) => String(m.id || "") === explicit);
    if (exact) return exact;
  }

  const hint = (opts.hint || "").trim();
  if (hint) {
    // 如果 hint 里包含一个“确切模型 id”，优先直接使用（例如 "gpt-5.2 xhigh"）。
    const tokens = hint.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    for (const rawToken of tokens) {
      const token = rawToken.replace(/^['"]|['"]$/g, "").replace(/[),.;]+$/, "");
      if (!token) continue;
      const exact = models.find((m) => String(m.id || "") === token);
      if (exact) return exact;
    }
  }

  const ranked = [...models].sort((a, b) => {
    const ha = normalizeModelHaystack(a);
    const hb = normalizeModelHaystack(b);
    const sa = baseScore(a, ha) + scoreWithHint(ha, hint);
    const sb = baseScore(b, hb) + scoreWithHint(hb, hint);
    return sb - sa;
  });

  return ranked[0] || null;
}
