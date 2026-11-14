#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const pc = await pool.query(`
  SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE image_path IS NOT NULL AND TRIM(image_path) <> '')::int AS has_path,
    COUNT(*) FILTER (WHERE image_url IS NOT NULL AND TRIM(image_url) <> '')::int AS has_url,
    COUNT(*) FILTER (WHERE image_path LIKE 'media/yesgatc/%')::int AS local_path,
    COUNT(*) FILTER (WHERE image_path LIKE 'http%')::int AS path_is_http,
    COUNT(*) FILTER (WHERE image_path LIKE 'products/%')::int AS path_firebase
  FROM products`);
console.log('PRODUCT_COUNTS', pc.rows[0]);

const products = await pool.query(`
  SELECT id::text, model_no,
         LEFT(COALESCE(image_path, ''), 180) AS image_path,
         LEFT(COALESCE(image_url, ''), 180) AS image_url,
         source_firebase_id
  FROM products
  ORDER BY sort_order NULLS LAST, model_no`);
for (const r of products.rows) console.log('P', JSON.stringify(r));

const vc = await pool.query(`
  SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE docs_json->>'vehiclePhotoUrl' IS NOT NULL)::int AS has_photo,
    COUNT(*) FILTER (WHERE docs_json->>'rcDocUrl' IS NOT NULL)::int AS has_rc,
    COUNT(*) FILTER (WHERE docs_json->>'insuranceDocUrl' IS NOT NULL)::int AS has_ins,
    COUNT(*) FILTER (WHERE docs_json->>'pollutionDocUrl' IS NOT NULL)::int AS has_pol,
    COUNT(*) FILTER (WHERE COALESCE(docs_json->>'vehiclePhotoLocalPath','') LIKE 'media/yesgatc/%')::int AS photo_local
  FROM vehicles`);
console.log('VEHICLE_COUNTS', vc.rows[0]);

const vehicles = await pool.query(`
  SELECT id::text, brand, model, reg_number, source_firebase_id,
    LEFT(COALESCE(docs_json->>'vehiclePhotoUrl', ''), 160) AS photo,
    LEFT(COALESCE(docs_json->>'rcDocUrl', ''), 120) AS rc,
    LEFT(COALESCE(docs_json->>'insuranceDocUrl', ''), 120) AS insurance,
    LEFT(COALESCE(docs_json->>'pollutionDocUrl', ''), 120) AS pollution,
    (SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb)
       FROM jsonb_object_keys(docs_json) AS k) AS keys
  FROM vehicles
  ORDER BY brand`);
for (const r of vehicles.rows) console.log('V', JSON.stringify(r));

console.log('DATA_ROOT', process.env.DATA_ROOT);
await pool.end();
