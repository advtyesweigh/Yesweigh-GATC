<#
.SYNOPSIS
  Non-admin follow-up after Admin-Free443-For-GATC.ps1 succeeds.

.DESCRIPTION
  Starts Caddy on :443, sets PUBLIC_API_URL, restarts the Node backend.
  Run as gatcdev after Admin frees 443.
#>
[CmdletBinding()]
param(
  [switch]$ForceTlsInternal
)

$ErrorActionPreference = 'Stop'
Set-Location 'C:\GATC\gatc-vps'

Write-Host '=== Continue-AfterFree443 ==='
$owner = $null
foreach ($line in (& netstat.exe -ano 2>$null)) {
  $s = [string]$line
  if ($s -notlike '*LISTENING*') { continue }
  if ($s -notlike '*:443 *' -and $s -notlike "*:443`t*") { continue }
  if ($s -match 'LISTENING\s+(\d+)\s*$') {
    $owner = [int]$Matches[1]
    break
  }
}
if ($owner) {
  $name = 'unknown'
  try { $name = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName } catch {}
  if ($name -notmatch 'caddy') {
    throw "TCP 443 still owned by PID $owner ($name). Re-run Admin-Free443-For-GATC.ps1 -ConfirmFree443"
  }
}

$startArgs = @{}
if ($ForceTlsInternal) { $startArgs['ForceTlsInternal'] = $true }
& .\deployment\Start-Caddy.ps1 @startArgs
& .\deployment\Set-PublicApiUrl.ps1 -PublicUrl 'https://gatc.yesweigh.in'
& .\deployment\Restart-GATC.ps1
Write-Host 'CONTINUE_AFTER_FREE443_DONE'
Write-Host 'Verify from Mac: curl -sf https://gatc.yesweigh.in/health   (or curl -k if tls internal)'
