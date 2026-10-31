<#
.SYNOPSIS
  Elevated (Administrator) one-shot: free TCP 443 for GATC HTTPS reverse proxy.

.DESCRIPTION
  On this VPS, Tun4China (scheduled task + sing-box.exe) binds 0.0.0.0:443 / [::]:443
  (VLESS Reality + Hysteria2). Windows SstpSvc may also contend for 443.
  Public HTTPS for GATC therefore cannot use the standard port until these are stopped.

  Safe for typical GATC use: does NOT touch RDP (3389), SSH (22), or the Node
  backend on 127.0.0.1:3000. Stops Tun4China / sing-box and SSTP only.

  Run in an elevated PowerShell (Admin RDP), then continue as gatcdev:
    .\deployment\Start-Caddy.ps1
    .\deployment\Set-PublicApiUrl.ps1 -PublicUrl https://gatc.yesweigh.in
    .\deployment\Restart-GATC.ps1

.EXAMPLE
  Set-ExecutionPolicy -Scope Process Bypass -Force
  C:\GATC\gatc-vps\deployment\Admin-Free443-For-GATC.ps1 -ConfirmFree443
#>
[CmdletBinding()]
param(
  [switch]$ConfirmFree443,
  [switch]$KeepSstpEnabled,
  [switch]$KeepTun4ChinaTask
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script in an elevated Administrator PowerShell (Admin RDP).'
}

if (-not $ConfirmFree443) {
  throw 'Refusing to change services/firewall without -ConfirmFree443'
}

Write-Host '=== Before: listeners on 443 ==='
netstat -ano | Select-String -Pattern ':443\s' | ForEach-Object { $_.Line }

# 1) Tun4China scheduled task (SYSTEM) + sing-box process
$task = Get-ScheduledTask -TaskName 'Tun4China' -ErrorAction SilentlyContinue
if ($task) {
  Write-Host ("Tun4China task State={0}" -f $task.State)
  Stop-ScheduledTask -TaskName 'Tun4China' -ErrorAction SilentlyContinue
  if (-not $KeepTun4ChinaTask) {
    Unregister-ScheduledTask -TaskName 'Tun4China' -Confirm:$false
    Write-Host 'Unregistered scheduled task Tun4China (use -KeepTun4ChinaTask to only stop)'
  } else {
    Write-Host 'Left Tun4China task registered but stopped (-KeepTun4ChinaTask)'
  }
} else {
  Write-Host 'Tun4China scheduled task not present'
}

Get-Process -Name 'sing-box' -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  Write-Host ("Stopped sing-box PID {0}" -f $_.Id)
}

# Official Tun4China uninstall (idempotent)
$uninstall = 'C:\tun4china\server\uninstall.ps1'
if (Test-Path $uninstall) {
  try {
    & $uninstall
    Write-Host "Ran $uninstall"
  } catch {
    Write-Host ("uninstall.ps1 note: {0}" -f $_.Exception.Message)
  }
}

# 2) Windows SSTP (often also wants :443)
$sstp = Get-Service SstpSvc -ErrorAction SilentlyContinue
if ($sstp) {
  Write-Host ("SstpSvc Status={0} StartType={1}" -f $sstp.Status, $sstp.StartType)
  if ($sstp.Status -ne 'Stopped') {
    Stop-Service SstpSvc -Force -ErrorAction SilentlyContinue
    Write-Host 'Stopped SstpSvc'
  }
  if (-not $KeepSstpEnabled) {
    Set-Service SstpSvc -StartupType Disabled
    Write-Host 'Set SstpSvc StartType=Disabled (use -KeepSstpEnabled to leave Manual)'
  }
} else {
  Write-Host 'SstpSvc not present'
}

# 3) Firewall: allow GATC HTTP/HTTPS (ACME HTTP-01 needs 80; clients use 443)
$rules = @(
  @{ Name = 'GATC HTTP 80'; Port = 80 },
  @{ Name = 'GATC HTTPS 443'; Port = 443 }
)
foreach ($r in $rules) {
  $existing = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
  if (-not $existing) {
    New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $r.Port -Profile Any | Out-Null
    Write-Host ("Created firewall rule: {0}" -f $r.Name)
  } else {
    Enable-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
    Write-Host ("Firewall rule present/enabled: {0}" -f $r.Name)
  }
}

Start-Sleep -Seconds 2
Write-Host '=== After: listeners on 443 (should be empty until Caddy starts) ==='
$left = @(netstat -ano | Select-String -Pattern ':443\s.*LISTENING')
if ($left.Count -eq 0) {
  Write-Host '(none listening)'
} else {
  $left | ForEach-Object { $_.Line }
}

Write-Host ''
Write-Host 'ADMIN_OK: Port 443 should now be free for Caddy.'
Write-Host 'Next (as gatcdev, non-admin SSH/RDP):'
Write-Host '  cd C:\GATC\gatc-vps'
Write-Host '  .\deployment\Start-Caddy.ps1'
Write-Host '  .\deployment\Set-PublicApiUrl.ps1 -PublicUrl https://gatc.yesweigh.in'
Write-Host '  .\deployment\Restart-GATC.ps1'
Write-Host 'Verify from Mac: curl -sfI https://gatc.yesweigh.in/health   (or curl -k if tls internal)'
