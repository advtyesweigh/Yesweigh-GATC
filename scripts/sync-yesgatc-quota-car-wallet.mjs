/**
 * One-shot sync: Firestore vehicles / rcWallets / walletLedger / walletTopUps
 * + RC ovQuota fields → Postgres (migration 004 tables + fees_json).
 *
 * Auth: Yes One credentials on VPS ($DATA_ROOT/yesone) via JWT_SECRET decrypt,
 * or YESGATC_SUPER_AADHAR/PASSWORD / local credentials.local.json.
 *
 * Usage:
 *   node scripts/sync-yesgatc-quota-car-wallet.mjs
 *   DATABASE_URL=... DATA_ROOT=... JWT_SECRET=... node scripts/sync-yesgatc-quota-car-wallet.mjs
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  signInWithAadhaarPassword,
  signInSuperAdmin,
  listCollection,
} from './lib/yesgatc-firestore.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
dotenv.config({ path: resolve(REPO_ROOT, '.env') });

const require = createRequire(resolve(REPO_ROOT, 'backend/package.json'));
const { Client } = require('pg');

async function loadYesoneAuth() {
  try {
    const mod = await import(resolve(REPO_ROOT, 'backend/src/yesoneCredentials.js'));
    const secrets = mod.loadYesoneCredentialsSecrets({
      dataRoot: process.env.DATA_ROOT,
      jwtSecret: process.env.JWT_SECRET,
    });
    if (secrets?.userId && secrets?.password) {
      return signInWithAadhaarPassword(secrets.userId, secrets.password, { credPath: 'yesone' });
    }
  } catch {
    // fall through
  }
  return signInSuperAdmin();
}

function parseDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseTs(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function entryType(raw) {
  const t = String(raw || '').trim();
  if (t === 'top_up_credit' || t === 'rv_payment' || t === 'rv_refund') return t;
  if (/top.?up|credit/i.test(t)) return 'top_up_credit';
  if (/refund/i.test(t)) return 'rv_refund';
  return 'rv_payment';
}

async function buildRcMap(client) {
  const rows = await client.query(
    `SELECT id, code, fees_json FROM regional_centers WHERE active = TRUE`,
  );
  const byFirebase = new Map();
  const byCode = new Map();
  for (const row of rows.rows) {
    const uid = row.fees_json?.firebaseUid;
    if (uid) byFirebase.set(String(uid), row.id);
    if (row.code) byCode.set(String(row.code).toUpperCase(), row.id);
  }
  return { byFirebase, byCode };
}

async function syncQuota(client, rcMap, users) {
  let updated = 0;
  let skipped = 0;
  for (const doc of users.filter((u) => u.role === 'rc_admin')) {
    const rcId = rcMap.byFirebase.get(String(doc.id))
      || (doc.rcCode ? rcMap.byCode.get(String(doc.rcCode).toUpperCase()) : null);
    if (!rcId) {
      skipped += 1;
      continue;
    }
    const reserved = Array.isArray(doc.yesoneReservedSerials) ? doc.yesoneReservedSerials.length : 0;
    const patch = {
      ovQuota: doc.ovQuota ?? null,
      ovQuotaUsed: doc.ovQuotaUsed ?? null,
      ovQuotaPeriod: doc.ovQuotaPeriod || null,
      ovQuotaUpdatedAt: doc.ovQuotaUpdatedAt || new Date().toISOString(),
      ovQuotaSource: doc.ovQuotaSource || 'yesgatc_firestore',
      ovQuotaReserved: reserved,
    };
    await client.query(
      `UPDATE regional_centers
       SET fees_json = COALESCE(fees_json, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [rcId, JSON.stringify(patch)],
    );
    updated += 1;
  }
  return { updated, skipped };
}

async function syncVehicles(client, rcMap, vehicles) {
  let upserted = 0;
  let skipped = 0;
  for (const doc of vehicles) {
    const rcId = rcMap.byFirebase.get(String(doc.rcId || ''));
    if (!rcId) {
      skipped += 1;
      continue;
    }
    const docsJson = {
      rcDocUrl: doc.rcDocUrl || null,
      insuranceDocUrl: doc.insuranceDocUrl || null,
      pollutionDocUrl: doc.pollutionDocUrl || null,
      f2WeightDocUrl: doc.f2WeightDocUrl || null,
      vehiclePhotoUrl: doc.vehiclePhotoUrl || null,
    };
    await client.query(
      `INSERT INTO vehicles (
         rc_id, brand, model, year, reg_number,
         rc_validity, insurance_validity, pollution_validity, f2_weight_validity,
         docs_json, active, source_firebase_id, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,
         COALESCE($13::timestamptz, NOW()), COALESCE($14::timestamptz, NOW()))
       ON CONFLICT (source_firebase_id) DO UPDATE SET
         rc_id = EXCLUDED.rc_id,
         brand = EXCLUDED.brand,
         model = EXCLUDED.model,
         year = EXCLUDED.year,
         reg_number = EXCLUDED.reg_number,
         rc_validity = EXCLUDED.rc_validity,
         insurance_validity = EXCLUDED.insurance_validity,
         pollution_validity = EXCLUDED.pollution_validity,
         f2_weight_validity = EXCLUDED.f2_weight_validity,
         docs_json = EXCLUDED.docs_json,
         active = EXCLUDED.active,
         updated_at = NOW()`,
      [
        rcId,
        String(doc.brand || '').trim() || '—',
        String(doc.model || '').trim() || '—',
        String(doc.year || '').trim() || null,
        String(doc.regNumber || '').trim() || '—',
        parseDate(doc.rcValidity),
        parseDate(doc.insuranceValidity),
        parseDate(doc.pollutionValidity),
        parseDate(doc.f2WeightValidity),
        JSON.stringify(docsJson),
        doc.active !== false,
        String(doc.id),
        parseTs(doc.createdAt),
        parseTs(doc.updatedAt || doc.createdAt),
      ],
    );
    upserted += 1;
  }
  return { upserted, skipped };
}

async function syncWallets(client, rcMap, wallets) {
  let upserted = 0;
  let skipped = 0;
  for (const doc of wallets) {
    const firebaseRc = String(doc.rcId || doc.id || '');
    const rcId = rcMap.byFirebase.get(firebaseRc);
    if (!rcId) {
      skipped += 1;
      continue;
    }
    await client.query(
      `INSERT INTO rc_wallets (rc_id, balance_inr, updated_at)
       VALUES ($1, $2, COALESCE($3::timestamptz, NOW()))
       ON CONFLICT (rc_id) DO UPDATE SET
         balance_inr = EXCLUDED.balance_inr,
         updated_at = EXCLUDED.updated_at`,
      [rcId, Number(doc.balanceInr) || 0, parseTs(doc.updatedAt)],
    );
    upserted += 1;
  }
  return { upserted, skipped };
}

async function syncLedger(client, rcMap, ledger) {
  let upserted = 0;
  let skipped = 0;
  for (const doc of ledger) {
    const rcId = rcMap.byFirebase.get(String(doc.rcId || ''));
    if (!rcId) {
      skipped += 1;
      continue;
    }
    const status = doc.status === 'refunded' ? 'refunded' : 'completed';
    await client.query(
      `INSERT INTO wallet_ledger (
         rc_id, entry_type, amount_inr, balance_after_inr, status,
         meta_json, source_firebase_id, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,COALESCE($8::timestamptz, NOW()))
       ON CONFLICT (source_firebase_id) DO UPDATE SET
         amount_inr = EXCLUDED.amount_inr,
         balance_after_inr = EXCLUDED.balance_after_inr,
         status = EXCLUDED.status,
         meta_json = EXCLUDED.meta_json`,
      [
        rcId,
        entryType(doc.type),
        Number(doc.amountInr) || 0,
        Number(doc.balanceAfterInr) || 0,
        status,
        JSON.stringify({
          recordIds: doc.recordIds || [],
          idempotencyKey: doc.idempotencyKey || null,
          topUpId: doc.topUpId || null,
        }),
        String(doc.id),
        parseTs(doc.createdAt),
      ],
    );
    upserted += 1;
  }
  return { upserted, skipped };
}

async function syncTopUps(client, rcMap, topUps) {
  let upserted = 0;
  let skipped = 0;
  for (const doc of topUps) {
    const rcId = rcMap.byFirebase.get(String(doc.rcId || ''));
    if (!rcId) {
      skipped += 1;
      continue;
    }
    const status = ['pending', 'approved', 'rejected'].includes(doc.status) ? doc.status : 'pending';
    const method = doc.rechargeMethod === 'razorpay' ? 'razorpay'
      : doc.rechargeMethod === 'manual' ? 'manual' : null;
    await client.query(
      `INSERT INTO wallet_top_ups (
         rc_id, amount_inr, gross_amount_inr, status, recharge_method,
         razorpay_order_id, razorpay_payment_id, note, meta_json,
         source_firebase_id, submitted_at, reviewed_at, rejection_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,
         COALESCE($11::timestamptz, NOW()), $12::timestamptz, $13)
       ON CONFLICT (source_firebase_id) DO UPDATE SET
         amount_inr = EXCLUDED.amount_inr,
         gross_amount_inr = EXCLUDED.gross_amount_inr,
         status = EXCLUDED.status,
         recharge_method = EXCLUDED.recharge_method,
         note = EXCLUDED.note,
         meta_json = EXCLUDED.meta_json,
         reviewed_at = EXCLUDED.reviewed_at,
         rejection_reason = EXCLUDED.rejection_reason`,
      [
        rcId,
        Number(doc.amountInr) || 0,
        doc.grossAmountInr != null ? Number(doc.grossAmountInr) : null,
        status,
        method,
        doc.razorpayOrderId || null,
        doc.razorpayPaymentId || null,
        doc.note || null,
        JSON.stringify({
          rcCompanyName: doc.rcCompanyName || null,
          zohoTransferStatus: doc.zohoTransferStatus || null,
        }),
        String(doc.id),
        parseTs(doc.submittedAt),
        parseTs(doc.reviewedAt),
        doc.rejectionReason || null,
      ],
    );
    upserted += 1;
  }
  return { upserted, skipped };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const auth = await loadYesoneAuth();
  const [vehicles, wallets, ledger, topUps, users] = await Promise.all([
    listCollection(auth.idToken, 'vehicles'),
    listCollection(auth.idToken, 'rcWallets'),
    listCollection(auth.idToken, 'walletLedger'),
    listCollection(auth.idToken, 'walletTopUps'),
    listCollection(auth.idToken, 'users'),
  ]);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const started = new Date().toISOString();
  try {
    const rcMap = await buildRcMap(client);
    const quota = await syncQuota(client, rcMap, users);
    const veh = await syncVehicles(client, rcMap, vehicles);
    const wal = await syncWallets(client, rcMap, wallets);
    const led = await syncLedger(client, rcMap, ledger);
    const top = await syncTopUps(client, rcMap, topUps);
    const counts = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM vehicles) AS vehicles,
         (SELECT COUNT(*)::int FROM rc_wallets) AS wallets,
         (SELECT COUNT(*)::int FROM wallet_ledger) AS ledger,
         (SELECT COUNT(*)::int FROM wallet_top_ups) AS top_ups,
         (SELECT COALESCE(SUM(balance_inr),0)::float FROM rc_wallets) AS wallet_sum,
         (SELECT COALESCE(SUM(COALESCE((fees_json->>'ovQuota')::numeric,0)),0)::int
            FROM regional_centers WHERE code <> 'DEMO-RC') AS quota_allotted,
         (SELECT COALESCE(SUM(COALESCE((fees_json->>'ovQuotaUsed')::numeric,0)),0)::int
            FROM regional_centers WHERE code <> 'DEMO-RC') AS quota_used`,
    );
    console.log(JSON.stringify({
      ok: true,
      started,
      finished: new Date().toISOString(),
      fetched: {
        vehicles: vehicles.length,
        wallets: wallets.length,
        ledger: ledger.length,
        topUps: topUps.length,
        users: users.length,
        rcAdmins: users.filter((u) => u.role === 'rc_admin').length,
      },
      synced: { quota, vehicles: veh, wallets: wal, ledger: led, topUps: top },
      db: counts.rows[0],
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
