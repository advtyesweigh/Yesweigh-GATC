<#
.SYNOPSIS
  Start portable Caddy reverse proxy on :443 (survives SSH disconnect).

.DESCRIPTION
  Uses deployment\Caddyfile (gatc.yesweigh.in -> 127.0.0.1:3000).
  Requires TCP 443 free (run Admin-Free443-For-GATC.ps1 as Admin first).
  Tries Let's Encrypt automatic HTTPS; if ACME fails, falls back to
  deployment\Caddyfile.tls-internal (browser warning until LE works).
  Optionally keeps :8443 as a redirect to canonical HTTPS.
  Uses CREATE_BREAKAWAY_FROM_JOB like Restart-GATC.ps1.
#>
[CmdletBinding()]
param(
  [string]$ToolsRoot = 'C:\GATC\tools\caddy',
  [string]$DeployRoot = 'C:\GATC\gatc-vps',
  [switch]$StopOnly,
  [switch]$SkipFirewall,
  [switch]$ForceTlsInternal
)

$ErrorActionPreference = 'Stop'
# Prefer caddy-run.exe when caddy.exe is locked by AV/scanner/stale handle.
$caddyExePrimary = Join-Path $ToolsRoot 'caddy.exe'
$caddyExeAlt = Join-Path $ToolsRoot 'caddy-run.exe'
if (Test-Path $caddyExeAlt) {
  $caddyExe = $caddyExeAlt
} else {
  $caddyExe = $caddyExePrimary
}
$caddyfile = Join-Path $DeployRoot 'deployment\Caddyfile'
$caddyfileInternal = Join-Path $DeployRoot 'deployment\Caddyfile.tls-internal'
$pidFile = Join-Path $ToolsRoot 'caddy.pid'
$outLog = Join-Path $ToolsRoot 'caddy.out.log'
$errLog = Join-Path $ToolsRoot 'caddy.err.log'
$wrapperCmd = Join-Path $ToolsRoot 'run-caddy.cmd'
$dataDir = Join-Path $ToolsRoot 'data'
$configDir = Join-Path $ToolsRoot 'config'

if (-not (Test-Path $caddyExe)) { throw "Missing $caddyExe - run Install-PortableCaddy.ps1 first" }
if (-not (Test-Path $caddyfile)) { throw "Missing $caddyfile" }

function Get-ListeningPidOnPort {
  param([int]$Port)
  # Require non-digit before/after port so :443 does not match :8443.
  $rx = "(?i)TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
  foreach ($line in (& netstat.exe -ano 2>$null)) {
    $s = [string]$line
    if ($s -match $rx) { return [int]$Matches[1] }
  }
  return $null
}

