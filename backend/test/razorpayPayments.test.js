import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveRazorpayCredentials } from '../src/razorpayCredentials.js';
import {
  verifyRazorpayPaymentSignature,
  createRazorpayTestOrder,
  razorpayTestLimits,
} from '../src/razorpayPayments.js';

describe('razorpayPayments', () => {
  let tmp;
  const secret = 'test-jwt-secret-at-least-32-chars!!';
  const keyId = 'rzp_live_TestKeyIdABCD';
  const keySecret = 'TestSecretValueForHmac12345';

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatc-razorpay-pay-'));
    saveRazorpayCredentials(
      { keyId, keySecret },
      { dataRoot: tmp, jwtSecret: secret },
    );
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('verifies a valid Checkout signature', () => {
    const orderId = 'order_ABC123';
    const paymentId = 'pay_XYZ789';
    const signature = crypto
      .createHmac('sha256', keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const result = verifyRazorpayPaymentSignature(
      {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      },
      { dataRoot: tmp, jwtSecret: secret },
    );
    assert.equal(result.verified, true);
    assert.equal(result.orderId, orderId);
    assert.equal(result.paymentId, paymentId);
    assert.equal(result.live, true);
    assert.equal(JSON.stringify(result).includes(keySecret), false);
  });

  it('accepts uppercase hex signatures (normalized)', () => {
    const orderId = 'order_UpperHex';
    const paymentId = 'pay_UpperHex';
    const signature = crypto
      .createHmac('sha256', keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex')
      .toUpperCase();
    const result = verifyRazorpayPaymentSignature(
      {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      },
      { dataRoot: tmp, jwtSecret: secret },
    );
    assert.equal(result.verified, true);
  });

  it('rejects signatures computed with a wrong secret (e.g. webhook secret)', () => {
    const orderId = 'order_WrongSecret';
    const paymentId = 'pay_WrongSecret';
    const signature = crypto
      .createHmac('sha256', 'whsec_not_the_key_secret')
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    const result = verifyRazorpayPaymentSignature(
      {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      },
      { dataRoot: tmp, jwtSecret: secret },
    );
    assert.equal(result.verified, false);
  });

  it('rejects swapped field order payment_id|order_id', () => {
    const orderId = 'order_OrderFirst';
    const paymentId = 'pay_PaySecond';
    const signature = crypto
      .createHmac('sha256', keySecret)
      .update(`${paymentId}|${orderId}`)
      .digest('hex');
    const result = verifyRazorpayPaymentSignature(
      {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      },
      { dataRoot: tmp, jwtSecret: secret },
    );
    assert.equal(result.verified, false);
  });

  it('rejects a bad signature', () => {
    const result = verifyRazorpayPaymentSignature(
      {
        razorpay_order_id: 'order_1',
        razorpay_payment_id: 'pay_1',
        razorpay_signature: 'deadbeef',
      },
      { dataRoot: tmp, jwtSecret: secret },
    );
    assert.equal(result.verified, false);
  });

  it('rejects oversize test amounts without calling Razorpay', async () => {
    await assert.rejects(
      () => createRazorpayTestOrder(
        { amountInr: razorpayTestLimits.maxAmountInr + 1 },
        { dataRoot: tmp, jwtSecret: secret },
      ),
      /capped/,
    );
  });
});
