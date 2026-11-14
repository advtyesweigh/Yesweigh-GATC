import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRazorpayCredentialsStatus,
  saveRazorpayCredentials,
  loadRazorpayCredentialsSecrets,
  maskKeyId,
  bootstrapRazorpayFromEnv,
} from '../src/razorpayCredentials.js';

describe('razorpayCredentials store', () => {
  let tmp;
  const secret = 'test-jwt-secret-at-least-32-chars!!';

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatc-razorpay-creds-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('masks key ids', () => {
    const masked = maskKeyId('rzp_live_ABCDEFGHijkl');
    assert.equal(masked.startsWith('rzp_live'), true);
    assert.equal(masked.includes('ABCDEFGH'), false);
    assert.equal(masked.endsWith('ijkl'), true);
  });

  it('saves encrypted and returns status without secrets', () => {
    const status = saveRazorpayCredentials(
      { keyId: 'rzp_live_TestKeyId1234', keySecret: 'SuperSecretKeyValue99' },
      { dataRoot: tmp, jwtSecret: secret },
    );
    assert.equal(status.configured, true);
    assert.equal(status.label, 'Connected');
    assert.equal(status.keySecretSet, true);
    assert.ok(status.keyIdMasked);
    assert.equal(JSON.stringify(status).includes('SuperSecretKeyValue99'), false);
    assert.equal(JSON.stringify(status).includes('rzp_live_TestKeyId1234'), false);

    const raw = fs.readFileSync(path.join(tmp, 'razorpay', 'credentials.enc.json'), 'utf8');
    assert.equal(raw.includes('SuperSecretKeyValue99'), false);
    assert.equal(raw.includes('rzp_live_TestKeyId1234'), false);

    const again = getRazorpayCredentialsStatus({ dataRoot: tmp, jwtSecret: secret });
    assert.equal(again.configured, true);
    assert.equal(again.keyIdMasked, status.keyIdMasked);

    const secrets = loadRazorpayCredentialsSecrets({ dataRoot: tmp, jwtSecret: secret });
    assert.equal(secrets.keyId, 'rzp_live_TestKeyId1234');
    assert.equal(secrets.keySecret, 'SuperSecretKeyValue99');
  });

  it('rejects incomplete payloads', () => {
    assert.throws(
      () => saveRazorpayCredentials({ keyId: 'rzp_live_x', keySecret: '' }, { dataRoot: tmp, jwtSecret: secret }),
      /required/,
    );
  });

  it('bootstraps from env when file missing', () => {
    const bootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatc-razorpay-boot-'));
    try {
      const status = bootstrapRazorpayFromEnv({
        dataRoot: bootTmp,
        jwtSecret: secret,
        razorpayKeyId: 'rzp_live_BootKey9999',
        razorpayKeySecret: 'BootSecretValue12345',
      });
      assert.equal(status.configured, true);
      assert.ok(status.keyIdMasked);
      assert.equal(JSON.stringify(status).includes('BootSecretValue12345'), false);
    } finally {
      fs.rmSync(bootTmp, { recursive: true, force: true });
    }
  });
});
