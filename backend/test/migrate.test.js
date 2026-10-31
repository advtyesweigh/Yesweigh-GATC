import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMigrationFiles, MIGRATIONS_DIR } from '../src/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('migrations', () => {
  it('lists ordered SQL migration files for M1 tables', async () => {
    const files = await listMigrationFiles(MIGRATIONS_DIR);
    assert.ok(files.length >= 1);
    assert.deepEqual([...files].sort(), files);
    assert.ok(files.includes('001_m1_core.sql'));
  });

  it('M1 migration SQL defines required tables', async () => {
    const sql = await fs.readFile(
      path.join(MIGRATIONS_DIR, '001_m1_core.sql'),
      'utf8',
    );
    for (const table of [
      'regional_centers',
      'users',
      'products',
      'customers',
      'verifications',
      'verification_media',
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`));
    }
  });

  it('applies migrations when DATABASE_URL is set', async () => {
    if (!process.env.DATABASE_URL) {
      return;
    }
    const { applyMigrations } = await import('../src/migrate.js');
    const first = await applyMigrations({
      databaseUrl: process.env.DATABASE_URL,
      logger: { info() {}, log() {} },
    });
    assert.ok(Array.isArray(first.applied));
    const second = await applyMigrations({
      databaseUrl: process.env.DATABASE_URL,
      logger: { info() {}, log() {} },
    });
    assert.deepEqual(second.applied, []);
  });
});
