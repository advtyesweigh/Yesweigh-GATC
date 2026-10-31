#Requires -Version 5.1
# Durable start — delegates to _launch-cert-dl.ps1 (schtasks /TR=.cmd). NEVER marks failed.
$ErrorActionPreference = 'Stop'
& 'C:\GATC\gatc-vps\scripts\_launch-cert-dl.ps1'
