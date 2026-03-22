<#
  Single-instance restart script triggered by bridge /restart.
  Runs detached: wait old process exit -> npm install -> start new process.
#>

param(
  [Parameter(Mandatory)][string]$ControlDir,
  [Parameter(Mandatory)][string]$EnvFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not [System.IO.Path]::IsPathRooted($ControlDir)) {
  $ControlDir = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $ControlDir))
}
New-Item -ItemType Directory -Force -Path $ControlDir | Out-Null

$pidFile = Join-Path $ControlDir "pid"
$heartbeatFile = Join-Path $ControlDir "heartbeat.json"
$restartStatusFile = Join-Path $ControlDir "restart-status.json"
$restartDebugFile = Join-Path $ControlDir "restart-debug.log"
$logOut = Join-Path $ControlDir "stdout.log"
$logErr = Join-Path $ControlDir "stderr.log"

function Get-BridgePid {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $raw = (Get-Content -LiteralPath $pidFile -Encoding UTF8 -Raw).Trim()
  $parsed = 0
  if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) {
    return $parsed
  }
  return $null
}

function Get-BridgeProcess([int]$bridgePid) {
  try {
    return Get-Process -Id $bridgePid -ErrorAction Stop
  } catch {
    return $null
  }
}

function Get-BridgeHeartbeatStatus {
  if (-not (Test-Path -LiteralPath $heartbeatFile)) { return $null }
  try {
    $raw = Get-Content -LiteralPath $heartbeatFile -Encoding UTF8 -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    $parsed = $raw | ConvertFrom-Json
    if ($null -eq $parsed) { return $null }
    if ($parsed.PSObject.Properties.Name -notcontains "status") { return $null }
    $status = [string]$parsed.status
    if ([string]::IsNullOrWhiteSpace($status)) { return $null }
    return $status.Trim()
  } catch {
    return $null
  }
}

function Get-BridgeHeartbeatPid {
  if (-not (Test-Path -LiteralPath $heartbeatFile)) { return $null }
  try {
    $raw = Get-Content -LiteralPath $heartbeatFile -Encoding UTF8 -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    $parsed = $raw | ConvertFrom-Json
    if ($null -eq $parsed) { return $null }
    if ($parsed.PSObject.Properties.Name -notcontains "pid") { return $null }
    $hbPid = 0
    if ([int]::TryParse([string]$parsed.pid, [ref]$hbPid) -and $hbPid -gt 0) {
      return $hbPid
    }
    return $null
  } catch {
    return $null
  }
}

function Write-RestartDebug([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date).ToString("o"), $message
  Write-Host $line
  Add-Content -LiteralPath $restartDebugFile -Encoding UTF8 -Value $line
}

function Get-LogTail([string]$filePath, [int]$lineCount = 20) {
  if (-not (Test-Path -LiteralPath $filePath)) { return @() }
  try {
    return @(Get-Content -LiteralPath $filePath -Encoding UTF8 -Tail $lineCount)
  } catch {
    return @()
  }
}

function Write-LogTailToDebug([string]$label, [string]$filePath, [int]$lineCount = 20) {
  $tail = Get-LogTail -filePath $filePath -lineCount $lineCount
  if ($tail.Count -eq 0) {
    Write-RestartDebug ("{0}: (empty)" -f $label)
    return
  }

  Write-RestartDebug ("{0}:" -f $label)
  foreach ($line in $tail) {
    Write-RestartDebug ("  {0}" -f $line)
  }
}

function Write-RestartFailure([string]$stage, [string]$message, [string[]]$details = @()) {
  $payload = [ordered]@{
    status = "failed"
    stage = $stage
    message = $message
    ts = (Get-Date).ToString("o")
    debugLog = $restartDebugFile
    stdoutLog = $logOut
    stderrLog = $logErr
  }
  if ($details.Count -gt 0) {
    $payload.details = $details
  }

  Set-Content -LiteralPath $restartStatusFile -Encoding UTF8 -Value ($payload | ConvertTo-Json -Depth 4)
  Write-RestartDebug ("FAIL [{0}] {1}" -f $stage, $message)
  foreach ($detail in $details) {
    Write-RestartDebug ("  {0}" -f $detail)
  }
}

