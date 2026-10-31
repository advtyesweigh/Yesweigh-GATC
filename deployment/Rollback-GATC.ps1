<#
.SYNOPSIS
  Roll back gatc-vps to a previous snapshot created by Deploy-GATC.ps1.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SnapshotPath,

  [string]$DeployRoot = 'C:\GATC\gatc-vps',

  [switch]$ConfirmRollback
)

$ErrorActionPreference = 'Stop'

if (-not $ConfirmRollback) {
  throw 'Refusing to roll back without -ConfirmRollback.'
}

if (-not (Test-Path $SnapshotPath)) {
  throw "Snapshot not found: $SnapshotPath"
}

$envPath = Join-Path $DeployRoot '.env'
$envBackup = $null
if (Test-Path $envPath) {
  $envBackup = Join-Path $env:TEMP ("gatc-env-rollback-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Copy-Item $envPath $envBackup -Force
}

Write-Host "Rolling back from $SnapshotPath"
robocopy $SnapshotPath $DeployRoot /E /XD node_modules logs backups .git /XF .env /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) {
  throw "robocopy failed with exit code $LASTEXITCODE"
}

if ($envBackup) {
  Copy-Item $envBackup $envPath -Force
}

Write-Host 'Rollback file sync complete. Run Restart-GATC.ps1 to apply.'
