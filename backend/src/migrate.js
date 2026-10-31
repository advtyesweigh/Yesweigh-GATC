import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from './config.js';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

export async function listMigrationFiles(migrationsDir = MIGRATIONS_DIR) {
  const entries = await fs.readdir(migrationsDir);
  return entries
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

export async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function appliedMigrations(client) {
  const result = await client.query('SELECT id FROM schema_migrations ORDER BY id');
  return new Set(result.rows.map((row) => row.id));
}

export async function applyMigrations({
  databaseUrl,
  migrationsDir = MIGRATIONS_DIR,
  logger = console,
} = {}) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  const files = await listMigrationFiles(migrationsDir);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await appliedMigrations(client);
    const pending = files.filter((file) => !applied.has(file));

    if (pending.length === 0) {
      logger.info?.('No pending migrations') ?? logger.log('No pending migrations');
      return { applied: [], pending: [] };
    }

    const newlyApplied = [];
    for (const file of pending) {
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (id) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
        newlyApplied.push(file);
        logger.info?.('Applied migration', { file }) ?? logger.log(`Applied migration ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return { applied: newlyApplied, pending };
  } finally {
    await client.end();
  }
}

async function main() {
  const config = loadConfig();
  const result = await applyMigrations({ databaseUrl: config.databaseUrl });
  console.log(JSON.stringify({ ok: true, ...result }));
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
    }));
    process.exit(1);
  });
}
