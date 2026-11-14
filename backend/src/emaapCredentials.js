import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Server-side eMaap portal credentials (User ID, Password, Master OTP).
 * Stored under $DATA_ROOT/emaap/credentials.enc.json — AES-256-GCM.
 * Public APIs must return only configured/masked status — never plaintext secrets.
 */

const FILE_NAME = 'credentials.enc.json';
const ALGO = 'aes-256-gcm';
const KEY_SALT = 'gatc-vps-emaap-credentials-v1';

export function resolveEmaapCredentialsPath(dataRoot) {
  const root = String(dataRoot || '').trim();
  if (root) return path.resolve(root, 'emaap', FILE_NAME);
  return path.resolve(process.cwd(), 'data', 'emaap', FILE_NAME);
}

function deriveKey(secret) {
  const material = String(secret || '').trim();
  if (!material || material.length < 16) {
    throw new Error('JWT_SECRET (or encryption key) required to store eMaap credentials');
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
    throw new Error('Unsupported eMaap credentials file format');
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
    && String(payload.password || '').trim()
    && String(payload.masterOtp || '').trim(),
  );
  return {
    configured,
    status: configured ? 'configured' : 'not_configured',
    label: configured ? 'Connected' : 'Not connected',
    userIdMasked: configured ? maskUserId(payload.userId) : null,
    passwordSet: configured,
    masterOtpSet: configured,
    updatedAt: payload?.updatedAt || null,
    source,
    path: filePath || null,
  };
}

/**
 * Read status only (never returns secrets).
 * @param {{ dataRoot?: string, jwtSecret?: string, credentialsPath?: string }} opts
 */
export function getEmaapCredentialsStatus(opts = {}) {
  const filePath = opts.credentialsPath
    ? path.resolve(opts.credentialsPath)
    : resolveEmaapCredentialsPath(opts.dataRoot);

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
      masterOtpSet: false,
      updatedAt: null,
      source: 'error',
      path: filePath,
      note: `Could not read eMaap credentials: ${error.message}`,
    };
  }
}

/**
 * Persist credentials. Returns public status only.
 * @param {{ userId: string, password: string, masterOtp: string }} input
 * @param {{ dataRoot?: string, jwtSecret?: string, credentialsPath?: string }} opts
 */
export function saveEmaapCredentials(input, opts = {}) {
  const userId = String(input?.userId || '').trim();
  const password = String(input?.password || '').trim();
  const masterOtp = String(input?.masterOtp || '').trim();
  if (!userId || !password || !masterOtp) {
    const err = new Error('userId, password, and masterOtp are required');
    err.code = 'VALIDATION';
    throw err;
  }

  const filePath = opts.credentialsPath
    ? path.resolve(opts.credentialsPath)
    : resolveEmaapCredentialsPath(opts.dataRoot);

  const payload = {
    userId,
    password,
    masterOtp,
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
 * Internal: load decrypted credentials for automation workers only.
 * Do not expose via HTTP.
 */
export function loadEmaapCredentialsSecrets(opts = {}) {
  const filePath = opts.credentialsPath
    ? path.resolve(opts.credentialsPath)
    : resolveEmaapCredentialsPath(opts.dataRoot);
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return decryptPayload(raw, opts.jwtSecret);
}
