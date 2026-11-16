#!/usr/bin/env node
/**
 * One-shot: download RC media still pointing at firebasestorage.googleapis.com
 * into $DATA_ROOT and rewrite regional_centers.*_url columns to local paths.
 *
 * Layout:
 *   $DATA_ROOT/media/yesgatc/regionalCenters/<uuid>/logo.<ext>
 *   …/seal.<ext>
 *   …/standard_weights_cert.<ext>
 *   …/pan_card.<ext>
 *   …/pdf_signer_sign.<ext>
 *
 * Usage:
 *   node scripts/download-yesgatc-rc-media.mjs
 *   node scripts/download-yesgatc-rc-media.mjs --dry-run
 *   node scripts/download-yesgatc-rc-media.mjs --concurrency=3
 *
 * Env: DATABASE_URL, DATA_ROOT (from repo .env)
 *
 * Best-effort: Firebase URLs that 403/404 are logged and left unchanged.
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
const PROGRESS_PATH = join(REPO_ROOT, '.tmp', 'rc-media-download.progress');
const FAIL_LOG_PATH = join(REPO_ROOT, '.tmp', 'rc-media-download.failures.jsonl');
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
  // Firebase object paths often encode the extension before ?alt=media
  const decoded = decodeURIComponent(String(url || ''));
  const m = /\.(jpe?g|png|webp|gif|pdf)(?:\?|$)/i.exec(decoded);
  if (m) return `.${m[1].toLowerCase().replace('jpeg', 'jpg')}`;
  return fallback;
}

function isFirebaseOrHttp(url) {
  if (typeof url !== 'string') return false;
  const t = url.trim();
  return /^https?:\/\//i.test(t);
}

async function downloadTo(url, destPath) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'image/*,application/pdf,*/*',
      'User-Agent': 'gatc-vps-rc-media-download/1.0',
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

const JOBS = [
  { kind: 'logo', column: 'logo_url', stem: 'logo', fallbackExt: '.png' },
  { kind: 'seal', column: 'seal_url', stem: 'seal', fallbackExt: '.png' },
  {
    kind: 'standard_weights_cert',
    column: 'standard_weights_cert_url',
    stem: 'standard_weights_cert',
    fallbackExt: '.pdf',
  },
  { kind: 'pan_card', column: 'pan_card_url', stem: 'pan_card', fallbackExt: '.jpg' },
  {
    kind: 'pdf_signer_sign',
    column: 'pdf_signer_sign_url',
    stem: 'pdf_signer_sign',
    fallbackExt: '.png',
  },
];

async function main() {
  const dataRoot = process.env.DATA_ROOT || '';
  if (!dataRoot) throw new Error('DATA_ROOT required');
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL required');

  const concurrency = Math.max(1, Number(argValue('--concurrency') || '3') || 3);
  const dryRun = hasFlag('--dry-run');
  const limit = Number(argValue('--limit') || '0') || 0;

  const pool = new Pool({
    connectionString: databaseUrl,
    max: Math.max(4, concurrency + 2),
  });

  const stats = {
    dryRun,
    concurrency,
    considered: 0,
    downloaded: 0,
    skippedExisting: 0,
    skippedLocal: 0,
    skippedNoUrl: 0,
    failed: 0,
    bytesDownloaded: 0,
    byKind: {},
    errors: [],
    dataRoot,
  };
  writeProgress(stats);

  try {
    let sql = `
      SELECT id, code, company_name,
             logo_url, seal_url, standard_weights_cert_url,
             pan_card_url, pdf_signer_sign_url
      FROM regional_centers
      WHERE code <> 'DEMO-RC'
      ORDER BY code ASC`;
    if (limit > 0) sql += ` LIMIT ${limit}`;
    const { rows } = await pool.query(sql);

    const work = [];
    for (const row of rows) {
      for (const job of JOBS) {
        const current = row[job.column];
        if (!current) {
          stats.skippedNoUrl += 1;
          continue;
        }
        if (isLocalVpsMediaPath(String(current).trim())) {
          stats.skippedLocal += 1;
          continue;
        }
        if (!isFirebaseOrHttp(current)) {
          stats.skippedNoUrl += 1;
          continue;
        }
        work.push({ row, job, url: String(current).trim() });
      }
    }

    stats.considered = work.length;
    writeProgress(stats);

    await mapPool(work, concurrency, async (item) => {
      const { row, job, url } = item;
      const relDir = `media/yesgatc/regionalCenters/${row.id}`;
      stats.byKind[job.kind] = stats.byKind[job.kind] || {
        downloaded: 0,
        failed: 0,
        skippedExisting: 0,
      };

      // Probe extension after HEAD-ish via GET (Firebase often needs full GET)
      let destRel = `${relDir}/${job.stem}${job.fallbackExt}`;
      const probeExt = extFor('', url, job.fallbackExt);
      destRel = `${relDir}/${job.stem}${probeExt}`;
      const destAbs = join(dataRoot, destRel);

      if (existsSync(destAbs) && statSync(destAbs).size >= 32) {
        stats.skippedExisting += 1;
        stats.byKind[job.kind].skippedExisting += 1;
        if (!dryRun) {
          await pool.query(
            `UPDATE regional_centers SET ${job.column} = $2, updated_at = NOW() WHERE id = $1`,
            [row.id, destRel],
          );
        }
        writeProgress(stats);
        return;
      }

      if (dryRun) {
        stats.downloaded += 1;
        stats.byKind[job.kind].downloaded += 1;
        writeProgress(stats);
        return;
      }

      try {
        const { size, contentType } = await downloadTo(url, destAbs);
        const finalExt = extFor(contentType, url, probeExt);
        let finalRel = destRel;
        if (finalExt !== probeExt) {
          finalRel = `${relDir}/${job.stem}${finalExt}`;
          const finalAbs = join(dataRoot, finalRel);
          if (finalAbs !== destAbs) {
            renameSync(destAbs, finalAbs);
          }
        }
        await pool.query(
          `UPDATE regional_centers SET ${job.column} = $2, updated_at = NOW() WHERE id = $1`,
          [row.id, finalRel],
        );
        stats.downloaded += 1;
        stats.bytesDownloaded += size;
        stats.byKind[job.kind].downloaded += 1;
      } catch (error) {
        stats.failed += 1;
        stats.byKind[job.kind].failed += 1;
        const entry = {
          rc: row.code,
          id: row.id,
          kind: job.kind,
          url: url.slice(0, 180),
          error: String(error.message || error),
        };
        stats.errors.push(entry);
        appendFailure(entry);
      }
      writeProgress(stats);
    });

    console.log(JSON.stringify(stats, null, 2));
    if (stats.failed) {
      console.error(`Failures logged to ${FAIL_LOG_PATH}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
