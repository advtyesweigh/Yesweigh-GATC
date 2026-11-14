import crypto from 'node:crypto';
import { loadRazorpayCredentialsSecrets } from './razorpayCredentials.js';

const RAZORPAY_ORDERS_URL = 'https://api.razorpay.com/v1/orders';
const MIN_AMOUNT_INR = 1;
const MAX_TEST_AMOUNT_INR = 100;

/**
 * Admin test payments against stored live Razorpay keys.
 * Never returns keySecret. Key ID is public (Checkout requires it).
 */

function requireSecrets(opts) {
  const secrets = loadRazorpayCredentialsSecrets(opts);
  if (!secrets?.keyId || !secrets?.keySecret) {
    const err = new Error('Razorpay is not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return secrets;
}

function parseAmountInr(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_AMOUNT_INR) {
    const err = new Error(`Amount must be at least ₹${MIN_AMOUNT_INR}`);
    err.code = 'VALIDATION';
    throw err;
  }
  if (n > MAX_TEST_AMOUNT_INR) {
    const err = new Error(`Test amount capped at ₹${MAX_TEST_AMOUNT_INR}`);
    err.code = 'VALIDATION';
    throw err;
  }
  // Razorpay amount is paise (integer).
  return Math.round(n * 100);
}

function basicAuthHeader(keyId, keySecret) {
  const token = Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

/**
 * Create a Razorpay order for an admin test payment.
 * @returns {{ orderId, amount, amountInr, currency, receipt, keyId, live }}
 */
export async function createRazorpayTestOrder(input, opts = {}) {
  const secrets = requireSecrets(opts);
  const amountPaise = parseAmountInr(input?.amountInr ?? input?.amount ?? 1);
  const receipt = String(input?.receipt || `gatc-test-${Date.now()}`).slice(0, 40);
  const note = String(input?.note || input?.notes || '').trim().slice(0, 200);

  const body = {
    amount: amountPaise,
    currency: 'INR',
    receipt,
    notes: {
      purpose: 'gatc_admin_test_payment',
      ...(note ? { note } : {}),
    },
  };

  const res = await fetch(RAZORPAY_ORDERS_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(secrets.keyId, secrets.keySecret),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.description || json?.error?.reason || `Razorpay order failed (${res.status})`;
    const err = new Error(msg);
    err.code = 'RAZORPAY';
    err.status = res.status;
    throw err;
  }

  const live = String(secrets.keyId).startsWith('rzp_live_');
  return {
    orderId: json.id,
    amount: json.amount,
    amountInr: Number((json.amount / 100).toFixed(2)),
    currency: json.currency || 'INR',
    receipt: json.receipt || receipt,
    keyId: secrets.keyId,
    live,
  };
}

/**
 * Verify Checkout payment signature.
 * Official Razorpay Node docs: HMAC-SHA256 of `${order_id}|${payment_id}` using
 * the API **key_secret** (never the webhook secret), digest hex.
 * @see https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/#5-verify-the-signature
 */
export function verifyRazorpayPaymentSignature(input, opts = {}) {
  const secrets = requireSecrets(opts);
  // Checkout signatures are always keyed with key_secret — never webhookSecret.
  const keySecret = String(secrets.keySecret || '').trim();
  if (!keySecret) {
    const err = new Error('Razorpay is not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const orderId = String(input?.razorpay_order_id || input?.orderId || '').trim();
  const paymentId = String(input?.razorpay_payment_id || input?.paymentId || '').trim();
  const signature = String(input?.razorpay_signature || input?.signature || '').trim().toLowerCase();

  if (!orderId || !paymentId || !signature) {
    const err = new Error('order id, payment id, and signature are required');
    err.code = 'VALIDATION';
    throw err;
  }

  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  let ok = false;
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    ok = a.length === 32 && a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    ok = false;
  }

  return {
    verified: ok,
    orderId,
    paymentId,
    live: String(secrets.keyId).startsWith('rzp_live_'),
  };
}

export const razorpayTestLimits = {
  minAmountInr: MIN_AMOUNT_INR,
  maxAmountInr: MAX_TEST_AMOUNT_INR,
};
