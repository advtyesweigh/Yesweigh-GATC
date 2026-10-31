export const ROLES = Object.freeze(['ADMIN', 'RC_ADMIN', 'VCT']);

export function isAdmin(user) {
  return user?.role === 'ADMIN';
}

/**
 * RC isolation: ADMIN may access any RC; RC_ADMIN/VCT only their own rcId.
 * @returns {true | { code: string, message: string }}
 */
export function assertRcAccess(user, rcId) {
  if (!user) {
    return { code: 'UNAUTHORIZED', message: 'Authentication required' };
  }
  if (isAdmin(user)) {
    return true;
  }
  if (!user.rcId) {
    return { code: 'FORBIDDEN', message: 'User has no regional center scope' };
  }
  if (!rcId || String(rcId) !== String(user.rcId)) {
    return { code: 'FORBIDDEN', message: 'Cross-RC access denied' };
  }
  return true;
}

/**
 * SQL filter helper: null means no extra filter (ADMIN); otherwise bind rc_id.
 */
export function rcScopeFilter(user) {
  if (isAdmin(user)) {
    return { sql: '', params: [] };
  }
  return { sql: 'AND rc_id = $1', params: [user.rcId] };
}

export function requireRoles(...allowed) {
  const set = new Set(allowed);
  return (user) => {
    if (!user) {
      return { code: 'UNAUTHORIZED', message: 'Authentication required' };
    }
    if (!set.has(user.role)) {
      return { code: 'FORBIDDEN', message: `Role ${user.role} is not allowed` };
    }
    return true;
  };
}
