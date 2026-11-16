import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMigrationFiles, MIGRATIONS_DIR } from '../src/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('migrations', () => {
  it('lists ordered SQL migration files including domain parity', async () => {
    const files = await listMigrationFiles(MIGRATIONS_DIR);
    assert.ok(files.length >= 1);
    assert.deepEqual([...files].sort(), files);
    assert.ok(files.includes('001_m1_core.sql'));
    assert.ok(files.includes('002_yesgatc_import.sql'));
    assert.ok(files.includes('003_auth_sessions_otp.sql'));
    assert.ok(files.includes('004_domain_parity.sql'));
    assert.ok(files.includes('005_product_media_urls.sql'));
    assert.ok(files.includes('006_regional_center_details.sql'));
    assert.ok(files.includes('007_regional_center_media.sql'));
    assert.ok(files.includes('008_product_capacities_specs.sql'));
  });

  it('005 migration adds product media URL columns', async () => {
    const sql = await fs.readFile(
      path.join(MIGRATIONS_DIR, '005_product_media_urls.sql'),
      'utf8',
    );
    assert.match(sql, /image_url/);
    assert.match(sql, /approval_doc_url/);
  });

  it('006 migration adds regional centre profile columns', async () => {
    const sql = await fs.readFile(
      path.join(MIGRATIONS_DIR, '006_regional_center_details.sql'),
      'utf8',
    );
    assert.match(sql, /ADD COLUMN IF NOT EXISTS place/);
    assert.match(sql, /gst_number/);
    assert.match(sql, /certification_method/);
  });

  it('007 migration adds regional centre media / PDF-signer columns', async () => {
    const sql = await fs.readFile(
      path.join(MIGRATIONS_DIR, '007_regional_center_media.sql'),
      'utf8',
    );
    assert.match(sql, /ADD COLUMN IF NOT EXISTS logo_url/);
    assert.match(sql, /seal_url/);
    assert.match(sql, /pdf_signer_sign_url/);
    assert.match(sql, /pdf_signer_sign_scale/);
  });

  it('008 migration backfills capacities.specifications from legacy scalars', async () => {
    const sql = await fs.readFile(
      path.join(MIGRATIONS_DIR, '008_product_capacities_specs.sql'),
      'utf8',
    );
    assert.match(sql, /specifications/);
    assert.match(sql, /maximumCapacity/);
    assert.match(sql, /verificationScaleInterval/);
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

  it('002 migration adds yesgatc import columns and doca_certificates', async () => {
    const sql = await fs.readFile(
      path.join(MIGRATIONS_DIR, '002_yesgatc_import.sql'),
      'utf8',
    );
    assert.match(sql, /source_firebase_id/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS doca_certificates\b/);
    assert.match(sql, /certificate_number/);
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
