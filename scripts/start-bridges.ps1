<#
  Claude + Codex 双桥接管理脚本
  支持 start / stop 两种操作，并兼容清理旧的默认 bridge-runner。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts/start-bridges.ps1 [start|stop]

  start   (默认) npm install → npm run build → 启动双桥接窗口
  stop    优雅停止双桥接，并兼容清理旧的默认 bridge-runner，超时则强杀
#>

param(
  [Parameter(Position = 0)]
  [ValidateSet("start", "stop")]
  [string]$Action = "start",

  [int]$StopTimeoutSec = 15
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

# ── PID 工具函数（与 bridge.ps1 的 Get-BridgePid / Get-BridgeProcess 对齐） ──

function Read-PidFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $raw = (Get-Content -LiteralPath $path -Encoding UTF8 -Raw).Trim()
    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
    return $null
  } catch { return $null }
}

function Get-RunningProcess([int]$processId) {
  try { return (Get-Process -Id $processId -ErrorAction Stop) } catch { return $null }
}

function Stop-ProcessTree([int]$processId, [string]$label = "") {
  $proc = Get-RunningProcess $processId
  if (-not $proc) { return $false }
  if ($label) { Write-Host "[bridges] ${label}: 强制结束 (pid=$processId) ..." -ForegroundColor Yellow }
  & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
  return $true
}

