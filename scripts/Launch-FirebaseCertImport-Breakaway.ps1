#Requires -Version 5.1
<#
.SYNOPSIS
  Detach Run-FirebaseCertImport-Breakaway.ps1 from the OpenSSH job object.
#>
$ErrorActionPreference = 'Stop'
$DeployRoot = 'C:\GATC\gatc-vps'
$Runner = Join-Path $DeployRoot 'scripts\Run-FirebaseCertImport-Breakaway.ps1'
$Tmp = Join-Path $DeployRoot '.tmp'
$WrapperCmd = Join-Path $Tmp 'firebase-cert-import-breakaway.cmd'
$LaunchLog = Join-Path $Tmp 'firebase-cert-import-launch.log'

if (-not (Test-Path $Runner)) { throw "Runner missing: $Runner" }
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$wrapperBody = @"
@echo off
cd /d "$DeployRoot"
"$psExe" -NoProfile -ExecutionPolicy Bypass -File "$Runner"
"@
Set-Content -Path $WrapperCmd -Value $wrapperBody -Encoding ascii

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
    throw "CreateProcess breakaway failed (Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
  }
  return $pi.dwProcessId
}

$cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
$launchPid = Start-BreakawayProcess -FileName $cmdExe -CommandLine "`"$cmdExe`" /c `"$WrapperCmd`"" -WorkingDirectory $DeployRoot
$msg = "launched_wrapper_pid=$launchPid runner=$Runner log=C:\GATC\gatc-vps\.tmp\firebase-cert-import.log"
Set-Content -Path $LaunchLog -Value $msg -Encoding ascii
Write-Output $msg
