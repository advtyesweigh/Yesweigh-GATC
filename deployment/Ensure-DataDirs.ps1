# Create GATC data directories per Phase 1 layout (C:\GATC\data\...).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\deployment\Ensure-DataDirs.ps1

$ErrorActionPreference = 'Stop'
$DataRoot = 'C:\GATC\data'
$dirs = @(
  $DataRoot,
  (Join-Path $DataRoot 'media\verifications'),
  (Join-Path $DataRoot 'media\customers'),
  (Join-Path $DataRoot 'media\products'),
  (Join-Path $DataRoot 'certificates'),
  (Join-Path $DataRoot 'backups')
)

foreach ($dir in $dirs) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

Write-Host "OK: data directories ready under $DataRoot"
Get-ChildItem $DataRoot -Recurse -Directory | Select-Object FullName