# ── 桥接实例定义 ──
# managed：由本脚本负责启动的双桥接。
$managedBridges = @(
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

# cleanup-only：只负责兼容清理历史默认实例，避免它与 codex 桥接共用同一飞书应用时抢消息。
$cleanupOnlyBridges = @(
  @{
    Name       = "Legacy Default"
    EnvFile    = ".env.bridge.local"
    ControlDir = ".ccg/bridge-runner"
  }
)

$bridgesToStop = @($managedBridges + $cleanupOnlyBridges)

# ════════════════════════════════════════
# Stop：优雅停止 → 超时强杀
# ════════════════════════════════════════
function Stop-AllBridges {
  # 第 1 步：收集每个桥接的 PID 信息（一次性读取，后续复用）
  $bridgeInfo = @()
  foreach ($b in $bridgesToStop) {
    $controlDir = Join-Path $repoRoot $b.ControlDir
    $info = @{
      Name       = $b.Name
      ControlDir = $controlDir
      PidFile    = Join-Path $controlDir "pid"
      StopFile   = Join-Path $controlDir "stop"
      CmdPidFile = Join-Path $controlDir "cmd-pid"
      BridgePid  = Read-PidFile (Join-Path $controlDir "pid")
      CmdPid     = Read-PidFile (Join-Path $controlDir "cmd-pid")
    }
    $bridgeInfo += $info
  }

  # 第 2 步：向存活进程发送停止信号
  $anyRunning = $false
  foreach ($info in $bridgeInfo) {
    if (-not $info.BridgePid) { continue }

    $proc = Get-RunningProcess $info.BridgePid
    if (-not $proc) {
      Write-Host "[bridges] $($info.Name): 进程不存在 (pid=$($info.BridgePid))，清理残留文件。"
      Remove-Item -LiteralPath $info.PidFile -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $info.StopFile -Force -ErrorAction SilentlyContinue
      continue
    }

    $anyRunning = $true
    Write-Host "[bridges] $($info.Name): 发送停止信号 (pid=$($info.BridgePid)) ..."
    New-Item -ItemType Directory -Force -Path $info.ControlDir | Out-Null
    Set-Content -LiteralPath $info.StopFile -Encoding UTF8 -Value (Get-Date).ToString("o")
  }

  # 第 3 步：等待进程退出 + 超时强杀（仅当有存活进程时）
  if ($anyRunning) {
    $deadline = (Get-Date).AddSeconds($StopTimeoutSec)
    while ((Get-Date) -lt $deadline) {
      $stillAlive = $false
      foreach ($info in $bridgeInfo) {
        if ($info.BridgePid -and (Get-RunningProcess $info.BridgePid)) { $stillAlive = $true }
      }
      if (-not $stillAlive) { break }
      Start-Sleep -Milliseconds 500
    }

    # 超时：强杀残留进程
    foreach ($info in $bridgeInfo) {
      if (-not $info.BridgePid) { continue }
      if (Stop-ProcessTree $info.BridgePid "$($info.Name): 超时未退出") {
        Start-Sleep -Milliseconds 500
      }
    }
  } else {
    Write-Host "[bridges] 没有正在运行的桥接进程。"
  }

  # 第 4 步：关闭残留 cmd 窗口 + 清理控制文件（无论正常退出还是超时，都执行）
  foreach ($info in $bridgeInfo) {
    if ($info.CmdPid) {
      $cmdProc = Get-RunningProcess $info.CmdPid
      if ($cmdProc) {
        Write-Host "[bridges] $($info.Name): 关闭 cmd 窗口 (cmd-pid=$($info.CmdPid)) ..."
        & taskkill.exe /PID $info.CmdPid /T /F 2>$null | Out-Null
      }
      Remove-Item -LiteralPath $info.CmdPidFile -Force -ErrorAction SilentlyContinue
    }

    Remove-Item -LiteralPath $info.PidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $info.StopFile -Force -ErrorAction SilentlyContinue
  }

  Write-Host "[bridges] 全部已停止。" -ForegroundColor Green
}

# ════════════════════════════════════════
# Start：install → build → 启动窗口
# ════════════════════════════════════════
function Start-AllBridges {
  $nodeModulesExist = Test-Path (Join-Path $repoRoot "node_modules")

  # npm install --ignore-scripts：跳过 prepare 钩子（避免 install 阶段触发 tsc 编译撞文件锁）
  # build 在下一步单独执行
  # 注意：临时切换 ErrorActionPreference 为 Continue，否则 npm stderr 输出会被
  #       PowerShell 当作终止性错误，导致脚本直接崩溃而跳过降级逻辑
  Write-Host "[bridges] npm install ..."
  $savedEAP = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & npm.cmd install --ignore-scripts
  $npmInstallExit = $LASTEXITCODE
  $ErrorActionPreference = $savedEAP

  if ($npmInstallExit -ne 0) {
    if ($nodeModulesExist) {
      Write-Host "[bridges] npm install 失败 (exit=$npmInstallExit)，但 node_modules 已存在，降级继续。" -ForegroundColor Yellow
    } else {
      Write-Host "[bridges] npm install 失败 (exit=$npmInstallExit)，且 node_modules 不存在，中止。" -ForegroundColor Red
      exit 1
    }
  } else {
    Write-Host "[bridges] npm install 完成。" -ForegroundColor Green
  }

  # npm run build（失败时若 dist 已存在则降级继续）
  $distExist = Test-Path (Join-Path $repoRoot "dist")
  Write-Host "[bridges] npm run build ..."
  $ErrorActionPreference = "Continue"
  & npm.cmd run build
  $npmBuildExit = $LASTEXITCODE
  $ErrorActionPreference = $savedEAP

  if ($npmBuildExit -ne 0) {
    if ($distExist) {
      Write-Host "[bridges] npm run build 失败 (exit=$npmBuildExit)，但 dist 已存在，降级继续。" -ForegroundColor Yellow
    } else {
      Write-Host "[bridges] npm run build 失败 (exit=$npmBuildExit)，且 dist 不存在，中止。" -ForegroundColor Red
      exit 1
    }
  } else {
    Write-Host "[bridges] npm run build 完成。" -ForegroundColor Green
  }

  # 启动双桥接（先清理残留旧窗口，再开新窗口）
  foreach ($b in $managedBridges) {
    $controlDir = Join-Path $repoRoot $b.ControlDir
    $cmdPidFile = Join-Path $controlDir "cmd-pid"
    New-Item -ItemType Directory -Force -Path $controlDir | Out-Null

    # 清理可能残留的旧 cmd 窗口（通过保存的 PID）
    $oldCmdPid = Read-PidFile $cmdPidFile
    if ($oldCmdPid) {
      Stop-ProcessTree $oldCmdPid "$($b.Name): 清理残留旧窗口"
    }

    $title = "Bridge: $($b.Name)"
    $cmd = "set BRIDGE_CONTROL_DIR=$($b.ControlDir) && cd /d `"$repoRoot`" && title $title && npx tsx scripts/feishu-claude-bridge.ts $($b.EnvFile)"

    Write-Host "[bridges] 启动 $($b.Name) 桥接窗口..."
    $cmdProc = Start-Process cmd.exe -ArgumentList "/k $cmd" -PassThru
    Set-Content -LiteralPath $cmdPidFile -Encoding UTF8 -Value $cmdProc.Id
    Write-Host "[bridges] $($b.Name): cmd 窗口 PID=$($cmdProc.Id)"
  }

  Write-Host "[bridges] 全部就绪：已启动 $($managedBridges.Count) 个桥接窗口。" -ForegroundColor Green
}

# ════════════════════════════════════════
# 主入口
# ════════════════════════════════════════
switch ($Action) {
  "start"   { Start-AllBridges }
  "stop"    { Stop-AllBridges }
}
