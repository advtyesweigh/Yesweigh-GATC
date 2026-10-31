#Requires -Version 5.1
$ErrorActionPreference = 'Continue'
$Tmp = 'C:\GATC\gatc-vps\.tmp'
Write-Output '===FILES==='
@(
  'firebase-certs-import.log',
  'firebase-certs-import.status',
  'firebase-certs-import.pid',
  'firebase-certs-import.lock',
  'firebase-cert-import.log',
  'firebase-cert-import.status',
  'firebase-cert-import.pid',
  'firebase-cert-import.lock',
  'yesgatc-certs-export.json'
) | ForEach-Object {
  $p = Join-Path $Tmp $_
  if (Test-Path $p) {
    $i = Get-Item $p
    Write-Output ("present=" + $_ + " bytes=" + $i.Length + " mtime=" + $i.LastWriteTime.ToString('s'))
  } else {
    Write-Output ("missing=" + $_)
  }
}
Write-Output '===STATUS_CONTENTS==='
foreach ($name in @('firebase-certs-import.status','firebase-cert-import.status')) {
  $p = Join-Path $Tmp $name
  if (Test-Path $p) { Write-Output ($name + '=' + (Get-Content -Raw $p).Trim()) }
}
Write-Output '===PROCS==='
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and (
      $_.CommandLine -match 'CertImport|CertsImport|export-yesgatc-certs|import-yesgatc-certs|firebase-cert'
    )
  } |
  ForEach-Object {
    $c = $_.CommandLine
    if ($c.Length -gt 160) { $c = $c.Substring(0, 160) }
    Write-Output ('PROC id=' + $_.ProcessId + ' name=' + $_.Name + ' cmd=' + $c)
  }
Write-Output '===LOG_TAILS==='
foreach ($name in @('firebase-certs-import.log','firebase-cert-import.log')) {
  $p = Join-Path $Tmp $name
  if (Test-Path $p) {
    Write-Output ('---' + $name + '---')
    Get-Content $p -Tail 50
  }
}
