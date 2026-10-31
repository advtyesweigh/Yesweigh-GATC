import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { hashPassword } from '../src/passwords.js';
import { signAccessToken, verifyAccessToken } from '../src/jwt.js';
import { assertRcAccess, requireRoles } from '../src/rbac.js';
import { normalizeAadhaar, publicUser } from '../src/auth.js';

const baseConfig = {
  appName: 'gatc-vps-test',
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'error',
  corsOrigin: 'http://127.0.0.1:5173',
  databaseUrl: '',
  jwtSecret: 'test-jwt-secret-do-not-use-elsewhere',
  jwtExpiresIn: '1h',
};

describe('passwords and jwt', () => {
  it('hashes and verifies passwords', async () => {
    const hash = await hashPassword('CorrectHorseBattery');
    assert.notEqual(hash, 'CorrectHorseBattery');
    assert.equal(await import('../src/passwords.js').then((m) => m.verifyPassword('CorrectHorseBattery', hash)), true);
    assert.equal(await import('../src/passwords.js').then((m) => m.verifyPassword('wrong', hash)), false);
  });

  it('signs and verifies access tokens with role and rcId', () => {
    const token = signAccessToken(
      { id: '11111111-1111-1111-1111-111111111111', role: 'RC_ADMIN', rcId: 'rc-1' },
      baseConfig,
    );
    const claims = verifyAccessToken(token, baseConfig);
    assert.equal(claims.id, '11111111-1111-1111-1111-111111111111');
    assert.equal(claims.role, 'RC_ADMIN');
    assert.equal(claims.rcId, 'rc-1');
  });
});

describe('rbac', () => {
  it('allows ADMIN any RC and blocks cross-RC for VCT', () => {
    assert.equal(assertRcAccess({ role: 'ADMIN', rcId: null }, 'any'), true);
    assert.equal(assertRcAccess({ role: 'VCT', rcId: 'rc-a' }, 'rc-a'), true);
    const denied = assertRcAccess({ role: 'VCT', rcId: 'rc-a' }, 'rc-b');
    assert.equal(denied.code, 'FORBIDDEN');
  });

  it('requireRoles enforces allowed roles', () => {
    const check = requireRoles('ADMIN', 'RC_ADMIN');
    assert.equal(check({ role: 'ADMIN' }), true);
    assert.equal(check({ role: 'VCT' }).code, 'FORBIDDEN');
  });
});

describe('auth helpers', () => {
  it('normalizes aadhaar and maps public user without password_hash', () => {
    assert.equal(normalizeAadhaar('9999 9999 9901'), '999999999901');
    const pub = publicUser({
      id: 'u1',
      aadhaar: '999999999901',
      username: 'seed_admin',
      password_hash: 'secret',
      role: 'ADMIN',
      rc_id: null,
      phone: null,
      email: null,
      active: true,
      workflow_mode: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(pub.password_hash, undefined);
    assert.equal(pub.role, 'ADMIN');
    assert.equal(pub.rcId, null);
  });
});

describe('health and status remain available', () => {
  it('keeps /health and /api/status without DB', async () => {
    const app = createApp({ config: baseConfig, logger: createLogger('error'), pool: null });
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      const status = await fetch(`http://127.0.0.1:${port}/api/status`);
      assert.equal(status.status, 200);
      const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ aadhaar: '999999999901', password: 'x' }),
      });
      assert.equal(login.status, 503);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('auth login with mock pool', () => {
  it('issues JWT on valid credentials and serves /me', async () => {
    const passwordHash = await hashPassword('TestSeedPass1');
    const userRow = {
      id: '22222222-2222-2222-2222-222222222222',
      aadhaar: '999999999901',
      username: 'seed_admin',
      password_hash: passwordHash,
      role: 'ADMIN',
      rc_id: null,
      phone: null,
      email: null,
      active: true,
      workflow_mode: null,
      created_at: new Date().toISOString(),
    };

    const pool = {
      async query(sql, params) {
        if (String(sql).includes('WHERE aadhaar')) {
          assert.equal(params[0], '999999999901');
          return { rows: [userRow] };
        }
        if (String(sql).includes('WHERE id')) {
          assert.equal(params[0], userRow.id);
          return { rows: [userRow] };
        }
        return { rows: [] };
      },
    };

    const app = createApp({
      config: { ...baseConfig, databaseUrl: 'postgresql://mock' },
      logger: createLogger('error'),
      pool,
    });
    const server = app.listen(0);
    const { port } = server.address();

    try {
      const loginRes = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ aadhaar: '999999999901', password: 'TestSeedPass1' }),
      });
      assert.equal(loginRes.status, 200);
      const loginBody = await loginRes.json();
      assert.ok(loginBody.data.token);
      assert.equal(loginBody.data.user.role, 'ADMIN');
      assert.equal(loginBody.data.user.password_hash, undefined);

      const meRes = await fetch(`http://127.0.0.1:${port}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${loginBody.data.token}` },
      });
      assert.equal(meRes.status, 200);
      const meBody = await meRes.json();
      assert.equal(meBody.data.user.id, userRow.id);

      const alias = await fetch(`http://127.0.0.1:${port}/api/v1/me`, {
        headers: { authorization: `Bearer ${loginBody.data.token}` },
      });
      assert.equal(alias.status, 200);

      const bad = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ aadhaar: '999999999901', password: 'wrong-password' }),
      });
      assert.equal(bad.status, 401);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
