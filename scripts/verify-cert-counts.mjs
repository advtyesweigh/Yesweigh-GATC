/**
 * Print Postgres counts for yesgatc cert import tables.
 * Never prints secrets.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const require = createRequire(join(REPO_ROOT, 'package.json'));
const pg = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: join(REPO_ROOT, '.env') });

const { Client } = pg;

async function main() {
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const rows = await client.query(`
      SELECT 'products' AS t, COUNT(*)::int AS n FROM products
      UNION ALL SELECT 'customers', COUNT(*)::int FROM customers
      UNION ALL SELECT 'verifications', COUNT(*)::int FROM verifications
      UNION ALL SELECT 'verification_media', COUNT(*)::int FROM verification_media
      UNION ALL SELECT 'doca_certificates', COUNT(*)::int FROM doca_certificates
      UNION ALL SELECT 'verifications_with_firebase_id', COUNT(*)::int FROM verifications WHERE source_firebase_id IS NOT NULL
      UNION ALL SELECT 'verifications_with_cert_no', COUNT(*)::int FROM verifications WHERE certificate_number IS NOT NULL
      UNION ALL SELECT 'media_with_source_url', COUNT(*)::int FROM verification_media WHERE source_url IS NOT NULL
      UNION ALL SELECT 'media_local_paths', COUNT(*)::int FROM verification_media
        WHERE file_path IS NOT NULL AND file_path NOT LIKE 'http%' AND file_path <> ''
    `);

    let dataRootFiles = null;
    const dataRoot = process.env.DATA_ROOT || '';
    if (dataRoot && existsSync(join(dataRoot, 'media', 'yesgatc'))) {
      // shallow presence only
      dataRootFiles = 'media/yesgatc present';
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          counts: Object.fromEntries(rows.rows.map((r) => [r.t, r.n])),
          dataRootMedia: dataRootFiles,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
