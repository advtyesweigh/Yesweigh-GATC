/**
 * Diagnose why download-yesgatc-cert-media finds 0 rows.
 * Prints counts only — no URLs, no secrets.
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const require = createRequire(join(REPO_ROOT, 'package.json'));
const { Client } = require('pg');

for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 1) continue;
  if (!process.env[t.slice(0, i).trim()]) {
    process.env[t.slice(0, i).trim()] = t.slice(i + 1);
  }
}

async function main() {
  const dataRoot = process.env.DATA_ROOT || '';
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const exactSql = `
      SELECT COUNT(*)::int AS n
      FROM verification_media vm
      JOIN verifications v ON v.id = vm.verification_id
      WHERE vm.kind IN ('certificate_pdf','signed_certificate_pdf')
        AND vm.source_url IS NOT NULL
        AND vm.source_url LIKE 'http%'
        AND vm.source_url NOT ILIKE '%emaap.gov.in%'
        AND (
          vm.file_path IS NULL
          OR vm.file_path = ''
          OR vm.file_path LIKE 'http%'
          OR vm.file_path = vm.source_url
          OR vm.file_path NOT LIKE 'media/yesgatc/%'
        )`;

  const exact = await client.query(exactSql);
  const noJoin = await client.query(`
      SELECT COUNT(*)::int AS n
      FROM verification_media vm
      WHERE vm.kind IN ('certificate_pdf','signed_certificate_pdf')
        AND vm.source_url IS NOT NULL
        AND vm.source_url LIKE 'http%'
        AND vm.source_url NOT ILIKE '%emaap.gov.in%'
        AND (
          vm.file_path IS NULL
          OR vm.file_path = ''
          OR vm.file_path LIKE 'http%'
          OR vm.file_path = vm.source_url
          OR vm.file_path NOT LIKE 'media/yesgatc/%'
        )`);
  const orphan = await client.query(`
      SELECT COUNT(*)::int AS n
      FROM verification_media vm
      LEFT JOIN verifications v ON v.id = vm.verification_id
      WHERE vm.kind IN ('certificate_pdf','signed_certificate_pdf')
        AND v.id IS NULL`);
  const pathLens = await client.query(`
      SELECT
        COUNT(*)::int AS cert_n,
        COUNT(*) FILTER (WHERE file_path LIKE 'media/yesgatc/%')::int AS local_slash,
        COUNT(*) FILTER (WHERE file_path LIKE 'media\\yesgatc\\%')::int AS local_backslash,
        COUNT(*) FILTER (WHERE file_path LIKE 'siteCalibrations/%')::int AS firebase_rel,
        COUNT(*) FILTER (WHERE TRIM(file_path) LIKE 'siteCalibrations/%')::int AS firebase_rel_trim,
        COUNT(*) FILTER (WHERE file_path LIKE 'http%')::int AS http_path,
        MIN(LENGTH(file_path))::int AS min_len,
        MAX(LENGTH(file_path))::int AS max_len,
        COUNT(*) FILTER (WHERE file_path ~ E'\\r|\\n|\\u0000')::int AS weird_chars
      FROM verification_media
      WHERE kind IN ('certificate_pdf','signed_certificate_pdf')`);

  // Show distinct path prefixes (first path segment) — no full paths with ids if avoidable
  const prefixes = await client.query(`
      SELECT
        split_part(replace(file_path, '\\', '/'), '/', 1) AS seg1,
        COUNT(*)::int AS n
      FROM verification_media
      WHERE kind IN ('certificate_pdf','signed_certificate_pdf')
      GROUP BY 1 ORDER BY n DESC LIMIT 20`);

  const docaExact = await client.query(`
        SELECT COUNT(*)::int AS n
        FROM doca_certificates
        WHERE certificate_pdf_url IS NOT NULL
          AND certificate_pdf_url LIKE 'http%'
          AND certificate_pdf_url NOT ILIKE '%emaap.gov.in%'
          AND (
            certificate_pdf_path IS NULL
            OR certificate_pdf_path = ''
            OR certificate_pdf_path LIKE 'http%'
            OR certificate_pdf_path = certificate_pdf_url
            OR certificate_pdf_path NOT LIKE 'media/yesgatc/%'
          )`);

  const dbName = await client.query(
    `SELECT current_database() AS db, current_user AS usr,
            inet_server_addr()::text AS addr, inet_server_port() AS port`,
  );

  let mediaTree = null;
  const mediaRoot = dataRoot ? join(dataRoot, 'media', 'yesgatc') : '';
  if (mediaRoot && existsSync(mediaRoot)) {
    let files = 0;
    let bytes = 0;
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else {
          files += 1;
          bytes += st.size;
        }
      }
    };
    walk(mediaRoot);
    mediaTree = { files, bytes };
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        db: {
          name: dbName.rows[0].db,
          user: dbName.rows[0].usr,
          // host/port only — no password
          addr: dbName.rows[0].addr,
          port: dbName.rows[0].port,
        },
        dataRootSet: Boolean(dataRoot),
        dataRootTail: dataRoot ? dataRoot.replace(/\\/g, '/').slice(-32) : null,
        exactJoinCount: exact.rows[0].n,
        noJoinCount: noJoin.rows[0].n,
        orphanMedia: orphan.rows[0].n,
        pathLens: pathLens.rows[0],
        prefixes: prefixes.rows,
        docaExact: docaExact.rows[0].n,
        mediaTree,
      },
      null,
      2,
    ),
  );
  await client.end();
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
