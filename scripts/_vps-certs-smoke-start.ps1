#Requires -Version 5.1
$ErrorActionPreference = 'Continue'
$runner = 'C:\GATC\gatc-vps\scripts\Run-FirebaseCertsImport-Breakaway.ps1'
$tmp = 'C:\GATC\gatc-vps\.tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$errs = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($runner, [ref]$null, [ref]$errs)
if ($errs -and $errs.Count -gt 0) {
  Write-Output ('PARSE_ERRORS=' + $errs.Count)
  foreach ($e in $errs) { Write-Output $e.ToString() }
  exit 1
}
Write-Output 'PARSE_OK'

$existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match 'Run-FirebaseCertsImport|export-yesgatc-certs|import-yesgatc-certs') }
if ($existing) {
  Write-Output 'ALREADY_RUNNING'
  foreach ($p in $existing) { Write-Output ('PROC id=' + $p.ProcessId) }
  exit 0
}

$console = Join-Path $tmp 'firebase-certs-import-console.log'
$errLog = Join-Path $tmp 'firebase-certs-import-console.err'
foreach ($f in @($console, $errLog)) {
  if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
}

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$p = Start-Process -FilePath $ps `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runner) `
  -WorkingDirectory 'C:\GATC\gatc-vps' `
  -RedirectStandardOutput $console `
  -RedirectStandardError $errLog `
  -PassThru `
  -WindowStyle Hidden

Write-Output ('started_pid=' + $p.Id)
Start-Sleep -Seconds 10
Write-Output ('has_exited=' + $p.HasExited)
if ($p.HasExited) { Write-Output ('exit_code=' + $p.ExitCode) }

Write-Output '---status---'
$st = Join-Path $tmp 'firebase-certs-import.status'
if (Test-Path $st) { Write-Output ('status=' + (Get-Content -Raw $st).Trim()) } else { Write-Output 'status=missing' }

Write-Output '---pidfile---'
$pf = Join-Path $tmp 'firebase-certs-import.pid'
if (Test-Path $pf) { Write-Output ('pidfile=' + (Get-Content -Raw $pf).Trim()) } else { Write-Output 'pidfile=missing' }

Write-Output '---log---'
$lg = Join-Path $tmp 'firebase-certs-import.log'
if (Test-Path $lg) { Get-Content $lg -Tail 40 } else { Write-Output 'log=missing' }

Write-Output '---console---'
if (Test-Path $console) { Get-Content $console -Tail 40 } else { Write-Output 'console=missing' }

Write-Output '---err---'
if (Test-Path $errLog) { Get-Content $errLog -Tail 40 } else { Write-Output 'err=missing' }

# Note: Start-Process is NOT breakaway-from-job. Re-launch via Launch script after confirming runner works.
Write-Output 'NOTE=Start-Process is session-tied; will relaunch via CREATE_BREAKAWAY after smoke OK'
