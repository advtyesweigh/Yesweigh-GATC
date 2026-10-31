<#
.SYNOPSIS
  Restart the GATC backend process on the Windows VPS.

.DESCRIPTION
  Stops any existing node process started for gatc-vps backend, then starts it again
  under the least-privilege service account context (run as gatcdev, not Administrator).

  Uses Win32 CreateProcess with CREATE_BREAKAWAY_FROM_JOB so Windows OpenSSH session
  teardown does not kill the backend. Prefer portable Node at C:\GATC\tools\node\node.exe.

  Note: Interactive-only schtasks /Run from SSH is unreliable (often 0x41303 / never runs).
  Plain Start-Process from an SSH session is killed with the OpenSSH job object.
#>
[CmdletBinding()]
param(
  [string]$DeployRoot = 'C:\GATC\gatc-vps',
  [switch]$StopOnly
)

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $DeployRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir 'backend.out.log'
$errLog = Join-Path $logDir 'backend.err.log'
$pidFile = Join-Path $DeployRoot 'backend.pid'
$wrapperCmd = Join-Path $logDir 'run-backend.cmd'

$nodeCandidates = @(
  'C:\GATC\tools\node\node.exe',
  (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
  'node'
)
$nodeExe = $null
foreach ($candidate in $nodeCandidates) {
  if ($candidate -eq 'node') {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $nodeExe = $cmd.Source; break }
  } elseif (Test-Path $candidate) {
    $nodeExe = $candidate
    break
  }
}
if (-not $nodeExe) {
  throw 'node.exe not found. Install portable Node at C:\GATC\tools\node\node.exe'
}

function Get-ListeningPidOnPort {
  param([int]$Port = 3000)
  $lines = netstat -ano | Select-String -Pattern ":$Port\s+.*LISTENING"
  foreach ($line in $lines) {
    if ($line.Line -match '\s(\d+)\s*$') {
      return [int]$Matches[1]
    }
  }
  return $null
}

function Stop-GatcBackend {
  if (Test-Path $pidFile) {
    $pidValue = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($pidValue) {
      $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
      if ($proc) {
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped backend PID $pidValue"
      }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }

  $listenPid = Get-ListeningPidOnPort -Port 3000
  if ($listenPid) {
    $proc = Get-Process -Id $listenPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match 'node') {
      Stop-Process -Id $listenPid -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped listening node PID $listenPid on :3000"
    }
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

Stop-GatcBackend

if ($StopOnly) {
  Write-Host 'Backend stopped.'
  exit 0
}

$backendEntry = Join-Path $DeployRoot 'backend\src\index.js'
if (-not (Test-Path $backendEntry)) {
  throw "Backend entry not found: $backendEntry"
}

$envFile = Join-Path $DeployRoot '.env'
if (-not (Test-Path $envFile)) {
  Write-Warning 'No .env found. Backend may fail configuration validation.'
}

$wrapperBody = @"
@echo off
cd /d "$DeployRoot"
"$nodeExe" backend\src\index.js >> "$outLog" 2>> "$errLog"
"@
Set-Content -Path $wrapperCmd -Value $wrapperBody -Encoding ascii

$cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
$launchPid = Start-BreakawayProcess -FileName $cmdExe -CommandLine "`"$cmdExe`" /c `"$wrapperCmd`"" -WorkingDirectory $DeployRoot
Write-Host "Launched breakaway wrapper PID $launchPid"

$startedPid = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  $startedPid = Get-ListeningPidOnPort -Port 3000
  if ($startedPid) { break }
}

if (-not $startedPid) {
  Write-Host 'Backend did not open :3000 in time. Recent stderr:'
  if (Test-Path $errLog) { Get-Content $errLog -Tail 40 }
  throw 'Backend start failed (port 3000 not listening).'
}

Set-Content -Path $pidFile -Value $startedPid -NoNewline
Write-Host "Backend started with PID $startedPid using $nodeExe (OpenSSH-safe breakaway)"
Write-Host "stdout: $outLog"
Write-Host "stderr: $errLog"
