import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!m || process.env[m[1]]) continue;
  process.env[m[1]] = m[2];
}
const require = createRequire(join(root, 'backend/package.json'));
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const roles = await client.query(
  `SELECT role, COUNT(*)::int AS n FROM users GROUP BY role ORDER BY role`,
);
const fb = await client.query(
  `SELECT role, COUNT(*)::int AS n FROM users WHERE profile_json ? 'firebaseUid' GROUP BY role ORDER BY role`,
);
const rc = await client.query(`SELECT COUNT(*)::int AS n FROM regional_centers`);
console.log(
  JSON.stringify(
    {
      roles: Object.fromEntries(roles.rows.map((r) => [r.role, r.n])),
      firebaseImported: Object.fromEntries(fb.rows.map((r) => [r.role, r.n])),
      regional_centers: rc.rows[0].n,
    },
    null,
    2,
  ),
);
await client.end();
