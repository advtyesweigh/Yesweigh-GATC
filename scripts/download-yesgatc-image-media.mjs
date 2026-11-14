/**
 * Resume-safe download of verification evidence images into $DATA_ROOT.
 * Respects media retention (see scripts/lib/media-retention.mjs):
 * - RV: all image kinds
 * - OV uncertified: all image kinds
 * - OV certified: only `scale_image` (kept product+weight thumbnail)
 *
 * Layout:
 *   $DATA_ROOT/media/yesgatc/siteCalibrations/<firebaseId>/<kind>.<ext>
 *
 * Usage:
 *   npm run yesgatc:download-image-media
 *   node scripts/download-yesgatc-image-media.mjs --dry-run
 *   node scripts/download-yesgatc-image-media.mjs --limit=50 --concurrency=6
 *   node scripts/download-yesgatc-image-media.mjs --only-keep  # certified OV scale_image only
 *   node scripts/download-yesgatc-image-media.mjs --pre-cert   # submitted/draft/pending_rc/… all kinds
 *   node scripts/download-yesgatc-image-media.mjs --status=submitted
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
import {
  IMAGE_MEDIA_KINDS,
  OV_POST_CERT_KEEP_IMAGE_KIND,
  isLocalVpsMediaPath,
  isVerificationCertified,
  shouldDownloadImageLocally,
} from './lib/media-retention.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PROGRESS_PATH = join(REPO_ROOT, '.tmp', 'image-media-download.progress');
const FAIL_LOG_PATH = join(REPO_ROOT, '.tmp', 'image-media-download.failures.jsonl');
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
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('gif')) return '.gif';
  const fromUrl = extname(String(url || '').split('?')[0] || '');
  if (fromUrl && fromUrl.length <= 5) return fromUrl;
  return '.jpg';
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}

function needsLocalPath(filePath) {
  if (filePath == null) return true;
  const p = String(filePath).trim();
  if (!p) return true;
  if (p.startsWith('http')) return true;
  if (isLocalVpsMediaPath(p)) return false;
  return true;
}

async function downloadTo(url, destPath) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'image/*,*/*',
      'User-Agent': 'gatc-vps-image-media-download/1.0',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const tmp = `${destPath}.part`;
  mkdirSync(dirname(destPath), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));
    const size = statSync(tmp).size;
    if (size < 32) throw new Error(`file too small (${size} bytes)`);
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

async function main() {
  const dataRoot = process.env.DATA_ROOT || '';
  if (!dataRoot) throw new Error('DATA_ROOT required');
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL required');

  const limit = Number(argValue('--limit') || '0') || 0;
  const concurrency = Math.max(1, Number(argValue('--concurrency') || '4') || 4);
  const retries = Math.max(0, Number(argValue('--retries') || '2') || 2);
  const dryRun = hasFlag('--dry-run');
  const onlyKeep = hasFlag('--only-keep');
  const preCert = hasFlag('--pre-cert');
  const statusFilter = (argValue('--status') || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const kinds = onlyKeep ? [OV_POST_CERT_KEEP_IMAGE_KIND] : [...IMAGE_MEDIA_KINDS];

  const pool = new Pool({
    connectionString: databaseUrl,
    max: Math.max(4, concurrency + 2),
  });

  const stats = {
    kinds,
    onlyKeep,
    preCert,
    statusFilter,
    dryRun,
    concurrency,
    retries,
    keepKind: OV_POST_CERT_KEEP_IMAGE_KIND,
    considered: 0,
    retentionSkipped: 0,
    linkedExisting: 0,
    downloaded: 0,
    skippedExisting: 0,
    failed: 0,
    bytesDownloaded: 0,
    byTypeKind: {},
    byStatus: {},
    errors: [],
    dataRoot,
  };
  writeProgress(stats);

  try {
    const params = [kinds];
    let statusClause = '';
    if (preCert) {
      statusClause = `
        AND NOT (v.status IN ('certified', 'approved') OR v.certified_at IS NOT NULL)`;
    } else if (statusFilter.length) {
      params.push(statusFilter);
      statusClause = ` AND lower(v.status) = ANY($${params.length}::text[])`;
    }

    let sql = `
      SELECT vm.id, vm.kind, vm.source_url, vm.content_type, vm.file_path,
             v.source_firebase_id, v.id AS verification_id,
             v.verification_type, v.status, v.certified_at,
             v.certificate_number, v.application_number
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
        ${statusClause}
      ORDER BY CASE lower(v.status)
                 WHEN 'submitted' THEN 0
                 WHEN 'pending_rc' THEN 1
                 WHEN 'draft' THEN 2
                 ELSE 3
               END,
               CASE WHEN vm.source_url ILIKE '%firebasestorage.googleapis.com%' THEN 0 ELSE 1 END,
               CASE vm.kind WHEN 'scale_image' THEN 0 ELSE 1 END,
               vm.created_at`;
    if (limit > 0) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }

    const { rows: rawRows } = await pool.query(sql, params);
    const rows = [];
    for (const row of rawRows) {
      const certified = isVerificationCertified({
        status: row.status,
        certifiedAt: row.certified_at,
      });
      const ok = shouldDownloadImageLocally({
        verificationType: row.verification_type,
        kind: row.kind,
        certified,
      });
      if (!ok) {
        stats.retentionSkipped += 1;
        continue;
      }
      rows.push(row);
      const st = String(row.status || '').toLowerCase() || '(none)';
      stats.byStatus[st] = (stats.byStatus[st] || 0) + 1;
    }
    stats.considered = rows.length;
    writeProgress(stats);
    process.stderr.write(
      `image-media: ${rows.length} pending (retention skipped ${stats.retentionSkipped}); concurrency=${concurrency}\n`,
    );

    await mapPool(rows, concurrency, async (row) => {
      const key = `${row.verification_type}:${row.kind}`;
      stats.byTypeKind[key] = (stats.byTypeKind[key] || 0) + 1;

      const ext = extFor(row.content_type, row.source_url);
      const rel = join(
        'media',
        'yesgatc',
        'siteCalibrations',
        row.source_firebase_id || String(row.verification_id),
        `${row.kind}${ext}`,
      ).replace(/\\/g, '/');
      const abs = join(dataRoot, rel);

      if (existsSync(abs) && statSync(abs).size >= 32) {
        if (!dryRun && needsLocalPath(row.file_path)) {
          await pool.query(
            `UPDATE verification_media SET file_path = $2 WHERE id = $1 AND (file_path IS DISTINCT FROM $2)`,
            [row.id, rel],
          );
        }
        stats.linkedExisting += 1;
        stats.skippedExisting += 1;
        if ((stats.linkedExisting + stats.downloaded) % 50 === 0) writeProgress(stats);
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
          if (stats.downloaded % 10 === 0 || stats.downloaded === 1) writeProgress(stats);
          if (stats.downloaded % 50 === 0) {
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
        host: hostOf(row.source_url),
        error: lastError?.message || String(lastError),
      };
      appendFailure(errEntry);
      if (stats.errors.length < 25) stats.errors.push(errEntry);
      writeProgress(stats);
    });

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
