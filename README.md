# gatc-vps

GATC stamping management application for original verification and re-verification of weighing and measuring instruments through the Government of India eMaap portal.

**Status:** Infrastructure bootstrap + Phase 1 architecture. Customer UI target is **native Android** (not the Vite scaffold). Government portal (eMaap) form submission is intentionally not implemented yet.

**Phase 1 design:** [ARCHITECTURE.md](./ARCHITECTURE.md) · [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

## Repository layout

| Path | Purpose |
|------|---------|
| `frontend/` | Bootstrap status page only — **not** the customer-facing app (replaced by Android) |
| `backend/` | Node.js API (headless; domain APIs planned) |
| `android/` | Native RC Admin app (Kotlin + Jetpack Compose) |
| `design/reference/` | UI visual references (not shipped in APK) |
| `automation/` | Playwright browser integration (operator-assisted; eMaap future) |
| `deployment/` | Windows VPS deployment and startup scripts |
| `docs/` | Setup, deployment, SSH |
| `.github/workflows/` | CI validation (build and tests) |

## Development workflow

1. Develop on a feature branch in Cursor on your Mac.
2. Open a pull request into `main`.
3. GitHub Actions runs build and basic tests.
4. After review and approval, deploy an approved revision to the Windows VPS.
5. Deployment is explicit and manual — commits do not auto-deploy.

```text
Laptop → Feature branch → PR → Review + CI → main → Approved VPS deploy
```

## Local setup (Mac)

```bash
cp .env.example .env
npm install
npm run dev:backend
# in another terminal
npm run dev:frontend
```

Backend health check: `GET http://127.0.0.1:3000/health`

## VPS deployment

See `docs/deployment.md` and scripts under `deployment/`.

Production secrets live only on the VPS (environment variables / secure store). Never commit `.env`, keys, cookies, or browser profiles.

## Security principles

- Private repository; individual GitHub accounts
- SSH key authentication to the VPS (`gatcdev` account)
- Least-privilege Windows accounts
- Operator review required for any government submission
- CAPTCHA / OTP / interactive challenges are completed manually by authorized operators
- No CAPTCHA solving, security bypass, or automated bulk submission

## SSH host alias

Mac SSH config host: `GATC-VPS` → Windows VPS OpenSSH on port 22.

## License

Private. All rights reserved.
