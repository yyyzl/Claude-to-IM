param(
  [Parameter(Position = 0)]
  [ValidateSet("start", "stop", "restart", "status", "watchdog")]
  [string]$Action = "status",

  [int]$TimeoutSec = 30,
  [switch]$Force,

  # watchdog：允许的最大心跳“失联”秒数；超过则认为卡死并重启
  [int]$MaxHeartbeatAgeSec = 120,

  # 可选：覆盖 runner 心跳/stop 轮询参数（毫秒）
  [int]$HeartbeatMs = 0,
  [int]$StopPollMs = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Get-ControlDir([string]$repoRoot) {
  $raw = $env:BRIDGE_CONTROL_DIR
  if ($null -eq $raw) { $raw = "" }
  $raw = $raw.Trim()
  if ($raw) {
    if ([System.IO.Path]::IsPathRooted($raw)) { return [System.IO.Path]::GetFullPath($raw) }
    return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $raw))
  }
  return (Join-Path $repoRoot ".ccg\\bridge-runner")
}

function Read-TextFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try { return (Get-Content -LiteralPath $path -Encoding UTF8 -Raw).Trim() } catch { return $null }
}

function Get-BridgePid([string]$pidFile) {
  $t = Read-TextFile $pidFile
  if (-not $t) { return $null }
  $pid = 0
  if ([int]::TryParse($t, [ref]$pid) -and $pid -gt 0) { return $pid }
  return $null
}

function Get-BridgeProcess([int]$pid) {
  try { return (Get-Process -Id $pid -ErrorAction Stop) } catch { return $null }
}

function Read-Heartbeat([string]$heartbeatFile) {
  $t = Read-TextFile $heartbeatFile
  if (-not $t) { return $null }
  try { return ($t | ConvertFrom-Json) } catch { return $null }
}

function Get-HeartbeatAgeSec($hb) {
  if ($null -eq $hb -or -not $hb.ts) { return $null }
  try {
    $ts = [DateTimeOffset]::Parse([string]$hb.ts)
    $age = (New-TimeSpan -Start $ts.UtcDateTime -End ([DateTime]::UtcNow)).TotalSeconds
    return [Math]::Round($age)
  } catch {
    return $null
  }
}

function Print-Status([string]$controlDir) {
  $pidFile = Join-Path $controlDir "pid"
  $heartbeatFile = Join-Path $controlDir "heartbeat.json"
  $logOut = Join-Path $controlDir "stdout.log"
  $logErr = Join-Path $controlDir "stderr.log"
  $stopFile = Join-Path $controlDir "stop"

  $pid = Get-BridgePid $pidFile
  $proc = if ($pid) { Get-BridgeProcess $pid } else { $null }
  $hb = Read-Heartbeat $heartbeatFile
  $age = Get-HeartbeatAgeSec $hb

  Write-Host ("[bridge] controlDir = {0}" -f $controlDir)
  if ($pid) {
    Write-Host ("[bridge] pid        = {0}" -f $pid)
  } else {
    Write-Host "[bridge] pid        = (none)"
  }

  if ($proc) {
    Write-Host ("[bridge] running    = yes ({0})" -f $proc.ProcessName)
  } else {
    Write-Host "[bridge] running    = no"
  }

  if ($null -ne $age) {
    $status = if ($hb.status) { [string]$hb.status } else { "(unknown)" }
    Write-Host ("[bridge] heartbeat  = {0}s ago (status={1})" -f $age, $status)
  } else {
    Write-Host "[bridge] heartbeat  = (none)"
  }

  if (Test-Path -LiteralPath $stopFile) {
    Write-Host "[bridge] stopFile   = exists"
  }

  Write-Host ("[bridge] logs       = {0}" -f $logOut)
  Write-Host ("[bridge] logs       = {0}" -f $logErr)
}

