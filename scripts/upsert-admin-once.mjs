/**
 * One-shot VPS upsert for ADMIN user. Reads secrets from env only.
 * Required: UPSERT_PASSWORD, DATABASE_URL (or load from .env via dotenv).
 * Optional: UPSERT_AADHAAR, UPSERT_USERNAME, UPSERT_PHONE, UPSERT_ROLE
 * Never logs password or OTP.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { hashPassword } from '../backend/src/passwords.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const aadhaar = String(process.env.UPSERT_AADHAAR || '').replace(/\D/g, '');
const username = String(process.env.UPSERT_USERNAME || '').trim();
const password = String(process.env.UPSERT_PASSWORD || '');
const role = String(process.env.UPSERT_ROLE || 'ADMIN').trim();
const phone = String(process.env.UPSERT_PHONE || '').trim();
const databaseUrl = process.env.DATABASE_URL || '';

if (!/^\d{12}$/.test(aadhaar)) {
  console.error(JSON.stringify({ ok: false, error: 'UPSERT_AADHAAR must be 12 digits' }));
  process.exit(1);
}
if (!username) {
  console.error(JSON.stringify({ ok: false, error: 'UPSERT_USERNAME required' }));
  process.exit(1);
}
if (password.length < 8) {
  console.error(JSON.stringify({ ok: false, error: 'UPSERT_PASSWORD too short' }));
  process.exit(1);
}
if (role !== 'ADMIN') {
  console.error(JSON.stringify({ ok: false, error: 'This upsert only supports ADMIN (super admin)' }));
  process.exit(1);
}
if (!databaseUrl) {
  console.error(JSON.stringify({ ok: false, error: 'DATABASE_URL missing' }));
  process.exit(1);
}

const { Client } = pg;
const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  const passwordHash = await hashPassword(password);
  const existing = await client.query(
    `SELECT id, phone, role FROM users WHERE aadhaar = $1 LIMIT 1`,
    [aadhaar],
  );
  const keepPhone = existing.rows[0]?.phone || null;
  const nextPhone = phone || keepPhone || '9000000001';

  const result = await client.query(
    `INSERT INTO users (
       aadhaar, username, password_hash, role, rc_id, phone, active, workflow_mode
     ) VALUES ($1, $2, $3, $4, NULL, $5, TRUE, NULL)
     ON CONFLICT (aadhaar) DO UPDATE
       SET username = EXCLUDED.username,
           password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           rc_id = NULL,
           phone = COALESCE(users.phone, EXCLUDED.phone),
           active = TRUE,
           updated_at = NOW()
     RETURNING id, aadhaar, username, role, phone IS NOT NULL AS has_phone`,
    [aadhaar, username, passwordHash, role, nextPhone],
  );

  const row = result.rows[0];
  console.log(JSON.stringify({
    ok: true,
    user: {
      id: row.id,
      aadhaar: row.aadhaar,
      username: row.username,
      role: row.role,
      hasPhone: row.has_phone,
      created: !existing.rows[0],
    },
  }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
} finally {
  await client.end();
}
