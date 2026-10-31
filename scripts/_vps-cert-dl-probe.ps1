#Requires -Version 5.1
# Short status probe — no Get-PSDrive, no secrets
$ErrorActionPreference = 'Continue'
$tmp = 'C:\GATC\gatc-vps\.tmp'
$media = 'C:\GATC\data\media\yesgatc'
$st = ''
if (Test-Path "$tmp\cert-media-download.status") { $st = ([IO.File]::ReadAllText("$tmp\cert-media-download.status")).Trim() }
$files = @(Get-ChildItem $media -File -Recurse -ErrorAction SilentlyContinue)
$sum = [int64]0
foreach ($f in $files) { $sum += $f.Length }
$np = ''
if (Test-Path "$tmp\cert-media-download-node.pid") { $np = ([IO.File]::ReadAllText("$tmp\cert-media-download-node.pid")).Trim() }
$pp = ''
if (Test-Path "$tmp\cert-media-download.pid") { $pp = ([IO.File]::ReadAllText("$tmp\cert-media-download.pid")).Trim() }
$na = $false
$pa = $false
if ($np -match '^\d+$') { $na = [bool](Get-Process -Id ([int]$np) -ErrorAction SilentlyContinue) }
if ($pp -match '^\d+$') { $pa = [bool](Get-Process -Id ([int]$pp) -ErrorAction SilentlyContinue) }
if (-not $na) {
  try {
    $hit = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'download-yesgatc-cert-media' })
    if ($hit.Count -gt 0) { $na = $true; $np = [string]$hit[0].ProcessId }
  } catch {}
}
$prog = ''
if (Test-Path "$tmp\cert-media-download.progress") { $prog = ([IO.File]::ReadAllText("$tmp\cert-media-download.progress")).Trim() }
$launch = ''
if (Test-Path "$tmp\cert-media-download-launch.log") { $launch = ([IO.File]::ReadAllText("$tmp\cert-media-download-launch.log")).Trim() }
$free = -1
try { $free = [math]::Round([IO.DriveInfo]::new('C').AvailableFreeSpace / 1GB, 2) } catch {}
Write-Output ("STATUS=$st")
Write-Output ("FILES=$($files.Count)")
Write-Output ("BYTES=$sum")
Write-Output ("NODE_ALIVE=$na pid=$np")
Write-Output ("PARENT_ALIVE=$pa pid=$pp")
Write-Output ("FREE_GB=$free")
Write-Output ("PROGRESS=$prog")
Write-Output ("LAUNCH=$launch")
if (Test-Path "$tmp\cert-media-download.log") {
  Get-Content "$tmp\cert-media-download.log" -Tail 6 | ForEach-Object { Write-Output ("LOG:$_") }
}
if (Test-Path "$tmp\cert-media-download-stderr.log") {
  $err = Get-Content "$tmp\cert-media-download-stderr.log" -Tail 8 -ErrorAction SilentlyContinue
  foreach ($e in @($err)) { Write-Output ("ERR:$e") }
}
