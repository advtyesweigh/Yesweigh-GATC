#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$DeployRoot = 'C:\GATC\gatc-vps'
$Tmp = Join-Path $DeployRoot '.tmp'
Set-Location $DeployRoot

# Mirror log to the name requested by the breakaway coordinator
$srcLog = Join-Path $Tmp 'firebase-cert-import.log'
$dstLog = Join-Path $Tmp 'firebase-certs-import.log'
if ((Test-Path $srcLog) -and -not (Test-Path $dstLog)) {
  Copy-Item $srcLog $dstLog -Force
}
$srcSt = Join-Path $Tmp 'firebase-cert-import.status'
$dstSt = Join-Path $Tmp 'firebase-certs-import.status'
if ((Test-Path $srcSt)) { Copy-Item $srcSt $dstSt -Force }

Write-Output ('status=' + (Get-Content -Raw $srcSt).Trim())
Write-Output '---LOG---'
Get-Content $srcLog

Write-Output '---VERIFY---'
$node = 'C:\GATC\tools\node\node.exe'
& $node (Join-Path $DeployRoot 'scripts\verify-cert-counts.mjs')
if ($LASTEXITCODE -ne 0) { throw "verify failed exit=$LASTEXITCODE" }

Write-Output '---EXPORT_COUNTS---'
& $node -e @"
const fs=require('fs');
const p='C:/GATC/gatc-vps/.tmp/yesgatc-certs-export.json';
const d=JSON.parse(fs.readFileSync(p,'utf8'));
const keys=['siteCalibrations','products','customers','certificates','docaCertificates'];
const out={};
for (const k of keys) out[k]=Array.isArray(d[k])?d[k].length:0;
console.log(JSON.stringify({exportCounts:out, bytes:fs.statSync(p).size}));
"@