Remove-Item -LiteralPath $restartStatusFile -Force -ErrorAction SilentlyContinue
Set-Content -LiteralPath $restartDebugFile -Encoding UTF8 -Value (
  "[{0}] restart begin controlDir={1} envFile={2}" -f (Get-Date).ToString("o"), $ControlDir, $EnvFile
)

# ── P1: Write ack file to signal parent that script has started executing ──
$ackFile = Join-Path $ControlDir "restart-ack"
Set-Content -LiteralPath $ackFile -Encoding UTF8 -Value "ack"
Write-RestartDebug "[restart-bridge] ack written: $ackFile"

try {
  Write-RestartDebug "[restart-bridge] waiting for old process exit..."
  for ($i = 0; $i -lt 60; $i++) {
    $oldPid = Get-BridgePid
    if (-not $oldPid) { break }
    $proc = Get-BridgeProcess $oldPid
    if (-not $proc) { break }
    Start-Sleep -Seconds 1
  }

  $oldPid = Get-BridgePid
  if ($oldPid) {
    $proc = Get-BridgeProcess $oldPid
    if ($proc) {
      Write-RestartDebug ("[restart-bridge] old process still alive, force kill pid={0}" -f $oldPid)
      & taskkill.exe /PID $oldPid /T /F 2>$null | Out-Null
      Start-Sleep -Seconds 2
    }
  }

  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $heartbeatFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $ControlDir "stop") -Force -ErrorAction SilentlyContinue

  Write-RestartDebug "[restart-bridge] running npm install..."
  Set-Location $repoRoot
  $npmInstallTimeout = 120  # seconds
  $npmLogOut = Join-Path $ControlDir "npm-install-stdout.log"
  $npmLogErr = Join-Path $ControlDir "npm-install-stderr.log"
  Remove-Item -LiteralPath $npmLogOut -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $npmLogErr -Force -ErrorAction SilentlyContinue
  $npmProc = Start-Process -FilePath "npm.cmd" -ArgumentList @("install") -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $npmLogOut -RedirectStandardError $npmLogErr -PassThru
  $npmExited = $npmProc.WaitForExit($npmInstallTimeout * 1000)
  if (-not $npmExited) {
    Write-RestartDebug "[restart-bridge] npm install timed out after ${npmInstallTimeout}s, killing..."
    try { $npmProc.Kill() } catch {}
    Start-Sleep -Seconds 2
    $installLines = Get-LogTail -filePath $npmLogOut -lineCount 20
    Write-RestartFailure "npm_install_timeout" "npm install did not complete within ${npmInstallTimeout}s" @(
      ("timeout=${npmInstallTimeout}s")
    )
    # Don't abort; try to start with existing node_modules
    Write-RestartDebug "[restart-bridge] proceeding despite npm install timeout..."
  } else {
    $installExit = $npmProc.ExitCode
    if ($installExit -ne 0) {
      $installLines = Get-LogTail -filePath $npmLogOut -lineCount 40
      Write-RestartDebug ("[restart-bridge] npm install failed exit={0}" -f $installExit)
      foreach ($line in $installLines) {
        Write-RestartDebug ("  {0}" -f $line)
      }
    } else {
      Write-RestartDebug "[restart-bridge] npm install finished exit=0"
    }
  }
  Remove-Item -LiteralPath $npmLogOut -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $npmLogErr -Force -ErrorAction SilentlyContinue

  Write-RestartDebug "[restart-bridge] starting new bridge process..."

  # ── Fix: 清除所有 bridge_* 环境变量，避免父进程的值污染新进程 ──
  # loadDotEnvFile() 采用"不覆盖已存在 key"策略，如果旧进程的 bridge_llm_backend
  # 等变量被继承，新进程的 .env 文件将无法覆盖它们，导致 backend 错误。
  $bridgeEnvVars = @(
    [System.Environment]::GetEnvironmentVariables(
      [System.EnvironmentVariableTarget]::Process
    ).Keys | Where-Object { $_ -like "bridge_*" }
  )
  foreach ($varName in $bridgeEnvVars) {
    Write-RestartDebug ("[restart-bridge] clearing inherited env: {0}" -f $varName)
    [System.Environment]::SetEnvironmentVariable(
      $varName, $null, [System.EnvironmentVariableTarget]::Process
    )
  }

  $env:BRIDGE_CONTROL_DIR = $ControlDir
  Remove-Item -LiteralPath $logOut -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $logErr -Force -ErrorAction SilentlyContinue

  $startArgs = @(
    "tsx",
    "scripts/feishu-claude-bridge.ts",
    $EnvFile
  )
  try {
    $startedProcess = Start-Process -FilePath "npx.cmd" -ArgumentList $startArgs -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr -PassThru
    if ($null -ne $startedProcess) {
      Write-RestartDebug ("[restart-bridge] Start-Process returned pid={0}" -f $startedProcess.Id)
    }
  } catch {
    $startMessage = $_.Exception.Message
    Write-RestartFailure "start_process" $startMessage @(
      ("command=npx.cmd {0}" -f ($startArgs -join " "))
    )
    throw
  }

  Write-RestartDebug "[restart-bridge] waiting for new process heartbeat..."
  $started = $false
  for ($i = 0; $i -lt 240; $i++) {
    Start-Sleep -Milliseconds 500
    $newPid = Get-BridgePid
    $heartbeatStatus = Get-BridgeHeartbeatStatus
    $heartbeatPid = Get-BridgeHeartbeatPid
    if (-not $newPid) { continue }
    if ($heartbeatStatus -eq "running") {
      # ── Fix: 四元组校验 ──
      # 确保 heartbeat.pid 与 pid 文件的值一致，防止旧僵尸进程的心跳
      # 被误判为新进程已就绪。
      if ($null -ne $heartbeatPid -and $heartbeatPid -ne $newPid) {
        if ($i % 10 -eq 0) {
          Write-RestartDebug (
            "[restart-bridge] heartbeat pid mismatch: pidFile={0} heartbeat.pid={1}, waiting..." -f $newPid, $heartbeatPid
          )
        }
        continue
      }
      $proc = Get-BridgeProcess $newPid
      if ($proc) {
        Write-RestartDebug ("[restart-bridge] new process verified pid={0} heartbeat.pid={1} status={2}" -f $newPid, $heartbeatPid, $heartbeatStatus)
        $started = $true
        break
      }
    }
  }

  if (-not $started) {
    Write-LogTailToDebug -label "[restart-bridge] stdout tail" -filePath $logOut -lineCount 30
    Write-LogTailToDebug -label "[restart-bridge] stderr tail" -filePath $logErr -lineCount 30
    $finalHeartbeatStatus = Get-BridgeHeartbeatStatus
    $heartbeatDetail = if ($null -ne $finalHeartbeatStatus -and -not [string]::IsNullOrWhiteSpace($finalHeartbeatStatus)) {
      $finalHeartbeatStatus
    } else {
      "missing"
    }
    Write-RestartFailure "start_timeout" "runner heartbeat did not reach running state" @(
      ("heartbeat={0}" -f $heartbeatDetail),
      ("stdout={0}" -f $logOut),
      ("stderr={0}" -f $logErr)
    )
  }

  Write-RestartDebug "[restart-bridge] done."
} catch {
  if (-not (Test-Path -LiteralPath $restartStatusFile)) {
    $scriptMessage = $_.Exception.Message
    Write-RestartFailure "script_exception" $scriptMessage
  }
  throw
}
