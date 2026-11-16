#!/usr/bin/env node
/**
 * Merge full Firebase VCT user fields into Postgres profile_json (+ address/phone)
 * from a yesgatc users export — does NOT touch password_hash.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/backfill-vct-profiles.mjs
 *   node scripts/backfill-vct-profiles.mjs --file=.tmp/yesgatc-users-export.json --dry-run
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const require = createRequire(join(REPO_ROOT, 'package.json'));
const { Pool } = require('pg');

for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1);
}

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
  'logoUrl',
  'logoPath',
  'logoName',
  'logoContentType',
  'profilePhotoUrl',
  'profilePhotoPath',
  'profilePhotoName',
  'profilePhotoContentType',
  'profilePhotoLocalPath',
  'sealUrl',
  'sealPath',
  'rcId',
  'approvedAt',
  'approvedByUid',
  'forceLogoutAt',
  'deactivatedAt',
  'deactivatedByUid',
  'aadharDocUrl',
  'aadharDocPath',
  'aadharDocName',
  'aadharDocContentType',
  'aadharDocLocalPath',
  'biodataDocUrl',
  'biodataDocPath',
  'biodataDocName',
  'biodataDocContentType',
  'biodataDocLocalPath',
  'educationCertDocUrl',
  'educationCertDocPath',
  'educationCertDocName',
  'educationCertDocContentType',
  'educationCertDocLocalPath',
  'pccDocUrl',
  'pccDocPath',
  'pccDocName',
  'pccDocContentType',
  'pccDocLocalPath',
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

function loadDocs(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.users)) return raw.users;
  if (Array.isArray(raw.docs)) return raw.docs;
  return Object.values(raw).filter((x) => x && typeof x === 'object' && (x.uid || x.id));
}

function buildProfilePatch(doc) {
  const uid = doc.uid || doc.id;
  const patch = {
    firebaseUid: uid,
    firebaseRole: doc.role || 'vct',
  };
  for (const key of PROFILE_KEEP) {
    if (key === 'firebaseUid' || key === 'firebaseRole') continue;
    if (doc[key] !== undefined && doc[key] !== null && doc[key] !== '') {
      patch[key] = doc[key];
    }
  }
  return patch;
}

function workflowMode(doc) {
  return doc.workflowMode === 'auto' ? 'auto' : 'manual';
}

function isActiveUser(doc) {
  if (doc.active === false) return false;
  if (doc.role === 'vct' && doc.approvalStatus === 'pending') return false;
  return true;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL required');
  const file = resolve(argValue('--file') || join(REPO_ROOT, '.tmp', 'yesgatc-users-export.json'));
  if (!existsSync(file)) throw new Error(`Export not found: ${file}`);
  const dryRun = hasFlag('--dry-run');

  const docs = loadDocs(file).filter((d) => String(d.role || '').toLowerCase() === 'vct');
  const pool = new Pool({ connectionString: databaseUrl });
  const stats = {
    dryRun,
    file,
    docs: docs.length,
    matched: 0,
    updated: 0,
    missing: 0,
    missingUids: [],
  };

  try {
    for (const doc of docs) {
      const uid = String(doc.uid || doc.id || '').trim();
      const aadhaar = normalizeAadhaar(doc.aadhar);
      const patch = buildProfilePatch(doc);
      const found = await pool.query(
        `SELECT id, profile_json, address, phone, username, workflow_mode, active
         FROM users
         WHERE role = 'VCT'
           AND (
             profile_json->>'firebaseUid' = $1
             OR ($2 <> '' AND aadhaar = $2)
           )
         LIMIT 1`,
        [uid, aadhaar],
      );
      if (!found.rowCount) {
        stats.missing += 1;
        if (uid) stats.missingUids.push(uid);
        continue;
      }
      stats.matched += 1;
      const row = found.rows[0];
      const merged = {
        ...(row.profile_json && typeof row.profile_json === 'object' ? row.profile_json : {}),
        ...patch,
      };
      // Preserve local media paths if already on VPS.
      for (const key of [
        'profilePhotoLocalPath',
        'aadharDocLocalPath',
        'biodataDocLocalPath',
        'educationCertDocLocalPath',
        'pccDocLocalPath',
      ]) {
        const existing = row.profile_json?.[key];
        if (typeof existing === 'string' && existing.startsWith('media/yesgatc/')) {
          merged[key] = existing;
        }
      }

      if (dryRun) {
        stats.updated += 1;
        continue;
      }

      await pool.query(
        `UPDATE users SET
           username = COALESCE(NULLIF(TRIM($2), ''), username),
           phone = COALESCE(NULLIF(TRIM($3), ''), phone),
           address = COALESCE(NULLIF(TRIM($4), ''), address),
           profile_json = $5::jsonb,
           workflow_mode = $6,
           active = $7,
           updated_at = NOW()
         WHERE id = $1`,
        [
          row.id,
          doc.username || null,
          doc.phone || null,
          doc.address || null,
          JSON.stringify(merged),
          workflowMode(doc),
          isActiveUser(doc),
        ],
      );
      stats.updated += 1;
    }
  } finally {
    await pool.end();
  }

  console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
