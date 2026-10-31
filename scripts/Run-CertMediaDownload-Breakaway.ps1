#Requires -Version 5.1
# Durable runner: start ONLY via _launch-cert-dl.ps1 (schtasks). No CIM (hangs). No force-failed finally.
$ErrorActionPreference = 'Stop'
$DeployRoot = 'C:\GATC\gatc-vps'
$Tmp = Join-Path $DeployRoot '.tmp'
$LogPath = Join-Path $Tmp 'cert-media-download.log'
$StatusPath = Join-Path $Tmp 'cert-media-download.status'
$PidPath = Join-Path $Tmp 'cert-media-download.pid'
$NodePidPath = Join-Path $Tmp 'cert-media-download-node.pid'
$ProgressPath = Join-Path $Tmp 'cert-media-download.progress'
$OutFile = Join-Path $Tmp 'cert-media-download-stdout.json'
$ErrFile = Join-Path $Tmp 'cert-media-download-stderr.log'
$NodeCmd = Join-Path $Tmp 'run-cert-media-node.cmd'
$NodeExe = 'C:\GATC\tools\node\node.exe'
if (-not (Test-Path $NodeExe)) { $NodeExe = 'node' }

Set-Location $DeployRoot
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
Set-Content -Path $PidPath -Value $PID -NoNewline -Encoding ascii

function Write-Log([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  [System.IO.File]::AppendAllText($LogPath, $line + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}
function Get-FreeGB {
  try { return [math]::Round([System.IO.DriveInfo]::new('C').AvailableFreeSpace / 1GB, 2) }
  catch {
    try { return [math]::Round((New-Object -ComObject Scripting.FileSystemObject).GetDrive('C').FreeSpace / 1GB, 2) }
    catch { return -1 }
  }
}
function Set-Status([string]$Value) {
  [System.IO.File]::WriteAllText($StatusPath, $Value, [System.Text.Encoding]::ASCII)
}
function Get-ProgressNodePid {
  if (-not (Test-Path $ProgressPath)) { return $null }
  try {
    $raw = [IO.File]::ReadAllText($ProgressPath)
    if ($raw -match '"pid"\s*:\s*(\d+)') { return [int]$Matches[1] }
  } catch {}
  return $null
}

try {
  if (Test-Path $LogPath) { Remove-Item $LogPath -Force -ErrorAction SilentlyContinue }
  Remove-Item $OutFile, $ErrFile, $NodePidPath, $ProgressPath -Force -ErrorAction SilentlyContinue
  [System.IO.File]::WriteAllText($OutFile, '', [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($ErrFile, '', [System.Text.UTF8Encoding]::new($false))
  Set-Status 'running'
  Write-Log 'START cert media download (task-hosted; no CIM; no force-failed)'

  $envText = [System.IO.File]::ReadAllText((Join-Path $DeployRoot '.env'))
  if ($envText -notmatch '(?m)^DATA_ROOT=') { throw 'DATA_ROOT missing in .env' }
  if ($envText -notmatch '(?m)^DATABASE_URL=') { throw 'DATABASE_URL missing in .env' }
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:DATA_ROOT -ErrorAction SilentlyContinue

  $freeGB = Get-FreeGB
  Write-Log ("freeGB=$freeGB")
  if ($freeGB -ge 0 -and $freeGB -lt 1.5) { throw "free disk too low (${freeGB}GB); refusing full download" }
  Write-Log 'env ok; PDFs + doca; node loads .env'

  $scriptPath = Join-Path $DeployRoot 'scripts\download-yesgatc-cert-media.mjs'
  $cmdBody = @(
    '@echo off'
    ('cd /d "{0}"' -f $DeployRoot)
    ('"{0}" "{1}" --include-doca > "{2}" 2> "{3}"' -f $NodeExe, $scriptPath, $OutFile, $ErrFile)
    'exit /b %ERRORLEVEL%'
  ) -join "`r`n"
  [System.IO.File]::WriteAllText($NodeCmd, $cmdBody, [System.Text.Encoding]::ASCII)

  $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') `
    -ArgumentList @('/c', $NodeCmd) `
    -WorkingDirectory $DeployRoot `
    -PassThru -WindowStyle Hidden

  # Record cmd pid immediately (never block on CIM/WMI).
  Set-Content -Path $NodePidPath -Value $p.Id -NoNewline -Encoding ascii
  Write-Log ("cmdPid=$($p.Id) (tracking wrapper; will refine from progress)")

  $mediaRoot = 'C:\GATC\data\media\yesgatc'
  while (-not $p.HasExited) {
    if ($p.WaitForExit(15000)) { break }
    $np = Get-ProgressNodePid
    if ($np -and (Get-Process -Id $np -ErrorAction SilentlyContinue)) {
      Set-Content -Path $NodePidPath -Value $np -NoNewline -Encoding ascii
    }
    $track = if ($np) { $np } else { [int]$p.Id }
    $na = [bool](Get-Process -Id $track -ErrorAction SilentlyContinue)
    $n = @(Get-ChildItem $mediaRoot -File -Recurse -ErrorAction SilentlyContinue).Count
    Write-Log ("heartbeat files=$n trackPid=$track alive=$na")
    Set-Status 'running'
  }
  Write-Log ("wrapper_exit=$($p.ExitCode)")

  if ($p.ExitCode -ne 0) {
    $errTail = ''
    if (Test-Path $ErrFile) {
      $errTail = ([System.IO.File]::ReadAllText($ErrFile, [System.Text.UTF8Encoding]::new($false)) -replace '\s+', ' ').Trim()
      if ($errTail.Length -gt 300) { $errTail = $errTail.Substring(0, 300) }
    }
    throw "download failed exit=$($p.ExitCode) stderr=$errTail"
  }

  if (Test-Path $OutFile) {
    $raw = [System.IO.File]::ReadAllText($OutFile, [System.Text.UTF8Encoding]::new($false))
    $trim = ($raw -replace '\s+', ' ').Trim()
    if ($trim.Length -gt 0) { Write-Log ('result=' + $trim.Substring(0, [Math]::Min(500, $trim.Length))) }
  }
  Set-Status 'completed'
  Write-Log 'DONE ok=true'
  exit 0
}
catch {
  Write-Log ("FAIL ok=false error=$($_.Exception.Message)")
  Set-Status 'failed'
  exit 1
}
