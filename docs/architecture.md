# Architecture

## Purpose

GATC stamping management for original verification and re-verification of weighing and measuring instruments via the Government of India eMaap portal.

## Components

- **frontend** — Operator-facing web UI (Vite). Initial scope: backend connection status.
- **backend** — Node.js Express API. Health and status endpoints; future domain APIs.
- **automation** — Playwright/Chromium scaffold for operator-assisted portal sessions.
- **deployment** — Explicit PowerShell scripts for Windows VPS deploy, restart, and rollback.

## Data domains (planned)

- Customer and instrument records
- Original verification / re-verification requests
- Request tracking
- Government acknowledgement records

## Government portal integration policy

1. Prefer official government APIs when available.
2. Browser automation only where permitted.
3. CAPTCHA, OTP, and interactive challenges: manual operator completion only.
4. Final submissions require operator review and confirmation.
5. No CAPTCHA solving, bypass, or automated bulk submission.

## Runtime constraints

Windows Server VPS with 4 GB RAM. Keep the production footprint light: no heavy IDEs, no unnecessary services, no production self-hosted GitHub Actions runner without a separate security review.
