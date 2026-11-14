/**
 * Resume-safe download of verification certificate PDFs from Firebase (and other
 * HTTP source_url values) into $DATA_ROOT. Updates verification_media.file_path
 * to local relative paths so the SA UI can serve them from the VPS.
 *
 * Evidence images: scripts/download-yesgatc-image-media.mjs (+ media retention
 * in scripts/lib/media-retention.mjs — OV post-cert keeps scale_image only).
 *
 * Layout:
 *   $DATA_ROOT/media/yesgatc/siteCalibrations/<firebaseId>/<kind>.pdf
 *   $DATA_ROOT/media/yesgatc/docaCertificates/<firebaseId>/certificate_pdf.pdf
 *
 * Usage:
 *   npm run yesgatc:download-cert-media
 *   node scripts/download-yesgatc-cert-media.mjs
 *   node scripts/download-yesgatc-cert-media.mjs --limit=50
 *   node scripts/download-yesgatc-cert-media.mjs --concurrency=6 --retries=2
 *   node scripts/download-yesgatc-cert-media.mjs --include-doca
 *   node scripts/download-yesgatc-cert-media.mjs --include-old
 *   node scripts/download-yesgatc-cert-media.mjs --dry-run
 *
 * Env: DATABASE_URL, DATA_ROOT (from repo .env)
 */

import { createRequire } from 'node:module';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PROGRESS_PATH = join(REPO_ROOT, '.tmp', 'cert-media-download.progress');
const FAIL_LOG_PATH = join(REPO_ROOT, '.tmp', 'cert-media-download.failures.jsonl');
const require = createRequire(join(REPO_ROOT, 'package.json'));
const { Pool } = require('pg');

const PDF_KINDS = ['certificate_pdf', 'signed_certificate_pdf'];
const OLD_KIND = 'old_verification_certificate';

// Always apply repo .env (override parent-shell values).
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

function writeProgress(stats) {
  try {
    mkdirSync(dirname(PROGRESS_PATH), { recursive: true });
    writeFileSync(
      PROGRESS_PATH,
      `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...stats })}\n`,
    );
  } catch {
    /* best-effort */
  }
}

