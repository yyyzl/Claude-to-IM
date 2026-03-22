<#
  一键启动 Claude + Codex 双桥接
  各自在独立的 PowerShell 窗口中运行，窗口标题标注后端类型。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts/start-bridges.ps1
#>

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

# ── 桥接实例定义 ──
$bridges = @(
  @{
    Name       = "Claude"
    EnvFile    = ".env.bridge.claude"
    ControlDir = ".ccg/bridge-claude"
  },
  @{
    Name       = "Codex"
    EnvFile    = ".env.bridge.codex"
    ControlDir = ".ccg/bridge-codex"
  }
)

foreach ($b in $bridges) {
  $title = "Bridge: $($b.Name)"
  # 用 cmd /k 保持窗口不关闭，方便看日志；set 设置环境变量后再 npx 启动
  $cmd = "set BRIDGE_CONTROL_DIR=$($b.ControlDir) && cd /d `"$repoRoot`" && title $title && npx tsx scripts/feishu-claude-bridge.ts $($b.EnvFile)"

  Write-Host "[start-bridges] 启动 $($b.Name) 桥接窗口..."
  Start-Process cmd.exe -ArgumentList "/k $cmd"
}

Write-Host "[start-bridges] 已启动 $($bridges.Count) 个桥接窗口。"
