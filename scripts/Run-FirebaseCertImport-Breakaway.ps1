#Requires -Version 5.1
<#
.SYNOPSIS
  VPS-local Firebase cert/product/customer export → Postgres import.

.NOTES
  - Prefers C:\GATC\secrets\yesgatc-superadmin.gatcdev.json (never echoes secrets)
  - Falls back to yesgatc-superadmin.json or service-account JSON if present
  - Logs to C:\GATC\gatc-vps\.tmp\firebase-cert-import.log (no passwords)
  - Launch via Launch-FirebaseCertImport-Breakaway.ps1
#>
$ErrorActionPreference = 'Stop'
$DeployRoot = 'C:\GATC\gatc-vps'
$SecretCandidates = @(
  'C:\GATC\secrets\yesgatc-superadmin.gatcdev.json',
  'C:\GATC\secrets\yesgatc-superadmin.json'
)
$SaCandidates = @(
  'C:\GATC\secrets\yesgatc-firebase-adminsdk.json',
  'C:\GATC\secrets\firebase-adminsdk.json'
)
$OutDump = Join-Path $DeployRoot '.tmp\yesgatc-certs-export.json'
$LogPath = Join-Path $DeployRoot '.tmp\firebase-cert-import.log'
$PidPath = Join-Path $DeployRoot '.tmp\firebase-cert-import.pid'
$StatusPath = Join-Path $DeployRoot '.tmp\firebase-cert-import.status'
$NodeExe = 'C:\GATC\tools\node\node.exe'
if (-not (Test-Path $NodeExe)) { $NodeExe = 'node' }

# Default none for first full load (fast, durable). Re-run with GATC_CERT_DOWNLOAD_MEDIA=certs
# to pull certificate PDFs into DATA_ROOT after rows exist.
$DownloadMedia = $env:GATC_CERT_DOWNLOAD_MEDIA
if (-not $DownloadMedia) { $DownloadMedia = 'none' }

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
  Write-Log 'START firebase cert export+import (VPS breakaway)'
  Write-Log ("pid=$PID node=$NodeExe download_media=$DownloadMedia")

  Import-DotEnv
  if (-not $env:DATABASE_URL) { throw 'DATABASE_URL missing from .env' }
  if (-not $env:DATA_ROOT) { Write-Log 'warn: DATA_ROOT unset — media download will store URL metadata only' }
  Write-Log 'env: DATABASE_URL present'

  $saPath = $null
  foreach ($c in $SaCandidates) {
    if (Test-Path $c) { $saPath = $c; break }
  }
  if ($saPath) {
    $env:FIREBASE_SERVICE_ACCOUNT_PATH = $saPath
    Write-Log 'auth: service-account file present (path omitted)'
  } else {
    $secretsPath = $null
    foreach ($c in $SecretCandidates) {
      if (-not (Test-Path $c)) { continue }
      $raw = Get-Content -Raw -Path $c
      $obj = $raw | ConvertFrom-Json
      $aadhar = [string]$obj.superAdmin.aadhar
      $password = [string]$obj.superAdmin.password
      $digits = ($aadhar -replace '\D', '')
      if ($digits.Length -eq 12 -and $password) {
        $secretsPath = $c
        $env:YESGATC_SUPER_AADHAR = $digits
        $env:YESGATC_SUPER_PASSWORD = $password
        $env:YESGATC_EMAAP_CREDENTIALS = $c
        Write-Log ('auth: client Auth via ' + [IO.Path]::GetFileName($c) + '; aadhaar_masked=' + (Mask-Aadhaar $digits))
        break
      }
      Write-Log ('auth: skip incomplete ' + [IO.Path]::GetFileName($c) + ' aadhaar_digits=' + $digits.Length)
    }
    if (-not $secretsPath) { throw 'No usable super_admin secrets file' }
  }

  $env:FORCE_IMPORT = '1'
  $env:NODE_ENV = 'production'

  $exportScript = Join-Path $DeployRoot 'scripts\export-yesgatc-certs.mjs'
  $importScript = Join-Path $DeployRoot 'scripts\import-yesgatc-certs.mjs'
  $migrateCmd = 'npm'
  foreach ($p in @($exportScript, $importScript)) {
    if (-not (Test-Path $p)) { throw "Missing script: $p" }
  }

  Write-Log 'phase=migrate starting'
  Set-Status 'migrating'
  & $NodeExe (Join-Path $DeployRoot 'backend\src\migrate.js')
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
  & $NodeExe $importScript "--in=$OutDump" "--download-media=$DownloadMedia"
  if ($LASTEXITCODE -ne 0) { throw "import failed exit=$LASTEXITCODE" }
  Write-Log 'phase=import ok'

  Write-Log 'phase=verify starting'
  Set-Status 'verifying'
  $verifyScript = Join-Path $DeployRoot 'scripts\verify-cert-counts.mjs'
  if (-not (Test-Path $verifyScript)) { throw "Missing script: $verifyScript" }
  & $NodeExe $verifyScript
  if ($LASTEXITCODE -ne 0) { throw "verify failed exit=$LASTEXITCODE" }
  Write-Log 'phase=verify ok'

  Set-Status 'completed'
  Write-Log 'DONE ok=true'
  exit 0
}
catch {
  $msg = $_.Exception.Message
  Write-Log ("FAIL ok=false error=$msg")
  Set-Status 'failed'
  exit 1
}
