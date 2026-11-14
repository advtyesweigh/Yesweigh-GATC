import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Server-side Yes One / YesWeigh portal credentials (User ID + Password).
 * Stored under $DATA_ROOT/yesone/credentials.enc.json — AES-256-GCM.
 * Public APIs must return only configured/masked status — never plaintext secrets.
 */

const FILE_NAME = 'credentials.enc.json';
const ALGO = 'aes-256-gcm';
const KEY_SALT = 'gatc-vps-yesone-credentials-v1';
export const DEFAULT_YESONE_BASE_URL = 'https://yesgatc.in';

export function resolveYesoneCredentialsPath(dataRoot) {
  const root = String(dataRoot || '').trim();
  if (root) return path.resolve(root, 'yesone', FILE_NAME);
  return path.resolve(process.cwd(), 'data', 'yesone', FILE_NAME);
}

function deriveKey(secret) {
  const material = String(secret || '').trim();
  if (!material || material.length < 16) {
    throw new Error('JWT_SECRET (or encryption key) required to store Yes One credentials');
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
    throw new Error('Unsupported Yes One credentials file format');
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

export function normalizeYesoneBaseUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return DEFAULT_YESONE_BASE_URL;
  s = s.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    if (host === 'yesgatc.in' || host === 'www.yesgatc.in') {
      return 'https://yesgatc.in';
    }
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`.replace(/\/+$/, '');
  } catch {
    return DEFAULT_YESONE_BASE_URL;
  }
}

export function maskUserId(userId) {
  const s = String(userId || '').trim();
  if (!s) return null;
  if (s.includes('@')) {
    const [local, domain] = s.split('@');
    const head = local.slice(0, Math.min(2, local.length));
    return `${head}${'*'.repeat(Math.max(3, local.length - head.length))}@${domain}`;
  }
  if (s.length <= 4) return '••••';
  return `${s.slice(0, 2)}${'•'.repeat(Math.min(8, s.length - 4))}${s.slice(-2)}`;
}

function publicStatus(payload, { path: filePath, source = 'file' } = {}) {
  const configured = Boolean(
    payload
    && String(payload.userId || '').trim()
    && String(payload.password || '').trim(),
  );
  const baseUrl = normalizeYesoneBaseUrl(payload?.baseUrl);
  return {
    configured,
    status: configured ? 'configured' : 'not_configured',
    label: configured ? 'Connected' : 'Not connected',
    userIdMasked: configured ? maskUserId(payload.userId) : null,
    passwordSet: configured,
    baseUrl,
    updatedAt: payload?.updatedAt || null,
    source,
    path: filePath || null,
  };
}

/**
 * Read status only (never returns secrets).
 * @param {{ dataRoot?: string, jwtSecret?: string, credentialsPath?: string }} opts
 */
export function getYesoneCredentialsStatus(opts = {}) {
  const filePath = opts.credentialsPath
    ? path.resolve(opts.credentialsPath)
    : resolveYesoneCredentialsPath(opts.dataRoot);

  try {
    if (!fs.existsSync(filePath)) {
      return publicStatus(null, { path: filePath, source: 'missing' });
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const payload = decryptPayload(raw, opts.jwtSecret);
    return publicStatus(payload, { path: filePath, source: 'file' });
  } catch (error) {
    return {
      configured: false,
      status: 'error',
      label: 'Not connected',
      userIdMasked: null,
      passwordSet: false,
      baseUrl: DEFAULT_YESONE_BASE_URL,
      updatedAt: null,
      source: 'error',
      path: filePath,
      note: `Could not read Yes One credentials: ${error.message}`,
    };
  }
}

/**
 * Persist credentials. Returns public status only.
 * @param {{ userId: string, password: string, baseUrl?: string }} input
 * @param {{ dataRoot?: string, jwtSecret?: string, credentialsPath?: string }} opts
 */
export function saveYesoneCredentials(input, opts = {}) {
  const userId = String(input?.userId || '').trim();
  const password = String(input?.password || '').trim();
  const baseUrl = normalizeYesoneBaseUrl(input?.baseUrl);
  if (!userId || !password) {
    const err = new Error('userId and password are required');
    err.code = 'VALIDATION';
    throw err;
  }

  const filePath = opts.credentialsPath
    ? path.resolve(opts.credentialsPath)
    : resolveYesoneCredentialsPath(opts.dataRoot);

  const payload = {
    userId,
    password,
    baseUrl,
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

  return publicStatus(payload, { path: filePath, source: 'file' });
}

/**
 * Internal: load decrypted credentials for workers only.
 * Do not expose via HTTP.
 */
export function loadYesoneCredentialsSecrets(opts = {}) {
  const filePath = opts.credentialsPath
    ? path.resolve(opts.credentialsPath)
    : resolveYesoneCredentialsPath(opts.dataRoot);
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return decryptPayload(raw, opts.jwtSecret);
}
