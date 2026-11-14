#!/usr/bin/env node
/**
 * Backfill RC logoUrl / VCT profilePhotoUrl into Postgres from a yesgatc users export.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/backfill-media-urls.mjs --file=.tmp/yesgatc-users-export.json
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const { Client } = pg;

function argValue(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1).trim() : '';
}

function loadDocs(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.users)) return raw.users;
  if (Array.isArray(raw.docs)) return raw.docs;
  return Object.values(raw).filter((x) => x && typeof x === 'object' && x.uid);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const file = argValue('--file') || '.tmp/yesgatc-users-export.json';
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`Export not found: ${abs}`);
    process.exit(1);
  }

  const docs = loadDocs(abs);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let rcUpdated = 0;
  let vctUpdated = 0;

  try {
    for (const doc of docs) {
      const uid = doc?.uid;
      if (!uid) continue;

      if (doc.role === 'rc_admin' && (doc.logoUrl || doc.logoPath)) {
        const result = await client.query(
          `UPDATE regional_centers
           SET fees_json = COALESCE(fees_json, '{}'::jsonb)
             || jsonb_strip_nulls(jsonb_build_object(
                  'logoUrl', $2::text,
                  'logoPath', $3::text,
                  'logoName', $4::text,
                  'logoContentType', $5::text,
                  'sealUrl', $6::text,
                  'sealPath', $7::text
                )),
               updated_at = NOW()
           WHERE fees_json->>'firebaseUid' = $1
           RETURNING id, code`,
          [
            uid,
            doc.logoUrl || null,
            doc.logoPath || null,
            doc.logoName || null,
            doc.logoContentType || null,
            doc.sealUrl || null,
            doc.sealPath || null,
          ],
        );
        if (result.rowCount) rcUpdated += 1;
      }

      if (doc.role === 'vct' && (doc.profilePhotoUrl || doc.profilePhotoPath)) {
        const result = await client.query(
          `UPDATE users
           SET profile_json = COALESCE(profile_json, '{}'::jsonb)
             || jsonb_strip_nulls(jsonb_build_object(
                  'profilePhotoUrl', $2::text,
                  'profilePhotoPath', $3::text,
                  'profilePhotoName', $4::text,
                  'profilePhotoContentType', $5::text
                )),
               updated_at = NOW()
           WHERE profile_json->>'firebaseUid' = $1 AND role = 'VCT'
           RETURNING id`,
          [
            uid,
            doc.profilePhotoUrl || null,
            doc.profilePhotoPath || null,
            doc.profilePhotoName || null,
            doc.profilePhotoContentType || null,
          ],
        );
        if (result.rowCount) vctUpdated += 1;
      }
    }
  } finally {
    await client.end();
  }

  console.log(JSON.stringify({ ok: true, docs: docs.length, rcUpdated, vctUpdated }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
