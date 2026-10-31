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
