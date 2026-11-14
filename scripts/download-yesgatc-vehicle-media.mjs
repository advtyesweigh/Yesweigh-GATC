#!/usr/bin/env node
/**
 * Resume-safe download of vehicle photos (+ optional docs) into $DATA_ROOT.
 *
 * Layout:
 *   $DATA_ROOT/media/yesgatc/vehicles/<firebaseOrUuid>/<kind>.<ext>
 *
 * Updates vehicles.docs_json:
 *   vehiclePhotoLocalPath / rcDocLocalPath / insuranceDocLocalPath /
 *   pollutionDocLocalPath / f2WeightDocLocalPath
 *
 * Usage:
 *   npm run yesgatc:download-vehicle-media
 *   node scripts/download-yesgatc-vehicle-media.mjs --dry-run
 *   node scripts/download-yesgatc-vehicle-media.mjs --docs --concurrency=4
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
const PROGRESS_PATH = join(REPO_ROOT, '.tmp', 'vehicle-media-download.progress');
const FAIL_LOG_PATH = join(REPO_ROOT, '.tmp', 'vehicle-media-download.failures.jsonl');
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

function extFor(contentType, url, fallback = '.bin') {
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('gif')) return '.gif';
  if (contentType?.includes('pdf')) return '.pdf';
  const fromUrl = extname(String(url || '').split('?')[0] || '');
  if (fromUrl && fromUrl.length <= 5) return fromUrl;
  return fallback;
}

async function downloadTo(url, destPath) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'image/*,application/pdf,*/*',
      'User-Agent': 'gatc-vps-vehicle-media-download/1.0',
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

const PHOTO_JOB = {
  kind: 'photo',
  remoteKey: 'vehiclePhotoUrl',
  localKey: 'vehiclePhotoLocalPath',
  fileStem: 'photo',
  fallbackExt: '.jpg',
};

const DOC_JOBS = [
  { kind: 'rc', remoteKey: 'rcDocUrl', localKey: 'rcDocLocalPath', fileStem: 'rc', fallbackExt: '.pdf' },
  {
    kind: 'insurance',
    remoteKey: 'insuranceDocUrl',
    localKey: 'insuranceDocLocalPath',
    fileStem: 'insurance',
    fallbackExt: '.pdf',
  },
  {
    kind: 'pollution',
    remoteKey: 'pollutionDocUrl',
    localKey: 'pollutionDocLocalPath',
    fileStem: 'pollution',
    fallbackExt: '.pdf',
  },
  {
    kind: 'f2_weight',
    remoteKey: 'f2WeightDocUrl',
    localKey: 'f2WeightDocLocalPath',
    fileStem: 'f2-weight',
    fallbackExt: '.pdf',
  },
];

function jobsFor(includeDocs) {
  return includeDocs ? [PHOTO_JOB, ...DOC_JOBS] : [PHOTO_JOB];
}

async function main() {
  const dataRoot = process.env.DATA_ROOT || '';
  if (!dataRoot) throw new Error('DATA_ROOT required');
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL required');

  const concurrency = Math.max(1, Number(argValue('--concurrency') || '4') || 4);
  const retries = Math.max(0, Number(argValue('--retries') || '2') || 2);
  const dryRun = hasFlag('--dry-run');
  const includeDocs = hasFlag('--docs');
  const limit = Number(argValue('--limit') || '0') || 0;
  const jobs = jobsFor(includeDocs);

  const pool = new Pool({
    connectionString: databaseUrl,
    max: Math.max(4, concurrency + 2),
  });

  const stats = {
    dryRun,
    includeDocs,
    concurrency,
    retries,
    considered: 0,
    downloaded: 0,
    skippedExisting: 0,
    linkedExisting: 0,
    failed: 0,
    bytesDownloaded: 0,
    byKind: {},
    errors: [],
    dataRoot,
  };
  writeProgress(stats);

  try {
    let sql = `
      SELECT id, brand, model, reg_number, source_firebase_id, docs_json
      FROM vehicles
      ORDER BY updated_at DESC NULLS LAST, created_at DESC`;
    if (limit > 0) sql += ` LIMIT ${limit}`;
    const { rows } = await pool.query(sql);

    const work = [];
    for (const row of rows) {
      const docs = row.docs_json && typeof row.docs_json === 'object' ? row.docs_json : {};
      const folderId = String(row.source_firebase_id || row.id).trim();
      for (const job of jobs) {
        const remote = typeof docs[job.remoteKey] === 'string' ? docs[job.remoteKey].trim() : '';
        if (!remote || !/^https?:\/\//i.test(remote)) continue;
        const existingLocal = typeof docs[job.localKey] === 'string' ? docs[job.localKey].trim() : '';
        work.push({
          vehicleId: row.id,
          folderId,
          reg: row.reg_number,
          job,
          remote,
          existingLocal,
        });
      }
    }
    stats.considered = work.length;
    writeProgress(stats);

    await mapPool(work, concurrency, async (item) => {
      const { vehicleId, folderId, job, remote, existingLocal } = item;
      const kindStats = () => {
        stats.byKind[job.kind] = stats.byKind[job.kind] || {
          downloaded: 0,
          skipped: 0,
          linked: 0,
          failed: 0,
        };
        return stats.byKind[job.kind];
      };

      try {
        if (existingLocal && isLocalVpsMediaPath(existingLocal)) {
          const absExisting = resolve(dataRoot, existingLocal);
          if (existsSync(absExisting) && statSync(absExisting).size >= 32) {
            stats.skippedExisting += 1;
            kindStats().skipped += 1;
            writeProgress(stats);
            return;
          }
        }

        // Reuse any matching file already on disk for this folder/kind.
        const dirRel = `media/yesgatc/vehicles/${folderId}`;
        const dirAbs = resolve(dataRoot, dirRel);
        if (existsSync(dirAbs)) {
          const candidates = [
            `${job.fileStem}.jpg`,
            `${job.fileStem}.jpeg`,
            `${job.fileStem}.png`,
            `${job.fileStem}.webp`,
            `${job.fileStem}.pdf`,
            `${job.fileStem}.bin`,
          ];
          for (const name of candidates) {
            const abs = join(dirAbs, name);
            if (existsSync(abs) && statSync(abs).size >= 32) {
              const rel = `${dirRel}/${name}`.replace(/\\/g, '/');
              if (!dryRun) {
                await pool.query(
                  `UPDATE vehicles
                   SET docs_json = COALESCE(docs_json, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
                       updated_at = NOW()
                   WHERE id = $1`,
                  [vehicleId, job.localKey, rel],
                );
              }
              stats.linkedExisting += 1;
              kindStats().linked += 1;
              writeProgress(stats);
              return;
            }
          }
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
              `UPDATE vehicles
               SET docs_json = COALESCE(docs_json, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
                   updated_at = NOW()
               WHERE id = $1`,
              [vehicleId, job.localKey, rel],
            );
            stats.downloaded += 1;
            stats.bytesDownloaded += size;
            kindStats().downloaded += 1;
            writeProgress(stats);
            return;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || new Error('download failed');
      } catch (error) {
        stats.failed += 1;
        kindStats().failed += 1;
        const entry = {
          vehicleId,
          kind: job.kind,
          reg: item.reg,
          url: remote.slice(0, 180),
          error: error.message,
        };
        stats.errors.push(entry);
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
