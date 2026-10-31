# Create least-privilege gatc role/database and write DATABASE_URL into project .env.
# Does not print the password. Safe to re-run when HBA is already scram (uses postgres.pw).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\deployment\Create-GatcDatabase.ps1

$ErrorActionPreference = 'Stop'
$PgsqlHome = 'C:\GATC\tools\pgsql'
$DataDir = 'C:\GATC\pgsql\data'
$EnvFile = 'C:\GATC\gatc-vps\.env'
$psql = Join-Path $PgsqlHome 'bin\psql.exe'
$pgCtl = Join-Path $PgsqlHome 'bin\pg_ctl.exe'
$pgPassFile = 'C:\GATC\pgsql\postgres.pw'
$hbaPath = Join-Path $DataDir 'pg_hba.conf'
# Prevent indefinite hang when the server accepts TCP but never completes auth/query.
$env:PGCONNECT_TIMEOUT = '10'

if (-not (Test-Path $psql)) { throw "psql not found at $psql" }
if (-not (Test-Path $EnvFile)) { throw ".env not found at $EnvFile" }

function Test-Local5432 {
  $lines = netstat -ano | Select-String -Pattern ':5432\s+.*LISTENING'
  return [bool]$lines
}

# Invoke psql without letting stderr abort under $ErrorActionPreference=Stop.
function Invoke-PsqlQuiet {
  param([Parameter(Mandatory = $true)][string[]]$SqlArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $psql @SqlArgs 2>&1
    $code = $LASTEXITCODE
    $text = if ($null -eq $out) { '' } else { ($out | ForEach-Object { "$_" }) -join "`n" }
    return [pscustomobject]@{ ExitCode = $code; Text = $text }
  } finally {
    $ErrorActionPreference = $prev
  }
}

function New-UrlSafeSecret {
  param([int]$Length = 40)
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  # Pad before Substring — raw base64(32) is only ~44 chars; bare .Substring(0,48) throws.
  $raw = ([Convert]::ToBase64String($bytes) -replace '[+/=]', 'x') + 'XxYyZz0123456789ABCDEF'
  if ($raw.Length -lt $Length) { throw "Secret entropy too short ($($raw.Length) < $Length)" }
  return $raw.Substring(0, $Length)
}

