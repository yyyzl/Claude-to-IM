<#
  Claude + Codex 双桥接管理脚本
  支持 start / stop 两种操作。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts/start-bridges.ps1 [start|stop]

  start   (默认) npm install → npm run build → 启动双桥接窗口
  stop    优雅停止两个桥接，超时则强杀
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

# ════════════════════════════════════════
# Stop：优雅停止 → 超时强杀
# ════════════════════════════════════════
function Stop-AllBridges {
  $anyRunning = $false

  foreach ($b in $bridges) {
    $controlDir = Join-Path $repoRoot $b.ControlDir
    $pidFile = Join-Path $controlDir "pid"
    $stopFile = Join-Path $controlDir "stop"

    if (-not (Test-Path -LiteralPath $pidFile)) { continue }
    $raw = (Get-Content -LiteralPath $pidFile -Encoding UTF8 -Raw).Trim()
    $bridgePid = 0
    if (-not ([int]::TryParse($raw, [ref]$bridgePid)) -or $bridgePid -le 0) { continue }

    $proc = $null
    try { $proc = Get-Process -Id $bridgePid -ErrorAction Stop } catch {}
    if (-not $proc) {
      Write-Host "[bridges] $($b.Name): 进程不存在 (pid=$bridgePid)，清理残留文件。"
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
      continue
    }

    $anyRunning = $true
    Write-Host "[bridges] $($b.Name): 发送停止信号 (pid=$bridgePid) ..."
    New-Item -ItemType Directory -Force -Path $controlDir | Out-Null
    Set-Content -LiteralPath $stopFile -Encoding UTF8 -Value (Get-Date).ToString("o")
  }

  if (-not $anyRunning) {
    Write-Host "[bridges] 没有正在运行的桥接进程。"
    # 仍需关闭可能残留的 cmd 窗口（node 退了但 /k 让 cmd 窗口留着的情况）
  }

  if ($anyRunning) {
    # 等待所有进程退出
    $deadline = (Get-Date).AddSeconds($StopTimeoutSec)
    while ((Get-Date) -lt $deadline) {
      $stillAlive = $false
      foreach ($b in $bridges) {
        $controlDir = Join-Path $repoRoot $b.ControlDir
        $pidFile = Join-Path $controlDir "pid"
        if (-not (Test-Path -LiteralPath $pidFile)) { continue }
        $raw = (Get-Content -LiteralPath $pidFile -Encoding UTF8 -Raw).Trim()
        $pid2 = 0
        if (-not ([int]::TryParse($raw, [ref]$pid2)) -or $pid2 -le 0) { continue }
        try { $null = Get-Process -Id $pid2 -ErrorAction Stop; $stillAlive = $true } catch {}
      }
      if (-not $stillAlive) { break }
      Start-Sleep -Milliseconds 500
    }

    # 超时：强杀残留进程
    foreach ($b in $bridges) {
      $controlDir = Join-Path $repoRoot $b.ControlDir
      $pidFile = Join-Path $controlDir "pid"

      if (-not (Test-Path -LiteralPath $pidFile)) { continue }
      $raw = (Get-Content -LiteralPath $pidFile -Encoding UTF8 -Raw).Trim()
      $pid3 = 0
      if (-not ([int]::TryParse($raw, [ref]$pid3)) -or $pid3 -le 0) { continue }

      $proc = $null
      try { $proc = Get-Process -Id $pid3 -ErrorAction Stop } catch {}
      if ($proc) {
        Write-Host "[bridges] $($b.Name): 超时未退出，强制结束 (pid=$pid3) ..." -ForegroundColor Yellow
        & taskkill.exe /PID $pid3 /T /F 2>$null | Out-Null
        Start-Sleep -Milliseconds 500
      }
    }
  }

  # 关闭残留 cmd 窗口 + 清理控制文件（无论正常退出还是超时，都执行）
  foreach ($b in $bridges) {
    $controlDir = Join-Path $repoRoot $b.ControlDir
    $pidFile = Join-Path $controlDir "pid"
    $stopFile = Join-Path $controlDir "stop"
    $cmdPidFile = Join-Path $controlDir "cmd-pid"

    # 通过保存的 cmd.exe PID 关闭窗口（WINDOWTITLE 过滤器对 Start-Process 创建的窗口无效）
    if (Test-Path -LiteralPath $cmdPidFile) {
      $cmdRaw = (Get-Content -LiteralPath $cmdPidFile -Encoding UTF8 -Raw).Trim()
      $cmdPid = 0
      if ([int]::TryParse($cmdRaw, [ref]$cmdPid) -and $cmdPid -gt 0) {
        $cmdProc = $null
        try { $cmdProc = Get-Process -Id $cmdPid -ErrorAction Stop } catch {}
        if ($cmdProc) {
          Write-Host "[bridges] $($b.Name): 关闭 cmd 窗口 (cmd-pid=$cmdPid) ..."
          & taskkill.exe /PID $cmdPid /T /F 2>$null | Out-Null
        }
      }
      Remove-Item -LiteralPath $cmdPidFile -Force -ErrorAction SilentlyContinue
    }

    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
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
  foreach ($b in $bridges) {
    $controlDir = Join-Path $repoRoot $b.ControlDir
    $cmdPidFile = Join-Path $controlDir "cmd-pid"
    New-Item -ItemType Directory -Force -Path $controlDir | Out-Null

    # 清理可能残留的旧 cmd 窗口（通过保存的 PID）
    if (Test-Path -LiteralPath $cmdPidFile) {
      $oldRaw = (Get-Content -LiteralPath $cmdPidFile -Encoding UTF8 -Raw).Trim()
      $oldCmdPid = 0
      if ([int]::TryParse($oldRaw, [ref]$oldCmdPid) -and $oldCmdPid -gt 0) {
        $oldProc = $null
        try { $oldProc = Get-Process -Id $oldCmdPid -ErrorAction Stop } catch {}
        if ($oldProc) {
          Write-Host "[bridges] $($b.Name): 清理残留旧窗口 (cmd-pid=$oldCmdPid) ..."
          & taskkill.exe /PID $oldCmdPid /T /F 2>$null | Out-Null
        }
      }
    }

    $title = "Bridge: $($b.Name)"
    $cmd = "set BRIDGE_CONTROL_DIR=$($b.ControlDir) && cd /d `"$repoRoot`" && title $title && npx tsx scripts/feishu-claude-bridge.ts $($b.EnvFile)"

    Write-Host "[bridges] 启动 $($b.Name) 桥接窗口..."
    $cmdProc = Start-Process cmd.exe -ArgumentList "/k $cmd" -PassThru
    Set-Content -LiteralPath $cmdPidFile -Encoding UTF8 -Value $cmdProc.Id
    Write-Host "[bridges] $($b.Name): cmd 窗口 PID=$($cmdProc.Id)"
  }

  Write-Host "[bridges] 全部就绪：已启动 $($bridges.Count) 个桥接窗口。" -ForegroundColor Green
}

# ════════════════════════════════════════
# 主入口
# ════════════════════════════════════════
switch ($Action) {
  "start"   { Start-AllBridges }
  "stop"    { Stop-AllBridges }
}
