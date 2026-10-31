# Setup

## Mac development

1. Install Node.js 20+.
2. Clone this private repository.
3. `cp .env.example .env` and adjust local values.
4. `npm install`
5. `npm run dev:backend` and `npm run dev:frontend`

## GitHub

- Repository: private `gatc-vps`
- Default branch: `main` (stable)
- Developers use feature branches and pull requests
- Individual GitHub accounts; no shared credentials

## SSH to Windows VPS

1. Use dedicated Ed25519 key `~/.ssh/gatc_vps` (passphrase-protected).
2. Host alias: `GATC-VPS` in `~/.ssh/config`.
3. Windows account: `gatcdev` (not Administrator for routine work).
4. Verify host fingerprint via an independent RDP session before first trust.
5. Prefer restricting inbound SSH to trusted IPs or a VPN.

See `docs/ssh-windows.md` for exact Windows account and `authorized_keys` steps.

## VPS project path

`C:\GATC\gatc-vps`
