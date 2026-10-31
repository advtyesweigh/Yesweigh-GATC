<#
.SYNOPSIS
  Apply master OTP env, upsert ADMIN user, restart backend, smoke login→OTP→/me.
  Secrets via env only: UPSERT_PASSWORD, MASTER_OTP (or ADMIN_MASTER_OTP).
  Does not print password or OTP values.
#>
[CmdletBinding()]
param(
  [string]$DeployRoot = 'C:\GATC\gatc-vps',
  [string]$Aadhaar = '718835126130',
  [string]$Username = 'faisal',
  [string]$Phone = '9000000001'
)

$ErrorActionPreference = 'Stop'
$envFile = Join-Path $DeployRoot '.env'
$nodeExe = 'C:\GATC\tools\node\node.exe'
if (-not (Test-Path $nodeExe)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'node.exe not found' }
  $nodeExe = $cmd.Source
}

$master = $env:MASTER_OTP
if (-not $master) { $master = $env:ADMIN_MASTER_OTP }
if (-not $master) { throw 'MASTER_OTP or ADMIN_MASTER_OTP env is required' }
if (-not $env:UPSERT_PASSWORD) { throw 'UPSERT_PASSWORD env is required' }

function Set-DotEnvValue {
  param([string]$Path, [string]$Key, [string]$Value)
  if (-not (Test-Path $Path)) { throw ".env missing at $Path" }
  $lines = Get-Content -LiteralPath $Path
  $found = $false
  $out = foreach ($line in $lines) {
    if ($line -match ("^\s*" + [regex]::Escape($Key) + "\s*=")) {
      $found = $true
      "{0}={1}" -f $Key, $Value
    } else {
      $line
    }
  }
  if (-not $found) {
    $out = @($out) + ("{0}={1}" -f $Key, $Value)
  }
  Set-Content -LiteralPath $Path -Value $out -Encoding UTF8
}

Write-Output 'env: updating MASTER_OTP and SMS_PROVIDER'
Set-DotEnvValue -Path $envFile -Key 'MASTER_OTP' -Value $master
Set-DotEnvValue -Path $envFile -Key 'SMS_PROVIDER' -Value 'log'
# Keep alias in sync for operators who prefer ADMIN_MASTER_OTP
Set-DotEnvValue -Path $envFile -Key 'ADMIN_MASTER_OTP' -Value $master

Write-Output 'db: upserting ADMIN user'
$env:UPSERT_AADHAAR = $Aadhaar
$env:UPSERT_USERNAME = $Username
$env:UPSERT_PHONE = $Phone
$env:UPSERT_ROLE = 'ADMIN'
Push-Location $DeployRoot
try {
  $upsertOut = & $nodeExe 'scripts\upsert-admin-once.mjs' 2>&1
  $upsertText = ($upsertOut | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "upsert failed (exit $LASTEXITCODE)"
  }
  if ($upsertText -notmatch '"ok":\s*true') {
    throw "upsert did not report ok"
  }
  Write-Output 'db: upsert ok'
} finally {
  Pop-Location
}

Write-Output 'svc: restarting backend'
& (Join-Path $DeployRoot 'deployment\Restart-GATC.ps1') -DeployRoot $DeployRoot

Start-Sleep -Seconds 3

Write-Output 'smoke: health'
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/health' -Method Get
if ($health.status -ne 'ok' -and $health.status -ne 'degraded') {
  throw "health unexpected: $($health.status)"
}
Write-Output ("smoke: health={0} db={1}" -f $health.status, $health.db)

Write-Output 'smoke: login'
$loginBody = @{ aadhaar = $Aadhaar; password = $env:UPSERT_PASSWORD } | ConvertTo-Json -Compress
$login = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/v1/auth/login' -Method Post -ContentType 'application/json' -Body $loginBody
if (-not $login.data.otpRequired -or -not $login.data.challengeId) {
  throw 'login did not return otpRequired/challengeId'
}
Write-Output 'smoke: login ok (otpRequired)'

Write-Output 'smoke: otp verify'
$otpBody = @{ challengeId = $login.data.challengeId; otp = $master } | ConvertTo-Json -Compress
$verify = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/v1/auth/otp/verify' -Method Post -ContentType 'application/json' -Body $otpBody
if (-not $verify.data.token) { throw 'otp verify missing token' }
if ($verify.data.user.role -ne 'ADMIN') { throw "unexpected role $($verify.data.user.role)" }
Write-Output ("smoke: otp ok user={0} role={1}" -f $verify.data.user.username, $verify.data.user.role)

Write-Output 'smoke: /me'
$headers = @{ Authorization = ("Bearer {0}" -f $verify.data.token) }
$me = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/v1/auth/me' -Method Get -Headers $headers
if ($me.data.user.aadhaar -ne $Aadhaar) { throw 'me aadhaar mismatch' }
Write-Output 'smoke: /me ok'

# UI marker check (no secrets)
$ui = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -UseBasicParsing
if ($ui.Content -notmatch 'Continue with WhatsApp OTP') {
  throw 'UI missing Continue with WhatsApp OTP'
}
if ($ui.Content -match '546054') {
  throw 'UI must not contain master OTP'
}
Write-Output 'smoke: UI ok'
Write-Output 'ALL_OK'