function appendFailure(entry) {
  try {
    mkdirSync(dirname(FAIL_LOG_PATH), { recursive: true });
    writeFileSync(FAIL_LOG_PATH, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`, {
      flag: 'a',
    });
  } catch {
    /* best-effort */
  }
}

function extFor(contentType, url) {
  if (contentType?.includes('pdf')) return '.pdf';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
  if (contentType?.includes('png')) return '.png';
  const fromUrl = extname(String(url || '').split('?')[0] || '');
  if (fromUrl && fromUrl.length <= 5) return fromUrl;
  return '.pdf';
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}

function diskUsage(dir) {
  try {
    const out = execFileSync('du', ['-sh', dir], { encoding: 'utf8' }).trim();
    return out.split(/\s+/)[0] || out;
  } catch {
    return null;
  }
}

function countPdfs(dir) {
  try {
    const out = execFileSync('find', [dir, '-type', 'f', '-name', '*.pdf'], {
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean).length;
  } catch {
    return null;
  }
}

async function downloadTo(url, destPath) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      // Some Firebase tokens work better with a browser-like Accept.
      Accept: 'application/pdf,*/*',
      'User-Agent': 'gatc-vps-cert-media-download/1.0',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const tmp = `${destPath}.part`;
  mkdirSync(dirname(destPath), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));
    const size = statSync(tmp).size;
    if (size < 64) throw new Error(`file too small (${size} bytes)`);
    renameSync(tmp, destPath);
    return size;
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await worker(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

function needsLocalPath(filePath) {
  if (filePath == null) return true;
  const p = String(filePath).trim();
  if (!p) return true;
  if (p.startsWith('http')) return true;
  if (p.startsWith('media/yesgatc/')) return false;
  return true;
}

async function main() {
  const dataRoot = process.env.DATA_ROOT || '';
  if (!dataRoot) throw new Error('DATA_ROOT required');
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL required');

  const limit = Number(argValue('--limit') || '0') || 0;
  const concurrency = Math.max(1, Number(argValue('--concurrency') || '4') || 4);
  const retries = Math.max(0, Number(argValue('--retries') || '2') || 2);
  const includeDoca = hasFlag('--include-doca');
  const includeOld = hasFlag('--include-old');
  const dryRun = hasFlag('--dry-run');

  const kinds = [...PDF_KINDS];
  if (includeOld) kinds.push(OLD_KIND);

  // Pool — downloads run concurrently; never share one Client across workers.
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Math.max(4, concurrency + 2),
  });

  const stats = {
    kinds,
    dryRun,
    concurrency,
    retries,
    considered: 0,
    linkedExisting: 0,
    downloaded: 0,
    skippedExisting: 0,
    failed: 0,
    bytesDownloaded: 0,
    errors: [],
    dataRoot,
  };
  writeProgress(stats);

  try {
    const totals = await pool.query(
      `
      SELECT
        COUNT(DISTINCT v.id)::int AS verifications_with_pdf_url,
        COUNT(*)::int AS media_rows,
        COUNT(*) FILTER (WHERE vm.file_path LIKE 'media/yesgatc/%')::int AS already_local,
        COUNT(*) FILTER (
          WHERE vm.source_url ~* '^https?://'
            AND vm.source_url NOT ILIKE '%emaap.gov.in%'
            AND (
              vm.file_path IS NULL
              OR TRIM(vm.file_path) = ''
              OR vm.file_path LIKE 'http%'
              OR vm.file_path = vm.source_url
              OR vm.file_path NOT LIKE 'media/yesgatc/%'
            )
        )::int AS pending_download
      FROM verification_media vm
      JOIN verifications v ON v.id = vm.verification_id
      WHERE vm.kind = ANY($1::text[])
        AND vm.source_url ~* '^https?://'
      `,
      [kinds],
    );
    stats.preflight = totals.rows[0];

    let sql = `
      SELECT vm.id, vm.kind, vm.source_url, vm.content_type, vm.file_path,
             v.source_firebase_id, v.id AS verification_id,
             v.certificate_number, v.rc_id
      FROM verification_media vm
      JOIN verifications v ON v.id = vm.verification_id
      WHERE vm.kind = ANY($1::text[])
        AND vm.source_url IS NOT NULL
        AND vm.source_url LIKE 'http%'
        AND vm.source_url NOT ILIKE '%emaap.gov.in%'
        AND (
          vm.file_path IS NULL
          OR TRIM(vm.file_path) = ''
          OR vm.file_path LIKE 'http%'
          OR vm.file_path = vm.source_url
          OR vm.file_path NOT LIKE 'media/yesgatc/%'
        )
      ORDER BY CASE WHEN vm.source_url ILIKE '%firebasestorage.googleapis.com%' THEN 0 ELSE 1 END,
               CASE vm.kind
                 WHEN 'signed_certificate_pdf' THEN 0
                 WHEN 'certificate_pdf' THEN 1
                 ELSE 2
               END,
               vm.created_at`;
    const params = [kinds];
    if (limit > 0) {
      sql += ` LIMIT $2`;
      params.push(limit);
    }

    const { rows } = await pool.query(sql, params);
    stats.considered = rows.length;
    writeProgress(stats);
    process.stderr.write(
      `cert-media: ${rows.length} pending (local already ${stats.preflight.already_local}); concurrency=${concurrency}\n`,
    );

    await mapPool(rows, concurrency, async (row) => {
      const ext = extFor(row.content_type, row.source_url);
      const rel = join(
        'media',
        'yesgatc',
        'siteCalibrations',
        row.source_firebase_id || String(row.verification_id),
        `${row.kind}${ext}`,
      ).replace(/\\/g, '/');
      const abs = join(dataRoot, rel);

      if (existsSync(abs) && statSync(abs).size >= 64) {
        if (!dryRun && needsLocalPath(row.file_path)) {
          await pool.query(
            `UPDATE verification_media SET file_path = $2 WHERE id = $1 AND (file_path IS DISTINCT FROM $2)`,
            [row.id, rel],
          );
        }
        stats.linkedExisting += 1;
        stats.skippedExisting += 1;
        if ((stats.linkedExisting + stats.downloaded) % 25 === 0) writeProgress(stats);
        return;
      }

      if (dryRun) {
        stats.downloaded += 1;
        return;
      }

      let lastError = null;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const bytes = await downloadTo(row.source_url, abs);
          await pool.query(`UPDATE verification_media SET file_path = $2 WHERE id = $1`, [
            row.id,
            rel,
          ]);
          stats.downloaded += 1;
          stats.bytesDownloaded += bytes;
          if (stats.downloaded % 5 === 0 || stats.downloaded === 1) writeProgress(stats);
          if (stats.downloaded % 25 === 0) {
            process.stderr.write(
              `downloaded ${stats.downloaded}/${stats.considered} (failed ${stats.failed}, linked ${stats.linkedExisting})\n`,
            );
          }
          return;
        } catch (error) {
          lastError = error;
          if (attempt < retries) {
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          }
        }
      }

      stats.failed += 1;
      const errEntry = {
        id: row.id,
        kind: row.kind,
        verificationId: row.verification_id,
        firebaseId: row.source_firebase_id,
        certificateNumber: row.certificate_number,
        host: hostOf(row.source_url),
        error: lastError?.message || String(lastError),
      };
      appendFailure(errEntry);
      if (stats.errors.length < 25) stats.errors.push(errEntry);
      writeProgress(stats);
    });

    if (includeDoca) {
      let docaSql = `
        SELECT id, source_firebase_id, certificate_pdf_url, certificate_pdf_path
        FROM doca_certificates
        WHERE certificate_pdf_url IS NOT NULL
          AND certificate_pdf_url LIKE 'http%'
          AND certificate_pdf_url NOT ILIKE '%emaap.gov.in%'
          AND (
            certificate_pdf_path IS NULL
            OR TRIM(certificate_pdf_path) = ''
            OR certificate_pdf_path LIKE 'http%'
            OR certificate_pdf_path = certificate_pdf_url
            OR certificate_pdf_path NOT LIKE 'media/yesgatc/%'
          )`;
      if (limit > 0) docaSql += ` LIMIT ${limit}`;
      const doca = await pool.query(docaSql);
      for (const row of doca.rows) {
        stats.considered += 1;
        const rel = join(
          'media',
          'yesgatc',
          'docaCertificates',
          row.source_firebase_id || row.id,
          'certificate_pdf.pdf',
        ).replace(/\\/g, '/');
        const abs = join(dataRoot, rel);
        if (existsSync(abs) && statSync(abs).size >= 64) {
          if (!dryRun) {
            await pool.query(
              `UPDATE doca_certificates SET certificate_pdf_path = $2, updated_at = NOW() WHERE id = $1`,
              [row.id, rel],
            );
          }
          stats.linkedExisting += 1;
          stats.skippedExisting += 1;
          continue;
        }
        if (dryRun) {
          stats.downloaded += 1;
          continue;
        }
        try {
          const bytes = await downloadTo(row.certificate_pdf_url, abs);
          await pool.query(
            `UPDATE doca_certificates SET certificate_pdf_path = $2, updated_at = NOW() WHERE id = $1`,
            [row.id, rel],
          );
          stats.downloaded += 1;
          stats.bytesDownloaded += bytes;
        } catch (error) {
          stats.failed += 1;
          const errEntry = {
            kind: 'doca_certificate_pdf',
            id: row.id,
            error: error.message,
            host: hostOf(row.certificate_pdf_url),
          };
          appendFailure(errEntry);
          if (stats.errors.length < 25) stats.errors.push(errEntry);
        }
      }
    }

    const after = await pool.query(
      `
      SELECT
        COUNT(DISTINCT v.id)::int AS verifications_with_local_pdf,
        COUNT(*) FILTER (WHERE vm.file_path LIKE 'media/yesgatc/%')::int AS local_media_rows
      FROM verification_media vm
      JOIN verifications v ON v.id = vm.verification_id
      WHERE vm.kind = ANY($1::text[])
      `,
      [kinds],
    );
    stats.postflight = after.rows[0];
    stats.disk = {
      mediaRoot: join(dataRoot, 'media'),
      usage: diskUsage(join(dataRoot, 'media')),
      pdfFiles: countPdfs(join(dataRoot, 'media')),
    };
    writeProgress(stats);
    console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
