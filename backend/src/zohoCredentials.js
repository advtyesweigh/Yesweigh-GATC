import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Server-side Zoho Books OAuth tokens (refresh + optional access cache metadata).
 * Stored under $DATA_ROOT/zoho/credentials.enc.json — AES-256-GCM.
 * Public APIs must return only configured/masked status — never plaintext secrets.
 */

const FILE_NAME = 'credentials.enc.json';
const ALGO = 'aes-256-gcm';
const KEY_SALT = 'gatc-vps-zoho-credentials-v1';

export function resolveZohoCredentialsPath(dataRoot) {
  const root = String(dataRoot || '').trim();
  if (root) return path.resolve(root, 'zoho', FILE_NAME);
  return path.resolve(process.cwd(), 'data', 'zoho', FILE_NAME);
}

function deriveKey(secret) {
  const material = String(secret || '').trim();
  if (!material || material.length < 16) {
    throw new Error('JWT_SECRET (or encryption key) required to store Zoho credentials');
  }
  return crypto.scryptSync(material, KEY_SALT, 32);
}

function encryptPayload(plainObj, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(plainObj), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: ALGO,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  };
}

function decryptPayload(fileObj, secret) {
  if (!fileObj || fileObj.v !== 1 || fileObj.alg !== ALGO) {
    throw new Error('Unsupported Zoho credentials file format');
  }
  const key = deriveKey(secret);
  const iv = Buffer.from(fileObj.iv, 'base64');
  const tag = Buffer.from(fileObj.tag, 'base64');
  const data = Buffer.from(fileObj.data, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

export function maskClientId(clientId) {
  const s = String(clientId || '').trim();
  if (!s) return null;
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}${'•'.repeat(Math.min(10, s.length - 8))}${s.slice(-4)}`;
}

function publicStatus(payload, { path: filePath, source = 'file', oauthClientConfigured = false, redirectUri = null } = {}) {
  const hasRefresh = Boolean(payload && String(payload.refreshToken || '').trim());
  const configured = hasRefresh;
  const organizationId = configured
    ? (payload.organizationId || null)
    : (payload?.organizationId || null);
  const organizationName = configured
    ? (payload.organizationName || null)
    : (payload?.organizationName || null);
  return {
    configured,
    status: configured ? 'configured' : 'not_configured',
    label: configured ? 'Connected' : 'Not connected',
    organizationId,
    organizationName,
    clientIdMasked: configured ? maskClientId(payload.clientId) : null,
    refreshTokenSet: configured,
    accountsBase: payload?.accountsBase || null,
    connectedVia: configured ? (payload.connectedVia || 'oauth') : null,
    updatedAt: payload?.updatedAt || null,
    oauthClientConfigured: Boolean(oauthClientConfigured),
    redirectUri: redirectUri || null,
    source,
    path: filePath || null,
  };
}

/**
 * Read status only (never returns secrets).
 * @param {{ dataRoot?: string, jwtSecret?: string, credentialsPath?: string, oauthClientConfigured?: boolean, redirectUri?: string }} opts
 */
export function getZohoCredentialsStatus(opts = {}) {
  const filePath = opts.credentialsPath
    ? path.resolve(opts.credentialsPath)
    : resolveZohoCredentialsPath(opts.dataRoot);

  const meta = {
    path: filePath,
    oauthClientConfigured: opts.oauthClientConfigured,
    redirectUri: opts.redirectUri,
  };

  try {
    if (!fs.existsSync(filePath)) {
      return publicStatus(null, { ...meta, source: 'missing' });
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const payload = decryptPayload(raw, opts.jwtSecret);
    return publicStatus(payload, { ...meta, source: 'file' });
  } catch (error) {
    return {
      configured: false,
      status: 'error',
      label: 'Not connected',
      organizationId: null,
      organizationName: null,
      clientIdMasked: null,
      refreshTokenSet: false,
      accountsBase: null,
      connectedVia: null,
      updatedAt: null,
      oauthClientConfigured: Boolean(opts.oauthClientConfigured),
      redirectUri: opts.redirectUri || null,
      source: 'error',
      path: filePath,
      note: `Could not read Zoho credentials: ${error.message}`,
    };
  }
}

/**
 * Persist OAuth tokens / org mapping. Returns public status only.
 * @param {{ refreshToken: string, accessToken?: string, expiresAt?: number|null, clientId?: string, organizationId?: string, organizationName?: string, accountsBase?: string, apiDomain?: string, connectedVia?: string }} input
 * @param {{ dataRoot?: string, jwtSecret?: string, credentialsPath?: string, oauthClientConfigured?: boolean, redirectUri?: string }} opts
 */
export function saveZohoCredentials(input, opts = {}) {
  const refreshToken = String(input?.refreshToken || '').trim();
  if (!refreshToken) {
    const err = new Error('refreshToken is required');
    err.code = 'VALIDATION';
    throw err;
  }

  const filePath = opts.credentialsPath
    ? path.resolve(opts.credentialsPath)
    : resolveZohoCredentialsPath(opts.dataRoot);

  let existing = null;
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      existing = decryptPayload(raw, opts.jwtSecret);
    }
  } catch {
    existing = null;
  }

  const organizationId = String(
    input?.organizationId != null ? input.organizationId : (existing?.organizationId || ''),
  ).trim() || null;

  const organizationName = String(
    input?.organizationName != null ? input.organizationName : (existing?.organizationName || ''),
  ).trim() || null;

  const payload = {
    refreshToken,
    accessToken: input?.accessToken != null ? String(input.accessToken) : (existing?.accessToken || null),
    expiresAt: input?.expiresAt != null ? Number(input.expiresAt) : (existing?.expiresAt || null),
    clientId: String(input?.clientId || existing?.clientId || '').trim() || null,
    organizationId,
    organizationName,
    accountsBase: String(input?.accountsBase || existing?.accountsBase || 'https://accounts.zoho.in').trim(),
    apiDomain: String(input?.apiDomain || existing?.apiDomain || '').trim() || null,
    connectedVia: String(input?.connectedVia || existing?.connectedVia || 'oauth').trim(),
    updatedAt: new Date().toISOString(),
  };

  const wrapped = encryptPayload(payload, opts.jwtSecret);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(wrapped, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* ignore on platforms that don't support chmod */
  }

  return publicStatus(payload, {
    path: filePath,
    source: 'file',
    oauthClientConfigured: opts.oauthClientConfigured,
    redirectUri: opts.redirectUri,
  });
}

/**
 * Update organization id/name without rotating tokens.
 * @param {string|{ organizationId?: string, organizationName?: string }} organizationIdOrPatch
 */
export function updateZohoOrganizationId(organizationIdOrPatch, opts = {}) {
  const secrets = loadZohoCredentialsSecrets(opts);
  if (!secrets?.refreshToken) {
    const err = new Error('Zoho is not connected');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const patch = (organizationIdOrPatch && typeof organizationIdOrPatch === 'object')
    ? organizationIdOrPatch
    : { organizationId: organizationIdOrPatch };
  return saveZohoCredentials(
    {
      ...secrets,
      organizationId: patch.organizationId != null
        ? (String(patch.organizationId || '').trim() || null)
        : secrets.organizationId,
      organizationName: patch.organizationName != null
        ? (String(patch.organizationName || '').trim() || null)
        : secrets.organizationName,
    },
    opts,
  );
}

/**
 * Remove stored credentials (disconnect).
 */
export function clearZohoCredentials(opts = {}) {
  const filePath = opts.credentialsPath
    ? path.resolve(opts.credentialsPath)
    : resolveZohoCredentialsPath(opts.dataRoot);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    const err = new Error(`Could not clear Zoho credentials: ${error.message}`);
    err.code = 'INTERNAL';
    throw err;
  }
  return publicStatus(null, {
    path: filePath,
    source: 'missing',
    oauthClientConfigured: opts.oauthClientConfigured,
    redirectUri: opts.redirectUri,
  });
}

/**
 * Internal: load decrypted credentials for workers / token refresh only.
 * Do not expose via HTTP.
 */
export function loadZohoCredentialsSecrets(opts = {}) {
  const filePath = opts.credentialsPath
    ? path.resolve(opts.credentialsPath)
    : resolveZohoCredentialsPath(opts.dataRoot);
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return decryptPayload(raw, opts.jwtSecret);
}
