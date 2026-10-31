import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const require = createRequire(join(REPO_ROOT, 'package.json'));
const { Client } = require('pg');

const envPath = join(REPO_ROOT, '.env');
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const kinds = await client.query(
  `SELECT kind, COUNT(*)::int n, COUNT(source_url)::int with_url
   FROM verification_media GROUP BY kind ORDER BY n DESC`,
);
const certKinds = await client.query(
  `SELECT kind, COUNT(*)::int n
   FROM verification_media
   WHERE kind IN ('certificate_pdf','signed_certificate_pdf','emaap_certificate_pdf','old_verification_certificate')
     AND source_url IS NOT NULL
   GROUP BY kind`,
);
const sample = await client.query(
  `SELECT kind, source_url FROM verification_media
   WHERE kind IN ('certificate_pdf','signed_certificate_pdf','emaap_certificate_pdf')
     AND source_url IS NOT NULL
   LIMIT 5`,
);
const sampleHead = [];
for (const row of sample.rows) {
  try {
    const r = await fetch(row.source_url, { method: 'HEAD', redirect: 'follow' });
    sampleHead.push({
      kind: row.kind,
      status: r.status,
      type: r.headers.get('content-type'),
      host: new URL(row.source_url).host,
    });
  } catch (e) {
    let host = '?';
    try {
      host = new URL(row.source_url).host;
    } catch {
      /* ignore */
    }
    sampleHead.push({ kind: row.kind, error: e.message, host });
  }
}
console.log(
  JSON.stringify(
    {
      ok: true,
      kinds: kinds.rows,
      certUrlCounts: certKinds.rows,
      sampleHead,
      dataRoot: process.env.DATA_ROOT || null,
    },
    null,
    2,
  ),
);
await client.end();
