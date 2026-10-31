import pg from 'pg';

const { Pool } = pg;

/** @type {import('pg').Pool | null} */
let pool = null;

export function createPool(databaseUrl) {
  if (!databaseUrl) {
    return null;
  }
  return new Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export function getPool() {
  return pool;
}

export function setPool(nextPool) {
  pool = nextPool;
}

export async function checkDb(dbPool = pool) {
  if (!dbPool) {
    return { ok: false, configured: false };
  }
  const client = await dbPool.connect();
  try {
    const result = await client.query('SELECT 1 AS ok');
    return { ok: result.rows[0]?.ok === 1, configured: true };
  } finally {
    client.release();
  }
}
