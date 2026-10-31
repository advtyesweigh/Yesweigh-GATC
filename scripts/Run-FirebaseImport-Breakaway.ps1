#Requires -Version 5.1
<#
.SYNOPSIS
  VPS-local Firebase users export → Postgres import (no SSH session required after start).

.NOTES
  - Reads C:\GATC\secrets\yesgatc-superadmin.json (never echoes secrets)
  - Logs to C:\GATC\gatc-vps\.tmp\firebase-import.log (no passwords)
  - Launch via Launch-FirebaseImport-Breakaway.ps1 so OpenSSH disconnect does not kill the job
#>
$ErrorActionPreference = 'Stop'
$DeployRoot = 'C:\GATC\gatc-vps'
# Prefer writable deploy-local secret; fall back to C:\GATC\secrets if present/readable
$SecretsCandidates = @(
  (Join-Path $DeployRoot '.tmp\yesgatc-superadmin.json'),
  'C:\GATC\secrets\yesgatc-superadmin.json'
)
$SaCandidates = @(
  'C:\GATC\secrets\yesgatc-firebase-adminsdk.json',
  'C:\GATC\secrets\firebase-adminsdk.json',
  (Join-Path $DeployRoot '.tmp\yesgatc-firebase-adminsdk.json')
)
$OutDump = Join-Path $DeployRoot '.tmp\yesgatc-users-export.json'
$LogPath = Join-Path $DeployRoot '.tmp\firebase-import.log'
$PidPath = Join-Path $DeployRoot '.tmp\firebase-import.pid'
$StatusPath = Join-Path $DeployRoot '.tmp\firebase-import.status'
$NodeExe = 'C:\GATC\tools\node\node.exe'
if (-not (Test-Path $NodeExe)) { $NodeExe = 'node' }

Set-Location $DeployRoot
New-Item -ItemType Directory -Force -Path (Join-Path $DeployRoot '.tmp') | Out-Null
Set-Content -Path $PidPath -Value $PID -NoNewline -Encoding ascii

function Write-Log([string]$Message) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
  Add-Content -Path $LogPath -Value $line -Encoding utf8
}

function Set-Status([string]$State) {
  Set-Content -Path $StatusPath -Value $State -NoNewline -Encoding ascii
}

function Import-DotEnv {
  $envFile = Join-Path $DeployRoot '.env'
  if (-not (Test-Path $envFile)) { throw '.env missing at C:\GATC\gatc-vps\.env' }
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $i = $line.IndexOf('=')
    if ($i -lt 1) { return }
    $k = $line.Substring(0, $i).Trim()
    $v = $line.Substring($i + 1)
    Set-Item -Path "Env:$k" -Value $v
  }
}

function Mask-Aadhaar([string]$Raw) {
  $d = ($Raw -replace '\D', '')
  if ($d.Length -lt 4) { return '****' }
  return ('****' + $d.Substring($d.Length - 4))
}

try {
  Set-Status 'running'
  if (Test-Path $LogPath) { Remove-Item $LogPath -Force -ErrorAction SilentlyContinue }
  Write-Log 'START firebase export+import (VPS breakaway)'
  Write-Log ("pid=$PID node=$NodeExe")

  Import-DotEnv
  if (-not $env:DATABASE_URL) { throw 'DATABASE_URL missing from .env' }
  $pw = $env:IMPORT_PASSWORD
  if (-not $pw) { $pw = $env:SEED_PASSWORD }
  if (-not $pw -or $pw.Length -lt 8) { throw 'IMPORT_PASSWORD/SEED_PASSWORD missing or too short' }
  Write-Log 'env: DATABASE_URL present; seed/import password present'

  $saPath = $null
  foreach ($c in $SaCandidates) {
    if (Test-Path $c) { $saPath = $c; break }
  }
  if ($saPath) {
    $env:FIREBASE_SERVICE_ACCOUNT_PATH = $saPath
    Write-Log 'auth: service-account file present (path omitted)'
  } else {
    $SecretsPath = $null
    foreach ($c in $SecretsCandidates) {
      if (Test-Path $c) { $SecretsPath = $c; break }
    }
    if (-not $SecretsPath) { throw 'Missing secrets file (checked deploy .tmp and C:\GATC\secrets)' }
    $raw = Get-Content -Raw -Path $SecretsPath
    $obj = $raw | ConvertFrom-Json
    $aadhar = [string]$obj.superAdmin.aadhar
    $password = [string]$obj.superAdmin.password
    $digits = ($aadhar -replace '\D', '')
    if ($digits.Length -ne 12 -or -not $password) {
      throw 'superAdmin entry incomplete in secrets file'
    }
    $env:YESGATC_SUPER_AADHAR = $digits
    $env:YESGATC_SUPER_PASSWORD = $password
    $env:YESGATC_EMAAP_CREDENTIALS = $SecretsPath
    Write-Log ('auth: client Auth via secrets file; aadhaar_masked=' + (Mask-Aadhaar $digits))
  }

  $env:FORCE_IMPORT = '1'
  $env:NODE_ENV = 'production'

  $exportScript = Join-Path $DeployRoot 'scripts\export-yesgatc-users.mjs'
  $importScript = Join-Path $DeployRoot 'scripts\import-yesgatc-users.mjs'
  $verifyScript = Join-Path $DeployRoot 'scripts\verify-user-counts.mjs'
  foreach ($p in @($exportScript, $importScript, $verifyScript)) {
    if (-not (Test-Path $p)) { throw "Missing script: $p" }
  }

  Write-Log 'phase=export starting'
  Set-Status 'exporting'
  & $NodeExe $exportScript "--out=$OutDump"
  if ($LASTEXITCODE -ne 0) { throw "export failed exit=$LASTEXITCODE" }
  if (-not (Test-Path $OutDump)) { throw 'export dump missing after export' }
  $dumpBytes = (Get-Item $OutDump).Length
  Write-Log ("phase=export ok dump_bytes=$dumpBytes")

  # Clear password env before import (import uses SEED/IMPORT from .env)
  Remove-Item Env:YESGATC_SUPER_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:YESGATC_SUPER_AADHAR -ErrorAction SilentlyContinue

  Write-Log 'phase=import starting'
  Set-Status 'importing'
  & $NodeExe $importScript "--in=$OutDump"
  if ($LASTEXITCODE -ne 0) { throw "import failed exit=$LASTEXITCODE" }
  Write-Log 'phase=import ok'

  Write-Log 'phase=verify starting'
  Set-Status 'verifying'
  & $NodeExe $verifyScript
  if ($LASTEXITCODE -ne 0) { throw "verify failed exit=$LASTEXITCODE" }
  Write-Log 'phase=verify ok'

  Set-Status 'completed'
  Write-Log 'DONE ok=true'
  exit 0
}
catch {
  $msg = $_.Exception.Message
  # Never log credential-like substrings from exceptions that might include paths only
  Write-Log ("FAIL ok=false error=$msg")
  Set-Status 'failed'
  exit 1
}
