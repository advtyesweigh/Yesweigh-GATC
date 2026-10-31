#Requires -Version 5.1
$ErrorActionPreference = 'Continue'
$Tmp = 'C:\GATC\gatc-vps\.tmp'
Write-Output ('export_script=' + (Test-Path 'C:\GATC\gatc-vps\scripts\export-yesgatc-certs.mjs'))
Write-Output ('import_script=' + (Test-Path 'C:\GATC\gatc-vps\scripts\import-yesgatc-certs.mjs'))
Write-Output ('runner=' + (Test-Path 'C:\GATC\gatc-vps\scripts\Run-FirebaseCertsImport-Breakaway.ps1'))
Write-Output ('launcher=' + (Test-Path 'C:\GATC\gatc-vps\scripts\Launch-FirebaseCertsImport-Breakaway.ps1'))
Write-Output ('migration=' + (Test-Path 'C:\GATC\gatc-vps\backend\migrations\002_firebase_cert_import.sql'))
Write-Output ('secrets_gatcdev=' + (Test-Path 'C:\GATC\secrets\yesgatc-superadmin.gatcdev.json'))
Write-Output ('secrets_json=' + (Test-Path 'C:\GATC\secrets\yesgatc-superadmin.json'))
Write-Output ('log_present=' + (Test-Path (Join-Path $Tmp 'firebase-certs-import.log')))
Write-Output ('status_present=' + (Test-Path (Join-Path $Tmp 'firebase-certs-import.status')))
Write-Output ('pid_present=' + (Test-Path (Join-Path $Tmp 'firebase-certs-import.pid')))
Write-Output ('lock_present=' + (Test-Path (Join-Path $Tmp 'firebase-certs-import.lock')))
if (Test-Path (Join-Path $Tmp 'firebase-certs-import.status')) {
  Write-Output ('status=' + (Get-Content -Raw (Join-Path $Tmp 'firebase-certs-import.status')).Trim())
}
if (Test-Path (Join-Path $Tmp 'firebase-certs-import.pid')) {
  $fp = (Get-Content -Raw (Join-Path $Tmp 'firebase-certs-import.pid')).Trim()
  Write-Output ('file_pid=' + $fp)
  $alive = $false
  try { $alive = [bool](Get-Process -Id ([int]$fp) -ErrorAction Stop) } catch { $alive = $false }
  Write-Output ('file_pid_alive=' + $alive)
}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match 'Run-FirebaseCertsImport|export-yesgatc-certs|import-yesgatc-certs|firebase-certs-import-breakaway') } |
  ForEach-Object {
    $c = $_.CommandLine
    if ($c.Length -gt 140) { $c = $c.Substring(0, 140) }
    Write-Output ('PROC id=' + $_.ProcessId + ' name=' + $_.Name + ' cmd=' + $c)
  }
if (Test-Path (Join-Path $Tmp 'firebase-certs-import.log')) {
  Write-Output '---LOG_TAIL---'
  Get-Content (Join-Path $Tmp 'firebase-certs-import.log') -Tail 40
}
