import fs from 'node:fs';
import path from 'node:path';

/**
 * eMaap portal session status (operator-assisted only).
 *
 * Status is read from a small JSON file written by a future Playwright worker
 * AFTER an authorized operator completes login (including CAPTCHA/OTP manually).
 * This module never performs login, CAPTCHA solving, or credential automation.
 *
 * File (default): `$DATA_ROOT/emaap/session-status.json`
 * Shape:
 *   {
 *     "loggedIn": true|false,
 *     "updatedAt": "2026-10-31T12:00:00.000Z",
 *     "note": "optional operator note"
 *   }
 */

export const EMAAP_STATUS = Object.freeze({
  LOGGED_IN: 'logged_in',
  NOT_LOGGED_IN: 'not_logged_in',
});

export function defaultSessionStatusPath(dataRoot) {
  const root = String(dataRoot || '').trim();
  if (root) {
    return path.join(root, 'emaap', 'session-status.json');
  }
  return path.join(process.cwd(), 'data', 'emaap', 'session-status.json');
}

/**
 * Resolve path: EMAAP_SESSION_STATUS_PATH env override, else under DATA_ROOT.
 * @param {{ dataRoot?: string, statusPath?: string }} [opts]
 */
export function resolveSessionStatusPath(opts = {}) {
  const fromEnv = String(process.env.EMAAP_SESSION_STATUS_PATH || '').trim();
  if (opts.statusPath) return path.resolve(opts.statusPath);
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(defaultSessionStatusPath(opts.dataRoot));
}

function notLoggedIn(extra = {}) {
  return {
    status: EMAAP_STATUS.NOT_LOGGED_IN,
    label: 'Not Logged In',
    loggedIn: false,
    updatedAt: null,
    source: 'stub',
    note: 'No eMaap session status file yet. Operator-assisted login not wired.',
    ...extra,
  };
}

/**
 * Read portal session status from the status file (no browser automation).
 * @param {{ dataRoot?: string, statusPath?: string }} [opts]
 */
export function getEmaapSessionStatus(opts = {}) {
  const statusPath = resolveSessionStatusPath(opts);

  try {
    if (!fs.existsSync(statusPath)) {
      return {
        ...notLoggedIn(),
        path: statusPath,
        hook: hookHint(statusPath),
      };
    }

    const raw = fs.readFileSync(statusPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') {
      return {
        ...notLoggedIn({ source: 'status_file', note: 'Invalid session status JSON' }),
        path: statusPath,
        hook: hookHint(statusPath),
      };
    }

    const loggedIn = data.loggedIn === true;
    return {
      status: loggedIn ? EMAAP_STATUS.LOGGED_IN : EMAAP_STATUS.NOT_LOGGED_IN,
      label: loggedIn ? 'Logged In' : 'Not Logged In',
      loggedIn,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
      source: 'status_file',
      note: typeof data.note === 'string' ? data.note : null,
      path: statusPath,
      hook: hookHint(statusPath),
    };
  } catch (error) {
    return {
      ...notLoggedIn({
        source: 'error',
        note: `Could not read session status: ${error.message}`,
      }),
      path: statusPath,
      hook: hookHint(statusPath),
    };
  }
}

function hookHint(statusPath) {
  return (
    `After an authorized operator completes eMaap login (CAPTCHA/OTP manually), ` +
    `the automation worker should write ${statusPath} with ` +
    `{"loggedIn":true,"updatedAt":"<ISO8601>"}. On logout/expiry write loggedIn:false. ` +
    `Never store passwords or CAPTCHA solutions in this file.`
  );
}