function Start-Bridge([string]$repoRoot, [string]$controlDir) {
  New-Item -ItemType Directory -Force -Path $controlDir | Out-Null

  $pidFile = Join-Path $controlDir "pid"
  $pid = Get-BridgePid $pidFile
  if ($pid) {
    $proc = Get-BridgeProcess $pid
    if ($proc) {
      Write-Host ("[bridge] 已在运行：pid={0}" -f $pid)
      return
    }
  }

  if ($HeartbeatMs -gt 0) { $env:BRIDGE_RUNNER_HEARTBEAT_MS = [string]$HeartbeatMs }
  if ($StopPollMs -gt 0) { $env:BRIDGE_RUNNER_STOP_POLL_MS = [string]$StopPollMs }
  $env:BRIDGE_CONTROL_DIR = $controlDir

  $logOut = Join-Path $controlDir "stdout.log"
  $logErr = Join-Path $controlDir "stderr.log"

  Write-Host "[bridge] 启动中..."
  Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList "/d /c npx tsx scripts/feishu-claude-bridge.ts" `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError $logErr | Out-Null

  # 等待 runner 写入 pid
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $newPid = Get-BridgePid $pidFile
    if ($newPid) { break }
  }

  Print-Status $controlDir
}

function Stop-Bridge([string]$controlDir) {
  New-Item -ItemType Directory -Force -Path $controlDir | Out-Null

  $pidFile = Join-Path $controlDir "pid"
  $stopFile = Join-Path $controlDir "stop"

  $pid = Get-BridgePid $pidFile
  if (-not $pid) {
    Write-Host "[bridge] 未检测到 pid 文件，可能未运行。"
    return
  }

  $proc = Get-BridgeProcess $pid
  if (-not $proc) {
    Write-Host ("[bridge] pid 文件存在但进程不存在（pid={0}），将清理残留文件。" -f $pid)
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
    return
  }

  Write-Host ("[bridge] 请求优雅停止：pid={0}" -f $pid)
  Set-Content -LiteralPath $stopFile -Encoding UTF8 -Value (Get-Date).ToString("o")

  $deadline = (Get-Date).AddSeconds([Math]::Max(1, $TimeoutSec))
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $p = Get-BridgeProcess $pid
    if (-not $p) { break }
  }

  $still = Get-BridgeProcess $pid
  if (-not $still) {
    Write-Host "[bridge] 已停止。"
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
    return
  }

  if (-not $Force) {
    Write-Host ("[bridge] 超时仍未退出（{0}s）。如确认卡死，可加 -Force 强制结束：" -f $TimeoutSec)
    Write-Host "         powershell -ExecutionPolicy Bypass -File scripts/bridge.ps1 stop -Force"
    return
  }

  Write-Host "[bridge] 强制结束进程树（仅用于卡死场景）..."
  & taskkill.exe /PID $pid /T /F | Out-Null

  Start-Sleep -Milliseconds 300
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
  Write-Host "[bridge] 已强制结束。"
}

function Watchdog([string]$repoRoot, [string]$controlDir) {
  $mutex = New-Object System.Threading.Mutex($false, "Local\\ClaudeToIM_Bridge_Watchdog")
  $locked = $false
  try {
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { return }

    $pidFile = Join-Path $controlDir "pid"
    $heartbeatFile = Join-Path $controlDir "heartbeat.json"

    $pid = Get-BridgePid $pidFile
    $proc = if ($pid) { Get-BridgeProcess $pid } else { $null }
    $hb = Read-Heartbeat $heartbeatFile
    $age = Get-HeartbeatAgeSec $hb

    $healthy = $false
    if ($proc) {
      if ($null -eq $age) { $healthy = $true } else { $healthy = ($age -le $MaxHeartbeatAgeSec) }
    }

    if ($healthy) { return }

    if ($proc) {
      Write-Host ("[bridge] watchdog：检测到可能卡死/失联（heartbeatAge={0}s），准备重启..." -f $age)
      Stop-Bridge $controlDir
      # Stop-Bridge 默认优雅；若仍存活则强制
      $pid2 = Get-BridgePid $pidFile
      if ($pid2 -and (Get-BridgeProcess $pid2)) {
        $script:Force = $true
        Stop-Bridge $controlDir
        $script:Force = $false
      }
    }

    Start-Bridge $repoRoot $controlDir
  } finally {
    if ($locked) { $mutex.ReleaseMutex() | Out-Null }
    $mutex.Dispose()
  }
}

$repoRoot = Get-RepoRoot
$controlDir = Get-ControlDir $repoRoot

switch ($Action) {
  "start" { Start-Bridge $repoRoot $controlDir; break }
  "stop" { Stop-Bridge $controlDir; break }
  "restart" {
    Stop-Bridge $controlDir
    $pid = Get-BridgePid (Join-Path $controlDir "pid")
    if ($pid -and (Get-BridgeProcess $pid)) {
      if (-not $Force) {
        Write-Host "[bridge] 仍在运行；如需强制重启请加 -Force。"
        break
      }
      $script:Force = $true
      Stop-Bridge $controlDir
      $script:Force = $false
    }
    Start-Bridge $repoRoot $controlDir
    break
  }
  "status" { Print-Status $controlDir; break }
  "watchdog" { Watchdog $repoRoot $controlDir; break }
}
