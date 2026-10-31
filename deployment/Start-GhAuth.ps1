<#
.SYNOPSIS
  Start gh auth web/device flow with output captured to files (for SSH headless use).
#>
$ErrorActionPreference = 'Continue'
$tools = 'C:\GATC\tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$out = Join-Path $tools 'gh-out.txt'
$err = Join-Path $tools 'gh-err.txt'
$in  = Join-Path $tools 'gh-in.txt'
Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
Set-Content -Path $in -Value "`r`n`r`n`r`n" -Encoding ascii

Get-Process -Name gh -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$p = Start-Process -FilePath 'gh' `
  -ArgumentList 'auth login --hostname github.com --git-protocol https --web --skip-ssh-key' `
  -RedirectStandardOutput $out `
  -RedirectStandardError $err `
  -RedirectStandardInput $in `
  -WindowStyle Hidden `
  -PassThru

"STARTED_PID=$($p.Id)" | Set-Content (Join-Path $tools 'gh-auth.pid')
Start-Sleep -Seconds 8
'===OUT==='
if (Test-Path $out) { Get-Content $out }
'===ERR==='
if (Test-Path $err) { Get-Content $err }
"ALIVE=$(-not $p.HasExited) EXITCODE=$($p.ExitCode)"
