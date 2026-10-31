<#
.SYNOPSIS
  Restart the GATC backend process on the Windows VPS.

.DESCRIPTION
  Stops any existing node process started for gatc-vps backend, then starts it again
  under the least-privilege service account context (run as gatcdev, not Administrator).
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

function Stop-GatcBackend {
  if (Test-Path $pidFile) {
    $pidValue = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($pidValue) {
      $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
      if ($proc) {
        Stop-Process -Id $pidValue -Force
        Write-Host "Stopped backend PID $pidValue"
      }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
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

Push-Location $DeployRoot
try {
  $proc = Start-Process -FilePath 'node' `
    -ArgumentList 'backend\src\index.js' `
    -WorkingDirectory $DeployRoot `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden `
    -PassThru
  Set-Content -Path $pidFile -Value $proc.Id -NoNewline
  Write-Host "Backend started with PID $($proc.Id)"
  Write-Host "stdout: $outLog"
  Write-Host "stderr: $errLog"
}
finally {
  Pop-Location
}
