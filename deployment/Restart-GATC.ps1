<#
.SYNOPSIS
  Restart the GATC backend process on the Windows VPS.

.DESCRIPTION
  Stops any existing node process started for gatc-vps backend, then starts it again
  under the least-privilege service account context (run as gatcdev, not Administrator).

  Prefers a one-shot scheduled task so the process survives Windows OpenSSH session teardown.
  Interactive-only schtasks often ignore /Run from SSH (result 0x41303); in that case we
  detach via Start-Process -WindowStyle Hidden (survives SSH when WorkingDirectory is set).
#>
[CmdletBinding()]
param(
  [string]$DeployRoot = 'C:\GATC\gatc-vps',
  [switch]$StopOnly
)

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $DeployRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir 'backend.out.log'
$errLog = Join-Path $logDir 'backend.err.log'
$pidFile = Join-Path $DeployRoot 'backend.pid'
$taskName = 'GATC-Backend'
$wrapperCmd = Join-Path $logDir 'run-backend.cmd'

# Prefer portable Node under C:\GATC\tools so SSH/session PATH is not required.
$nodeCandidates = @(
  'C:\GATC\tools\node\node.exe',
  (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\node\node.exe'),
  'node'
)
$nodeExe = $null
foreach ($candidate in $nodeCandidates) {
  if ($candidate -eq 'node') {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $nodeExe = $cmd.Source; break }
  } elseif (Test-Path $candidate) {
    $nodeExe = $candidate
    break
  }
}
if (-not $nodeExe) {
  throw 'node.exe not found. Install portable Node at C:\GATC\tools\node\node.exe'
}

function Get-ListeningPidOnPort {
  param([int]$Port = 3000)
  $lines = netstat -ano | Select-String -Pattern ":$Port\s+.*LISTENING"
  foreach ($line in $lines) {
    if ($line.Line -match '\s(\d+)\s*$') {
      return [int]$Matches[1]
    }
  }
  return $null
}

function Wait-ForPort {
  param(
    [int]$Port = 3000,
    [int]$Attempts = 40,
    [int]$DelayMs = 500
  )
  for ($i = 0; $i -lt $Attempts; $i++) {
    $pidOnPort = Get-ListeningPidOnPort -Port $Port
    if ($pidOnPort) { return $pidOnPort }
    Start-Sleep -Milliseconds $DelayMs
  }
  return $null
}

function Stop-GatcBackend {
  if (Test-Path $pidFile) {
    $pidValue = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($pidValue) {
      $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
      if ($proc) {
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped backend PID $pidValue"
      }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }

  $listenPid = Get-ListeningPidOnPort -Port 3000
  if ($listenPid) {
    $proc = Get-Process -Id $listenPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match 'node') {
      Stop-Process -Id $listenPid -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped listening node PID $listenPid on :3000"
    }
  }

  cmd /c "schtasks /Delete /TN $taskName /F >nul 2>nul" | Out-Null
}

function Start-ViaSchtasks {
  # Schedule one minute ahead so /ST is valid; /Run is supposed to start immediately,
  # but Interactive-only tasks often ignore /Run from non-interactive SSH sessions.
  $st = (Get-Date).AddMinutes(1).ToString('HH:mm')
  $tr = "cmd /c `"$wrapperCmd`""
  $createOut = cmd /c "schtasks /Create /TN $taskName /TR `"$tr`" /SC ONCE /ST $st /RL LIMITED /F 2>&1"
  $createCode = $LASTEXITCODE
  Write-Host $createOut
  if ($createCode -ne 0) {
    Write-Warning "schtasks create failed with exit $createCode (may need elevation for non-interactive tasks)"
    return $null
  }

  $runOut = cmd /c "schtasks /Run /TN $taskName 2>&1"
  $runCode = $LASTEXITCODE
  Write-Host $runOut
  if ($runCode -ne 0) {
    Write-Warning "schtasks run failed with exit $runCode"
    return $null
  }

  # Short poll: only succeed if /Run actually detached a process immediately.
  return (Wait-ForPort -Port 3000 -Attempts 20 -DelayMs 500)
}

function Start-ViaDetachedProcess {
  # Detach from the SSH job so the backend survives session teardown.
  # Prefer Start-Process Hidden; fall back to Win32_Process.Create if needed.
  Write-Host 'Falling back to detached Start-Process (schtasks did not open :3000; Interactive-only /Run is unreliable over SSH without elevation).'
  try {
    $proc = Start-Process -FilePath 'cmd.exe' `
      -ArgumentList "/c `"$wrapperCmd`"" `
      -WorkingDirectory $DeployRoot `
      -WindowStyle Hidden `
      -PassThru
    if ($proc) {
      Write-Host "Started wrapper PID $($proc.Id) via Start-Process"
    }
  } catch {
    Write-Warning "Start-Process failed: $($_.Exception.Message); trying Win32_Process.Create"
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine      = "cmd /c `"$wrapperCmd`""
      CurrentDirectory = $DeployRoot
    }
    if ($created.ReturnValue -ne 0) {
      throw "Win32_Process.Create failed with ReturnValue $($created.ReturnValue)"
    }
    Write-Host "Started wrapper PID $($created.ProcessId) via Win32_Process.Create"
  }

  return (Wait-ForPort -Port 3000 -Attempts 40 -DelayMs 500)
}

Stop-GatcBackend

if ($StopOnly) {
  Write-Host 'Backend stopped.'
  exit 0
}

$backendEntry = Join-Path $DeployRoot 'backend\src\index.js'
if (-not (Test-Path $backendEntry)) {
  throw "Backend entry not found: $backendEntry"
}

$envFile = Join-Path $DeployRoot '.env'
if (-not (Test-Path $envFile)) {
  Write-Warning 'No .env found. Backend may fail configuration validation.'
}

$wrapperBody = @"
@echo off
cd /d "$DeployRoot"
"$nodeExe" backend\src\index.js >> "$outLog" 2>> "$errLog"
"@
Set-Content -Path $wrapperCmd -Value $wrapperBody -Encoding ascii

$startedPid = Start-ViaSchtasks
$startMethod = 'schtasks'

if (-not $startedPid) {
  $startedPid = Start-ViaDetachedProcess
  $startMethod = 'Start-Process'
}

if (-not $startedPid) {
  Write-Host 'Backend did not open :3000 in time. Recent stderr:'
  if (Test-Path $errLog) { Get-Content $errLog -Tail 40 }
  Write-Host 'Task query:'
  cmd /c "schtasks /Query /TN $taskName /V /FO LIST 2>&1"
  throw 'Backend start failed (port 3000 not listening).'
}

Set-Content -Path $pidFile -Value $startedPid -NoNewline
Write-Host "Backend started with PID $startedPid using $nodeExe via $startMethod"
Write-Host "stdout: $outLog"
Write-Host "stderr: $errLog"
