import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadRazorpayCredentialsSecrets,
  resolveRazorpayCredentialsPath,
} from './razorpayCredentials.js';

const INTERESTING_EVENTS = new Set([
  'payment.captured',
  'payment.authorized',
  'order.paid',
  'payment.failed',
]);

/**
 * Resolve webhook secret: encrypted store first, then env RAZORPAY_WEBHOOK_SECRET,
 * then Key Secret (yesgatc parity when Dashboard secret was set to the API key secret).
 */
export function resolveRazorpayWebhookSecret(opts = {}) {
  let keySecretFallback = '';
  try {
    const secrets = loadRazorpayCredentialsSecrets(opts);
    const fromFile = String(secrets?.webhookSecret || '').trim();
    if (fromFile) return { secret: fromFile, source: 'file' };
    keySecretFallback = String(secrets?.keySecret || '').trim();
  } catch {
    /* fall through to env */
  }
  const fromEnv = String(opts.webhookSecretEnv || process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  if (fromEnv) return { secret: fromEnv, source: 'env' };
  if (keySecretFallback) return { secret: keySecretFallback, source: 'keySecret' };
  return { secret: '', source: 'missing' };
}

export function verifyRazorpayWebhookSignature(rawBody, signatureHeader, secret) {
  const signature = String(signatureHeader || '').trim();
  const material = String(secret || '').trim();
  if (!material || !signature) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const expected = crypto.createHmac('sha256', material).update(body).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function eventsDir(dataRoot) {
  const credPath = resolveRazorpayCredentialsPath(dataRoot);
  return path.join(path.dirname(credPath), 'events');
}

/**
 * Persist a webhook event under $DATA_ROOT/razorpay/events/ (no secrets).
 */
export function storeRazorpayWebhookEvent(event, opts = {}) {
  const dir = eventsDir(opts.dataRoot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const eventId = String(event?.event || 'unknown').replace(/[^\w.-]+/g, '_');
  const id = String(event?.id || crypto.randomBytes(6).toString('hex'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}_${eventId}_${id}.json`);
  const payment = event?.payload?.payment?.entity || null;
  const order = event?.payload?.order?.entity || null;
  const summary = {
    receivedAt: new Date().toISOString(),
    event: event?.event || null,
    accountId: event?.account_id || null,
    paymentId: payment?.id || null,
    orderId: order?.id || payment?.order_id || null,
    amount: payment?.amount ?? order?.amount ?? null,
    currency: payment?.currency || order?.currency || null,
    status: payment?.status || order?.status || null,
    // Keep a trimmed payload for ops — never include card PAN etc.
    payload: {
      payment: payment
        ? {
          id: payment.id,
          order_id: payment.order_id,
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status,
          method: payment.method,
          email: payment.email || null,
          contact: payment.contact || null,
          created_at: payment.created_at,
        }
        : null,
      order: order
        ? {
          id: order.id,
          amount: order.amount,
          currency: order.currency,
          status: order.status,
          receipt: order.receipt,
          created_at: order.created_at,
        }
        : null,
    },
  };
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return { path: file, summary };
}

/**
 * Handle an inbound Razorpay webhook request.
 * @returns {{ ok: boolean, status: number, body: object }}
 */
export function handleRazorpayWebhook(reqLike, opts = {}) {
  const { secret, source } = resolveRazorpayWebhookSecret(opts);
  const signature = reqLike.headers?.['x-razorpay-signature']
    || reqLike.headers?.['X-Razorpay-Signature']
    || '';
  const rawBody = reqLike.rawBody
    ?? (typeof reqLike.body === 'string' ? reqLike.body : null)
    ?? (reqLike.body ? Buffer.from(JSON.stringify(reqLike.body)) : Buffer.alloc(0));

  if (!secret) {
    return {
      ok: false,
      status: 503,
      body: {
        error: {
          code: 'WEBHOOK_SECRET_MISSING',
          message: 'Configure Razorpay webhook secret (UI or RAZORPAY_WEBHOOK_SECRET) before accepting events',
        },
      },
    };
  }

  if (!verifyRazorpayWebhookSignature(rawBody, signature, secret)) {
    return {
      ok: false,
      status: 400,
      body: { error: { code: 'SIGNATURE_INVALID', message: 'Invalid X-Razorpay-Signature' } },
    };
  }

  const event = typeof reqLike.body === 'object' && reqLike.body
    ? reqLike.body
    : (() => {
      try {
        return JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
      } catch {
        return null;
      }
    })();

  if (!event || typeof event !== 'object') {
    return {
      ok: false,
      status: 400,
      body: { error: { code: 'VALIDATION', message: 'Invalid webhook JSON' } },
    };
  }

  const eventName = String(event.event || '');
  let stored = null;
  if (INTERESTING_EVENTS.has(eventName) || eventName.startsWith('payment.') || eventName.startsWith('order.')) {
    stored = storeRazorpayWebhookEvent(event, opts);
  }

  return {
    ok: true,
    status: 200,
    body: {
      data: {
        received: true,
        event: eventName || null,
        stored: Boolean(stored),
        paymentId: stored?.summary?.paymentId || null,
        orderId: stored?.summary?.orderId || null,
        secretSource: source,
      },
    },
  };
}
