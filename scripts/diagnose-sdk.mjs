/**
 * 诊断 Claude Agent SDK 是否能正常工作。
 * 用法（PowerShell）：node scripts/diagnose-sdk.mjs
 */
import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

console.log("=== 环境诊断 ===");
console.log("Node:", process.version);
console.log("Platform:", process.platform);
console.log("CLAUDECODE:", process.env.CLAUDECODE || "(未设置)");
console.log("CLAUDE_CODE_GIT_BASH_PATH:", process.env.CLAUDE_CODE_GIT_BASH_PATH || "(未设置)");
console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "已设置" : "未设置");

// 检测 git-bash
const gitExec = spawnSync("git", ["--exec-path"], { encoding: "utf8", timeout: 3000, windowsHide: true });
if (gitExec.stdout) {
  const gitRoot = path.resolve(gitExec.stdout.trim(), "..", "..", "..");
  const bashPath = path.join(gitRoot, "bin", "bash.exe");
  console.log("Git bash detected:", bashPath, fs.existsSync(bashPath) ? "(存在)" : "(不存在)");
  if (!process.env.CLAUDE_CODE_GIT_BASH_PATH && fs.existsSync(bashPath)) {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
    console.log("已自动设置 CLAUDE_CODE_GIT_BASH_PATH");
  }
}

// 清除嵌套检测
delete process.env.CLAUDECODE;

// SDK 版本
const sdkPkg = JSON.parse(fs.readFileSync(path.join(root, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8"));
console.log("SDK version:", sdkPkg.version);

// 测试 SDK
console.log("\n=== 测试 SDK query ===");
const { query } = await import(
  "file:///" + path.join(root, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs").replace(/\\/g, "/")
);

let stderrBuf = "";
try {
  const conversation = query({
    prompt: "Reply with exactly: OK",
    options: {
      maxTurns: 1,
      permissionMode: "default",
      stderr: (data) => { stderrBuf += data; },
    },
  });

  for await (const msg of conversation) {
    if (msg?.type === "result") {
      console.log("Result:", msg.subtype, (msg.result || "").slice(0, 50));
    }
  }
  console.log("✅ SDK 工作正常");
} catch (e) {
  console.error("❌ SDK 错误:", e.message);
  if (stderrBuf) console.error("STDERR:", stderrBuf);
  else console.error("(无 stderr 输出 — 子进程可能在 stderr pipe 建立前就退出了)");
}
