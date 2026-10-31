$ErrorActionPreference = 'Stop'
$p = 'C:\GATC\gatc-vps\scripts\.upsert-once.env'
if (-not (Test-Path $p)) { throw "missing $p" }
Get-Content -LiteralPath $p | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') {
    Set-Item -Path ("Env:" + $Matches[1]) -Value $Matches[2]
  }
}
& 'C:\GATC\gatc-vps\scripts\apply-admin-signin.ps1'
Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
