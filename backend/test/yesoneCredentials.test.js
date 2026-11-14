import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getYesoneCredentialsStatus,
  saveYesoneCredentials,
  loadYesoneCredentialsSecrets,
  maskUserId,
  normalizeYesoneBaseUrl,
  DEFAULT_YESONE_BASE_URL,
} from '../src/yesoneCredentials.js';

describe('yesoneCredentials store', () => {
  let tmp;
  const secret = 'test-jwt-secret-at-least-32-chars!!';

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatc-yesone-creds-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('normalizes yesgatc base URL', () => {
    assert.equal(normalizeYesoneBaseUrl('yesgatc.in'), DEFAULT_YESONE_BASE_URL);
    assert.equal(normalizeYesoneBaseUrl('https://yesgatc.in/'), DEFAULT_YESONE_BASE_URL);
    assert.equal(normalizeYesoneBaseUrl(''), DEFAULT_YESONE_BASE_URL);
  });

  it('masks user ids', () => {
    assert.equal(maskUserId('718835126130').startsWith('71'), true);
    assert.equal(maskUserId('718835126130').endsWith('30'), true);
    assert.equal(maskUserId('718835126130').includes('8835'), false);
  });

  it('saves encrypted and returns status without secrets', () => {
    const status = saveYesoneCredentials(
      { userId: '718835126130', password: 'SecretPass1!', baseUrl: 'yesgatc.in' },
      { dataRoot: tmp, jwtSecret: secret },
    );
    assert.equal(status.configured, true);
    assert.equal(status.label, 'Connected');
    assert.equal(status.passwordSet, true);
    assert.equal(status.baseUrl, DEFAULT_YESONE_BASE_URL);
    assert.ok(status.userIdMasked);
    assert.equal(status.userIdMasked.includes('SecretPass'), false);
    assert.equal(JSON.stringify(status).includes('SecretPass1!'), false);
    assert.equal(JSON.stringify(status).includes('718835126130'), false);

    const raw = fs.readFileSync(path.join(tmp, 'yesone', 'credentials.enc.json'), 'utf8');
    assert.equal(raw.includes('SecretPass1!'), false);
    assert.equal(raw.includes('718835126130'), false);

    const again = getYesoneCredentialsStatus({ dataRoot: tmp, jwtSecret: secret });
    assert.equal(again.configured, true);
    assert.equal(again.userIdMasked, status.userIdMasked);
    assert.equal(again.baseUrl, DEFAULT_YESONE_BASE_URL);

    const secrets = loadYesoneCredentialsSecrets({ dataRoot: tmp, jwtSecret: secret });
    assert.equal(secrets.userId, '718835126130');
    assert.equal(secrets.password, 'SecretPass1!');
    assert.equal(secrets.baseUrl, DEFAULT_YESONE_BASE_URL);
  });

  it('rejects incomplete payloads', () => {
    assert.throws(
      () => saveYesoneCredentials({ userId: 'a', password: '' }, { dataRoot: tmp, jwtSecret: secret }),
      /required/,
    );
  });
});
