/**
 * Download certificate PDFs already imported as verification_media / doca_certificates
 * into DATA_ROOT. Idempotent; skips files that already exist locally.
 *
 * Usage:
 *   node scripts/download-yesgatc-cert-media.mjs
 *   node scripts/download-yesgatc-cert-media.mjs --limit=50
 *   node scripts/download-yesgatc-cert-media.mjs --include-doca
 */

import { createRequire } from 'node:module';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PROGRESS_PATH = join(REPO_ROOT, '.tmp', 'cert-media-download.progress');
const require = createRequire(join(REPO_ROOT, 'package.json'));
const { Client } = require('pg');

function writeProgress(stats) {
  try {
    mkdirSync(dirname(PROGRESS_PATH), { recursive: true });
    writeFileSync(
      PROGRESS_PATH,
      JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...stats }) + '\n',
    );
  } catch {
    /* best-effort heartbeat */
  }
}

// Always apply repo .env (override parent-shell values). PowerShell Set-Item can
// mangle DATABASE_URL and leave Node with a bad connection that returns 0 rows.
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

function extFor(contentType, url) {
  if (contentType?.includes('pdf')) return '.pdf';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
  if (contentType?.includes('png')) return '.png';
  const fromUrl = extname(String(url || '').split('?')[0] || '');
  if (fromUrl && fromUrl.length <= 5) return fromUrl;
  return '.pdf';
}

async function downloadTo(url, destPath) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  mkdirSync(dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
}

async function main() {
  const dataRoot = process.env.DATA_ROOT || '';
  if (!dataRoot) throw new Error('DATA_ROOT required');
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL required');
  const limit = Number(argValue('--limit') || '0') || 0;
  const includeDoca = hasFlag('--include-doca');

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const stats = {
    considered: 0,
    downloaded: 0,
    skippedExisting: 0,
    failed: 0,
    errors: [],
  };
  writeProgress(stats);

  try {
    // Prefer Firebase Storage PDFs. eMAAP public portal URLs often fail from VPS
    // (TLS/network) — keep metadata URLs; skip download attempts for emaap.gov.in.
    let sql = `
      SELECT vm.id, vm.kind, vm.source_url, vm.content_type, v.source_firebase_id
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
        )
      ORDER BY CASE WHEN vm.source_url ILIKE '%firebasestorage.googleapis.com%' THEN 0 ELSE 1 END,
               vm.created_at`;
    if (limit > 0) sql += ` LIMIT ${limit}`;

    const rows = await client.query(sql);
    for (const row of rows.rows) {
      stats.considered += 1;
      const ext = extFor(row.content_type, row.source_url);
      const rel = join(
        'media',
        'yesgatc',
        'siteCalibrations',
        row.source_firebase_id || row.id,
        `${row.kind}${ext}`,
      ).replace(/\\/g, '/');
      const abs = join(dataRoot, rel);
      if (existsSync(abs)) {
        stats.skippedExisting += 1;
        await client.query(
          `UPDATE verification_media SET file_path = $2 WHERE id = $1 AND (file_path IS DISTINCT FROM $2)`,
          [row.id, rel],
        );
        continue;
      }
      try {
        await downloadTo(row.source_url, abs);
        await client.query(`UPDATE verification_media SET file_path = $2 WHERE id = $1`, [
          row.id,
          rel,
        ]);
        stats.downloaded += 1;
        if (stats.downloaded % 5 === 0 || stats.downloaded === 1) {
          writeProgress(stats);
        }
        if (stats.downloaded % 25 === 0) {
          process.stderr.write(`downloaded ${stats.downloaded}/${stats.considered}\n`);
        }
      } catch (error) {
        stats.failed += 1;
        if (stats.errors.length < 15) {
          stats.errors.push({
            kind: row.kind,
            error: error.message,
            host: (() => {
              try {
                return new URL(row.source_url).host;
              } catch {
                return '?';
              }
            })(),
          });
        }
      }
    }

    writeProgress(stats);

    if (includeDoca) {
      let docaSql = `
        SELECT id, source_firebase_id, certificate_pdf_url, certificate_pdf_path
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
          )`;
      if (limit > 0) docaSql += ` LIMIT ${limit}`;
      const doca = await client.query(docaSql);
      for (const row of doca.rows) {
        stats.considered += 1;
        const rel = join(
          'media',
          'yesgatc',
          'docaCertificates',
          row.source_firebase_id,
          'certificate_pdf.pdf',
        ).replace(/\\/g, '/');
        const abs = join(dataRoot, rel);
        if (existsSync(abs)) {
          stats.skippedExisting += 1;
          continue;
        }
        try {
          await downloadTo(row.certificate_pdf_url, abs);
          await client.query(
            `UPDATE doca_certificates SET certificate_pdf_path = $2, updated_at = NOW() WHERE id = $1`,
            [row.id, rel],
          );
          stats.downloaded += 1;
          if (stats.downloaded % 5 === 0) writeProgress(stats);
        } catch (error) {
          stats.failed += 1;
          if (stats.errors.length < 15) {
            stats.errors.push({ kind: 'doca_certificate_pdf', error: error.message });
          }
        }
      }
    }

    writeProgress(stats);
    console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
