$ErrorActionPreference = 'Continue'
$env:Path = 'C:\GATC\tools\node;C:\GATC\tools\mingit\cmd;C:\Program Files\GitHub CLI;' + $env:Path
Set-Location C:\GATC\gatc-vps

Write-Host '=== GH ==='
gh auth status 2>&1
gh auth setup-git 2>&1

Write-Host '=== FETCH ==='
git fetch 2>&1
Write-Host "FETCH_EXIT=$LASTEXITCODE"

Write-Host '=== STATUS ==='
git status -sb
git rev-parse HEAD
git log -1 --oneline
git remote -v

Write-Host '=== ARTIFACTS ==='
Write-Host "node_modules=$(Test-Path .\node_modules)"
Write-Host "frontend_dist=$(Test-Path .\frontend\dist)"
Write-Host "backend_entry=$(Test-Path .\backend\src\index.js)"
Write-Host "env=$(Test-Path .\.env)"
if (Test-Path .\node_modules) {
  $n = (Get-ChildItem .\node_modules | Measure-Object).Count
  Write-Host "node_modules_top=$n"
}

Write-Host '=== HEALTH ==='
try {
  $r = Invoke-WebRequest -Uri http://127.0.0.1:3000/health -UseBasicParsing -TimeoutSec 5
  Write-Host "HEALTH_STATUS=$($r.StatusCode)"
  Write-Host $r.Content
} catch {
  Write-Host "HEALTH_ERR=$($_.Exception.Message)"
}

Write-Host '=== NODE ==='
Get-Process node -ErrorAction SilentlyContinue | Format-Table Id, CPU, WorkingSet -AutoSize
if (Test-Path .\backend.pid) { Write-Host "PIDFILE=$(Get-Content .\backend.pid)" }
