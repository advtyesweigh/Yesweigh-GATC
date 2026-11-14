import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveRazorpayCredentials, saveRazorpayWebhookSecret } from '../src/razorpayCredentials.js';
import {
  verifyRazorpayWebhookSignature,
  handleRazorpayWebhook,
} from '../src/razorpayWebhook.js';

describe('razorpayWebhook', () => {
  let tmp;
  const jwtSecret = 'test-jwt-secret-at-least-32-chars!!';
  const webhookSecret = 'whsec_test_secret_value_12345';

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatc-razorpay-wh-'));
    saveRazorpayCredentials(
      { keyId: 'rzp_live_TestKeyIdABCD', keySecret: 'TestSecretValueForHmac12345' },
      { dataRoot: tmp, jwtSecret },
    );
    saveRazorpayWebhookSecret(
      { webhookSecret },
      { dataRoot: tmp, jwtSecret },
    );
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('verifies webhook HMAC against raw body', () => {
    const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', id: 'evt_1' }), 'utf8');
    const sig = crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
    assert.equal(verifyRazorpayWebhookSignature(raw, sig, webhookSecret), true);
    assert.equal(verifyRazorpayWebhookSignature(raw, 'bad', webhookSecret), false);
  });

  it('accepts payment.captured and stores event without leaking secrets', () => {
    const payload = {
      event: 'payment.captured',
      id: 'evt_test_1',
      payload: {
        payment: {
          entity: {
            id: 'pay_test_1',
            order_id: 'order_test_1',
            amount: 100,
            currency: 'INR',
            status: 'captured',
            method: 'upi',
          },
        },
      },
    };
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const sig = crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
    const result = handleRazorpayWebhook(
      {
        headers: { 'x-razorpay-signature': sig },
        rawBody: raw,
        body: payload,
      },
      { dataRoot: tmp, jwtSecret },
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.paymentId, 'pay_test_1');
    assert.equal(JSON.stringify(result).includes(webhookSecret), false);

    const eventsDir = path.join(tmp, 'razorpay', 'events');
    const files = fs.readdirSync(eventsDir);
    assert.ok(files.length >= 1);
    const stored = fs.readFileSync(path.join(eventsDir, files[0]), 'utf8');
    assert.equal(stored.includes(webhookSecret), false);
    assert.match(stored, /pay_test_1/);
  });

  it('rejects bad signature', () => {
    const payload = { event: 'order.paid', id: 'evt_bad' };
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const result = handleRazorpayWebhook(
      {
        headers: { 'x-razorpay-signature': 'deadbeef' },
        rawBody: raw,
        body: payload,
      },
      { dataRoot: tmp, jwtSecret },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  });
});
