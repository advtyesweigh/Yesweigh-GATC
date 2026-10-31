# Automation

Playwright / Chromium integration for **operator-assisted** government portal sessions.

## Rules

- Prefer an official government API when available.
- Use browser automation only where permitted by the portal operator.
- CAPTCHA, OTP, and interactive security challenges require manual completion by an authorized operator.
- Do not implement CAPTCHA solving, security-control bypass, or automated bulk submission.
- All final government submissions require operator review and confirmation.
- Never commit cookies, browser profiles, session storage, or credentials.

This package is a scaffold only during infrastructure setup.

## eMaap session status (Super Admin dashboard)

The Super Admin UI reads **Logged In / Not Logged In** from a small status file — not from live browser cookies in the API process.

| Piece | Location |
|-------|----------|
| Reader | `src/emaapSession.js` → `getEmaapSessionStatus()` |
| API | `GET /api/v1/admin/ops-status` and `GET /api/v1/admin/emaap-status` (ADMIN JWT only) |
| Default file | `$DATA_ROOT/emaap/session-status.json` |
| Override | `EMAAP_SESSION_STATUS_PATH` |

### Status file shape

```json
{
  "loggedIn": true,
  "updatedAt": "2026-10-31T12:00:00.000Z",
  "note": "optional"
}
```

- Missing or invalid file → API reports `not_logged_in` / **Not Logged In** (stub).
- After an authorized operator completes eMaap login **manually** (CAPTCHA/OTP), the future Playwright worker should write `loggedIn: true`.
- On logout, expiry, or failed session check, write `loggedIn: false`.
- Do **not** put passwords, cookies, CAPTCHA solutions, or OTP codes in this file.
