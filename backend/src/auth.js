import { verifyPassword } from './passwords.js';
import { signAccessToken, verifyAccessToken } from './jwt.js';
import { ROLES, requireRoles, assertRcAccess } from './rbac.js';

const AADHAAR_RE = /^[0-9]{12}$/;

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

export async function findUserByAadhaar(pool, aadhaar) {
  const result = await pool.query(
    `SELECT id, aadhaar, username, password_hash, role, rc_id, phone, email,
            active, workflow_mode, created_at
     FROM users
     WHERE aadhaar = $1
     LIMIT 1`,
    [aadhaar],
  );
  return result.rows[0] ?? null;
}

export async function findUserById(pool, id) {
  const result = await pool.query(
    `SELECT id, aadhaar, username, password_hash, role, rc_id, phone, email,
            active, workflow_mode, created_at
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function authenticateUser(pool, { aadhaar, password }) {
  const normalized = normalizeAadhaar(aadhaar);
  if (!AADHAAR_RE.test(normalized)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'Aadhaar must be 12 digits' };
  }
  if (typeof password !== 'string' || password.length < 1) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'Password is required' };
  }

  const row = await findUserByAadhaar(pool, normalized);
  if (!row || !row.active) {
    return { ok: false, code: 'INVALID_CREDENTIALS', message: 'Invalid Aadhaar or password' };
  }
  if (!ROLES.includes(row.role)) {
    return { ok: false, code: 'INVALID_CREDENTIALS', message: 'Invalid Aadhaar or password' };
  }

  const match = await verifyPassword(password, row.password_hash);
  if (!match) {
    return { ok: false, code: 'INVALID_CREDENTIALS', message: 'Invalid Aadhaar or password' };
  }

  return { ok: true, user: row };
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
    const [scheme, token] = header.split(' ');
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

export function mountAuthRoutes(app, { config, pool, logger }) {
  const { requireAuth } = createAuthMiddleware({ config, pool, logger });

  app.post('/api/v1/auth/login', async (req, res) => {
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

    try {
      const aadhaar = req.body?.aadhaar ?? req.body?.aadhar;
      const password = req.body?.password;
      const result = await authenticateUser(pool, { aadhaar, password });
      if (!result.ok) {
        const status = result.code === 'VALIDATION_ERROR' ? 400 : 401;
        return res.status(status).json({
          error: { code: result.code, message: result.message },
        });
      }

      const user = publicUser(result.user);
      const token = signAccessToken(
        { id: user.id, role: user.role, rcId: user.rcId },
        config,
      );
      return res.json({ data: { token, user } });
    } catch (error) {
      logger.error?.('Login failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Login failed' },
      });
    }
  });

  app.get('/api/v1/auth/me', requireAuth, async (req, res) => {
    return res.json({ data: { user: req.user } });
  });

  // Alias matching architecture shorthand GET /me under v1
  app.get('/api/v1/me', requireAuth, async (req, res) => {
    return res.json({ data: { user: req.user } });
  });

  return { requireAuth };
}
