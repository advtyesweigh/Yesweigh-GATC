import crypto from 'node:crypto';
import { verifyPassword } from './passwords.js';
import { signAccessToken, verifyAccessToken } from './jwt.js';
import { ROLES, requireRoles, assertRcAccess } from './rbac.js';
import {
  generateOtpCode,
  hashOtp,
  verifyOtpHash,
  createOtpChallenge,
  findOtpChallenge,
  consumeOtpChallenge,
  incrementOtpAttempts,
  refreshOtpChallenge,
  invalidateOpenChallenges,
} from './otp.js';
import {
  createSession,
  findActiveSession,
  revokeSession,
  expiresInToSeconds,
} from './sessions.js';
import {
  normalizePhone,
  maskPhone,
  sendSms,
  buildLoginOtpMessage,
} from './sms.js';

const AADHAAR_RE = /^[0-9]{12}$/;
const OTP_RE = /^[0-9]{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** ADMIN (super admin) only. Compares against env MASTER_OTP / ADMIN_MASTER_OTP. */
export function matchesAdminMasterOtp(otp, config, role) {
  if (role !== 'ADMIN') return false;
  const master = String(config?.masterOtp || '').trim();
  if (!OTP_RE.test(otp) || !OTP_RE.test(master)) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(otp, 'utf8'), Buffer.from(master, 'utf8'));
  } catch {
    return false;
  }
}

export function normalizeAadhaar(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\s+/g, '');
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    aadhaar: row.aadhaar,
    username: row.username,
    role: row.role,
    rcId: row.rc_id ?? null,
    phone: row.phone,
    email: row.email,
    active: row.active,
    workflowMode: row.workflow_mode ?? null,
    createdAt: row.created_at,
  };
}

const USER_SELECT = `id, aadhaar, username, password_hash, role, rc_id, phone, email,
            active, workflow_mode, created_at`;

export async function findUserByAadhaar(pool, aadhaar) {
  const result = await pool.query(
    `SELECT ${USER_SELECT}
     FROM users
     WHERE aadhaar = $1
     LIMIT 1`,
    [aadhaar],
  );
  return result.rows[0] ?? null;
}

export async function findUserByUsername(pool, username) {
  const result = await pool.query(
    `SELECT ${USER_SELECT}
     FROM users
     WHERE lower(username) = lower($1)
     LIMIT 1`,
    [username],
  );
  return result.rows[0] ?? null;
}

