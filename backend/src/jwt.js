import jwt from 'jsonwebtoken';

/**
 * @param {{ id: string, role: string, rcId: string | null }} user
 * @param {{ jwtSecret: string, jwtExpiresIn?: string }} config
 */
export function signAccessToken(user, config) {
  if (!config.jwtSecret) {
    throw new Error('JWT_SECRET is required to sign tokens');
  }
  const payload = {
    sub: user.id,
    role: user.role,
    rcId: user.rcId ?? null,
  };
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn || '12h',
    issuer: 'gatc-vps',
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
  return {
    id: decoded.sub,
    role: decoded.role,
    rcId: decoded.rcId ?? null,
  };
}
