#Requires -Version 5.1
$ErrorActionPreference = 'Continue'
Write-Output ('secrets_json=' + (Test-Path 'C:\GATC\secrets\yesgatc-superadmin.json'))
Write-Output ('secrets_gatcdev=' + (Test-Path 'C:\GATC\secrets\yesgatc-superadmin.gatcdev.json'))

function Write-SecretShape([string]$Path) {
  if (-not (Test-Path $Path)) {
    Write-Output ('shape_' + [IO.Path]::GetFileName($Path) + '=missing')
    return
  }
  $o = Get-Content -Raw $Path | ConvertFrom-Json
  $top = @($o.PSObject.Properties | ForEach-Object { $_.Name }) -join ','
  Write-Output ('shape_' + [IO.Path]::GetFileName($Path) + '_top=' + $top)
  if ($o.superAdmin) {
    $a = ([string]$o.superAdmin.aadhar) -replace '\D', ''
    $p = [string]$o.superAdmin.password
    Write-Output ('shape_' + [IO.Path]::GetFileName($Path) + '_aadhar_len=' + $a.Length)
    Write-Output ('shape_' + [IO.Path]::GetFileName($Path) + '_pw_len=' + $p.Length)
  } else {
    Write-Output ('shape_' + [IO.Path]::GetFileName($Path) + '_superAdmin=absent')
  }
}

Write-SecretShape 'C:\GATC\secrets\yesgatc-superadmin.json'
Write-SecretShape 'C:\GATC\secrets\yesgatc-superadmin.gatcdev.json'
Write-Output ('data_root=' + (Test-Path 'C:\GATC\data'))
Write-Output ('certs_dir=' + (Test-Path 'C:\GATC\data\certificates'))
Write-Output ('media_dir=' + (Test-Path 'C:\GATC\data\media\verifications'))
Write-Output ('env_present=' + (Test-Path 'C:\GATC\gatc-vps\.env'))
Write-Output ('node_present=' + (Test-Path 'C:\GATC\tools\node\node.exe'))

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match 'CertsImport|export-yesgatc-certs|import-yesgatc-certs|firebase-certs') } |
  ForEach-Object {
    Write-Output ('EXISTING_PROC id=' + $_.ProcessId + ' name=' + $_.Name)
  }

$envFile = 'C:\GATC\gatc-vps\.env'
$dbUrl = $null
Get-Content $envFile -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_ -match '^DATABASE_URL=(.*)$') { $dbUrl = $Matches[1] }
}
if (-not $dbUrl) {
  Write-Output 'DATABASE_URL=missing'
  exit 0
}
$env:DATABASE_URL = $dbUrl
$node = 'C:\GATC\tools\node\node.exe'
Set-Location 'C:\GATC\gatc-vps'
& $node -e @'
const {Client}=require("pg");
(async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL});
  await c.connect();
  for (const t of ["users","regional_centers","products","customers","verifications","verification_media"]) {
    try {
      const r=await c.query("select count(*)::int as n from "+t);
      console.log(t+"="+r.rows[0].n);
    } catch {
      console.log(t+"=ERR");
    }
  }
  const m=await c.query("select count(*)::int as n from users where profile_json->>'firebaseUid' is not null");
  console.log("users_with_firebaseUid="+m.rows[0].n);
  const r=await c.query("select count(*)::int as n from regional_centers where fees_json->>'firebaseUid' is not null");
  console.log("rcs_with_firebaseUid="+r.rows[0].n);
  await c.end();
})().catch(e=>{ console.log("pg_err="+e.message); process.exit(1); });
'@
