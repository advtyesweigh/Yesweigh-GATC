# Start portable PostgreSQL (user-mode, no Windows service).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\deployment\Start-Postgres.ps1

$ErrorActionPreference = 'Stop'
$PgsqlHome = 'C:\GATC\tools\pgsql'
$DataDir = 'C:\GATC\pgsql\data'
$LogFile = 'C:\GATC\pgsql\log\postgres-start.log'
$bin = Join-Path $PgsqlHome 'bin'
$pgCtl = Join-Path $bin 'pg_ctl.exe'

if (-not (Test-Path $pgCtl)) {
  throw "PostgreSQL not found at $PgsqlHome. Run Install-PortablePostgres.ps1 first."
}

New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null

$status = & $pgCtl -D $DataDir status 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Host 'PostgreSQL already running.'
  exit 0
}

Write-Host 'Starting PostgreSQL...'
& $pgCtl -D $DataDir -l $LogFile -o "-p 5432" start
if ($LASTEXITCODE -ne 0) {
  throw "pg_ctl start failed (exit $LASTEXITCODE). See $LogFile"
}

Start-Sleep -Seconds 1
& $pgCtl -D $DataDir status
Write-Host 'PostgreSQL started on 127.0.0.1:5432'
