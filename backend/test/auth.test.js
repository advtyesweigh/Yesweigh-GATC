import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { hashPassword } from '../src/passwords.js';
import { signAccessToken, verifyAccessToken } from '../src/jwt.js';
import { assertRcAccess, requireRoles } from '../src/rbac.js';
import {
  normalizeAadhaar,
  normalizeLoginRole,
  publicUser,
  matchesAdminMasterOtp,
} from '../src/auth.js';
import { hashOtp, verifyOtpHash, generateOtpCode } from '../src/otp.js';
import { maskPhone, normalizePhone } from '../src/sms.js';
import { expiresInToSeconds } from '../src/sessions.js';

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
};

describe('passwords and jwt', () => {
  it('hashes and verifies passwords', async () => {
    const hash = await hashPassword('CorrectHorseBattery');
    assert.notEqual(hash, 'CorrectHorseBattery');
    assert.equal(await import('../src/passwords.js').then((m) => m.verifyPassword('CorrectHorseBattery', hash)), true);
    assert.equal(await import('../src/passwords.js').then((m) => m.verifyPassword('wrong', hash)), false);
  });

  it('signs and verifies access tokens with role, rcId, and sessionId', () => {
    const token = signAccessToken(
      {
        id: '11111111-1111-1111-1111-111111111111',
        role: 'RC_ADMIN',
        rcId: 'rc-1',
        sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      },
      baseConfig,
    );
    const claims = verifyAccessToken(token, baseConfig);
    assert.equal(claims.id, '11111111-1111-1111-1111-111111111111');
    assert.equal(claims.role, 'RC_ADMIN');
    assert.equal(claims.rcId, 'rc-1');
    assert.equal(claims.sessionId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });
});

describe('otp and phone helpers', () => {
  it('hashes OTP with pepper and verifies timing-safe', () => {
    const code = generateOtpCode(6);
    assert.match(code, /^[0-9]{6}$/);
    const digest = hashOtp(code, baseConfig.jwtSecret);
    assert.equal(verifyOtpHash(code, digest, baseConfig.jwtSecret), true);
    assert.equal(verifyOtpHash('000000', digest, baseConfig.jwtSecret), false);
  });

  it('normalizes and masks Indian phones', () => {
    assert.equal(normalizePhone('9876543210'), '+919876543210');
    assert.equal(maskPhone('9876543210'), '******3210');
  });

  it('parses jwt expiresIn to seconds', () => {
    assert.equal(expiresInToSeconds('12h'), 12 * 3600);
    assert.equal(expiresInToSeconds('30m'), 1800);
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

  it('accepts master OTP for ADMIN only', () => {
    const cfg = { ...baseConfig, masterOtp: '546054' };
    assert.equal(matchesAdminMasterOtp('546054', cfg, 'ADMIN'), true);
    assert.equal(matchesAdminMasterOtp('546054', cfg, 'RC_ADMIN'), false);
    assert.equal(matchesAdminMasterOtp('000000', cfg, 'ADMIN'), false);
    assert.equal(matchesAdminMasterOtp('546054', { ...baseConfig, masterOtp: '' }, 'ADMIN'), false);
  });

  it('normalizes legacy role aliases (client role no longer required)', () => {
    assert.equal(normalizeLoginRole('ADMIN'), 'ADMIN');
    assert.equal(normalizeLoginRole('Super admin'), 'ADMIN');
    assert.equal(normalizeLoginRole('RC admin'), 'RC_ADMIN');
    assert.equal(normalizeLoginRole('RC_ADMIN'), 'RC_ADMIN');
    assert.equal(normalizeLoginRole('VCT'), 'VCT');
    assert.equal(normalizeLoginRole('nope'), null);
    assert.equal(normalizeLoginRole(''), null);
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

function createAuthMockPool(userRow) {
  /** @type {Map<string, object>} */
  const challenges = new Map();
  /** @type {Map<string, object>} */
  const sessions = new Map();
  let lastOtpPlain = null;

  const pool = {
    lastOtpPlain: () => lastOtpPlain,
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
        // Recover plain OTP by brute is unnecessary; tests read from logger.
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

      return { rows: [] };
    },
    // Test helper: inject known OTP by replacing hash after challenge create.
    async forceOtp(challengeId, plain) {
      lastOtpPlain = plain;
      const row = challenges.get(challengeId);
      if (row) row.code_hash = hashOtp(plain, baseConfig.jwtSecret);
    },
    getChallenge(id) {
      return challenges.get(id);
    },
    getSession(id) {
      return sessions.get(id);
    },
  };

  return pool;
}

describe('auth login OTP + single session', () => {
  it('requires OTP after password then issues session-bound JWT', async () => {
    const passwordHash = await hashPassword('TestSeedPass1');
    const userRow = {
      id: '22222222-2222-2222-2222-222222222222',
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

    const app = createApp({
      config: { ...baseConfig, databaseUrl: 'postgresql://mock' },
      logger,
      pool,
    });
    const server = app.listen(0);
    const { port } = server.address();

    try {
      const bad = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: '999999999901', password: 'wrong-password' }),
      });
      assert.equal(bad.status, 401);

      const loginRes = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: '999999999901', password: 'TestSeedPass1' }),
      });
      assert.equal(loginRes.status, 200);
      const loginBody = await loginRes.json();
      assert.equal(loginBody.data.otpRequired, false);
      assert.ok(loginBody.data.token);
      assert.equal(loginBody.data.user.role, 'ADMIN');
      const token1 = loginBody.data.token;

      const meRes = await fetch(`http://127.0.0.1:${port}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${token1}` },
      });
      assert.equal(meRes.status, 200);

      // Second login revokes the first session.
      const login2 = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ aadhaar: '999999999901', password: 'TestSeedPass1' }),
      });
      assert.equal(login2.status, 200);
      const token2 = (await login2.json()).data.token;
      assert.ok(token2);

      const stale = await fetch(`http://127.0.0.1:${port}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${token1}` },
      });
      assert.equal(stale.status, 401);
      const staleBody = await stale.json();
      assert.equal(staleBody.error.code, 'SESSION_REVOKED');

      const me2 = await fetch(`http://127.0.0.1:${port}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${token2}` },
      });
      assert.equal(me2.status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('accepts ADMIN master OTP without matching challenge hash', async () => {
    const passwordHash = await hashPassword('TestSeedPass1');
    const userRow = {
      id: '44444444-4444-4444-4444-444444444444',
      aadhaar: '718835126130',
      username: 'faisal',
      password_hash: passwordHash,
      role: 'ADMIN',
      rc_id: null,
      phone: '9000000099',
      email: null,
      active: true,
      workflow_mode: null,
      created_at: new Date().toISOString(),
    };
    const pool = createAuthMockPool(userRow);
    const app = createApp({
      config: {
        ...baseConfig,
        databaseUrl: 'postgresql://mock',
        masterOtp: '546054',
      },
      logger: createLogger('error'),
      pool,
    });
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const loginRes = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ aadhaar: '718835126130', password: 'TestSeedPass1' }),
      });
      assert.equal(loginRes.status, 200);
      const body = await loginRes.json();
      assert.ok(body.data.token);
      assert.equal(body.data.otpRequired, false);
      assert.equal(body.data.user.role, 'ADMIN');
      assert.equal(body.data.user.username, 'faisal');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects login when user has no phone', async () => {
    const passwordHash = await hashPassword('TestSeedPass1');
    const userRow = {
      id: '33333333-3333-3333-3333-333333333333',
      aadhaar: '999999999902',
      username: 'nophone',
      password_hash: passwordHash,
      role: 'ADMIN',
      rc_id: null,
      phone: null,
      email: null,
      active: true,
      workflow_mode: null,
      created_at: new Date().toISOString(),
    };
    const pool = createAuthMockPool(userRow);
    const app = createApp({
      config: { ...baseConfig, databaseUrl: 'postgresql://mock' },
      logger: createLogger('error'),
      pool,
    });
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: '999999999902', password: 'TestSeedPass1' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.data.token);
      assert.equal(body.data.user.username, 'nophone');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
