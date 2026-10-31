#Requires -Version 5.1
# NEVER mark-failed. Start once via schtasks launcher.
$ErrorActionPreference = 'Continue'
& 'C:\GATC\gatc-vps\scripts\_launch-cert-dl.ps1'
Start-Sleep -Seconds 8
& 'C:\GATC\gatc-vps\scripts\_vps-cert-dl-probe.ps1'
