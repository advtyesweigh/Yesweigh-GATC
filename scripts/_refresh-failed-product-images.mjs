#!/usr/bin/env node
/**
 * Re-fetch productImageUrl from Firestore for products still on Firebase storage paths,
 * then retry download.
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
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { listCollection, signInWithAadhaarPassword } from './lib/yesgatc-firestore.mjs';

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

async function downloadTo(url, destPath) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'image/*,*/*',
      'User-Agent': 'gatc-vps-product-media-refresh/1.0',
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

function extFor(contentType, url) {
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('gif')) return '.gif';
  const fromUrl = extname(String(url || '').split('?')[0] || '');
  if (fromUrl && fromUrl.length <= 5) return fromUrl;
  return '.jpg';
}

async function resolveAuth() {
  const dataRoot = process.env.DATA_ROOT || '';
  const jwtSecret = process.env.JWT_SECRET || '';
  try {
    const { loadYesoneCredentialsSecrets } = await import('../backend/src/yesoneCredentials.js');
    const secrets = loadYesoneCredentialsSecrets({ dataRoot, jwtSecret });
    if (secrets?.userId && secrets?.password) {
      return signInWithAadhaarPassword(secrets.userId, secrets.password, {
        credPath: 'yesone:credentials.enc.json',
      });
    }
  } catch (error) {
    console.error('yesone_auth', error.message);
  }
  try {
    const { signInSuperAdmin } = await import('./lib/yesgatc-firestore.mjs');
    return await signInSuperAdmin();
  } catch (error) {
    console.error('super_auth', error.message);
  }
  return null;
}

const dataRoot = process.env.DATA_ROOT || '';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const pending = await pool.query(`
  SELECT id, model_no, source_firebase_id, image_path, image_url
  FROM products
  WHERE source_firebase_id IS NOT NULL
    AND (
      image_path IS NULL
      OR TRIM(COALESCE(image_path, '')) = ''
      OR image_path NOT LIKE 'media/yesgatc/%'
    )
`);

console.log(JSON.stringify({ pending: pending.rows.length }, null, 2));
if (!pending.rows.length) {
  await pool.end();
  process.exit(0);
}

const auth = await resolveAuth();
if (!auth) {
  console.error(JSON.stringify({ ok: false, error: 'no_firebase_auth' }));
  await pool.end();
  process.exit(1);
}

const products = await listCollection(auth.idToken, 'products');
const byId = new Map(products.map((p) => [p.id, p]));
const stats = { refreshed: 0, downloaded: 0, failed: 0, errors: [] };

for (const row of pending.rows) {
  const doc = byId.get(row.source_firebase_id);
  if (!doc) {
    stats.failed += 1;
    stats.errors.push({ id: row.id, error: 'firestore_doc_missing' });
    continue;
  }
  const url =
    typeof doc.productImageUrl === 'string' && /^https?:\/\//i.test(doc.productImageUrl.trim())
      ? doc.productImageUrl.trim()
      : '';
  if (!url) {
    stats.failed += 1;
    stats.errors.push({ id: row.id, model: row.model_no, error: 'no_productImageUrl' });
    continue;
  }
  await pool.query(`UPDATE products SET image_url = $2, updated_at = NOW() WHERE id = $1`, [
    row.id,
    url,
  ]);
  stats.refreshed += 1;

  // Probe URL
  try {
    const folderId = String(row.source_firebase_id);
    const probe = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    console.log(
      JSON.stringify({
        model: row.model_no,
        fid: row.source_firebase_id,
        head: probe.status,
        path: doc.productImagePath,
      }),
    );
    if (!probe.ok) {
      // try GET anyway; some buckets reject HEAD
      const getProbe = await fetch(url, { method: 'GET', redirect: 'follow' });
      if (!getProbe.ok) throw new Error(`HTTP ${getProbe.status}`);
      // consume body to temp
      const ext = extFor(getProbe.headers.get('content-type'), url);
      const rel = `media/yesgatc/products/${folderId}/image${ext}`;
      const abs = join(dataRoot, rel);
      mkdirSync(dirname(abs), { recursive: true });
      const tmp = `${abs}.part`;
      await pipeline(Readable.fromWeb(getProbe.body), createWriteStream(tmp));
      const size = statSync(tmp).size;
      if (size < 32) throw new Error(`file too small (${size})`);
      renameSync(tmp, abs);
      await pool.query(
        `UPDATE products SET image_path = $2, updated_at = NOW() WHERE id = $1`,
        [row.id, rel],
      );
      stats.downloaded += 1;
      continue;
    }
    const ext = '.jpg';
    const rel = `media/yesgatc/products/${folderId}/image${ext}`;
    const abs = join(dataRoot, rel);
    const { size, contentType } = await downloadTo(url, abs);
    const finalExt = extFor(contentType, url);
    let finalRel = rel;
    if (finalExt !== ext) {
      finalRel = `media/yesgatc/products/${folderId}/image${finalExt}`;
      renameSync(abs, join(dataRoot, finalRel));
    }
    await pool.query(`UPDATE products SET image_path = $2, updated_at = NOW() WHERE id = $1`, [
      row.id,
      finalRel,
    ]);
    stats.downloaded += 1;
    console.log(JSON.stringify({ downloaded: row.model_no, bytes: size }));
  } catch (error) {
    stats.failed += 1;
    stats.errors.push({
      id: row.id,
      model: row.model_no,
      fid: row.source_firebase_id,
      error: error.message,
      url: url.slice(0, 160),
    });
  }
}

await pool.end();
console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
if (stats.failed) process.exitCode = 1;
