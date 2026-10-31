# Setup

## Mac development

1. Install Node.js 20+.
2. Clone this private repository.
3. `cp .env.example .env` and adjust local values.
4. `npm install`
5. `npm run dev:backend` and `npm run dev:frontend`

## GitHub

- Repository: private `https://github.com/faisalweighvox/gatc-vps`
- Default branch: `main` (stable)
- Developers use feature branches and pull requests
- Individual GitHub accounts; no shared credentials

## SSH to Windows VPS

1. Use dedicated Ed25519 key `~/.ssh/gatc_vps` (passphrase-protected).
2. Host alias: `GATC-VPS` in `~/.ssh/config`.
3. Windows account: `gatcdev` (not Administrator for routine work).
4. Real Windows profile on this VPS: `C:\Users\gatcdev.VPS` (authorized_keys under that `.ssh`).
5. Verify host fingerprint via an independent RDP session before first trust.
6. Prefer restricting inbound SSH to trusted IPs or a VPN (`deployment/Restrict-SSH.ps1`).

See `docs/ssh-windows.md` for exact Windows account, `icacls` `${User}` fix, portable tools PATH, and Cursor Remote SSH notes.

## VPS project path

`C:\GATC\gatc-vps`

## VPS portable tools

- Node: `C:\GATC\tools\node\`
- MinGit: `C:\GATC\tools\mingit\cmd\`
- PostgreSQL (portable): `C:\GATC\tools\pgsql\`
- Optional bundle: `C:\GATC\tools\gatc-vps.bundle`
- User PATH should include the Node and MinGit directories (persisted via `[Environment]::SetEnvironmentVariable`).

## GitHub auth on the VPS (for `git pull`)

Prefer HTTPS + `gh` credential helper:

```powershell
# Headless-friendly helper (prints device code + URL)
.\deployment\Start-GhAuth.ps1
# Open https://github.com/login/device and enter the one-time code
gh auth setup-git
git -C C:\GATC\gatc-vps fetch
git -C C:\GATC\gatc-vps status
```

### Fallback if interactive auth is blocked

**Option A — deploy key (read-only):** create a VPS-only SSH key as `gatcdev`, add it as a GitHub deploy key on the private repo, set `origin` to SSH.

**Option B — Mac-side bundle update:**

```bash
# On Mac (authenticated)
git -C "/path/to/gatc-vps" bundle create /tmp/gatc-vps.bundle --all
scp /tmp/gatc-vps.bundle GATC-VPS:C:/GATC/tools/gatc-vps.bundle

# On VPS
git -C C:\GATC\gatc-vps fetch C:\GATC\tools\gatc-vps.bundle
git -C C:\GATC\gatc-vps checkout -B main FETCH_HEAD
```

## PostgreSQL (local Mac)

1. Install PostgreSQL 16+ (Homebrew: `brew install postgresql@16`).
2. Create role/database `gatc` / `gatc`.
3. Set `DATABASE_URL=postgresql://gatc:YOUR_PASSWORD@127.0.0.1:5432/gatc` in `.env`.
4. Set `DATA_ROOT` to a writable local path.
5. Run migrations: `npm run db:migrate`.
6. Set `JWT_SECRET` (long random) and `SEED_PASSWORD` (local only), then `npm run db:seed`.
7. Auth smoke: `POST /api/v1/auth/login` with seed Aadhaar `999999999901` + `SEED_PASSWORD`; then `GET /api/v1/auth/me` with `Authorization: Bearer <token>`.

## PostgreSQL on Windows VPS (portable, no admin)

Preferred because `gatcdev` is not an Administrator:

```powershell
cd C:\GATC\gatc-vps
.\deployment\Install-PortablePostgres.ps1
.\deployment\Start-Postgres.ps1
.\deployment\Create-GatcDatabase.ps1   # writes DATABASE_URL into .env (does not print password)
.\deployment\Ensure-DataDirs.ps1
npm run db:migrate
```

- Binaries: `C:\GATC\tools\pgsql`
- Data: `C:\GATC\pgsql\data`
- Listen: `127.0.0.1:5432` only (`shared_buffers=128MB`)
- App data root: `C:\GATC\data` (`DATA_ROOT`)

Admin silent installer fallback (elevated RDP only): `deployment/Install-Postgres-AdminSilent.ps1`.

## Application runtime on VPS

```powershell
cd C:\GATC\gatc-vps
# Ensure .env exists (never commit secrets)
npm install
npm run build
.\deployment\Restart-GATC.ps1
# Health (local on VPS)
Invoke-RestMethod http://127.0.0.1:3000/health
```

`Restart-GATC.ps1` starts Node with `-WindowStyle Hidden` and writes `backend.pid`, so the process survives SSH disconnect.
