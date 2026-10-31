import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from './config.js';
import { hashPassword } from './passwords.js';

const { Client } = pg;

const SEED_RC_CODE = 'DEMO-RC';
const SEED_USERS = [
  {
    key: 'admin',
    aadhaar: '999999999901',
    username: 'seed_admin',
    role: 'ADMIN',
    rc: false,
    phone: '9000000001',
  },
  {
    key: 'rc_admin',
    aadhaar: '999999999902',
    username: 'seed_rc_admin',
    role: 'RC_ADMIN',
    rc: true,
    phone: '9000000002',
  },
  {
    key: 'vct',
    aadhaar: '999999999903',
    username: 'seed_vct',
    role: 'VCT',
    rc: true,
    phone: '9000000003',
  },
];

const SEED_PRODUCT = {
  model_id: 'SEED-MODEL-001',
  model_no: 'SM-001',
  name: 'Seed Weighing Scale',
  type_of_instrument: 'Weighing Instrument',
  manufacturer_brand_series: 'GATC Seed',
  accuracy_class: 'III',
  unit_of_measurement: 'kg',
};

export async function seedDatabase({
  databaseUrl,
  password,
  logger = console,
  force = false,
  nodeEnv = 'development',
} = {}) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to seed');
  }
  if (!password || password.length < 8) {
    throw new Error('SEED_PASSWORD must be at least 8 characters');
  }
  if (nodeEnv === 'production' && !force) {
    throw new Error('Refusing to seed in production without FORCE_SEED=1');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const passwordHash = await hashPassword(password);

  try {
    await client.query('BEGIN');

    const rc = await client.query(
      `INSERT INTO regional_centers (code, company_name, contact_person, state, active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (code) DO UPDATE
         SET company_name = EXCLUDED.company_name,
             updated_at = NOW()
       RETURNING id, code`,
      [SEED_RC_CODE, 'Demo Regional Center', 'Seed Contact', 'Demo State'],
    );
    const rcId = rc.rows[0].id;

    const users = {};
    for (const u of SEED_USERS) {
      const result = await client.query(
        `INSERT INTO users (
           aadhaar, username, password_hash, role, rc_id, phone, active, workflow_mode
         ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)
         ON CONFLICT (aadhaar) DO UPDATE
           SET username = EXCLUDED.username,
               password_hash = EXCLUDED.password_hash,
               role = EXCLUDED.role,
               rc_id = EXCLUDED.rc_id,
               phone = COALESCE(EXCLUDED.phone, users.phone),
               active = TRUE,
               updated_at = NOW()
         RETURNING id, aadhaar, role, rc_id`,
        [
          u.aadhaar,
          u.username,
          passwordHash,
          u.role,
          u.rc ? rcId : null,
          u.phone || null,
          u.role === 'VCT' ? 'manual' : null,
        ],
      );
      users[u.key] = result.rows[0];
    }

    const product = await client.query(
      `INSERT INTO products (
         model_id, model_no, name, type_of_instrument,
         manufacturer_brand_series, accuracy_class, unit_of_measurement, active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
       ON CONFLICT (model_id) DO UPDATE
         SET name = EXCLUDED.name,
             updated_at = NOW()
       RETURNING id, model_id, name`,
      [
        SEED_PRODUCT.model_id,
        SEED_PRODUCT.model_no,
        SEED_PRODUCT.name,
        SEED_PRODUCT.type_of_instrument,
        SEED_PRODUCT.manufacturer_brand_series,
        SEED_PRODUCT.accuracy_class,
        SEED_PRODUCT.unit_of_measurement,
      ],
    );

    await client.query('COMMIT');

    const summary = {
      regionalCenter: { id: rcId, code: SEED_RC_CODE },
      users: Object.fromEntries(
        Object.entries(users).map(([k, row]) => [
          k,
          { id: row.id, aadhaar: row.aadhaar, role: row.role, rcId: row.rc_id },
        ]),
      ),
      product: product.rows[0],
    };
    logger.info?.('Seed complete', summary) ?? logger.log('Seed complete', summary);
    return summary;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const config = loadConfig();
  const password = process.env.SEED_PASSWORD || '';
  const force = process.env.FORCE_SEED === '1';
  const result = await seedDatabase({
    databaseUrl: config.databaseUrl,
    password,
    force,
    nodeEnv: config.nodeEnv,
  });
  // Never print the password.
  console.log(JSON.stringify({ ok: true, seed: result }));
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exit(1);
  });
}
