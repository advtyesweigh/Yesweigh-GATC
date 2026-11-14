#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) n += countFiles(p);
    else if (st.size >= 32) n += 1;
  }
  return n;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const dataRoot = process.env.DATA_ROOT;

const pc = await pool.query(`
  SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE image_path LIKE 'media/yesgatc/%')::int AS local_image,
    COUNT(*) FILTER (WHERE image_url LIKE 'http%')::int AS has_image_url,
    COUNT(*) FILTER (WHERE approval_doc_path LIKE 'media/yesgatc/%')::int AS local_approval,
    COUNT(*) FILTER (WHERE image_path LIKE 'products/%')::int AS still_firebase_path,
    COUNT(*) FILTER (WHERE image_path IS NULL OR TRIM(image_path) = '')::int AS no_image_path
  FROM products`);
console.log('PRODUCTS', pc.rows[0]);

const missing = await pool.query(`
  SELECT id::text, model_no, source_firebase_id,
         LEFT(COALESCE(image_path, ''), 120) AS image_path,
         CASE WHEN image_url LIKE 'http%' THEN 'has_url' ELSE 'no_url' END AS url_state
  FROM products
  WHERE image_path IS NULL
     OR TRIM(COALESCE(image_path, '')) = ''
     OR image_path NOT LIKE 'media/yesgatc/%'
  ORDER BY model_no`);
console.log('PRODUCTS_NOT_LOCAL', missing.rows);

const vc = await pool.query(`
  SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE COALESCE(docs_json->>'vehiclePhotoLocalPath','') LIKE 'media/yesgatc/%')::int AS photo_local,
    COUNT(*) FILTER (WHERE COALESCE(docs_json->>'rcDocLocalPath','') LIKE 'media/yesgatc/%')::int AS rc_local,
    COUNT(*) FILTER (WHERE COALESCE(docs_json->>'insuranceDocLocalPath','') LIKE 'media/yesgatc/%')::int AS ins_local,
    COUNT(*) FILTER (WHERE COALESCE(docs_json->>'pollutionDocLocalPath','') LIKE 'media/yesgatc/%')::int AS pol_local,
    COUNT(*) FILTER (WHERE COALESCE(docs_json->>'f2WeightDocLocalPath','') LIKE 'media/yesgatc/%')::int AS f2_local
  FROM vehicles`);
console.log('VEHICLES', vc.rows[0]);

console.log('DISK_products', countFiles(join(dataRoot, 'media/yesgatc/products')));
console.log('DISK_vehicles', countFiles(join(dataRoot, 'media/yesgatc/vehicles')));
await pool.end();
