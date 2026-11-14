import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';

const baseConfig = {
  appName: 'gatc-vps-test',
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'error',
  corsOrigin: 'http://127.0.0.1:5173',
  databaseUrl: 'postgresql://mock',
  dataRoot: '',
  jwtSecret: 'test-jwt-secret-at-least-32-chars!!',
  jwtExpiresIn: '1h',
  otpTtlSeconds: 300,
  otpResendSeconds: 60,
  otpMaxAttempts: 5,
  masterOtp: '',
  smsProvider: 'log',
  smsApiKey: '',
  smsApiUrl: '',
  smsSender: '',
  smsMsg91TemplateId: '',
  smsMsg91BaseUrl: '',
  smsLogOtp: false,
  whatsappToken: '',
  whatsappPhoneNumberId: '',
  whatsappWabaId: '',
  whatsappOtpTemplate: 'otp',
  whatsappOtpLanguage: 'en_US',
  whatsappGraphVersion: 'v21.0',
};

function createAuthMockPool(userRow) {
  const challenges = new Map();
  const sessions = new Map();

  const pool = {
    async connect() {
      return {
        async query(sql, params) {
          return pool.query(sql, params);
        },
        async release() {},
      };
    },
    async query(sql, params = []) {
      const text = String(sql);

      if (text.includes('WHERE aadhaar')) {
        return { rows: params[0] === userRow.aadhaar ? [userRow] : [] };
      }
      if (text.includes('lower(username)')) {
        return {
          rows:
            userRow.username
            && String(params[0]).toLowerCase() === String(userRow.username).toLowerCase()
              ? [userRow]
              : [],
        };
      }
      if (text.includes('FROM users') && text.includes('WHERE id')) {
        return { rows: params[0] === userRow.id ? [userRow] : [] };
      }

      if (text.includes('INSERT INTO auth_otp_challenges')) {
        const id = crypto.randomUUID();
        const row = {
          id,
          user_id: params[0],
          code_hash: params[1],
          phone_e164: params[2],
          phone_hint: params[3],
          created_at: new Date(),
          expires_at: new Date(Date.now() + 300_000),
          consumed_at: null,
          attempts: 0,
          max_attempts: params[5] ?? 5,
          last_sent_at: new Date(),
        };
        challenges.set(id, row);
        return { rows: [{ id, expires_at: row.expires_at, phone_hint: row.phone_hint, last_sent_at: row.last_sent_at }] };
      }

      if (text.includes('FROM auth_otp_challenges') && text.includes('WHERE id')) {
        const row = challenges.get(params[0]);
        return { rows: row ? [row] : [] };
      }

      if (text.includes('UPDATE auth_otp_challenges') && text.includes('SET consumed_at')) {
        if (text.includes('WHERE user_id')) {
          for (const row of challenges.values()) {
            if (row.user_id === params[0] && !row.consumed_at) row.consumed_at = new Date();
          }
          return { rows: [] };
        }
        const row = challenges.get(params[0]);
        if (row && !row.consumed_at) row.consumed_at = new Date();
        return { rows: [] };
      }

      if (text.includes('UPDATE auth_otp_challenges') && text.includes('SET attempts')) {
        const row = challenges.get(params[0]);
        if (row) {
          row.attempts += 1;
          return { rows: [{ attempts: row.attempts, max_attempts: row.max_attempts }] };
        }
        return { rows: [] };
      }

      if (text.includes('UPDATE auth_otp_challenges') && text.includes('SET code_hash')) {
        const row = challenges.get(params[0]);
        if (!row || row.consumed_at) return { rows: [] };
        row.code_hash = params[1];
        row.expires_at = new Date(Date.now() + 300_000);
        row.last_sent_at = new Date();
        row.attempts = 0;
        return {
          rows: [{
            id: row.id,
            expires_at: row.expires_at,
            phone_hint: row.phone_hint,
            phone_e164: row.phone_e164,
            last_sent_at: row.last_sent_at,
          }],
        };
      }

      if (text.includes('UPDATE auth_sessions') && text.includes('SET revoked_at')) {
        if (text.includes('WHERE user_id') && !text.includes('WHERE id')) {
          for (const s of sessions.values()) {
            if (s.user_id === params[0] && !s.revoked_at) s.revoked_at = new Date();
          }
          return { rows: [] };
        }
        const s = sessions.get(params[0]);
        if (s && !s.revoked_at) s.revoked_at = new Date();
        return { rows: [] };
      }

      if (text.includes('INSERT INTO auth_sessions')) {
        const id = crypto.randomUUID();
        const row = {
          id,
          user_id: params[0],
          created_at: new Date(),
          expires_at: new Date(Date.now() + 3600_000),
          revoked_at: null,
        };
        sessions.set(id, row);
        return { rows: [row] };
      }

      if (text.includes('FROM auth_sessions')) {
        const s = sessions.get(params[0]);
        if (
          s
          && s.user_id === params[1]
          && !s.revoked_at
          && s.expires_at > new Date()
        ) {
          return { rows: [s] };
        }
        return { rows: [] };
      }

      if (text.includes('BEGIN') || text.includes('COMMIT') || text.includes('ROLLBACK')) {
        return { rows: [] };
      }

      // Admin ops checkDb: SELECT 1
      if (text.includes('SELECT 1') || text.trim() === 'SELECT 1') {
        return { rows: [{ '?column?': 1 }] };
      }

      return { rows: [] };
    },
    getSession(id) {
      return sessions.get(id);
    },
  };

  return pool;
}

