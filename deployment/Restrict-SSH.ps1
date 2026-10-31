<#
.SYNOPSIS
  Restrict inbound OpenSSH (TCP 22) to a trusted client IP. Run explicitly.

.DESCRIPTION
  Creates a Windows Firewall rule that allows SSH only from -ClientIp and
  optionally disables the broad OpenSSH "allow any" rule(s).

  WARNING:
  - Wrong or unstable IP can lock you out of SSH. Keep RDP available.
  - Do NOT run this unless you have verified your current public IP and
    have an alternate admin path (RDP / console).
  - This script does not touch Remote Desktop rules.

.PARAMETER ClientIp
  Public IPv4 of the trusted client (e.g. office/home).

.PARAMETER ConfirmRestrict
  Required confirmation switch.

.EXAMPLE
  .\Restrict-SSH.ps1 -ClientIp 116.68.104.18 -ConfirmRestrict
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d{1,3}(\.\d{1,3}){3}$')]
  [string]$ClientIp,

  [switch]$ConfirmRestrict
)

$ErrorActionPreference = 'Stop'

if (-not $ConfirmRestrict) {
  throw 'Refusing to change firewall without -ConfirmRestrict. Wrong IP can lock out SSH; keep RDP available.'
}

$ruleName = "GATC SSH allow $ClientIp only"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
  Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
}

New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 22 `
  -RemoteAddress $ClientIp `
  -Action Allow `
  -Profile Any `
  -Enabled True | Out-Null

Write-Host "Created allow rule: $ruleName"

# Disable stock OpenSSH any-source allow rules if present (do not delete).
$broad = Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Enabled -eq 'True' -and
    $_.Direction -eq 'Inbound' -and
    (
      $_.DisplayName -match 'OpenSSH' -or
      $_.DisplayName -match 'SSH Server' -or
      $_.Name -match 'OpenSSH-Server'
    )
  }

foreach ($rule in $broad) {
  if ($rule.DisplayName -eq $ruleName) { continue }
  $portFilter = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
  if ($portFilter -and ($portFilter.LocalPort -eq 22 -or $portFilter.LocalPort -contains 22)) {
    Disable-NetFirewallRule -Name $rule.Name
    Write-Host "Disabled broad SSH rule: $($rule.DisplayName) ($($rule.Name))"
  }
}

Write-Host ''
Write-Host 'SSH inbound is now restricted. Verify from the allowed client:'
Write-Host '  ssh GATC-VPS'
Write-Host 'If locked out, use RDP and re-enable OpenSSH firewall rules, or remove:'
Write-Host "  Remove-NetFirewallRule -DisplayName '$ruleName'"
Write-Host 'RDP rules were not modified.'
