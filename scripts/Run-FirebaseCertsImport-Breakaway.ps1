#Requires -Version 5.1
<#
.SYNOPSIS
  VPS-local Firebase cert/verification export → Postgres import (survives SSH disconnect).

.NOTES
  - Prefers C:\GATC\secrets\yesgatc-superadmin.gatcdev.json then yesgatc-superadmin.json
  - Logs to C:\GATC\gatc-vps\.tmp\firebase-certs-import.log (no passwords)
  - Launch via Launch-FirebaseCertsImport-Breakaway.ps1
#>
$ErrorActionPreference = 'Stop'
$DeployRoot = 'C:\GATC\gatc-vps'
$SecretsCandidates = @(
  'C:\GATC\secrets\yesgatc-superadmin.gatcdev.json',
  'C:\GATC\secrets\yesgatc-superadmin.json'
)
$SaCandidates = @(
  'C:\GATC\secrets\yesgatc-firebase-adminsdk.json',
  'C:\GATC\secrets\firebase-adminsdk.json'
)
$OutDump = Join-Path $DeployRoot '.tmp\yesgatc-certs-export.json'
$LogPath = Join-Path $DeployRoot '.tmp\firebase-certs-import.log'
$PidPath = Join-Path $DeployRoot '.tmp\firebase-certs-import.pid'
$StatusPath = Join-Path $DeployRoot '.tmp\firebase-certs-import.status'
$LockPath = Join-Path $DeployRoot '.tmp\firebase-certs-import.lock'
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

function Resolve-SecretsPath {
  foreach ($c in $SecretsCandidates) {
    if (-not (Test-Path $c)) { continue }
    try {
      $obj = (Get-Content -Raw -Path $c) | ConvertFrom-Json
      $entry = $obj.superAdmin
      if (-not $entry) { $entry = $obj }
      $aadhar = [string]$entry.aadhar
      if (-not $aadhar) { $aadhar = [string]$entry.aadhaar }
      $password = [string]$entry.password
      $digits = ($aadhar -replace '\D', '')
      if ($digits.Length -eq 12 -and $password) { return $c }
    } catch { }
  }
  return $null
}

try {
  if (Test-Path $LockPath) {
    $old = Get-Content -Raw $LockPath
    Write-Log ("WARN lock present: $old - continuing under this runner")
  }
  Set-Content -Path $LockPath -Value ("pid=$PID started=$(Get-Date -Format o)") -Encoding ascii

  Write-Log 'REFUSE_DUPLICATE: use Run-FirebaseCertImport-Breakaway.ps1 (singular); this duplicate runner is retired'
  throw 'Retired duplicate runner — use Run-FirebaseCertImport-Breakaway.ps1'
  Set-Status 'running'
  if (Test-Path $LogPath) { Remove-Item $LogPath -Force -ErrorAction SilentlyContinue }
  Write-Log 'START firebase certs export+import (VPS breakaway)'
  Write-Log ("pid=$PID node=$NodeExe")

  Import-DotEnv
  if (-not $env:DATABASE_URL) { throw 'DATABASE_URL missing from .env' }
  if (-not $env:DATA_ROOT) { $env:DATA_ROOT = 'C:\GATC\data' }
  Write-Log ('env: DATABASE_URL present; DATA_ROOT=' + $env:DATA_ROOT)

  # Ensure data dirs
  New-Item -ItemType Directory -Force -Path (Join-Path $env:DATA_ROOT 'media\verifications') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $env:DATA_ROOT 'certificates') | Out-Null

  $saPath = $null
  foreach ($c in $SaCandidates) {
    if (Test-Path $c) { $saPath = $c; break }
  }
  if ($saPath) {
    $env:FIREBASE_SERVICE_ACCOUNT_PATH = $saPath
    Write-Log 'auth: service-account file present (path omitted)'
  } else {
    $SecretsPath = Resolve-SecretsPath
    if (-not $SecretsPath) { throw 'Missing usable secrets file (need superAdmin aadhar+password)' }
    $raw = Get-Content -Raw -Path $SecretsPath
    $obj = $raw | ConvertFrom-Json
    $entry = $obj.superAdmin
    if (-not $entry) { $entry = $obj }
    $aadhar = [string]$entry.aadhar
    if (-not $aadhar) { $aadhar = [string]$entry.aadhaar }
    $password = [string]$entry.password
    $digits = ($aadhar -replace '\D', '')
    if ($digits.Length -ne 12 -or -not $password) {
      throw 'superAdmin entry incomplete in secrets file'
    }
    $env:YESGATC_SUPER_AADHAR = $digits
    $env:YESGATC_SUPER_PASSWORD = $password
    $env:YESGATC_EMAAP_CREDENTIALS = $SecretsPath
    Write-Log ('auth: client Auth via secrets file name=' + [IO.Path]::GetFileName($SecretsPath) + '; aadhaar_masked=' + (Mask-Aadhaar $digits))
  }

  $env:FORCE_IMPORT = '1'
  $env:NODE_ENV = 'production'

  $exportScript = Join-Path $DeployRoot 'scripts\export-yesgatc-certs.mjs'
  $importScript = Join-Path $DeployRoot 'scripts\import-yesgatc-certs.mjs'
  $migrateScript = Join-Path $DeployRoot 'backend\src\migrate.js'
  foreach ($p in @($exportScript, $importScript, $migrateScript)) {
    if (-not (Test-Path $p)) { throw "Missing script: $p" }
  }

  Write-Log 'phase=migrate starting'
  Set-Status 'migrating'
  & $NodeExe $migrateScript
  if ($LASTEXITCODE -ne 0) { throw "migrate failed exit=$LASTEXITCODE" }
  Write-Log 'phase=migrate ok'

  Write-Log 'phase=export starting'
  Set-Status 'exporting'
  & $NodeExe $exportScript "--out=$OutDump"
  if ($LASTEXITCODE -ne 0) { throw "export failed exit=$LASTEXITCODE" }
  if (-not (Test-Path $OutDump)) { throw 'export dump missing after export' }
  $dumpBytes = (Get-Item $OutDump).Length
  Write-Log ("phase=export ok dump_bytes=$dumpBytes")

  Remove-Item Env:YESGATC_SUPER_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:YESGATC_SUPER_AADHAR -ErrorAction SilentlyContinue

  Write-Log 'phase=import starting'
  Set-Status 'importing'
  & $NodeExe $importScript "--in=$OutDump"
  if ($LASTEXITCODE -ne 0) { throw "import failed exit=$LASTEXITCODE" }
  Write-Log 'phase=import ok'

  Set-Status 'completed'
  Write-Log 'DONE ok=true'
  Remove-Item $LockPath -Force -ErrorAction SilentlyContinue
  exit 0
}
catch {
  $msg = $_.Exception.Message
  Write-Log ("FAIL ok=false error=$msg")
  Set-Status 'failed'
  Remove-Item $LockPath -Force -ErrorAction SilentlyContinue
  exit 1
}
