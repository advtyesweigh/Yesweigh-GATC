import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getEmaapCredentialsStatus,
  saveEmaapCredentials,
  loadEmaapCredentialsSecrets,
  maskUserId,
} from '../src/emaapCredentials.js';

describe('emaapCredentials store', () => {
  let tmp;
  const secret = 'test-jwt-secret-at-least-32-chars!!';

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatc-emaap-creds-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('masks user ids', () => {
    assert.equal(maskUserId('admin@example.com').includes('@example.com'), true);
    assert.equal(maskUserId('admin@example.com').startsWith('ad'), true);
    assert.equal(maskUserId('admin@example.com').includes('admin'), false);
  });

  it('saves encrypted and returns status without secrets', () => {
    const status = saveEmaapCredentials(
      { userId: 'portal.user@gov.in', password: 'SecretPass1!', masterOtp: '123456' },
      { dataRoot: tmp, jwtSecret: secret },
    );
    assert.equal(status.configured, true);
    assert.equal(status.label, 'Connected');
    assert.equal(status.passwordSet, true);
    assert.equal(status.masterOtpSet, true);
    assert.ok(status.userIdMasked);
    assert.equal(status.userIdMasked.includes('SecretPass'), false);
    assert.equal(JSON.stringify(status).includes('SecretPass1!'), false);
    assert.equal(JSON.stringify(status).includes('123456'), false);

    const raw = fs.readFileSync(path.join(tmp, 'emaap', 'credentials.enc.json'), 'utf8');
    assert.equal(raw.includes('SecretPass1!'), false);
    assert.equal(raw.includes('123456'), false);
    assert.equal(raw.includes('portal.user@gov.in'), false);

    const again = getEmaapCredentialsStatus({ dataRoot: tmp, jwtSecret: secret });
    assert.equal(again.configured, true);
    assert.equal(again.userIdMasked, status.userIdMasked);

    const secrets = loadEmaapCredentialsSecrets({ dataRoot: tmp, jwtSecret: secret });
    assert.equal(secrets.userId, 'portal.user@gov.in');
    assert.equal(secrets.password, 'SecretPass1!');
    assert.equal(secrets.masterOtp, '123456');
  });

  it('rejects incomplete payloads', () => {
    assert.throws(
      () => saveEmaapCredentials({ userId: 'a', password: '', masterOtp: '1' }, { dataRoot: tmp, jwtSecret: secret }),
      /required/,
    );
  });
});
