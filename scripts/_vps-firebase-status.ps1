#Requires -Version 5.1
$ErrorActionPreference = 'Continue'
$Tmp = 'C:\GATC\gatc-vps\.tmp'
Write-Output ('export_script=' + (Test-Path 'C:\GATC\gatc-vps\scripts\export-yesgatc-users.mjs'))
Write-Output ('import_script=' + (Test-Path 'C:\GATC\gatc-vps\scripts\import-yesgatc-users.mjs'))
Write-Output ('runner=' + (Test-Path 'C:\GATC\gatc-vps\scripts\Run-FirebaseImport-Breakaway.ps1'))
Write-Output ('launcher=' + (Test-Path 'C:\GATC\gatc-vps\scripts\Launch-FirebaseImport-Breakaway.ps1'))
Write-Output ('secrets_present=' + (Test-Path 'C:\GATC\secrets\yesgatc-superadmin.json'))
Write-Output ('env_present=' + (Test-Path 'C:\GATC\gatc-vps\.env'))
Write-Output ('node_present=' + (Test-Path 'C:\GATC\tools\node\node.exe'))
Write-Output ('log_present=' + (Test-Path (Join-Path $Tmp 'firebase-import.log')))
Write-Output ('status_present=' + (Test-Path (Join-Path $Tmp 'firebase-import.status')))
Write-Output ('pid_present=' + (Test-Path (Join-Path $Tmp 'firebase-import.pid')))
if (Test-Path (Join-Path $Tmp 'firebase-import.status')) {
  Write-Output ('status=' + (Get-Content -Raw (Join-Path $Tmp 'firebase-import.status')).Trim())
}
if (Test-Path (Join-Path $Tmp 'firebase-import.pid')) {
  $fp = (Get-Content -Raw (Join-Path $Tmp 'firebase-import.pid')).Trim()
  Write-Output ('file_pid=' + $fp)
  $alive = $false
  try { $alive = [bool](Get-Process -Id ([int]$fp) -ErrorAction Stop) } catch { $alive = $false }
  Write-Output ('file_pid_alive=' + $alive)
}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match 'Run-FirebaseImport|export-yesgatc|import-yesgatc|firebase-import-breakaway') } |
  ForEach-Object {
    $c = $_.CommandLine
    if ($c.Length -gt 140) { $c = $c.Substring(0, 140) }
    Write-Output ('PROC id=' + $_.ProcessId + ' name=' + $_.Name + ' cmd=' + $c)
  }
if (Test-Path (Join-Path $Tmp 'firebase-import.log')) {
  Write-Output '---LOG_TAIL---'
  Get-Content (Join-Path $Tmp 'firebase-import.log') -Tail 30
}
