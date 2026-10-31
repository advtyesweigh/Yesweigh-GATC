# OPTIONAL Admin/RDP fallback: silent EDB PostgreSQL 16 Windows installer.
# gatcdev cannot run this. Pause and run elevated as Administrator only if portable install fails.
#
# In an elevated PowerShell (Administrator RDP):
#   cd C:\GATC\gatc-vps
#   .\deployment\Install-Postgres-AdminSilent.ps1
#
# After install, still create gatc/gatc and keep listen_addresses = 'localhost'.

$ErrorActionPreference = 'Stop'
Write-Host 'This script requires Administrator elevation.'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
  IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw 'Not elevated. Open Administrator PowerShell via RDP, then re-run.'
}

$Installer = 'C:\GATC\tools\postgresql-16-windows-x64.exe'
$Url = 'https://get.enterprisedb.com/postgresql/postgresql-16.15-1-windows-x64.exe'

if (-not (Test-Path $Installer)) {
  Write-Host "Download the official EDB installer to $Installer first:"
  Write-Host $Url
  throw "Missing installer: $Installer"
}

# Superuser password must be supplied by the operator (do not hardcode).
if (-not $env:PG_SUPERUSER_PASSWORD) {
  throw 'Set env PG_SUPERUSER_PASSWORD before running (will not be echoed here).'
}

Write-Host 'Starting silent PostgreSQL install (localhost service)...'
$args = @(
  '--mode', 'unattended',
  '--unattendedmodeui', 'none',
  '--superpassword', $env:PG_SUPERUSER_PASSWORD,
  '--serverport', '5432',
  '--prefix', 'C:\Program Files\PostgreSQL\16',
  '--datadir', 'C:\Program Files\PostgreSQL\16\data',
  '--serviceaccount', 'NT AUTHORITY\NetworkService'
)
$proc = Start-Process -FilePath $Installer -ArgumentList $args -Wait -PassThru
if ($proc.ExitCode -ne 0) {
  throw "Installer failed with exit code $($proc.ExitCode)"
}

Write-Host 'OK: service install finished. Set listen_addresses=localhost and shared_buffers=128MB in postgresql.conf, then create role/db gatc.'
