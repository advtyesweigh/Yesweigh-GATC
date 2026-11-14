/**
 * Purge local OV images after certification per media retention policy.
 * Keeps `scale_image` only; never deletes RV images or PDFs.
 *
 * See scripts/lib/media-retention.mjs for the full policy.
 *
 * Usage:
 *   node scripts/cleanup-ov-media-retention.mjs --dry-run
 *   node scripts/cleanup-ov-media-retention.mjs --apply
 *   node scripts/cleanup-ov-media-retention.mjs --apply --limit=100
 *
 * Env: DATABASE_URL, DATA_ROOT (from repo .env)
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OV_POST_CERT_KEEP_IMAGE_KIND,
  purgeOvPostCertLocalImages,
} from './lib/media-retention.mjs';

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

function argValue(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1).trim() : '';
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function main() {
  const dataRoot = process.env.DATA_ROOT || '';
  if (!dataRoot) throw new Error('DATA_ROOT required');
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL required');

  const apply = hasFlag('--apply');
  const dryRun = hasFlag('--dry-run') || !apply;
  if (hasFlag('--dry-run') && apply) {
    throw new Error('Use either --dry-run or --apply, not both');
  }
  const limit = Number(argValue('--limit') || '0') || 0;

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const stats = await purgeOvPostCertLocalImages({
      pool,
      dataRoot,
      dryRun,
      limit,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          policyKeepKind: OV_POST_CERT_KEEP_IMAGE_KIND,
          rvUntouched: true,
          pdfsUntouched: true,
          ...stats,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
