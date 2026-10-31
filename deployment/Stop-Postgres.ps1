# Stop portable PostgreSQL.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\deployment\Stop-Postgres.ps1

$ErrorActionPreference = 'Stop'
$PgsqlHome = 'C:\GATC\tools\pgsql'
$DataDir = 'C:\GATC\pgsql\data'
$pgCtl = Join-Path $PgsqlHome 'bin\pg_ctl.exe'

if (-not (Test-Path $pgCtl)) {
  Write-Host 'PostgreSQL binaries not installed; nothing to stop.'
  exit 0
}

$status = & $pgCtl -D $DataDir status 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host 'PostgreSQL is not running.'
  exit 0
}

Write-Host 'Stopping PostgreSQL...'
& $pgCtl -D $DataDir stop -m fast
Write-Host 'PostgreSQL stopped.'
