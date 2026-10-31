#Requires -Version 5.1
$ErrorActionPreference = 'Continue'
$Tmp = 'C:\GATC\gatc-vps\.tmp'
function Say([string]$m) { Write-Output $m }

Say ("STATUS=" + $(if (Test-Path "$Tmp\cert-media-download.status") { [IO.File]::ReadAllText("$Tmp\cert-media-download.status").Trim() } else { 'missing' }))
$pp = if (Test-Path "$Tmp\cert-media-download.pid") { (Get-Content "$Tmp\cert-media-download.pid" -Raw).Trim() } else { '' }
$np = if (Test-Path "$Tmp\cert-media-download-node.pid") { (Get-Content "$Tmp\cert-media-download-node.pid" -Raw).Trim() } else { '' }
Say ("PIDFILE_PARENT=" + $pp)
Say ("PIDFILE_NODE=" + $np)
if ($pp -match '^\d+$') { Say ("PARENT_ALIVE=" + [bool](Get-Process -Id ([int]$pp) -EA SilentlyContinue)) }
if ($np -match '^\d+$') { Say ("NODE_ALIVE=" + [bool](Get-Process -Id ([int]$np) -EA SilentlyContinue)) }

Say '=== powershell ==='
Get-Process powershell -EA SilentlyContinue | ForEach-Object { Say ("ps pid=" + $_.Id + " start=" + $_.StartTime) }
Say '=== node ==='
Get-Process node -EA SilentlyContinue | ForEach-Object { Say ("node pid=" + $_.Id + " start=" + $_.StartTime) }

$count = @(Get-ChildItem 'C:\GATC\data\media\yesgatc' -File -Recurse -EA SilentlyContinue).Count
$sum = [int64]((Get-ChildItem 'C:\GATC\data\media\yesgatc' -File -Recurse -EA SilentlyContinue | Measure-Object Length -Sum).Sum)
Say ("COUNT=" + $count)
Say ("SUM=" + $sum)

Say '=== schtasks ==='
cmd /c "schtasks /Query /TN GATC-CertMediaDownload /V /FO LIST" | Select-Object -First 40 | ForEach-Object { Say $_ }

Say '=== log tail ==='
if (Test-Path "$Tmp\cert-media-download.log") { Get-Content "$Tmp\cert-media-download.log" -Tail 15 | ForEach-Object { Say $_ } }

Say '=== cmd wrapper ==='
if (Test-Path "$Tmp\start-cert-media-download.cmd") { Get-Content "$Tmp\start-cert-media-download.cmd" | ForEach-Object { Say $_ } }
