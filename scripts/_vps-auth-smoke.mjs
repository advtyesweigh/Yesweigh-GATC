/**
 * VPS auth smoke test — prints statuses only (no passwords, OTP, or tokens).
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

const root = path.resolve('C:\\GATC\\gatc-vps');
dotenv.config({ path: path.join(root, '.env') });

const base = 'http://127.0.0.1:3000';
const password = process.env.IMPORT_PASSWORD || process.env.SEED_PASSWORD || '';
if (!password) {
  console.error('MISSING_PASSWORD_ENV');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('MISSING_DATABASE_URL');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

let user;
try {
  const r = await client.query(
    `SELECT aadhaar, phone
     FROM users
     WHERE active = TRUE
       AND phone IS NOT NULL
       AND length(regexp_replace(phone, '\\D', '', 'g')) >= 10
     ORDER BY created_at
     LIMIT 1`,
  );
  user = r.rows[0];
} finally {
  await client.end();
}

if (!user) {
  console.error('NO_USER_WITH_PHONE');
  process.exit(1);
}

console.log('smoke_user_aadhaar_suffix=' + String(user.aadhaar).slice(-4));

async function post(p, body) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function get(p, token) {
  const res = await fetch(base + p, {
    headers: { authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function readLatestOtp() {
  const logPath = path.join(root, 'logs', 'backend.out.log');
  if (!fs.existsSync(logPath)) return null;
  const text = fs.readFileSync(logPath, 'utf8').slice(-20000);
  const matches = [...text.matchAll(/"otp"\s*:\s*"(\d{6})"/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

const login = await post('/api/v1/auth/login', {
  userId: user.aadhaar,
  password,
});
if (login.status !== 200 || !login.json?.data?.challengeId) {
  console.error('login_failed_status=' + login.status);
  console.error('login_error_code=' + (login.json?.error?.code || 'unknown'));
  process.exit(1);
}
if (login.json.data.token) {
  console.error('login_unexpected_token');
  process.exit(1);
}
console.log('login_otp_challenge=ok');
console.log('phone_hint_present=' + Boolean(login.json.data.phoneHint));

await new Promise((r) => setTimeout(r, 500));
const otp = readLatestOtp();
if (!otp) {
  console.log('otp_from_logfile=missing');
  console.log('SMOKE_PARTIAL_OK');
  process.exit(0);
}
console.log('otp_from_logfile=found');

const verify = await post('/api/v1/auth/otp/verify', {
  challengeId: login.json.data.challengeId,
  otp,
});
if (verify.status !== 200 || !verify.json?.data?.token) {
  console.error('otp_verify_failed_status=' + verify.status);
  console.error('otp_verify_error_code=' + (verify.json?.error?.code || 'unknown'));
  process.exit(1);
}
console.log('otp_verify=ok');
const token1 = verify.json.data.token;

const me = await get('/api/v1/auth/me', token1);
if (me.status !== 200) {
  console.error('me_failed_status=' + me.status);
  process.exit(1);
}
console.log('me=ok');

const login2 = await post('/api/v1/auth/login', {
  userId: user.aadhaar,
  password,
});
if (login2.status !== 200) {
  console.error('login2_failed_status=' + login2.status);
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 500));
const otp2 = readLatestOtp();
if (!otp2) {
  console.log('single_device_revoke=skipped_no_otp2');
  console.log('AUTH_SMOKE_PARTIAL');
  process.exit(0);
}

const verify2 = await post('/api/v1/auth/otp/verify', {
  challengeId: login2.json.data.challengeId,
  otp: otp2,
});
if (verify2.status !== 200) {
  console.error('otp_verify2_failed_status=' + verify2.status);
  process.exit(1);
}

const stale = await get('/api/v1/auth/me', token1);
if (stale.status !== 401 || stale.json?.error?.code !== 'SESSION_REVOKED') {
  console.error('single_device_revoke_failed_status=' + stale.status);
  console.error('single_device_revoke_code=' + (stale.json?.error?.code || 'unknown'));
  process.exit(1);
}
console.log('single_device_revoke=ok');

const me2 = await get('/api/v1/auth/me', verify2.json.data.token);
if (me2.status !== 200) {
  console.error('new_session_me_failed');
  process.exit(1);
}
console.log('new_session_me=ok');
console.log('AUTH_SMOKE_OK');
