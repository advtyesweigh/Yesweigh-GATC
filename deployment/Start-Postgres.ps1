# Start portable PostgreSQL so it survives Windows OpenSSH session teardown.
# Uses CREATE_BREAKAWAY_FROM_JOB (same pattern as Restart-GATC.ps1).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\deployment\Start-Postgres.ps1

$ErrorActionPreference = 'Stop'
$PgsqlHome = 'C:\GATC\tools\pgsql'
$DataDir = 'C:\GATC\pgsql\data'
$LogDir = 'C:\GATC\pgsql\log'
$LogFile = Join-Path $LogDir 'postgres-start.log'
$PidFile = Join-Path $LogDir 'postgres.pid'
$WrapperCmd = Join-Path $LogDir 'run-postgres.cmd'
$bin = Join-Path $PgsqlHome 'bin'
$pgCtl = Join-Path $bin 'pg_ctl.exe'

if (-not (Test-Path $pgCtl)) {
  throw "PostgreSQL not found at $PgsqlHome. Run Install-PortablePostgres.ps1 first."
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Get-ListeningPidOnPort {
  param([int]$Port = 5432)
  $lines = netstat -ano | Select-String -Pattern ":$Port\s+.*LISTENING"
  foreach ($line in $lines) {
    if ($line.Line -match '\s(\d+)\s*$') {
      return [int]$Matches[1]
    }
  }
  return $null
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

$existing = Get-ListeningPidOnPort -Port 5432
if ($existing) {
  Write-Host "PostgreSQL already listening on 127.0.0.1:5432 (PID $existing)"
  exit 0
}

# Stale postmaster.pid after OpenSSH/job teardown blocks pg_ctl start
$postmasterPid = Join-Path $DataDir 'postmaster.pid'
if (Test-Path $postmasterPid) {
  Write-Host 'Removing stale postmaster.pid (no listener on 5432)...'
  Remove-Item -Force $postmasterPid -ErrorAction Stop
}

# Prefer pg_ctl status when data dir is consistent
$status = & $pgCtl -D $DataDir status 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Host 'pg_ctl reports running but port not yet visible; waiting...'
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 250
    $existing = Get-ListeningPidOnPort -Port 5432
    if ($existing) {
      Write-Host "PostgreSQL listening (PID $existing)"
      exit 0
    }
  }
}

$wrapperBody = @"
@echo off
"$pgCtl" -D "$DataDir" -l "$LogFile" -o "-p 5432" start
"@
# Avoid Set-Content -Encoding (some VPS hosts reject that parameter).
[System.IO.File]::WriteAllText($WrapperCmd, $wrapperBody)

$cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
$launchPid = Start-BreakawayProcess -FileName $cmdExe -CommandLine "`"$cmdExe`" /c `"$WrapperCmd`"" -WorkingDirectory $bin
Write-Host "Launched breakaway pg_ctl wrapper PID $launchPid"

$startedPid = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  $startedPid = Get-ListeningPidOnPort -Port 5432
  if ($startedPid) { break }
}

if (-not $startedPid) {
  Write-Host 'PostgreSQL did not open :5432 in time. Recent log:'
  if (Test-Path $LogFile) { Get-Content $LogFile -Tail 40 }
  throw 'PostgreSQL start failed (port 5432 not listening).'
}

[System.IO.File]::WriteAllText($PidFile, [string]$startedPid)
Write-Host "PostgreSQL started on 127.0.0.1:5432 (PID $startedPid, OpenSSH-safe breakaway)"
