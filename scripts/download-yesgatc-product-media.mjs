#!/usr/bin/env node
/**
 * Resume-safe download of product catalogue images (+ optional approval docs)
 * into $DATA_ROOT.
 *
 * Layout:
 *   $DATA_ROOT/media/yesgatc/products/<firebaseOrUuid>/image.<ext>
 *   $DATA_ROOT/media/yesgatc/products/<firebaseOrUuid>/approval_doc.<ext>
 *
 * Updates products:
 *   - image_url / approval_doc_url  → Firebase (or other) HTTP source URL
 *   - image_path / approval_doc_path → local media/yesgatc/… path when on disk
 *
 * URL resolution order per product:
 *   1. products.image_url / approval_doc_url (if http)
 *   2. --urls-file / .tmp/yesgatc-certs-export.json productImageUrl / modelApprovalDocUrl
 *   3. (image only) skip if only storage path and no URL
 *
 * Usage:
 *   npm run yesgatc:download-product-media
 *   node scripts/download-yesgatc-product-media.mjs --dry-run
 *   node scripts/download-yesgatc-product-media.mjs --approval-docs --concurrency=4
 *   node scripts/download-yesgatc-product-media.mjs --urls-file=.tmp/yesgatc-certs-export.json
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
import { isLocalVpsMediaPath } from './lib/media-retention.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PROGRESS_PATH = join(REPO_ROOT, '.tmp', 'product-media-download.progress');
const FAIL_LOG_PATH = join(REPO_ROOT, '.tmp', 'product-media-download.failures.jsonl');
const DEFAULT_URLS_FILE = join(REPO_ROOT, '.tmp', 'yesgatc-certs-export.json');
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

function extFor(contentType, url, fallback = '.jpg') {
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('gif')) return '.gif';
  if (contentType?.includes('pdf')) return '.pdf';
  const fromUrl = extname(String(url || '').split('?')[0] || '');
  if (fromUrl && fromUrl.length <= 5) return fromUrl;
  return fallback;
}

function httpUrl(value) {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  return /^https?:\/\//i.test(t) ? t : '';
}

function loadUrlMap(filePath) {
  const map = new Map();
  if (!filePath || !existsSync(filePath)) return map;
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return map;
  }
  const products = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.products)
      ? raw.products
      : [];
  for (const doc of products) {
    const id = String(doc?.id || doc?.source_firebase_id || '').trim();
    if (!id) continue;
    map.set(id, {
      imageUrl: httpUrl(doc.productImageUrl || doc.imageUrl || doc.image_url),
      approvalUrl: httpUrl(
        doc.modelApprovalDocUrl || doc.approvalDocUrl || doc.approval_doc_url,
      ),
      imagePath: typeof doc.productImagePath === 'string' ? doc.productImagePath.trim() : '',
      approvalPath:
        typeof doc.modelApprovalDocPath === 'string' ? doc.modelApprovalDocPath.trim() : '',
    });
  }
  return map;
}

async function downloadTo(url, destPath) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'image/*,application/pdf,*/*',
      'User-Agent': 'gatc-vps-product-media-download/1.0',
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
    return { size, contentType: response.headers.get('content-type') || '' };
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

const IMAGE_JOB = {
  kind: 'image',
  pathCol: 'image_path',
  urlCol: 'image_url',
  fileStem: 'image',
  fallbackExt: '.jpg',
  exportUrlKey: 'imageUrl',
};

const APPROVAL_JOB = {
  kind: 'approval_doc',
  pathCol: 'approval_doc_path',
  urlCol: 'approval_doc_url',
  fileStem: 'approval_doc',
  fallbackExt: '.pdf',
  exportUrlKey: 'approvalUrl',
};

