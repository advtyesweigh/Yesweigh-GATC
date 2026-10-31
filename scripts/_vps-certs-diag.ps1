#Requires -Version 5.1
$ErrorActionPreference = 'Continue'
$Tmp = 'C:\GATC\gatc-vps\.tmp'
Write-Output '---launch---'
if (Test-Path (Join-Path $Tmp 'firebase-certs-import-launch.log')) {
  Get-Content (Join-Path $Tmp 'firebase-certs-import-launch.log')
} else { Write-Output 'launch_log=missing' }
Write-Output '---wrapper---'
if (Test-Path (Join-Path $Tmp 'firebase-certs-import-breakaway.cmd')) {
  Get-Content (Join-Path $Tmp 'firebase-certs-import-breakaway.cmd')
} else { Write-Output 'wrapper=missing' }
Write-Output '---tmp---'
Get-ChildItem $Tmp -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Output ($_.Name + ' bytes=' + $_.Length + ' mtime=' + $_.LastWriteTime.ToString('s'))
}
Write-Output '---procs---'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match 'CertsImport|yesgatc-certs|firebase-certs|migrate\.js') } |
  ForEach-Object {
    $c = $_.CommandLine
    if ($c.Length -gt 160) { $c = $c.Substring(0, 160) }
    Write-Output ('PROC id=' + $_.ProcessId + ' name=' + $_.Name + ' cmd=' + $c)
  }
Write-Output '---pid11944---'
try {
  $p = Get-Process -Id 11944 -ErrorAction Stop
  Write-Output ('pid11944_alive name=' + $p.ProcessName)
} catch {
  Write-Output 'pid11944_gone'
}
Write-Output '---manual-smoke---'
# Run only the start of the runner briefly to see if it can write status (will start full import - DO NOT if already running)
$any = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match 'Run-FirebaseCertsImport|export-yesgatc-certs|import-yesgatc-certs') }
if ($any) {
  Write-Output 'import_already_running=true'
} else {
  Write-Output 'import_already_running=false'
}
