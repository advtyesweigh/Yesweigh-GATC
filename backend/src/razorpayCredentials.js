import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Server-side Razorpay API credentials (Key ID + Key Secret).
 * Stored under $DATA_ROOT/razorpay/credentials.enc.json — AES-256-GCM.
 * Public APIs must return only configured/masked status — never plaintext secrets.
 */

const FILE_NAME = 'credentials.enc.json';
const ALGO = 'aes-256-gcm';
const KEY_SALT = 'gatc-vps-razorpay-credentials-v1';

export function resolveRazorpayCredentialsPath(dataRoot) {
  const root = String(dataRoot || '').trim();
  if (root) return path.resolve(root, 'razorpay', FILE_NAME);
  return path.resolve(process.cwd(), 'data', 'razorpay', FILE_NAME);
}

function deriveKey(secret) {
  const material = String(secret || '').trim();
  if (!material || material.length < 16) {
    throw new Error('JWT_SECRET (or encryption key) required to store Razorpay credentials');
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
    throw new Error('Unsupported Razorpay credentials file format');
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

export function maskKeyId(keyId) {
  const s = String(keyId || '').trim();
  if (!s) return null;
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 8)}${'•'.repeat(Math.min(10, s.length - 12))}${s.slice(-4)}`;
}

function publicStatus(payload, { path: filePath, source = 'file' } = {}) {
  const configured = Boolean(
    payload
    && String(payload.keyId || '').trim()
    && String(payload.keySecret || '').trim(),
  );
  const webhookSecretSet = Boolean(String(payload?.webhookSecret || '').trim());
  return {
    configured,
    status: configured ? 'configured' : 'not_configured',
    label: configured ? 'Connected' : 'Not connected',
    keyIdMasked: configured ? maskKeyId(payload.keyId) : null,
    keySecretSet: configured,
    webhookSecretSet,
    updatedAt: payload?.updatedAt || null,
    source,
    path: filePath || null,
  };
}

function readPayload(opts = {}) {
  const filePath = opts.credentialsPath
    ? path.resolve(opts.credentialsPath)
    : resolveRazorpayCredentialsPath(opts.dataRoot);
  if (!fs.existsSync(filePath)) return { filePath, payload: null };
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return { filePath, payload: decryptPayload(raw, opts.jwtSecret) };
}

function writePayload(payload, filePath, jwtSecret) {
  const wrapped = encryptPayload(payload, jwtSecret);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(wrapped, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* ignore on platforms that don't support chmod */
  }
}

export function resolveRazorpayWebhookUrl(config = {}) {
  const base = String(config.publicApiUrl || process.env.PUBLIC_API_URL || 'https://gatc.yesweigh.in')
    .trim()
    .replace(/\/+$/, '');
  return `${base}/api/v1/integrations/razorpay/webhook`;
}

/**
 * Read status only (never returns secrets).
 * @param {{ dataRoot?: string, jwtSecret?: string, credentialsPath?: string }} opts
 */
export function getRazorpayCredentialsStatus(opts = {}) {
  const filePath = opts.credentialsPath
    ? path.resolve(opts.credentialsPath)
    : resolveRazorpayCredentialsPath(opts.dataRoot);

  try {
    if (!fs.existsSync(filePath)) {
      return publicStatus(null, { path: filePath, source: 'missing' });
    }
    const { payload } = readPayload(opts);
    return publicStatus(payload, { path: filePath, source: 'file' });
  } catch (error) {
    return {
      configured: false,
      status: 'error',
      label: 'Not connected',
      keyIdMasked: null,
      keySecretSet: false,
      webhookSecretSet: false,
      updatedAt: null,
      source: 'error',
      path: filePath,
      note: `Could not read Razorpay credentials: ${error.message}`,
    };
  }
}

/**
 * Persist credentials. Returns public status only.
 * Preserves existing webhookSecret unless a new one is provided.
 * @param {{ keyId: string, keySecret: string, webhookSecret?: string }} input
 * @param {{ dataRoot?: string, jwtSecret?: string, credentialsPath?: string }} opts
 */
export function saveRazorpayCredentials(input, opts = {}) {
  const keyId = String(input?.keyId || '').trim();
  const keySecret = String(input?.keySecret || '').trim();
  if (!keyId || !keySecret) {
    const err = new Error('keyId and keySecret are required');
    err.code = 'VALIDATION';
    throw err;
  }

  const { filePath, payload: existing } = readPayload(opts);
  const nextWebhook = Object.prototype.hasOwnProperty.call(input || {}, 'webhookSecret')
    ? String(input.webhookSecret || '').trim()
    : String(existing?.webhookSecret || '').trim();

  const payload = {
    keyId,
    keySecret,
    ...(nextWebhook ? { webhookSecret: nextWebhook } : {}),
    updatedAt: new Date().toISOString(),
  };

  writePayload(payload, filePath, opts.jwtSecret);
  return publicStatus(payload, { path: filePath, source: 'file' });
}

/**
 * Save / replace webhook secret only (keeps Key ID + Key Secret).
 * @param {{ webhookSecret: string }} input
 */
export function saveRazorpayWebhookSecret(input, opts = {}) {
  const webhookSecret = String(input?.webhookSecret || '').trim();
  if (!webhookSecret) {
    const err = new Error('webhookSecret is required');
    err.code = 'VALIDATION';
    throw err;
  }
  const { filePath, payload: existing } = readPayload(opts);
  if (!existing?.keyId || !existing?.keySecret) {
    const err = new Error('Connect Razorpay keys before saving a webhook secret');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const payload = {
    ...existing,
    webhookSecret,
    updatedAt: new Date().toISOString(),
  };
  writePayload(payload, filePath, opts.jwtSecret);
  return publicStatus(payload, { path: filePath, source: 'file' });
}

/**
 * If env has RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET and no encrypted file yet,
 * bootstrap the encrypted store so status can show Connected.
 * @param {{ dataRoot?: string, jwtSecret?: string, razorpayKeyId?: string, razorpayKeySecret?: string }} config
 */
export function bootstrapRazorpayFromEnv(config = {}) {
  const existing = getRazorpayCredentialsStatus({
    dataRoot: config.dataRoot,
    jwtSecret: config.jwtSecret,
  });
  if (existing.configured) return existing;

  const keyId = String(config.razorpayKeyId || process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = String(config.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!keyId || !keySecret || !config.jwtSecret) {
    return existing;
  }
  return saveRazorpayCredentials(
    { keyId, keySecret },
    { dataRoot: config.dataRoot, jwtSecret: config.jwtSecret },
  );
}

/**
 * Internal: load decrypted credentials for payment workers only.
 * Do not expose via HTTP.
 */
export function loadRazorpayCredentialsSecrets(opts = {}) {
  const filePath = opts.credentialsPath
    ? path.resolve(opts.credentialsPath)
    : resolveRazorpayCredentialsPath(opts.dataRoot);
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return decryptPayload(raw, opts.jwtSecret);
}
