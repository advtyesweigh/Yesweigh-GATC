#Requires -Version 5.1
# Launch cert PDF+doca download via schtasks.exe so it survives SSH teardown.
# Avoids Register-ScheduledTask/CIM (Access Denied for gatcdev on this host).
$ErrorActionPreference = 'Stop'
$DeployRoot = 'C:\GATC\gatc-vps'
$tmp = Join-Path $DeployRoot '.tmp'
$log = Join-Path $tmp '_launch-cert-dl.log'
$break = Join-Path $DeployRoot 'scripts\Run-CertMediaDownload-Breakaway.ps1'
$taskName = 'GATC-CertMediaDownload'
$wrapper = Join-Path $tmp 'run-cert-media-download-task.cmd'

function L([string]$m) {
  Add-Content -Path $log -Value (('[{0}] {1}' -f (Get-Date -Format 's'), $m)) -Encoding utf8
}

New-Item -ItemType Directory -Force -Path $tmp | Out-Null
if (Test-Path $log) { Remove-Item $log -Force }
L 'begin'

if (-not (Test-Path $break)) { throw 'missing breakaway script' }
$txt = Get-Content $break -Raw
if ($txt -notmatch '--include-doca') { throw 'breakaway missing --include-doca' }

$statusPath = Join-Path $tmp 'cert-media-download.status'
$pidPath = Join-Path $tmp 'cert-media-download.pid'
$nodePidPath = Join-Path $tmp 'cert-media-download-node.pid'
$cur = ''
if (Test-Path $statusPath) { $cur = (Get-Content $statusPath -Raw).Trim() }
$parentAlive = $false
$nodeAlive = $false
if (Test-Path $pidPath) {
  $pp = 0
  [void][int]::TryParse((Get-Content $pidPath -Raw).Trim(), [ref]$pp)
  if ($pp -gt 0) { $parentAlive = [bool](Get-Process -Id $pp -ErrorAction SilentlyContinue) }
}
if (Test-Path $nodePidPath) {
  $np = 0
  [void][int]::TryParse((Get-Content $nodePidPath -Raw).Trim(), [ref]$np)
  if ($np -gt 0) { $nodeAlive = [bool](Get-Process -Id $np -ErrorAction SilentlyContinue) }
}
# Only refuse when download node is actually alive (parent-only stuck is OK to replace later).
$progressAlive = $false
$progPath = Join-Path $tmp 'cert-media-download.progress'
if (Test-Path $progPath) {
  try {
    $praw = Get-Content $progPath -Raw
    if ($praw -match '"pid"\s*:\s*(\d+)') {
      $progPid = [int]$Matches[1]
      if (Get-Process -Id $progPid -ErrorAction SilentlyContinue) { $progressAlive = $true; $nodeAlive = $true; $np = $progPid }
    }
  } catch {}
}
if ($nodeAlive -or $progressAlive) {
  L ("refuse_restart status=$cur nodeAlive=$nodeAlive progressAlive=$progressAlive")
  Write-Output ("LAUNCH_SKIPPED already_running nodeAlive=True")
  exit 0
}

# cmd wrapper avoids schtasks quoting hell for powershell -File paths.
$cmd = @(
  '@echo off'
  "cd /d `"$DeployRoot`""
  "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$break`""
) -join "`r`n"
[System.IO.File]::WriteAllText($wrapper, $cmd, [System.Text.Encoding]::ASCII)
L ('wrapper=' + $wrapper)

# Delete may fail (access); ignore.
cmd /c "schtasks /Delete /TN `"$taskName`" /F" | Out-Null
# Create ONCE task; /RU with no password runs as current user when interactive/batch allows.
$tr = "`"$wrapper`""
$createOut = cmd /c "schtasks /Create /TN `"$taskName`" /TR $tr /SC ONCE /ST 23:59 /F /RL LIMITED"
L ('schtasks_create=' + (($createOut | Out-String) -replace '\s+', ' ').Trim() + ' exit=' + $LASTEXITCODE)
if ($LASTEXITCODE -ne 0) { throw "schtasks create failed: $createOut" }

$runOut = cmd /c "schtasks /Run /TN `"$taskName`""
L ('schtasks_run=' + (($runOut | Out-String) -replace '\s+', ' ').Trim() + ' exit=' + $LASTEXITCODE)
if ($LASTEXITCODE -ne 0) { throw "schtasks run failed: $runOut" }

Start-Sleep -Seconds 12
$st = ''
if (Test-Path $statusPath) { $st = (Get-Content $statusPath -Raw).Trim() }
L ('status_after12=' + $st)
$parentId = ''
$nodeId = ''
if (Test-Path $pidPath) {
  $parentId = (Get-Content $pidPath -Raw).Trim()
  L ('pidfile=' + $parentId)
}
if (Test-Path $nodePidPath) {
  $nodeId = (Get-Content $nodePidPath -Raw).Trim()
  L ('node_pidfile=' + $nodeId)
}
if (Test-Path (Join-Path $tmp 'cert-media-download.log')) {
  L ('log_tail=' + ((Get-Content (Join-Path $tmp 'cert-media-download.log') -Tail 6) -join ' || '))
}
$pa = $false; $na = $false
if ($parentId -match '^\d+$') { $pa = [bool](Get-Process -Id ([int]$parentId) -ErrorAction SilentlyContinue) }
if ($nodeId -match '^\d+$') { $na = [bool](Get-Process -Id ([int]$nodeId) -ErrorAction SilentlyContinue) }
Write-Output ("LAUNCH_OK parent=$parentId parentAlive=$pa node=$nodeId nodeAlive=$na status=$st via=schtasks")
exit 0
