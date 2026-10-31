$ErrorActionPreference = 'Stop'
$env:Path = 'C:\GATC\tools\node;C:\GATC\tools\mingit\cmd;C:\Program Files\GitHub CLI;' + $env:Path
$root = 'C:\GATC\gatc-vps'
Set-Location $root
New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null

# Stop known backend pid and any leftover node owned by this user when possible
& "$root\deployment\Restart-GATC.ps1" -StopOnly
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    Stop-Process -Id $_.Id -Force -ErrorAction Stop
    Write-Host "Stopped leftover node PID $($_.Id)"
  } catch {
    Write-Host "Could not stop node PID $($_.Id): $($_.Exception.Message)"
  }
}

# Ensure deps (idempotent; skip if node_modules present and healthy)
if (-not (Test-Path "$root\node_modules\express")) {
  Write-Host 'Running npm install...'
  $env:NODE_OPTIONS = '--max-old-space-size=1536'
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
}

if (-not (Test-Path "$root\frontend\dist\index.html")) {
  Write-Host 'Running frontend/workspace build...'
  $env:NODE_OPTIONS = '--max-old-space-size=1536'
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed: $LASTEXITCODE" }
} else {
  Write-Host 'frontend/dist already present — skipping build'
}

Write-Host 'Starting backend...'
& "$root\deployment\Restart-GATC.ps1"
Start-Sleep -Seconds 2

try {
  $r = Invoke-WebRequest -Uri http://127.0.0.1:3000/health -UseBasicParsing -TimeoutSec 8
  Write-Host "HEALTH_STATUS=$($r.StatusCode)"
  Write-Host $r.Content
} catch {
  Write-Host 'Health check failed; backend logs:'
  if (Test-Path "$root\logs\backend.err.log") { Get-Content "$root\logs\backend.err.log" -Tail 50 }
  if (Test-Path "$root\logs\backend.out.log") { Get-Content "$root\logs\backend.out.log" -Tail 50 }
  throw
}

git -C $root branch --set-upstream-to=origin/main main 2>&1 | Out-Host
git -C $root status -sb
Write-Host 'Bootstrap complete.'
