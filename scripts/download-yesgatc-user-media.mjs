#!/usr/bin/env node
/**
 * Resume-safe download of VCT (user) profile photos (+ optional docs) into $DATA_ROOT.
 *
 * Layout:
 *   $DATA_ROOT/media/yesgatc/users/<firebaseOrUuid>/profile.<ext>
 *   $DATA_ROOT/media/yesgatc/users/<firebaseOrUuid>/aadhaar.<ext>
 *   … biodata / education / pcc
 *
 * Updates users.profile_json local path keys (profilePhotoLocalPath, …).
 *
 * Usage:
 *   npm run yesgatc:download-user-media
 *   node scripts/download-yesgatc-user-media.mjs --dry-run
 *   node scripts/download-yesgatc-user-media.mjs --docs --concurrency=4
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
const PROGRESS_PATH = join(REPO_ROOT, '.tmp', 'user-media-download.progress');
const FAIL_LOG_PATH = join(REPO_ROOT, '.tmp', 'user-media-download.failures.jsonl');
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

async function downloadTo(url, destPath) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'image/*,application/pdf,*/*',
      'User-Agent': 'gatc-vps-user-media-download/1.0',
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
  kind: 'profile',
  remoteKey: 'profilePhotoUrl',
  localKey: 'profilePhotoLocalPath',
  fileStem: 'profile',
  fallbackExt: '.jpg',
};

const DOC_JOBS = [
  {
    kind: 'aadhaar',
    remoteKey: 'aadharDocUrl',
    localKey: 'aadharDocLocalPath',
    fileStem: 'aadhaar',
    fallbackExt: '.pdf',
  },
  {
    kind: 'biodata',
    remoteKey: 'biodataDocUrl',
    localKey: 'biodataDocLocalPath',
    fileStem: 'biodata',
    fallbackExt: '.pdf',
  },
  {
    kind: 'education',
    remoteKey: 'educationCertDocUrl',
    localKey: 'educationCertDocLocalPath',
    fileStem: 'education',
    fallbackExt: '.pdf',
  },
  {
    kind: 'pcc',
    remoteKey: 'pccDocUrl',
    localKey: 'pccDocLocalPath',
    fileStem: 'pcc',
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
  const role = String(argValue('--role') || 'VCT').trim().toUpperCase() || 'VCT';
  const jobs = jobsFor(includeDocs);

  const pool = new Pool({
    connectionString: databaseUrl,
    max: Math.max(4, concurrency + 2),
  });

  const stats = {
    dryRun,
    includeDocs,
    role,
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
      SELECT id, username, aadhaar, source_firebase_id, profile_json
      FROM users
      WHERE role = $1
      ORDER BY username NULLS LAST, aadhaar`;
    const params = [role];
    if (limit > 0) {
      sql += ` LIMIT $2`;
      params.push(limit);
    }
    // source_firebase_id may not exist on older schemas — fall back.
    let rows;
    try {
      ({ rows } = await pool.query(sql, params));
    } catch (error) {
      if (!String(error.message || '').includes('source_firebase_id')) throw error;
      sql = `
        SELECT id, username, aadhaar, NULL::text AS source_firebase_id, profile_json
        FROM users
        WHERE role = $1
        ORDER BY username NULLS LAST, aadhaar`;
      const limited = limit > 0 ? `${sql} LIMIT $2` : sql;
      ({ rows } = await pool.query(limited, params));
    }

    const work = [];
    for (const row of rows) {
      const profile = row.profile_json && typeof row.profile_json === 'object' ? row.profile_json : {};
      const folderId = String(
        row.source_firebase_id || profile.firebaseUid || row.id,
      ).trim();
      for (const job of jobs) {
        const remote = typeof profile[job.remoteKey] === 'string' ? profile[job.remoteKey].trim() : '';
        if (!remote || !/^https?:\/\//i.test(remote)) continue;
        const existingLocal =
          typeof profile[job.localKey] === 'string' ? profile[job.localKey].trim() : '';
        work.push({
          userId: row.id,
          folderId,
          username: row.username,
          job,
          remote,
          existingLocal,
        });
      }
    }
    stats.considered = work.length;
    writeProgress(stats);
    process.stderr.write(
      `user-media: ${work.length} jobs for role=${role}; concurrency=${concurrency}\n`,
    );

    await mapPool(work, concurrency, async (item) => {
      const { userId, folderId, job, remote, existingLocal } = item;
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

        const dirRel = `media/yesgatc/users/${folderId}`;
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
                  `UPDATE users
                   SET profile_json = COALESCE(profile_json, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
                       updated_at = NOW()
                   WHERE id = $1`,
                  [userId, job.localKey, rel],
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
              `UPDATE users
               SET profile_json = COALESCE(profile_json, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
                   updated_at = NOW()
               WHERE id = $1`,
              [userId, job.localKey, rel],
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
          userId,
          kind: job.kind,
          username: item.username,
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
