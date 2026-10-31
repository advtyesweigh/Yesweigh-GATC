# Deployment

Deployment is an **explicit, approved** operation. CI does not push to production. Developers do not all receive live VPS access.

## Flow

1. Feature branch → pull request
2. GitHub Actions: install, build, test
3. Review and merge to `main`
4. Authorized operator deploys an approved revision to the VPS
5. Restart application; verify `/health`
6. On failure, roll back using a snapshot

## Scripts (run on Windows as `gatcdev`)

```powershell
# Deploy (requires confirmation switch)
.\deployment\Deploy-GATC.ps1 -SourcePath D:\releases\gatc-vps-<sha> -ConfirmDeploy

# Restart (uses C:\GATC\tools\node\node.exe when present; survives SSH exit)
.\deployment\Restart-GATC.ps1

# Rollback
.\deployment\Rollback-GATC.ps1 -SnapshotPath C:\GATC\gatc-vps\backups\snapshot-<ts> -ConfirmRollback
.\deployment\Restart-GATC.ps1

# Optional first-boot helper (install/build if missing, then restart + health)
.\deployment\Bootstrap-Runtime.ps1

# Optional SSH firewall restrict — explicit only; keep RDP; wrong IP locks SSH
# .\deployment\Restrict-SSH.ps1 -ClientIp YOUR.PUBLIC.IP -ConfirmRestrict
```

## Secrets

- Production `.env` stays on the VPS only.
- Never commit secrets, keys, cookies, or browser profiles.
- Do not install a production self-hosted GitHub Actions runner without a separate security review.

## Verification after deploy

```powershell
Invoke-WebRequest http://127.0.0.1:3000/health
```
