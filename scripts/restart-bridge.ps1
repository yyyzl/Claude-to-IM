<#
  单实例重启脚本 — 被 bridge /restart 命令触发。
  作为 detached 进程运行，等旧进程退出 → npm install → 启动新进程。

  用法（由 runner 自动调用，通常不需手动运行）：
    powershell -ExecutionPolicy Bypass -File scripts/restart-bridge.ps1 `
      -ControlDir .ccg/bridge-claude `
      -EnvFile .env.bridge.claude
#>

param(
  [Parameter(Mandatory)][string]$ControlDir,
  [Parameter(Mandatory)][string]$EnvFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

# ── Resolve controlDir to absolute ──
if (-not [System.IO.Path]::IsPathRooted($ControlDir)) {
  $ControlDir = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $ControlDir))
}
New-Item -ItemType Directory -Force -Path $ControlDir | Out-Null

$pidFile = Join-Path $ControlDir "pid"

# ── Helper: read PID ──
function Get-BridgePid {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $t = (Get-Content -LiteralPath $pidFile -Encoding UTF8 -Raw).Trim()
  $p = 0
  if ([int]::TryParse($t, [ref]$p) -and $p -gt 0) { return $p }
  return $null
}

function Get-BridgeProcess([int]$bridgePid) {
  try { return (Get-Process -Id $bridgePid -ErrorAction Stop) } catch { return $null }
}

# ── 1. Wait for old process to exit (max 60s) ──
Write-Host "[restart-bridge] 等待旧进程退出..."
for ($i = 0; $i -lt 60; $i++) {
  $oldPid = Get-BridgePid
  if (-not $oldPid) { break }
  $proc = Get-BridgeProcess $oldPid
  if (-not $proc) { break }
  Start-Sleep -Seconds 1
}

# Force kill if still alive
$oldPid = Get-BridgePid
if ($oldPid) {
  $proc = Get-BridgeProcess $oldPid
  if ($proc) {
    Write-Host "[restart-bridge] 旧进程仍在运行（pid=$oldPid），强制终止..."
    & taskkill.exe /PID $oldPid /T /F 2>$null | Out-Null
    Start-Sleep -Seconds 2
  }
}

# Clean up stale files
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $ControlDir "stop") -Force -ErrorAction SilentlyContinue

# ── 2. npm install (triggers prepare → build if deps changed) ──
Write-Host "[restart-bridge] 执行 npm install..."
Set-Location $repoRoot
$installResult = & npm.cmd install 2>&1
$installExit = $LASTEXITCODE
if ($installExit -ne 0) {
  Write-Host "[restart-bridge] npm install 失败（exit=$installExit）:"
  Write-Host ($installResult -join "`n")
  # Still try to start — ensureClaudeToImBuild may recover
}

# ── 3. Start new bridge process ──
Write-Host "[restart-bridge] 启动新 bridge 进程..."

$env:BRIDGE_CONTROL_DIR = $ControlDir

$logOut = Join-Path $ControlDir "stdout.log"
$logErr = Join-Path $ControlDir "stderr.log"

Start-Process `
  -FilePath "cmd.exe" `
  -ArgumentList "/d /c npx tsx scripts/feishu-claude-bridge.ts $EnvFile" `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logOut `
  -RedirectStandardError $logErr | Out-Null

# ── 4. Wait for new process to write PID (max 30s) ──
Write-Host "[restart-bridge] 等待新进程启动..."
$started = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  $newPid = Get-BridgePid
  if ($newPid) {
    $proc = Get-BridgeProcess $newPid
    if ($proc) {
      Write-Host "[restart-bridge] 新进程已启动：pid=$newPid"
      $started = $true
      break
    }
  }
}

if (-not $started) {
  Write-Host "[restart-bridge] 警告：未检测到新进程 PID，请检查日志："
  Write-Host "  stdout: $logOut"
  Write-Host "  stderr: $logErr"
}

Write-Host "[restart-bridge] 完成。"
