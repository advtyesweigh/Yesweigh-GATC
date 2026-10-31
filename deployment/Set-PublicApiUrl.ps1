<#
.SYNOPSIS
  Set public API URL in VPS .env (does not print secrets).

.DESCRIPTION
  Updates PUBLIC_API_URL (and optionally API_BASE_URL) to the Caddy HTTPS URL.
  Default: https://gatc.yesweigh.in (Caddy on :443 after Tun4China reclaim).
#>
[CmdletBinding()]
param(
  [string]$DeployRoot = 'C:\GATC\gatc-vps',
  [string]$PublicUrl = 'https://gatc.yesweigh.in',
  [switch]$AlsoSetApiBaseUrl
)

$ErrorActionPreference = 'Stop'
$envPath = Join-Path $DeployRoot '.env'
if (-not (Test-Path $envPath)) { throw "Missing $envPath" }

$keys = @('PUBLIC_API_URL')
if ($AlsoSetApiBaseUrl) { $keys += 'API_BASE_URL' }

$lines = Get-Content $envPath
$found = @{}
foreach ($k in $keys) { $found[$k] = $false }

$out = foreach ($line in $lines) {
  $matched = $false
  foreach ($k in $keys) {
    if ($line -match "^$k=") {
      $found[$k] = $true
      $matched = $true
      Write-Output "$k=$PublicUrl"
      break
    }
  }
  if (-not $matched) { Write-Output $line }
}

foreach ($k in $keys) {
  if (-not $found[$k]) { $out += "$k=$PublicUrl" }
}

Set-Content -Path $envPath -Value $out -Encoding UTF8
Write-Host "Updated public URL key(s) to $PublicUrl (secrets untouched)"
Write-Host 'SET_PUBLIC_URL_OK'
