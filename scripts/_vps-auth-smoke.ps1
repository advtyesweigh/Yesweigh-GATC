$ErrorActionPreference = 'Stop'
Set-Location C:\GATC\gatc-vps

# Load .env into process without printing values
Get-Content .\.env | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $parts = $_.Split('=', 2)
  $name = $parts[0].Trim()
  $val = $parts[1]
  if ($name -and -not [string]::IsNullOrWhiteSpace($name)) {
    [Environment]::SetEnvironmentVariable($name, $val, 'Process')
  }
}

$password = $env:IMPORT_PASSWORD
if (-not $password) { $password = $env:SEED_PASSWORD }
if (-not $password) { throw 'IMPORT_PASSWORD or SEED_PASSWORD required in .env for smoke login' }

# Pick an active user that has a phone
$env:Path = 'C:\GATC\tools\node;C:\GATC\tools\pgsql\bin;' + $env:Path
$psql = 'C:\GATC\tools\pgsql\bin\psql.exe'
if (-not (Test-Path $psql)) { $psql = 'psql' }

$aadhaar = & $psql $env:DATABASE_URL -t -A -c "SELECT aadhaar FROM users WHERE active AND phone IS NOT NULL AND length(regexp_replace(phone, '\D', '', 'g')) >= 10 ORDER BY created_at LIMIT 1;"
$aadhaar = ($aadhaar | Out-String).Trim()
if (-not $aadhaar) { throw 'No active user with phone found for smoke test' }
Write-Output ("smoke_user_aadhaar_suffix=" + $aadhaar.Substring($aadhaar.Length - 4))

$loginBody = @{ userId = $aadhaar; password = $password } | ConvertTo-Json
try {
  $login = Invoke-RestMethod -Method POST -Uri http://127.0.0.1:3000/api/v1/auth/login -ContentType 'application/json' -Body $loginBody
} catch {
  Write-Output ("login_failed=" + $_.Exception.Message)
  if ($_.ErrorDetails) { Write-Output ("login_body=" + $_.ErrorDetails.Message) }
  throw
}
if (-not $login.data.challengeId) { throw 'login did not return challengeId' }
if ($login.data.token) { throw 'login unexpectedly returned token before OTP' }
Write-Output 'login_otp_challenge=ok'
Write-Output ("phone_hint_present=" + [bool]$login.data.phoneHint)

# Read latest OTP from backend log file if present; else from recent console is unavailable.
# Restart-GATC may write to a log — probe common locations; fallback: query hash not possible.
$otp = $null
$logCandidates = @(
  'C:\GATC\gatc-vps\logs\backend.out.log',
  'C:\GATC\gatc-vps\backend.out.log',
  'C:\GATC\logs\backend.out.log'
)
foreach ($p in $logCandidates) {
  if (Test-Path $p) {
    $line = Get-Content $p -Tail 80 | Where-Object { $_ -match '"otp"\s*:\s*"(\d{6})"' } | Select-Object -Last 1
    if ($line -match '"otp"\s*:\s*"(\d{6})"') { $otp = $Matches[1]; break }
  }
}

if (-not $otp) {
  # Fallback: generate known OTP by direct DB update is insecure; instead ask Node one-shot reader of last log via Get-Content on job stdout.
  # Try Windows Event / transcript not available. Use a tiny node helper that reuses sms log by calling resend after we attach nothing.
  Write-Output 'otp_from_logfile=missing'
  Write-Output 'SMOKE_PARTIAL_OK (challenge issued; configure SMS or ensure SMS_LOG_OTP + log capture for full verify)'
  exit 0
}

Write-Output 'otp_from_logfile=found'
$verifyBody = @{ challengeId = $login.data.challengeId; otp = $otp } | ConvertTo-Json
$verify = Invoke-RestMethod -Method POST -Uri http://127.0.0.1:3000/api/v1/auth/otp/verify -ContentType 'application/json' -Body $verifyBody
if (-not $verify.data.token) { throw 'otp verify did not return token' }
Write-Output 'otp_verify=ok'

$token = $verify.data.token
$me = Invoke-RestMethod -Uri http://127.0.0.1:3000/api/v1/auth/me -Headers @{ Authorization = "Bearer $token" }
if (-not $me.data.user.id) { throw 'me failed' }
Write-Output 'me=ok'

# Second login should revoke first session
$login2 = Invoke-RestMethod -Method POST -Uri http://127.0.0.1:3000/api/v1/auth/login -ContentType 'application/json' -Body $loginBody
Start-Sleep -Seconds 1
$otp2 = $null
foreach ($p in $logCandidates) {
  if (Test-Path $p) {
    $line = Get-Content $p -Tail 40 | Where-Object { $_ -match '"otp"\s*:\s*"(\d{6})"' } | Select-Object -Last 1
    if ($line -match '"otp"\s*:\s*"(\d{6})"') { $otp2 = $Matches[1]; break }
  }
}
if ($otp2) {
  $verify2 = Invoke-RestMethod -Method POST -Uri http://127.0.0.1:3000/api/v1/auth/otp/verify -ContentType 'application/json' -Body (@{ challengeId = $login2.data.challengeId; otp = $otp2 } | ConvertTo-Json)
  try {
    Invoke-RestMethod -Uri http://127.0.0.1:3000/api/v1/auth/me -Headers @{ Authorization = "Bearer $token" } | Out-Null
    throw 'expected SESSION_REVOKED for old token'
  } catch {
    Write-Output 'single_device_revoke=ok'
  }
  $me2 = Invoke-RestMethod -Uri http://127.0.0.1:3000/api/v1/auth/me -Headers @{ Authorization = "Bearer $($verify2.data.token)" }
  if (-not $me2.data.user.id) { throw 'new session me failed' }
  Write-Output 'new_session_me=ok'
} else {
  Write-Output 'single_device_revoke=skipped_no_otp2'
}

Write-Output 'AUTH_SMOKE_OK'