async function loginGetToken(port, userRow, password) {
  const loginRes = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ aadhaar: userRow.aadhaar, password }),
  });
  assert.equal(loginRes.status, 200);
  const loginBody = await loginRes.json();
  assert.ok(loginBody.data?.token, 'expected session token from password login');
  return loginBody.data.token;
}

describe('admin ops status', () => {
  it('requires auth and ADMIN role; returns API/DB ops status', async () => {
    const passwordHash = await hashPassword('TestSeedPass1');
    const userRow = {
      id: '55555555-5555-5555-5555-555555555555',
      aadhaar: '999999999901',
      username: 'seed_admin',
      password_hash: passwordHash,
      role: 'ADMIN',
      rc_id: null,
      phone: '9876543210',
      email: null,
      active: true,
      workflow_mode: null,
      created_at: new Date().toISOString(),
    };

    const pool = createAuthMockPool(userRow);
    const logs = [];
    const logger = {
      error: () => {},
      warn: () => {},
      info: (message, meta) => logs.push({ message, meta }),
      debug: () => {},
    };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatc-admin-'));
    const app = createApp({
      config: { ...baseConfig, dataRoot: tmp },
      logger,
      pool,
    });
    const server = app.listen(0);
    const { port } = server.address();

    try {
      const unauth = await fetch(`http://127.0.0.1:${port}/api/v1/admin/ops-status`);
      assert.equal(unauth.status, 401);

      const token = await loginGetToken(port, userRow, 'TestSeedPass1');

      const opsRes = await fetch(`http://127.0.0.1:${port}/api/v1/admin/ops-status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(opsRes.status, 200);
      const ops = await opsRes.json();
      assert.equal(ops.data.services.api.status, 'online');
      assert.ok(ops.data.services.db);
      assert.equal(ops.data.services.worker, undefined);
      assert.equal(ops.data.services.emaap, undefined);
      assert.equal(ops.data.emaap, undefined);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('forbids RC_ADMIN from ops-status', async () => {
    const passwordHash = await hashPassword('TestSeedPass1');
    const userRow = {
      id: '66666666-6666-6666-6666-666666666666',
      aadhaar: '999999999902',
      username: 'seed_rc',
      password_hash: passwordHash,
      role: 'RC_ADMIN',
      rc_id: 'rc-1',
      phone: '9876543211',
      email: null,
      active: true,
      workflow_mode: null,
      created_at: new Date().toISOString(),
    };

    const pool = createAuthMockPool(userRow);
    const logs = [];
    const logger = {
      error: () => {},
      warn: () => {},
      info: (message, meta) => logs.push({ message, meta }),
      debug: () => {},
    };

    const app = createApp({
      config: { ...baseConfig },
      logger,
      pool,
    });
    const server = app.listen(0);
    const { port } = server.address();

    try {
      const token = await loginGetToken(port, userRow, 'TestSeedPass1');
      const opsRes = await fetch(`http://127.0.0.1:${port}/api/v1/admin/ops-status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(opsRes.status, 403);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
