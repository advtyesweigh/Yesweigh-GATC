$ErrorActionPreference = 'Stop'
Set-Location 'C:\GATC\gatc-vps'

Get-Content '.\.env' | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith('#')) { return }
  $i = $line.IndexOf('=')
  if ($i -lt 1) { return }
  $k = $line.Substring(0, $i).Trim()
  $v = $line.Substring($i + 1)
  Set-Item -Path "Env:$k" -Value $v
}

if (-not $env:DATABASE_URL) { throw 'DATABASE_URL missing from .env' }
$pw = $env:IMPORT_PASSWORD
if (-not $pw) { $pw = $env:SEED_PASSWORD }
if (-not $pw -or $pw.Length -lt 8) { throw 'IMPORT_PASSWORD/SEED_PASSWORD missing or too short' }

$env:FORCE_IMPORT = '1'
$env:NODE_ENV = 'production'

Write-Output 'has_db=true'
Write-Output 'has_seed_pw=true'

$node = 'C:\GATC\tools\node\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

& $node 'scripts\import-yesgatc-users.mjs' '--in=C:\GATC\gatc-vps\.tmp\yesgatc-users-export.json'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $node 'scripts\verify-user-counts.mjs'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