function Stop-CaddyProcess {
  if (Test-Path $pidFile) {
    $pidRaw = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $pidValue = 0
    if ($pidRaw -and [int]::TryParse([string]$pidRaw, [ref]$pidValue) -and $pidValue -gt 0) {
      $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
      # Portable binary may be caddy.exe or caddy-run.exe (ProcessName caddy-run).
      if ($proc -and $proc.ProcessName -match 'caddy') {
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped recorded PID $pidValue ($($proc.ProcessName))"
      }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
  Get-Process -Name caddy,caddy-run -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped $($_.ProcessName) process $($_.Id)"
  }
  # Wait so :443 / admin :2019 release before relaunch.
  for ($i = 0; $i -lt 20; $i++) {
    $left = @(Get-Process -Name caddy,caddy-run -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  }
}

function Start-BreakawayProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FileName,
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  if (-not ('DetachProc' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DetachProc {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CreateProcess(
    string lpApplicationName,
    string lpCommandLine,
    IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes,
    bool bInheritHandles,
    uint dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation);
}
"@
  }

  $si = New-Object DetachProc+STARTUPINFO
  $si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
  $pi = New-Object DetachProc+PROCESS_INFORMATION
  # CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
  $flags = [uint32]0x09000200
  $ok = [DetachProc]::CreateProcess(
    $FileName,
    $CommandLine,
    [IntPtr]::Zero,
    [IntPtr]::Zero,
    $false,
    $flags,
    [IntPtr]::Zero,
    $WorkingDirectory,
    [ref]$si,
    [ref]$pi
  )
  if (-not $ok) {
    throw "CreateProcess breakaway failed for $FileName (Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
  }
  return $pi.dwProcessId
}

function Try-OpenFirewallPort {
  param([string]$RuleName, [int]$Port)
  $adminCmd = "New-NetFirewallRule -DisplayName '$RuleName' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Any"
  $adminNetsh = "netsh advfirewall firewall add rule name=`"$RuleName`" dir=in action=allow protocol=TCP localport=$Port profile=any"
  try {
    $shown = & netsh.exe advfirewall firewall show rule name="$RuleName" 2>&1 | Out-String
    if ($shown -match 'Enabled:') {
      Write-Host "Firewall rule already present: $RuleName"
      return
    }
  } catch { }

  $out = & netsh.exe advfirewall firewall add rule name="$RuleName" dir=in action=allow protocol=TCP localport=$Port profile=any 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0 -and $out -match 'Ok') {
    Write-Host "Created firewall rule: $RuleName (TCP $Port inbound)"
    return
  }

  Write-Host ''
  Write-Host "ADMIN_REQUIRED: firewall rule for TCP $Port was not created (needs elevation)."
  Write-Host 'Run ONE of these exact commands in an elevated Administrator PowerShell:'
  Write-Host ''
  Write-Host "  $adminCmd"
  Write-Host ''
  Write-Host "  $adminNetsh"
  Write-Host ''
  Write-Host ("netsh output: " + $out.Trim())
}

function Start-CaddyWithConfig {
  param([string]$ConfigPath, [string]$Label)

  Stop-CaddyProcess
  New-Item -ItemType Directory -Force -Path $dataDir, $configDir | Out-Null
  Set-Content -Path $outLog -Value '' -Encoding ascii
  Set-Content -Path $errLog -Value '' -Encoding ascii

  # Out-Null: native stdout must not leak into this function's return value.
  & $caddyExe validate --config $ConfigPath --adapter caddyfile | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "caddy validate failed for $ConfigPath" }

  $wrapperBody = @"
@echo off
set CADDY_DATA_DIR=$dataDir
set XDG_DATA_HOME=$dataDir
set XDG_CONFIG_HOME=$configDir
cd /d "$ToolsRoot"
"$caddyExe" run --config "$ConfigPath" --adapter caddyfile >> "$outLog" 2>> "$errLog"
"@
  Set-Content -Path $wrapperCmd -Value $wrapperBody -Encoding ascii

  $cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $launchPid = Start-BreakawayProcess -FileName $cmdExe -CommandLine "`"$cmdExe`" /c `"$wrapperCmd`"" -WorkingDirectory $ToolsRoot
  Write-Host "Launched breakaway wrapper PID $launchPid ($Label)"

  # LE can take a while; tls internal is faster. Allow up to ~90s.
  $listenPid = $null
  for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Milliseconds 500
    $listenPid = Get-ListeningPidOnPort -Port 443
    if ($listenPid) { break }
    # Abort early if process died and stderr mentions ACME/bind
    $still = Get-Process caddy -ErrorAction SilentlyContinue
    if (-not $still -and $i -gt 6) { break }
  }
  return $listenPid
}

if ($StopOnly) {
  Stop-CaddyProcess
  Write-Host 'Caddy stopped.'
  return
}

# Check :443 BEFORE stopping the current Caddy (:8443 interim must stay up if reclaim is blocked).
$owner443 = Get-ListeningPidOnPort -Port 443
if ($owner443) {
  $ownerName = 'unknown'
  try {
    $p = Get-Process -Id $owner443 -ErrorAction SilentlyContinue
    if ($p) { $ownerName = $p.ProcessName }
  } catch { }
  Write-Host ''
  Write-Host "BLOCKED: TCP 443 still in use by PID $owner443 ($ownerName). Existing Caddy left running."
  Write-Host 'Run this in elevated Administrator PowerShell first:'
  Write-Host ''
  Write-Host '  Set-ExecutionPolicy -Scope Process Bypass -Force'
  Write-Host '  C:\GATC\gatc-vps\deployment\Admin-Free443-For-GATC.ps1 -ConfirmFree443'
  Write-Host ''
  throw "Port 443 not free (PID $owner443 / $ownerName). Admin-Free443 required."
}

Stop-CaddyProcess

$activeConfig = $caddyfile
$certLabel = 'letsencrypt-or-auto'
if ($ForceTlsInternal) {
  if (-not (Test-Path $caddyfileInternal)) { throw "Missing $caddyfileInternal" }
  $activeConfig = $caddyfileInternal
  $certLabel = 'tls-internal'
  Write-Host 'Using ForceTlsInternal Caddyfile'
}

$listenPid = Start-CaddyWithConfig -ConfigPath $activeConfig -Label $certLabel

if (-not $listenPid -and -not $ForceTlsInternal -and (Test-Path $caddyfileInternal)) {
  Write-Host 'Primary Caddyfile did not open :443 (likely ACME/HTTP-01 failure). Falling back to tls internal...'
  if (Test-Path $errLog) { Get-Content $errLog -Tail 40 }
  $certLabel = 'tls-internal-fallback'
  $listenPid = Start-CaddyWithConfig -ConfigPath $caddyfileInternal -Label $certLabel
}

if (-not $listenPid) {
  Write-Host 'Caddy did not open :443. Recent stderr:'
  if (Test-Path $errLog) { Get-Content $errLog -Tail 80 }
  Write-Host 'netstat 443 snapshot:'
  & netstat.exe -ano 2>$null | ForEach-Object { if ($_ -like '*443*') { $_ } }
  throw 'Caddy start failed (port 443 not listening).'
}

Set-Content -Path $pidFile -Value $listenPid -NoNewline
Write-Host "Caddy listening on :443 PID $listenPid (cert mode: $certLabel)"
$listen8443 = Get-ListeningPidOnPort -Port 8443
if ($listen8443) {
  Write-Host "Also listening on :8443 PID $listen8443 (redirect secondary)"
}
Write-Host "stdout: $outLog"
Write-Host "stderr: $errLog"
Write-Host 'START_CADDY_DONE'
Write-Host 'Public URL: https://gatc.yesweigh.in'
if ($certLabel -like 'tls-internal*') {
  Write-Host 'Verify: curl -k https://gatc.yesweigh.in/health'
  Write-Host 'NOTE: browser will warn (self-signed). Re-run without -ForceTlsInternal after port 80 is open for LE.'
} else {
  Write-Host 'Verify: curl -sf https://gatc.yesweigh.in/health'
}

if (-not $SkipFirewall) {
  Try-OpenFirewallPort -RuleName 'GATC HTTPS 443' -Port 443
  Try-OpenFirewallPort -RuleName 'GATC HTTP 80' -Port 80
  Try-OpenFirewallPort -RuleName 'GATC Caddy HTTPS 8443' -Port 8443
}
