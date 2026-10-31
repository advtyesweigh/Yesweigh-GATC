/**
 * One active session per user: creating a session revokes all prior sessions.
 * JWT carries session id (`sid`); middleware rejects revoked/expired sessions.
 */

export async function createSession(pool, {
  userId,
  ttlSeconds,
  userAgent = null,
  ip = null,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE auth_sessions
       SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    const result = await client.query(
      `INSERT INTO auth_sessions (user_id, expires_at, user_agent, ip)
       VALUES (
         $1,
         NOW() + ($2::text || ' seconds')::interval,
         $3,
         $4
       )
       RETURNING id, user_id, created_at, expires_at`,
      [userId, String(ttlSeconds), userAgent, ip],
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function findActiveSession(pool, sessionId, userId) {
  const result = await pool.query(
    `SELECT id, user_id, created_at, expires_at, revoked_at
     FROM auth_sessions
     WHERE id = $1
       AND user_id = $2
       AND revoked_at IS NULL
       AND expires_at > NOW()
     LIMIT 1`,
    [sessionId, userId],
  );
  return result.rows[0] ?? null;
}

export async function revokeSession(pool, sessionId, userId = null) {
  if (userId) {
    await pool.query(
      `UPDATE auth_sessions
       SET revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [sessionId, userId],
    );
    return;
  }
  await pool.query(
    `UPDATE auth_sessions
     SET revoked_at = NOW()
     WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
}

export async function revokeAllUserSessions(pool, userId) {
  await pool.query(
    `UPDATE auth_sessions
     SET revoked_at = NOW()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

/** Parse JWT expiresIn like "12h" / "3600" into seconds (best-effort). */
export function expiresInToSeconds(expiresIn, fallback = 12 * 60 * 60) {
  if (expiresIn == null || expiresIn === '') return fallback;
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) {
    return Math.max(60, Math.floor(expiresIn));
  }
  const raw = String(expiresIn).trim();
  if (/^\d+$/.test(raw)) return Math.max(60, Number.parseInt(raw, 10));
  const m = raw.match(/^(\d+)\s*([smhd])$/i);
  if (!m) return fallback;
  const n = Number.parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit] || 1;
  return Math.max(60, n * mult);
}