async function main() {
  const dataRoot = process.env.DATA_ROOT || '';
  if (!dataRoot) throw new Error('DATA_ROOT required');
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL required');

  const concurrency = Math.max(1, Number(argValue('--concurrency') || '4') || 4);
  const retries = Math.max(0, Number(argValue('--retries') || '2') || 2);
  const dryRun = hasFlag('--dry-run');
  const includeApproval = hasFlag('--approval-docs');
  const limit = Number(argValue('--limit') || '0') || 0;
  const urlsFile = resolve(argValue('--urls-file') || DEFAULT_URLS_FILE);
  const urlMap = loadUrlMap(urlsFile);
  const jobs = includeApproval ? [IMAGE_JOB, APPROVAL_JOB] : [IMAGE_JOB];

  const pool = new Pool({
    connectionString: databaseUrl,
    max: Math.max(4, concurrency + 2),
  });

  const stats = {
    dryRun,
    includeApproval,
    concurrency,
    retries,
    urlsFile: existsSync(urlsFile) ? urlsFile : null,
    urlsMapped: urlMap.size,
    considered: 0,
    downloaded: 0,
    skippedExisting: 0,
    linkedExisting: 0,
    urlBackfilled: 0,
    skippedNoUrl: 0,
    failed: 0,
    bytesDownloaded: 0,
    byKind: {},
    errors: [],
    dataRoot,
  };
  writeProgress(stats);

  try {
    // Ensure URL columns exist (migration 005).
    await pool.query(`
      ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS approval_doc_url TEXT;
    `);

    let sql = `
      SELECT id, model_id, model_no, name, source_firebase_id,
             image_path, image_url, approval_doc_path, approval_doc_url
      FROM products
      ORDER BY sort_order NULLS LAST, model_no NULLS LAST, created_at`;
    if (limit > 0) sql += ` LIMIT ${limit}`;
    const { rows } = await pool.query(sql);

    const work = [];
    for (const row of rows) {
      const firebaseId = String(row.source_firebase_id || '').trim();
      const folderId = firebaseId || String(row.id);
      const exported = (firebaseId && urlMap.get(firebaseId)) || urlMap.get(String(row.model_id || '')) || null;

      for (const job of jobs) {
        const currentPath = row[job.pathCol];
        const currentUrl = httpUrl(row[job.urlCol]);
        const exportUrl = exported?.[job.exportUrlKey] || '';
        const remote = currentUrl || exportUrl;
        const alreadyLocal =
          typeof currentPath === 'string' && isLocalVpsMediaPath(currentPath.trim());

        if (!remote && !alreadyLocal) {
          stats.skippedNoUrl += 1;
          continue;
        }

        work.push({
          productId: row.id,
          modelNo: row.model_no,
          folderId,
          job,
          remote,
          currentPath: typeof currentPath === 'string' ? currentPath.trim() : '',
          currentUrl,
          needsUrlBackfill: Boolean(exportUrl && !currentUrl),
          exportUrl,
        });
      }
    }
    stats.considered = work.length;
    writeProgress(stats);
    process.stderr.write(
      `product-media: ${work.length} jobs (urlsMapped=${urlMap.size}, noUrl=${stats.skippedNoUrl}); concurrency=${concurrency}\n`,
    );

    await mapPool(work, concurrency, async (item) => {
      const { productId, folderId, job, remote, currentPath, needsUrlBackfill, exportUrl } = item;
      const kindStats = () => {
        stats.byKind[job.kind] = stats.byKind[job.kind] || {
          downloaded: 0,
          skipped: 0,
          linked: 0,
          failed: 0,
          urlBackfilled: 0,
        };
        return stats.byKind[job.kind];
      };

      try {
        if (needsUrlBackfill && !dryRun) {
          await pool.query(
            `UPDATE products SET ${job.urlCol} = $2, updated_at = NOW()
             WHERE id = $1 AND (${job.urlCol} IS NULL OR TRIM(${job.urlCol}) = '')`,
            [productId, exportUrl],
          );
          stats.urlBackfilled += 1;
          kindStats().urlBackfilled += 1;
        }

        if (currentPath && isLocalVpsMediaPath(currentPath)) {
          const absExisting = resolve(dataRoot, currentPath);
          if (existsSync(absExisting) && statSync(absExisting).size >= 32) {
            stats.skippedExisting += 1;
            kindStats().skipped += 1;
            writeProgress(stats);
            return;
          }
        }

        const dirRel = `media/yesgatc/products/${folderId}`;
        const dirAbs = resolve(dataRoot, dirRel);
        if (existsSync(dirAbs)) {
          const candidates = [
            `${job.fileStem}.jpg`,
            `${job.fileStem}.jpeg`,
            `${job.fileStem}.png`,
            `${job.fileStem}.webp`,
            `${job.fileStem}.gif`,
            `${job.fileStem}.pdf`,
          ];
          for (const name of candidates) {
            const abs = join(dirAbs, name);
            if (existsSync(abs) && statSync(abs).size >= 32) {
              const rel = `${dirRel}/${name}`.replace(/\\/g, '/');
              if (!dryRun) {
                await pool.query(
                  `UPDATE products
                   SET ${job.pathCol} = $2,
                       ${job.urlCol} = COALESCE(NULLIF(TRIM(${job.urlCol}), ''), $3),
                       updated_at = NOW()
                   WHERE id = $1`,
                  [productId, rel, remote || null],
                );
              }
              stats.linkedExisting += 1;
              kindStats().linked += 1;
              writeProgress(stats);
              return;
            }
          }
        }

        if (!remote) {
          stats.skippedNoUrl += 1;
          return;
        }

        if (dryRun) {
          stats.downloaded += 1;
          kindStats().downloaded += 1;
          writeProgress(stats);
          return;
        }

        let lastError = null;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          try {
            const probeExt = extFor('', remote, job.fallbackExt);
            const tmpRel = `${dirRel}/${job.fileStem}${probeExt}`;
            const tmpAbs = resolve(dataRoot, tmpRel);
            const { size, contentType } = await downloadTo(remote, tmpAbs);
            const finalExt = extFor(contentType, remote, probeExt);
            let rel = tmpRel.replace(/\\/g, '/');
            if (finalExt !== probeExt) {
              const finalRel = `${dirRel}/${job.fileStem}${finalExt}`;
              const finalAbs = resolve(dataRoot, finalRel);
              renameSync(tmpAbs, finalAbs);
              rel = finalRel.replace(/\\/g, '/');
            }
            await pool.query(
              `UPDATE products
               SET ${job.pathCol} = $2,
                   ${job.urlCol} = COALESCE(NULLIF(TRIM(${job.urlCol}), ''), $3),
                   updated_at = NOW()
               WHERE id = $1`,
              [productId, rel, remote],
            );
            stats.downloaded += 1;
            stats.bytesDownloaded += size;
            kindStats().downloaded += 1;
            writeProgress(stats);
            if (stats.downloaded % 10 === 0) {
              process.stderr.write(
                `downloaded ${stats.downloaded}/${stats.considered} (failed ${stats.failed})\n`,
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
        throw lastError || new Error('download failed');
      } catch (error) {
        stats.failed += 1;
        kindStats().failed += 1;
        const entry = {
          productId,
          kind: job.kind,
          modelNo: item.modelNo,
          url: (remote || '').slice(0, 180),
          error: error.message,
        };
        if (stats.errors.length < 40) stats.errors.push(entry);
        appendFailure(entry);
        writeProgress(stats);
      }
    });
  } finally {
    await pool.end();
    writeProgress(stats);
  }

  console.log(JSON.stringify(stats, null, 2));
  if (stats.failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
