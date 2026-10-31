$ErrorActionPreference = 'Stop'
Set-Location C:\GATC\gatc-vps

$envPath = 'C:\GATC\gatc-vps\.env'
$envText = Get-Content $envPath -Raw
if ($envText -notmatch '(?m)^SMS_PROVIDER=') {
  Add-Content -Path $envPath -Value "`nSMS_PROVIDER=log"
  Write-Output 'added SMS_PROVIDER=log'
} else {
  Write-Output 'SMS_PROVIDER already present'
}
# Re-read after possible append
$envText = Get-Content $envPath -Raw
if ($envText -notmatch '(?m)^SMS_LOG_OTP=') {
  Add-Content -Path $envPath -Value 'SMS_LOG_OTP=1'
  Write-Output 'added SMS_LOG_OTP=1'
} else {
  Write-Output 'SMS_LOG_OTP already present'
}

$env:Path = 'C:\GATC\tools\node;C:\GATC\tools\mingit\cmd;' + $env:Path
Write-Output 'Running db:migrate...'
npm run db:migrate
if ($LASTEXITCODE -ne 0) { throw "db:migrate failed: $LASTEXITCODE" }

Write-Output 'Restarting GATC backend...'
& .\deployment\Restart-GATC.ps1
Start-Sleep -Seconds 4

$health = Invoke-RestMethod http://127.0.0.1:3000/health
Write-Output ("health_status=" + $health.status)
Write-Output ("health_db=" + $health.db)
Write-Output 'AUTH_DEPLOY_OK'