export async function findUserById(pool, id) {
  const result = await pool.query(
    `SELECT ${USER_SELECT}
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Resolve login id: 12-digit Aadhaar, else username. */
export async function findUserByLoginId(pool, loginId) {
  const raw = String(loginId ?? '').trim();
  if (!raw) return null;
  const aadhaar = normalizeAadhaar(raw);
  if (AADHAAR_RE.test(aadhaar)) {
    return findUserByAadhaar(pool, aadhaar);
  }
  return findUserByUsername(pool, raw);
}

/** @deprecated Role is taken from the DB user row; client role is ignored. */
export function normalizeLoginRole(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const key = String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
  const aliases = {
    ADMIN: 'ADMIN',
    SUPER_ADMIN: 'ADMIN',
    SUPERADMIN: 'ADMIN',
    RC_ADMIN: 'RC_ADMIN',
    RCADMIN: 'RC_ADMIN',
    VCT: 'VCT',
  };
  return aliases[key] || (ROLES.includes(key) ? key : null);
}

/** Look up by Aadhaar/userId, verify password; role comes from the stored user row. */
export async function authenticateUser(pool, { aadhaar, userId, password }) {
  const loginId = userId ?? aadhaar;
  if (loginId == null || String(loginId).trim() === '') {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'User ID is required' };
  }
  if (typeof password !== 'string' || password.length < 1) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'Password is required' };
  }

  const row = await findUserByLoginId(pool, loginId);
  if (!row || !row.active) {
    return { ok: false, code: 'INVALID_CREDENTIALS', message: 'Invalid user ID or password' };
  }
  if (!ROLES.includes(row.role)) {
    return { ok: false, code: 'INVALID_CREDENTIALS', message: 'Invalid user ID or password' };
  }

  const match = await verifyPassword(password, row.password_hash);
  if (!match) {
    return { ok: false, code: 'INVALID_CREDENTIALS', message: 'Invalid user ID or password' };
  }

  return { ok: true, user: row };
}

function clientMeta(req) {
  return {
    userAgent: String(req.headers['user-agent'] || '').slice(0, 400) || null,
    ip: String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
      .split(',')[0]
      .trim()
      .slice(0, 128) || null,
  };
}

async function issueOtpChallenge({ pool, config, logger, user }) {
  const phone = normalizePhone(user.phone);
  if (!phone) {
    return {
      ok: false,
      code: 'PHONE_REQUIRED',
      message: 'No registered mobile number on this account. Contact an administrator.',
    };
  }

  await invalidateOpenChallenges(pool, user.id);

  const otp = generateOtpCode(6);
  const codeHash = hashOtp(otp, config.jwtSecret);
  const phoneHint = maskPhone(phone);
  const challenge = await createOtpChallenge(pool, {
    userId: user.id,
    phone,
    phoneHint,
    codeHash,
    ttlSeconds: config.otpTtlSeconds,
    maxAttempts: config.otpMaxAttempts,
  });

  try {
    await sendSms(
      {
        to: phone,
        message: buildLoginOtpMessage(otp, config),
        otp,
        name: user.username || user.displayName || 'there',
      },
      config,
      logger,
    );
  } catch (error) {
    logger.error?.('OTP SMS send failed', { error: error.message, userId: user.id });
    await consumeOtpChallenge(pool, challenge.id);
    return {
      ok: false,
      code: 'SMS_FAILED',
      message: 'Could not send OTP. Try again later or contact support.',
    };
  }

  return {
    ok: true,
    challengeId: challenge.id,
    phoneHint: challenge.phone_hint,
    expiresInSeconds: config.otpTtlSeconds,
  };
}

export function createAuthMiddleware({ config, pool, logger }) {
  async function requireAuth(req, res, next) {
    if (!pool) {
      return res.status(503).json({
        error: { code: 'DB_UNAVAILABLE', message: 'Database is not configured' },
      });
    }
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }

    const header = req.headers.authorization || '';
    let [scheme, token] = header.split(' ');
    // Allow ?access_token= for <img src> / media embeds (Bearer still preferred for XHR).
    if (scheme !== 'Bearer' || !token) {
      const qRaw = req.query?.access_token ?? req.query?.token;
      const qToken = Array.isArray(qRaw) ? String(qRaw[0] || '') : String(qRaw || '');
      if (qToken.trim()) {
        scheme = 'Bearer';
        token = qToken.trim();
      }
    }
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Bearer token required' },
      });
    }

    try {
      const claims = verifyAccessToken(token, config);
      const row = await findUserById(pool, claims.id);
      if (!row || !row.active) {
        return res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Invalid or inactive user' },
        });
      }
      const session = await findActiveSession(pool, claims.sessionId, claims.id);
      if (!session) {
        return res.status(401).json({
          error: {
            code: 'SESSION_REVOKED',
            message: 'Session expired or signed in elsewhere',
          },
        });
      }
      req.user = publicUser(row);
      req.auth = claims;
      return next();
    } catch (error) {
      logger.warn?.('JWT verification failed', { error: error.message });
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
      });
    }
  }

  function requireRole(...roles) {
    const check = requireRoles(...roles);
    return (req, res, next) => {
      const result = check(req.user);
      if (result !== true) {
        return res.status(result.code === 'UNAUTHORIZED' ? 401 : 403).json({
          error: result,
        });
      }
      return next();
    };
  }

  function requireRcAccess(getRcId) {
    return (req, res, next) => {
      const rcId = typeof getRcId === 'function' ? getRcId(req) : getRcId;
      const result = assertRcAccess(req.user, rcId);
      if (result !== true) {
        return res.status(result.code === 'UNAUTHORIZED' ? 401 : 403).json({
          error: result,
        });
      }
      return next();
    };
  }

  return { requireAuth, requireRole, requireRcAccess };
}

function authUnavailable(res, pool, config) {
  if (!pool) {
    res.status(503).json({
      error: { code: 'DB_UNAVAILABLE', message: 'Database is not configured' },
    });
    return true;
  }
  if (!config.jwtSecret) {
    res.status(503).json({
      error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
    });
    return true;
  }
  return false;
}

export function mountAuthRoutes(app, { config, pool, logger }) {
  const { requireAuth } = createAuthMiddleware({ config, pool, logger });

  /**
   * User id + password → session + JWT (no WhatsApp OTP).
   * Accepts aadhaar / userId / username for the login id field.
   */
  app.post('/api/v1/auth/login', async (req, res) => {
    if (authUnavailable(res, pool, config)) return;

    try {
      const loginId = req.body?.userId ?? req.body?.aadhaar ?? req.body?.aadhar ?? req.body?.username;
      const password = req.body?.password;
      // Client-sent role is ignored; workspace uses stored user.role.
      const result = await authenticateUser(pool, { userId: loginId, password });
      if (!result.ok) {
        const status = result.code === 'VALIDATION_ERROR' ? 400 : 401;
        return res.status(status).json({
          error: { code: result.code, message: result.message },
        });
      }

      const ttlSeconds = expiresInToSeconds(config.jwtExpiresIn);
      const meta = clientMeta(req);
      const session = await createSession(pool, {
        userId: result.user.id,
        ttlSeconds,
        userAgent: meta.userAgent,
        ip: meta.ip,
      });

      const user = publicUser(result.user);
      const token = signAccessToken(
        { id: user.id, role: user.role, rcId: user.rcId, sessionId: session.id },
        config,
      );

      return res.json({
        data: {
          otpRequired: false,
          token,
          user,
          sessionId: session.id,
        },
      });
    } catch (error) {
      logger.error?.('Login failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Login failed' },
      });
    }
  });

  /** Step 2: verify OTP → create single-device session + JWT. */
  app.post('/api/v1/auth/otp/verify', async (req, res) => {
    if (authUnavailable(res, pool, config)) return;

    try {
      const challengeId = String(req.body?.challengeId || '').trim();
      const otp = String(req.body?.otp || '').trim();
      if (!UUID_RE.test(challengeId)) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'Valid challengeId is required' },
        });
      }
      if (!OTP_RE.test(otp)) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'OTP must be 6 digits' },
        });
      }

      const challenge = await findOtpChallenge(pool, challengeId);
      if (!challenge || challenge.consumed_at) {
        return res.status(401).json({
          error: { code: 'INVALID_OTP', message: 'Invalid or expired OTP challenge' },
        });
      }
      if (new Date(challenge.expires_at).getTime() <= Date.now()) {
        return res.status(401).json({
          error: { code: 'OTP_EXPIRED', message: 'OTP has expired. Request a new code.' },
        });
      }
      if (challenge.attempts >= challenge.max_attempts) {
        return res.status(429).json({
          error: { code: 'OTP_LOCKED', message: 'Too many attempts. Request a new OTP.' },
        });
      }

      const userRow = await findUserById(pool, challenge.user_id);
      if (!userRow || !userRow.active) {
        return res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Invalid or inactive user' },
        });
      }

      const hashMatch = verifyOtpHash(otp, challenge.code_hash, config.jwtSecret);
      const masterMatch = matchesAdminMasterOtp(otp, config, userRow.role);
      if (!hashMatch && !masterMatch) {
        const updated = await incrementOtpAttempts(pool, challengeId);
        const remaining = Math.max(0, (updated?.max_attempts ?? 5) - (updated?.attempts ?? 0));
        return res.status(401).json({
          error: {
            code: 'INVALID_OTP',
            message: remaining
              ? `Incorrect OTP. ${remaining} attempt(s) left.`
              : 'Too many attempts. Request a new OTP.',
          },
        });
      }

      await consumeOtpChallenge(pool, challengeId);

      const ttlSeconds = expiresInToSeconds(config.jwtExpiresIn);
      const meta = clientMeta(req);
      const session = await createSession(pool, {
        userId: userRow.id,
        ttlSeconds,
        userAgent: meta.userAgent,
        ip: meta.ip,
      });

      const user = publicUser(userRow);
      const token = signAccessToken(
        { id: user.id, role: user.role, rcId: user.rcId, sessionId: session.id },
        config,
      );

      return res.json({ data: { token, user, sessionId: session.id } });
    } catch (error) {
      logger.error?.('OTP verify failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'OTP verification failed' },
      });
    }
  });

  /** Resend OTP for an open challenge (rate-limited). */
  app.post('/api/v1/auth/otp/resend', async (req, res) => {
    if (authUnavailable(res, pool, config)) return;

    try {
      const challengeId = String(req.body?.challengeId || '').trim();
      if (!UUID_RE.test(challengeId)) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'Valid challengeId is required' },
        });
      }

      const challenge = await findOtpChallenge(pool, challengeId);
      if (!challenge || challenge.consumed_at) {
        return res.status(401).json({
          error: { code: 'INVALID_OTP', message: 'Invalid or expired OTP challenge' },
        });
      }

      const lastSent = new Date(challenge.last_sent_at).getTime();
      const waitMs = (config.otpResendSeconds || 60) * 1000;
      const elapsed = Date.now() - lastSent;
      if (elapsed < waitMs) {
        return res.status(429).json({
          error: {
            code: 'OTP_RESEND_WAIT',
            message: `Wait ${Math.ceil((waitMs - elapsed) / 1000)}s before resending`,
          },
        });
      }

      const otp = generateOtpCode(6);
      const codeHash = hashOtp(otp, config.jwtSecret);
      const refreshed = await refreshOtpChallenge(pool, challengeId, {
        codeHash,
        ttlSeconds: config.otpTtlSeconds,
      });
      if (!refreshed) {
        return res.status(401).json({
          error: { code: 'INVALID_OTP', message: 'Invalid or expired OTP challenge' },
        });
      }

      try {
        let resendName = 'there';
        if (challenge.user_id) {
          const userRes = await pool.query(
            `SELECT username FROM users WHERE id = $1 LIMIT 1`,
            [challenge.user_id],
          );
          resendName = userRes.rows[0]?.username || resendName;
        }
        await sendSms(
          {
            to: refreshed.phone_e164,
            message: buildLoginOtpMessage(otp, config),
            otp,
            name: resendName,
          },
          config,
          logger,
        );
      } catch (error) {
        logger.error?.('OTP resend SMS failed', { error: error.message });
        return res.status(502).json({
          error: { code: 'SMS_FAILED', message: 'Could not send OTP. Try again later.' },
        });
      }

      return res.json({
        data: {
          challengeId: refreshed.id,
          phoneHint: refreshed.phone_hint,
          expiresInSeconds: config.otpTtlSeconds,
        },
      });
    } catch (error) {
      logger.error?.('OTP resend failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'OTP resend failed' },
      });
    }
  });

  app.post('/api/v1/auth/logout', requireAuth, async (req, res) => {
    try {
      await revokeSession(pool, req.auth.sessionId, req.auth.id);
      return res.json({ data: { ok: true } });
    } catch (error) {
      logger.error?.('Logout failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Logout failed' },
      });
    }
  });

  app.get('/api/v1/auth/me', requireAuth, async (req, res) => {
    return res.json({ data: { user: req.user } });
  });

  app.get('/api/v1/me', requireAuth, async (req, res) => {
    return res.json({ data: { user: req.user } });
  });

  return { requireAuth };
}
