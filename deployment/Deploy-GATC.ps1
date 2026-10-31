<#
.SYNOPSIS
  Explicit, approved deployment of gatc-vps to the Windows VPS.

.DESCRIPTION
  Deploys a tested revision into C:\GATC\gatc-vps.
  Does NOT auto-run on every commit. Requires -ConfirmDeploy.
  Keeps production secrets outside Git (.env on the VPS only).

.PARAMETER SourcePath
  Path to the unpacked release (git checkout or artifact extract).

.PARAMETER DeployRoot
  Target directory on the VPS. Default: C:\GATC\gatc-vps

.PARAMETER ConfirmDeploy
  Required switch. Deployment will not proceed without it.

.PARAMETER SkipInstall
  Skip npm install (use when dependencies already present).

.EXAMPLE
  .\Deploy-GATC.ps1 -SourcePath D:\releases\gatc-vps-abc123 -ConfirmDeploy
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SourcePath,

  [string]$DeployRoot = 'C:\GATC\gatc-vps',

  [switch]$ConfirmDeploy,

  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logDir = Join-Path $DeployRoot 'logs'
$backupDir = Join-Path $DeployRoot 'backups'
$logFile = Join-Path $logDir "deploy-$timestamp.log"

function Write-DeployLog {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format 'o'), $Message
  Write-Host $line
  if (Test-Path (Split-Path $logFile)) {
    Add-Content -Path $logFile -Value $line
  }
}

if (-not $ConfirmDeploy) {
  throw 'Refusing to deploy without -ConfirmDeploy. Deployment must be an explicit approved operation.'
}

if (-not (Test-Path $SourcePath)) {
  throw "SourcePath not found: $SourcePath"
}

New-Item -ItemType Directory -Force -Path $DeployRoot, $logDir, $backupDir | Out-Null
Write-DeployLog "Starting deployment from $SourcePath to $DeployRoot"

# Preserve production env file if present
$envPath = Join-Path $DeployRoot '.env'
$envBackup = $null
if (Test-Path $envPath) {
  $envBackup = Join-Path $env:TEMP "gatc-env-$timestamp"
  Copy-Item $envPath $envBackup -Force
  Write-DeployLog 'Preserved existing .env'
}

# Snapshot previous release for rollback
$currentMarker = Join-Path $DeployRoot 'CURRENT_VERSION.txt'
if (Test-Path $currentMarker) {
  $prev = Get-Content $currentMarker -Raw
  $snap = Join-Path $backupDir "snapshot-$timestamp"
  New-Item -ItemType Directory -Force -Path $snap | Out-Null
  robocopy $DeployRoot $snap /E /XD node_modules logs backups .git /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
  Write-DeployLog "Created rollback snapshot: $snap (was: $prev)"
}

Write-DeployLog 'Syncing application files'
robocopy $SourcePath $DeployRoot /E /XD node_modules .git logs backups /XF .env /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) {
  throw "robocopy failed with exit code $LASTEXITCODE"
}

if ($envBackup -and (Test-Path $envBackup)) {
  Copy-Item $envBackup $envPath -Force
  Write-DeployLog 'Restored .env'
} elseif (-not (Test-Path $envPath)) {
  Write-DeployLog 'WARNING: No .env present. Copy .env.example to .env and configure secrets on the VPS.'
}

Push-Location $DeployRoot
try {
  if (-not $SkipInstall) {
    Write-DeployLog 'Installing npm dependencies'
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) {
      npm install --omit=dev
    }
    if ($LASTEXITCODE -ne 0) {
      throw 'npm install failed'
    }
  }

  Write-DeployLog 'Building workspaces'
  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw 'npm run build failed'
  }

  $version = if (Test-Path (Join-Path $SourcePath '.git')) {
    git -C $SourcePath rev-parse --short HEAD
  } else {
    "manual-$timestamp"
  }
  Set-Content -Path $currentMarker -Value $version -NoNewline
  Write-DeployLog "Deployment recorded as version $version"
}
finally {
  Pop-Location
}

Write-DeployLog 'Deployment complete. Restart the app with Restart-GATC.ps1 if needed.'
Write-DeployLog "Log file: $logFile"
