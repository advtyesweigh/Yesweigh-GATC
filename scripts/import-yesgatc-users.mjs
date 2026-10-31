/**
 * Import a yesgatc users JSON dump into GATC VPS Postgres.
 *
 * Creates/updates:
 *   - regional_centers from rc_admin profiles
 *   - users rows for ADMIN / RC_ADMIN / VCT
 *
 * Password strategy:
 *   Firebase Auth hashes cannot be exported. Every imported user gets a bcrypt
 *   hash of IMPORT_PASSWORD (preferred) or SEED_PASSWORD. Operators must rotate
 *   after first login. Never prints the password.
 *
 * Usage (Mac with tunnel, or on VPS):
 *   IMPORT_PASSWORD='...' DATABASE_URL='...' node scripts/import-yesgatc-users.mjs
 *   node scripts/import-yesgatc-users.mjs --in=.tmp/yesgatc-users-export.json --dry-run
 *
 * On VPS (loads C:\\GATC\\gatc-vps\\.env for DATABASE_URL / SEED_PASSWORD):
 *   node scripts/import-yesgatc-users.mjs --in=C:/GATC/tmp/yesgatc-users-export.json
 *
 * Env:
 *   DATABASE_URL   required (or present in repo .env)
 *   IMPORT_PASSWORD or SEED_PASSWORD  >= 8 chars
 *   FORCE_IMPORT=1  allow when NODE_ENV=production
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const require = createRequire(join(REPO_ROOT, 'backend/package.json'));
const pg = require('pg');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

dotenv.config({ path: join(REPO_ROOT, '.env') });

const { Client } = pg;
const ROLE_MAP = {
  super_admin: 'ADMIN',
  rc_admin: 'RC_ADMIN',
  vct: 'VCT',
};

const PROFILE_KEEP = [
  'firebaseUid',
  'firebaseRole',
  'companyName',
  'contactPerson',
  'place',
  'pincode',
  'state',
  'district',
  'location',
  'gstNumber',
  'laboratorySealIdentification',
  'feesStructure',
  'rcCode',
  'certificationMethod',
  'emaapSignerType',
  'bloodGroup',
  'policeStation',
  'secondaryContactName',
  'secondaryContactRelationship',
  'secondaryContactPhone',
  'approvalStatus',
  'ovInName',
  'allowedJobKinds',
  'createdAt',
  'createdByUid',
];

function argValue(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1).trim() : '';
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function normalizeAadhaar(raw) {
  return String(raw ?? '').replace(/\D/g, '');
}

function slugCode(raw, fallback) {
  const cleaned = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  if (cleaned.length >= 2) return cleaned;
  return fallback;
}

function rcCodeFor(doc) {
  const explicit = String(doc.rcCode || '')
    .trim()
    .toUpperCase();
  if (/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(explicit)) return explicit;
  const fromCompany = slugCode(doc.companyName, '');
  if (fromCompany) return fromCompany.slice(0, 16);
  return `RC-${String(doc.uid || 'X').slice(0, 8).toUpperCase()}`;
}

function buildProfile(doc) {
  const profile = {
    firebaseUid: doc.uid,
    firebaseRole: doc.role,
  };
  for (const key of PROFILE_KEEP) {
    if (key === 'firebaseUid' || key === 'firebaseRole') continue;
    if (doc[key] !== undefined && doc[key] !== null && doc[key] !== '') {
      profile[key] = doc[key];
    }
  }
  return profile;
}

function isActiveUser(doc) {
  if (doc.active === false) return false;
  if (doc.role === 'vct' && doc.approvalStatus === 'pending') return false;
  return true;
}

function workflowMode(doc) {
  if (doc.role !== 'vct') return null;
  return doc.workflowMode === 'auto' ? 'auto' : 'manual';
}

async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw new Error('IMPORT_PASSWORD/SEED_PASSWORD must be at least 8 characters');
  }
  return bcrypt.hash(plain, 12);
}

async function ensureUniqueRcCode(client, desired, firebaseUid) {
  let code = desired;
  let n = 0;
  while (true) {
    const existing = await client.query(
      `SELECT id, fees_json FROM regional_centers WHERE code = $1 LIMIT 1`,
      [code],
    );
    if (existing.rowCount === 0) return code;
    const fees = existing.rows[0].fees_json || {};
    if (fees.firebaseUid === firebaseUid) return code;
    n += 1;
    code = `${desired.slice(0, 20)}-${n}`;
  }
}

async function upsertRegionalCenter(client, doc) {
  const desired = rcCodeFor(doc);
  const code = await ensureUniqueRcCode(client, desired, doc.uid);
  const fees = {
    ...(doc.feesStructure && typeof doc.feesStructure === 'object' ? { feesStructure: doc.feesStructure } : {}),
    firebaseUid: doc.uid,
  };
  const result = await client.query(
    `INSERT INTO regional_centers (
       code, company_name, contact_person, phone, email, address,
       state, district, pincode, location_lat, location_lng,
       laboratory_seal_identification, fees_json, active
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,TRUE)
     ON CONFLICT (code) DO UPDATE SET
       company_name = EXCLUDED.company_name,
       contact_person = EXCLUDED.contact_person,
       phone = EXCLUDED.phone,
       email = EXCLUDED.email,
       address = EXCLUDED.address,
       state = EXCLUDED.state,
       district = EXCLUDED.district,
       pincode = EXCLUDED.pincode,
       location_lat = EXCLUDED.location_lat,
       location_lng = EXCLUDED.location_lng,
       laboratory_seal_identification = EXCLUDED.laboratory_seal_identification,
       fees_json = EXCLUDED.fees_json,
       active = TRUE,
       updated_at = NOW()
     RETURNING id, code`,
    [
      code,
      doc.companyName || doc.username || code,
      doc.contactPerson || doc.username || null,
      doc.phone || null,
      doc.email || null,
      doc.address || null,
      doc.state || null,
      doc.district || null,
      doc.pincode || null,
      doc.location?.lat ?? null,
      doc.location?.lng ?? null,
      doc.laboratorySealIdentification || null,
      JSON.stringify(fees),
    ],
  );
  return result.rows[0];
}

async function upsertUser(client, {
  aadhaar,
  username,
  passwordHash,
  role,
  rcId,
  phone,
  email,
  address,
  profile,
  workflow,
  active,
}) {
  const result = await client.query(
    `INSERT INTO users (
       aadhaar, username, password_hash, role, rc_id,
       phone, email, address, profile_json, workflow_mode, active
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
     ON CONFLICT (aadhaar) DO UPDATE SET
       username = EXCLUDED.username,
       password_hash = EXCLUDED.password_hash,
       role = EXCLUDED.role,
       rc_id = EXCLUDED.rc_id,
       phone = EXCLUDED.phone,
       email = EXCLUDED.email,
       address = EXCLUDED.address,
       profile_json = EXCLUDED.profile_json,
       workflow_mode = EXCLUDED.workflow_mode,
       active = EXCLUDED.active,
       updated_at = NOW()
     RETURNING id, aadhaar, role, rc_id, active`,
    [
      aadhaar,
      username || null,
      passwordHash,
      role,
      rcId,
      phone || null,
      email || null,
      address || null,
      JSON.stringify(profile),
      workflow,
      active,
    ],
  );
  return result.rows[0];
}

async function main() {
  const dryRun = hasFlag('--dry-run');
  const inPath = resolve(
    argValue('--in') || join(REPO_ROOT, '.tmp', 'yesgatc-users-export.json'),
  );
  if (!existsSync(inPath)) {
    throw new Error(`Dump not found: ${inPath}`);
  }

  const databaseUrl = process.env.DATABASE_URL || '';
  const password = process.env.IMPORT_PASSWORD || process.env.SEED_PASSWORD || '';
  const nodeEnv = process.env.NODE_ENV || 'development';
  const force = process.env.FORCE_IMPORT === '1';

  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!password || password.length < 8) {
    throw new Error('Set IMPORT_PASSWORD or SEED_PASSWORD (>= 8 chars)');
  }
  if (nodeEnv === 'production' && !force && !dryRun) {
    throw new Error('Refusing import in production without FORCE_IMPORT=1');
  }

  const dump = JSON.parse(readFileSync(inPath, 'utf8'));
  const users = Array.isArray(dump.users) ? dump.users : [];
  if (users.length === 0) throw new Error('Dump contains no users');

  const admins = users.filter((u) => u.role === 'super_admin');
  const rcAdmins = users.filter((u) => u.role === 'rc_admin');
  const vcts = users.filter((u) => u.role === 'vct');

  const stats = {
    dryRun,
    source: inPath,
    considered: { ADMIN: admins.length, RC_ADMIN: rcAdmins.length, VCT: vcts.length },
    imported: { ADMIN: 0, RC_ADMIN: 0, VCT: 0, regionalCenters: 0 },
    skipped: [],
    passwordStrategy:
      'All imported users share IMPORT_PASSWORD/SEED_PASSWORD (bcrypt). Firebase Auth hashes were not migrated.',
  };

  if (dryRun) {
    for (const doc of [...admins, ...rcAdmins, ...vcts]) {
      const aadhaar = normalizeAadhaar(doc.aadhar);
      if (aadhaar.length !== 12) {
        stats.skipped.push({
          uid: doc.uid,
          role: ROLE_MAP[doc.role],
          reason: 'invalid_aadhaar',
        });
        continue;
      }
      stats.imported[ROLE_MAP[doc.role]] += 1;
      if (doc.role === 'rc_admin') stats.imported.regionalCenters += 1;
    }
    console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
    return;
  }

  const passwordHash = await hashPassword(password);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const rcByFirebaseUid = new Map();

  try {
    await client.query('BEGIN');

    for (const doc of rcAdmins) {
      const aadhaar = normalizeAadhaar(doc.aadhar);
      if (aadhaar.length !== 12) {
        stats.skipped.push({ uid: doc.uid, role: 'RC_ADMIN', reason: 'invalid_aadhaar' });
        continue;
      }
      const rc = await upsertRegionalCenter(client, doc);
      rcByFirebaseUid.set(doc.uid, rc.id);
      // Also map explicit rcId if present (usually self)
      if (doc.rcId) rcByFirebaseUid.set(doc.rcId, rc.id);

      await upsertUser(client, {
        aadhaar,
        username: doc.username || doc.companyName || doc.contactPerson || null,
        passwordHash,
        role: 'RC_ADMIN',
        rcId: rc.id,
        phone: doc.phone,
        email: doc.email,
        address: doc.address,
        profile: buildProfile(doc),
        workflow: null,
        active: isActiveUser(doc),
      });
      stats.imported.RC_ADMIN += 1;
      stats.imported.regionalCenters += 1;
    }

    for (const doc of admins) {
      const aadhaar = normalizeAadhaar(doc.aadhar);
      if (aadhaar.length !== 12) {
        stats.skipped.push({ uid: doc.uid, role: 'ADMIN', reason: 'invalid_aadhaar' });
        continue;
      }
      await upsertUser(client, {
        aadhaar,
        username: doc.username || 'admin',
        passwordHash,
        role: 'ADMIN',
        rcId: null,
        phone: doc.phone,
        email: doc.email,
        address: doc.address,
        profile: buildProfile(doc),
        workflow: null,
        active: isActiveUser(doc),
      });
      stats.imported.ADMIN += 1;
    }

    for (const doc of vcts) {
      const aadhaar = normalizeAadhaar(doc.aadhar);
      if (aadhaar.length !== 12) {
        stats.skipped.push({ uid: doc.uid, role: 'VCT', reason: 'invalid_aadhaar' });
        continue;
      }
      const parentFirebaseUid = doc.rcId || null;
      const rcId = parentFirebaseUid ? rcByFirebaseUid.get(parentFirebaseUid) : null;
      if (!rcId) {
        stats.skipped.push({
          uid: doc.uid,
          role: 'VCT',
          reason: 'missing_rc_mapping',
          firebaseRcId: parentFirebaseUid || null,
        });
        continue;
      }
      await upsertUser(client, {
        aadhaar,
        username: doc.username || null,
        passwordHash,
        role: 'VCT',
        rcId,
        phone: doc.phone,
        email: doc.email,
        address: doc.address,
        profile: buildProfile(doc),
        workflow: workflowMode(doc),
        active: isActiveUser(doc),
      });
      stats.imported.VCT += 1;
    }

    const counts = await client.query(
      `SELECT role, COUNT(*)::int AS n
       FROM users
       WHERE role IN ('ADMIN','RC_ADMIN','VCT')
       GROUP BY role
       ORDER BY role`,
    );
    const rcCount = await client.query(`SELECT COUNT(*)::int AS n FROM regional_centers`);
    stats.dbCounts = Object.fromEntries(counts.rows.map((r) => [r.role, r.n]));
    stats.dbCounts.regional_centers = rcCount.rows[0].n;

    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
