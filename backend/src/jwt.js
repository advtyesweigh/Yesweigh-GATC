import jwt from 'jsonwebtoken';

/**
 * @param {{ id: string, role: string, rcId: string | null, sessionId: string }} user
 * @param {{ jwtSecret: string, jwtExpiresIn?: string }} config
 */
export function signAccessToken(user, config) {
  if (!config.jwtSecret) {
    throw new Error('JWT_SECRET is required to sign tokens');
  }
  if (!user.sessionId) {
    throw new Error('sessionId is required to sign tokens');
  }
  const payload = {
    sub: user.id,
    role: user.role,
    rcId: user.rcId ?? null,
    sid: user.sessionId,
  };
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn || '12h',
    issuer: 'gatc-vps',
    jwtid: user.sessionId,
  });
}

/**
 * @param {string} token
 * @param {{ jwtSecret: string }} config
 */
export function verifyAccessToken(token, config) {
  if (!config.jwtSecret) {
    throw new Error('JWT_SECRET is required to verify tokens');
  }
  const decoded = jwt.verify(token, config.jwtSecret, {
    issuer: 'gatc-vps',
  });
  const sessionId = decoded.sid || decoded.jti || null;
  if (!sessionId) {
    throw new Error('Token missing session id');
  }
  return {
    id: decoded.sub,
    role: decoded.role,
    rcId: decoded.rcId ?? null,
    sessionId,
  };
}