function Write-HbaFile {
  param([Parameter(Mandatory = $true)][string]$Content)
  # Postgres may briefly lock pg_hba.conf around reload; retry write.
  $normalized = ($Content -replace "`r`n", "`n" -replace "`n", "`r`n").TrimEnd() + "`r`n"
  $lastErr = $null
  for ($i = 1; $i -le 25; $i++) {
    try {
      $fs = [System.IO.File]::Open($hbaPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
      try {
        $bytes = [System.Text.Encoding]::ASCII.GetBytes($normalized)
        $fs.Write($bytes, 0, $bytes.Length)
        $fs.Flush($true)
      } finally {
        $fs.Dispose()
      }
      return
    } catch {
      $lastErr = $_
      Start-Sleep -Milliseconds (150 * [Math]::Min($i, 10))
    }
  }
  throw "Could not write pg_hba.conf (locked): $lastErr"
}

function Write-TrustHba {
  Write-HbaFile -Content @"
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
host    all             all             0.0.0.0/0               reject
host    all             all             ::/0                    reject
"@
}

function Write-ScramHba {
  Write-HbaFile -Content @"
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             all                                     scram-sha-256
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256
host    all             all             0.0.0.0/0               reject
host    all             all             ::/0                    reject
"@
}

function Invoke-PgReload {
  $r = Invoke-PsqlQuiet -SqlArgs @('-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT pg_reload_conf()')
  if ($r.ExitCode -ne 0 -and (Test-Path $pgCtl)) {
    & $pgCtl -D $DataDir reload | Out-Null
  }
  Start-Sleep -Milliseconds 500
}

if (-not (Test-Local5432)) {
  throw 'PostgreSQL is not listening on 127.0.0.1:5432. Run Start-Postgres.ps1 first.'
}

# Re-runs: HBA is usually scram already — load stored superuser password (never print it).
if (Test-Path $pgPassFile) {
  $env:PGPASSWORD = [System.IO.File]::ReadAllText($pgPassFile).Trim()
}

# Wait until accept connections (avoid "database system is starting up")
$env:PGCONNECT_TIMEOUT = '3'
$ready = $false
$lastPing = ''
for ($i = 0; $i -lt 20; $i++) {
  $ping = Invoke-PsqlQuiet -SqlArgs @('-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-w', '-tAc', 'SELECT 1')
  $lastPing = $ping.Text
  if ($ping.ExitCode -eq 0 -and ($ping.Text).Trim() -eq '1') { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) {
  # Last resort: temporarily restore local trust when password auth is required but pw file missing/wrong.
  Write-TrustHba
  if (Test-Path $pgCtl) { & $pgCtl -D $DataDir reload | Out-Null }
  Start-Sleep -Seconds 1
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 10; $i++) {
    $ping = Invoke-PsqlQuiet -SqlArgs @('-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-w', '-tAc', 'SELECT 1')
    $lastPing = $ping.Text
    if ($ping.ExitCode -eq 0 -and ($ping.Text).Trim() -eq '1') { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
}
if (-not $ready) {
  throw "PostgreSQL did not become ready for postgres@127.0.0.1. Last: $lastPing"
}

# Generate strong password (URL-safe alphanumeric)
$password = New-UrlSafeSecret -Length 40
$escaped = $password.Replace("'", "''")

# Use -c (not PowerShell stdin pipes — those hang with native psql on Windows).
$roleSql = "DO `$`$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gatc') THEN CREATE ROLE gatc LOGIN PASSWORD '$escaped'; ELSE ALTER ROLE gatc WITH LOGIN PASSWORD '$escaped'; END IF; END `$`$;"
$roleResult = Invoke-PsqlQuiet -SqlArgs @('-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', $roleSql)
if ($roleResult.ExitCode -ne 0) { throw "CREATE/ALTER ROLE gatc failed: $($roleResult.Text)" }

# No-row SELECT can yield empty text; treat blank as "create db".
$dbExists = Invoke-PsqlQuiet -SqlArgs @('-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname='gatc'")
if ($dbExists.ExitCode -ne 0) { throw "psql db-exists check failed: $($dbExists.Text)" }
if ([string]::IsNullOrWhiteSpace(($dbExists.Text).Trim())) {
  $createDb = Invoke-PsqlQuiet -SqlArgs @('-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE gatc OWNER gatc')
  if ($createDb.ExitCode -ne 0) { throw "CREATE DATABASE gatc failed: $($createDb.Text)" }
}

$grant = Invoke-PsqlQuiet -SqlArgs @('-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'gatc', '-v', 'ON_ERROR_STOP=1', '-c', 'REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT ALL ON SCHEMA public TO gatc; ALTER SCHEMA public OWNER TO gatc;')
if ($grant.ExitCode -ne 0) { throw "GRANT on public schema failed: $($grant.Text)" }

# Wire .env ASAP (before HBA harden) so a locked pg_hba.conf cannot leave DATABASE_URL unset.
$encPassword = [Uri]::EscapeDataString($password)
$databaseUrl = "postgresql://gatc:${encPassword}@127.0.0.1:5432/gatc"

$envText = Get-Content -Raw $EnvFile
if ($envText -match '(?m)^DATABASE_URL=') {
  $envText = [regex]::Replace($envText, '(?m)^DATABASE_URL=.*$', "DATABASE_URL=$databaseUrl")
} else {
  if (-not $envText.EndsWith("`n")) { $envText += "`r`n" }
  $envText += "`r`n# Database (local portable PostgreSQL)`r`nDATABASE_URL=$databaseUrl`r`n"
}

if ($envText -match '(?m)^DATA_ROOT=') {
  $envText = [regex]::Replace($envText, '(?m)^DATA_ROOT=.*$', 'DATA_ROOT=C:\GATC\data')
} else {
  $envText += "DATA_ROOT=C:\GATC\data`r`n"
}

# Add JWT_SECRET when missing or empty (pad before Substring — bare base64(32) is ~44 chars).
if ($envText -notmatch '(?m)^JWT_SECRET=.+') {
  $jwt = New-UrlSafeSecret -Length 48
  if ($envText -match '(?m)^JWT_SECRET=') {
    $envText = [regex]::Replace($envText, '(?m)^JWT_SECRET=.*$', "JWT_SECRET=$jwt")
  } else {
    $envText += "JWT_SECRET=$jwt`r`n"
  }
}

Set-Content -Path $EnvFile -Value $envText -NoNewline

# Smoke-test login as gatc without printing URL (works under current HBA: trust or scram).
$savedPgPass = $env:PGPASSWORD
$env:PGPASSWORD = $password
try {
  $who = Invoke-PsqlQuiet -SqlArgs @('-h', '127.0.0.1', '-p', '5432', '-U', 'gatc', '-d', 'gatc', '-tAc', "SELECT current_user || '@' || current_database()")
  if ($who.ExitCode -ne 0 -or ($who.Text).Trim() -ne 'gatc@gatc') { throw "Unexpected identity: $($who.Text)" }
} finally {
  if ($null -ne $savedPgPass -and $savedPgPass -ne '') {
    $env:PGPASSWORD = $savedPgPass
  } else {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  }
}

# Rotate postgres superuser password and harden HBA to scram (localhost only).
$pgPassword = New-UrlSafeSecret -Length 40
$pgEscaped = $pgPassword.Replace("'", "''")

# Prefer password-auth path when postgres.pw already works (avoids rewriting HBA to trust).
$canAuthWithPass = $false
if (Test-Path $pgPassFile) {
  $env:PGPASSWORD = [System.IO.File]::ReadAllText($pgPassFile).Trim()
  $probe = Invoke-PsqlQuiet -SqlArgs @('-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-w', '-tAc', 'SELECT 1')
  if ($probe.ExitCode -eq 0 -and ($probe.Text).Trim() -eq '1') { $canAuthWithPass = $true }
}

if (-not $canAuthWithPass) {
  Write-TrustHba
  Invoke-PgReload
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

$alterPg = Invoke-PsqlQuiet -SqlArgs @('-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', "ALTER ROLE postgres WITH PASSWORD '$pgEscaped';")
if ($alterPg.ExitCode -ne 0) { throw "ALTER ROLE postgres failed: $($alterPg.Text)" }

if (Test-Path $pgPassFile) {
  icacls $pgPassFile /grant:r "${env:USERNAME}:(F)" | Out-Null
  Remove-Item -Force $pgPassFile -ErrorAction SilentlyContinue
}
Set-Content -Path $pgPassFile -Value $pgPassword -Encoding ascii
icacls $pgPassFile /inheritance:r | Out-Null
icacls $pgPassFile /grant:r "${env:USERNAME}:(R,W)" | Out-Null

$env:PGPASSWORD = $pgPassword
Write-ScramHba
Invoke-PgReload
Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue

$hasJwt = [bool]($envText -match '(?m)^JWT_SECRET=.+')
Write-Host 'OK: role=gatc database=gatc listen=127.0.0.1:5432'
Write-Host 'OK: DATABASE_URL and DATA_ROOT written to .env (password not printed)'
Write-Host ("OK: JWT_SECRET present={0}" -f $hasJwt)
Write-Host 'OK: postgres superuser password stored at C:\GATC\pgsql\postgres.pw (restricted ACL)'
