# Create least-privilege gatc role/database and write DATABASE_URL into project .env.
# Does not print the password. Requires PostgreSQL running with local trust (post-install).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\deployment\Create-GatcDatabase.ps1

$ErrorActionPreference = 'Stop'
$PgsqlHome = 'C:\GATC\tools\pgsql'
$DataDir = 'C:\GATC\pgsql\data'
$EnvFile = 'C:\GATC\gatc-vps\.env'
$psql = Join-Path $PgsqlHome 'bin\psql.exe'
$pgCtl = Join-Path $PgsqlHome 'bin\pg_ctl.exe'

if (-not (Test-Path $psql)) { throw "psql not found at $psql" }
if (-not (Test-Path $EnvFile)) { throw ".env not found at $EnvFile" }

$status = & $pgCtl -D $DataDir status 2>&1
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL is not running. Start-Postgres.ps1 first.' }

# Generate strong password (URL-safe alphanumeric)
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = ([Convert]::ToBase64String($bytes) -replace '[+/=]', 'x').Substring(0, 40)

$escaped = $password.Replace("'", "''")
$sql = @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gatc') THEN
    CREATE ROLE gatc LOGIN PASSWORD '$escaped';
  ELSE
    ALTER ROLE gatc WITH LOGIN PASSWORD '$escaped';
  END IF;
END
`$`$;
SELECT 'role_ok' AS status;
"@

$tmpSql = Join-Path $env:TEMP 'gatc-create-role.sql'
Set-Content -Path $tmpSql -Value $sql -Encoding ascii
try {
  & $psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 -f $tmpSql | Out-Null
} finally {
  Remove-Item -Force $tmpSql -ErrorAction SilentlyContinue
}

$dbExists = & $psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='gatc'"
if (-not $dbExists.Trim()) {
  & $psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE gatc OWNER gatc" | Out-Null
}

& $psql -h 127.0.0.1 -p 5432 -U postgres -d gatc -v ON_ERROR_STOP=1 -c "REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT ALL ON SCHEMA public TO gatc; ALTER SCHEMA public OWNER TO gatc;" | Out-Null

# Harden pg_hba: localhost scram only (no remote)
$hbaPath = Join-Path $DataDir 'pg_hba.conf'
@"
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             all                                     scram-sha-256
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256
host    all             all             0.0.0.0/0               reject
host    all             all             ::/0                    reject
"@ | Set-Content -Path $hbaPath -Encoding ascii
& $pgCtl -D $DataDir reload | Out-Null

# Also set a postgres superuser password so local trust is gone
$pgPassBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($pgPassBytes)
$pgPassword = ([Convert]::ToBase64String($pgPassBytes) -replace '[+/=]', 'x').Substring(0, 40)
$pgEscaped = $pgPassword.Replace("'", "''")
# Still on trust until reload finishes; alter while we can via existing session... reload already applied scram.
# Use connection as gatc for app; store postgres password separately for ops if needed.
# Keep postgres password in a restricted file under C:\GATC\pgsql\ (not in git).
$pgPassFile = 'C:\GATC\pgsql\postgres.pw'
# Re-enable temporary trust to set postgres password, then re-harden.
@"
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
host    all             all             0.0.0.0/0               reject
host    all             all             ::/0                    reject
"@ | Set-Content -Path $hbaPath -Encoding ascii
& $pgCtl -D $DataDir reload | Out-Null
Start-Sleep -Milliseconds 500
& $psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "ALTER ROLE postgres WITH PASSWORD '$pgEscaped';" | Out-Null
Set-Content -Path $pgPassFile -Value $pgPassword -Encoding ascii
icacls $pgPassFile /inheritance:r | Out-Null
icacls $pgPassFile /grant:r "${env:USERNAME}:(R)" | Out-Null

@"
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             all                                     scram-sha-256
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256
host    all             all             0.0.0.0/0               reject
host    all             all             ::/0                    reject
"@ | Set-Content -Path $hbaPath -Encoding ascii
& $pgCtl -D $DataDir reload | Out-Null

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

if ($envText -notmatch '(?m)^JWT_SECRET=') {
  $jwtBytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($jwtBytes)
  $jwt = ([Convert]::ToBase64String($jwtBytes) -replace '[+/=]', 'x').Substring(0, 48)
  $envText += "JWT_SECRET=$jwt`r`n"
}

Set-Content -Path $EnvFile -Value $envText -NoNewline

# Smoke-test login as gatc without printing URL
$env:PGPASSWORD = $password
try {
  $who = & $psql -h 127.0.0.1 -p 5432 -U gatc -d gatc -tAc 'SELECT current_user || ''@'' || current_database()'
  if ($who.Trim() -ne 'gatc@gatc') { throw "Unexpected identity: $who" }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

Write-Host 'OK: role=gatc database=gatc listen=127.0.0.1:5432'
Write-Host 'OK: DATABASE_URL and DATA_ROOT written to .env (password not printed)'
Write-Host 'OK: postgres superuser password stored at C:\GATC\pgsql\postgres.pw (restricted ACL)'
