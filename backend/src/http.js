export function requireDb(res, pool, config) {
  if (!pool || !config.databaseUrl) {
    res.status(503).json({
      error: { code: 'DB_UNCONFIGURED', message: 'Database is not configured' },
    });
    return false;
  }
  return true;
}

export function parsePaging(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limit = Math.min(maxLimit, Math.max(1, Number(query.limit) || defaultLimit));
  const offset = Math.max(0, Number(query.offset) || 0);
  return { limit, offset };
}

export function resolveRcIdForActor(user, requestedRcId) {
  if (!user) return { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } };
  if (user.role === 'ADMIN') {
    const rcId = String(requestedRcId || '').trim();
    if (!rcId) {
      return { error: { code: 'RC_REQUIRED', message: 'rcId query/body is required for ADMIN' } };
    }
    return { rcId };
  }
  if (!user.rcId) {
    return { error: { code: 'FORBIDDEN', message: 'User has no regional center scope' } };
  }
  if (requestedRcId && String(requestedRcId) !== String(user.rcId)) {
    return { error: { code: 'FORBIDDEN', message: 'Cross-RC access denied' } };
  }
  return { rcId: user.rcId };
}
