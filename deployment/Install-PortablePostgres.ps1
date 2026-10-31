# Install portable PostgreSQL 16 binaries under C:\GATC\tools\pgsql (no admin).
# Listens on 127.0.0.1 only; modest shared_buffers for 4 GB VPS.
# Usage (as gatcdev): powershell -NoProfile -ExecutionPolicy Bypass -File .\deployment\Install-PortablePostgres.ps1

$ErrorActionPreference = 'Stop'

$ToolsRoot = 'C:\GATC\tools'
$PgsqlHome = Join-Path $ToolsRoot 'pgsql'
$DataDir = 'C:\GATC\pgsql\data'
$LogDir = 'C:\GATC\pgsql\log'
$ZipPath = Join-Path $ToolsRoot 'postgresql-16.15-5-windows-x64-binaries.zip'
$Url = 'https://get.enterprisedb.com/postgresql/postgresql-16.15-5-windows-x64-binaries.zip'
$ExpectedSha = '43bb45f173a6f08cf1d29a97a6d8deb119e8e8093a24c00d2d1001a0ccaa8281'
$ListenAddress = '127.0.0.1'
$Port = 5432

function Write-Step([string]$Message) {
  Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message)
}

function Get-FreeGb {
  $drive = (New-Object -ComObject Scripting.FileSystemObject).GetDrive('C:')
  return [math]::Round($drive.AvailableSpace / 1GB, 2)
}

Write-Step ("Free disk before: {0} GB" -f (Get-FreeGb))

New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $DataDir) | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Test-Path (Join-Path $PgsqlHome 'bin\postgres.exe'))) {
  if (-not (Test-Path $ZipPath)) {
    Write-Step 'Downloading PostgreSQL 16 Windows x64 binaries...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
  }

  Write-Step 'Verifying SHA-256...'
  $hash = (Get-FileHash -Algorithm SHA256 -Path $ZipPath).Hash.ToLowerInvariant()
  if ($hash -ne $ExpectedSha) {
    throw "Checksum mismatch for $ZipPath. Got $hash expected $ExpectedSha"
  }

  Write-Step 'Extracting...'
  $extractRoot = Join-Path $ToolsRoot 'pgsql-extract'
  if (Test-Path $extractRoot) { Remove-Item -Recurse -Force $extractRoot }
  if (Test-Path $PgsqlHome) { Remove-Item -Recurse -Force $PgsqlHome }
  Expand-Archive -Path $ZipPath -DestinationPath $extractRoot -Force
  if (Test-Path (Join-Path $extractRoot 'pgsql')) {
    Move-Item (Join-Path $extractRoot 'pgsql') $PgsqlHome
    Remove-Item -Recurse -Force $extractRoot
  } else {
    Move-Item $extractRoot $PgsqlHome
  }
  Remove-Item -Force $ZipPath
  Write-Step 'Binaries installed; zip removed to save disk.'
} else {
  Write-Step 'PostgreSQL binaries already present.'
}

$bin = Join-Path $PgsqlHome 'bin'
$env:Path = "$bin;$env:Path"

if (-not (Test-Path (Join-Path $DataDir 'PG_VERSION'))) {
  Write-Step 'Initializing data directory (trust auth for local bootstrap)...'
  & (Join-Path $bin 'initdb.exe') -D $DataDir -U postgres -A trust -E UTF8 --locale=C | Out-Host
}

$confPath = Join-Path $DataDir 'postgresql.conf'
$hbaPath = Join-Path $DataDir 'pg_hba.conf'

Write-Step 'Configuring listen address and memory...'
$conf = Get-Content -Raw $confPath
$conf = [regex]::Replace($conf, "(?m)^\s*#?\s*listen_addresses\s*=.*$", "listen_addresses = '$ListenAddress'")
$conf = [regex]::Replace($conf, "(?m)^\s*#?\s*port\s*=.*$", "port = $Port")
$conf = [regex]::Replace($conf, "(?m)^\s*#?\s*shared_buffers\s*=.*$", 'shared_buffers = 128MB')
$conf = [regex]::Replace($conf, "(?m)^\s*#?\s*max_connections\s*=.*$", 'max_connections = 40')
$conf = [regex]::Replace($conf, "(?m)^\s*#?\s*work_mem\s*=.*$", 'work_mem = 4MB')
$conf = [regex]::Replace($conf, "(?m)^\s*#?\s*maintenance_work_mem\s*=.*$", 'maintenance_work_mem = 64MB')
$conf = [regex]::Replace($conf, "(?m)^\s*#?\s*effective_cache_size\s*=.*$", 'effective_cache_size = 512MB')
$conf = [regex]::Replace($conf, "(?m)^\s*#?\s*logging_collector\s*=.*$", 'logging_collector = on')
$conf = [regex]::Replace($conf, "(?m)^\s*#?\s*log_directory\s*=.*$", "log_directory = '$($LogDir -replace '\\','/')'")
Set-Content -Path $confPath -Value $conf -NoNewline

# Local socket + localhost password auth after role is created (start with trust for setup).
@"
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
host    all             all             0.0.0.0/0               reject
host    all             all             ::/0                    reject
"@ | Set-Content -Path $hbaPath -Encoding ascii

Write-Step ("Free disk after install prep: {0} GB" -f (Get-FreeGb))
Write-Host 'OK: binaries ready. Next: Start-Postgres.ps1 then create role/db.'
Write-Host "PGHOME=$PgsqlHome"
Write-Host "PGDATA=$DataDir"
