import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getZohoCredentialsStatus,
  saveZohoCredentials,
  loadZohoCredentialsSecrets,
  clearZohoCredentials,
  maskClientId,
} from '../src/zohoCredentials.js';
import {
  buildZohoAuthorizeUrl,
  createOAuthState,
  consumeOAuthState,
  resolveZohoRedirectUri,
  zohoOAuthClientConfigured,
} from '../src/zohoOAuth.js';

describe('zohoCredentials store', () => {
  let tmp;
  const secret = 'test-jwt-secret-at-least-32-chars!!';

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatc-zoho-creds-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('masks client ids', () => {
    assert.equal(maskClientId('abcd1234efgh5678').startsWith('abcd'), true);
    assert.equal(maskClientId('abcd1234efgh5678').endsWith('5678'), true);
    assert.equal(maskClientId('abcd1234efgh5678').includes('1234'), false);
  });

  it('saves encrypted and returns status without secrets', () => {
    const status = saveZohoCredentials(
      {
        refreshToken: '1000.refresh.secret.token',
        clientId: '1000.CLIENTIDVALUE',
        organizationId: '60001225303',
        organizationName: 'INTERWEIGHING PRIVATE LIMITED',
        connectedVia: 'oauth',
      },
      { dataRoot: tmp, jwtSecret: secret, oauthClientConfigured: true, redirectUri: 'https://example/callback' },
    );
    assert.equal(status.configured, true);
    assert.equal(status.label, 'Connected');
    assert.equal(status.refreshTokenSet, true);
    assert.equal(status.organizationId, '60001225303');
    assert.equal(status.organizationName, 'INTERWEIGHING PRIVATE LIMITED');
    assert.ok(status.clientIdMasked);
    assert.equal(JSON.stringify(status).includes('1000.refresh.secret.token'), false);
    assert.equal(JSON.stringify(status).includes('CLIENTIDVALUE'), false);

    const raw = fs.readFileSync(path.join(tmp, 'zoho', 'credentials.enc.json'), 'utf8');
    assert.equal(raw.includes('1000.refresh.secret.token'), false);

    const again = getZohoCredentialsStatus({
      dataRoot: tmp,
      jwtSecret: secret,
      oauthClientConfigured: true,
    });
    assert.equal(again.configured, true);
    assert.equal(again.organizationName, 'INTERWEIGHING PRIVATE LIMITED');

    const secrets = loadZohoCredentialsSecrets({ dataRoot: tmp, jwtSecret: secret });
    assert.equal(secrets.refreshToken, '1000.refresh.secret.token');
    assert.equal(secrets.organizationId, '60001225303');
    assert.equal(secrets.organizationName, 'INTERWEIGHING PRIVATE LIMITED');

    const cleared = clearZohoCredentials({ dataRoot: tmp, jwtSecret: secret, oauthClientConfigured: true });
    assert.equal(cleared.configured, false);
  });

  it('rejects missing refresh token', () => {
    assert.throws(
      () => saveZohoCredentials({ refreshToken: '' }, { dataRoot: tmp, jwtSecret: secret }),
      /required/,
    );
  });
});

describe('zohoOAuth helpers', () => {
  it('defaults redirect URI to registered ECS callback', () => {
    const uri = resolveZohoRedirectUri({ publicApiUrl: 'https://gatc.yesweigh.in/' });
    assert.equal(uri, 'https://ecs.benchpc.online/api/integrations/zoho/callback');
  });

  it('honors explicit ZOHO_REDIRECT_URI override', () => {
    const uri = resolveZohoRedirectUri({
      zohoRedirectUri: 'https://ecs.benchpc.online/api/integrations/zoho/callback/',
    });
    assert.equal(uri, 'https://ecs.benchpc.online/api/integrations/zoho/callback');
  });

  it('builds authorize URL for India DC via ECS redirect', () => {
    const state = createOAuthState({ adminUserId: '1' });
    assert.match(state, /^gatc_zoho_/);
    const url = buildZohoAuthorizeUrl(
      {
        zohoClientId: '1000.TESTCLIENT',
        zohoClientSecret: 'secret',
        zohoAccountsBase: 'https://accounts.zoho.in',
        publicApiUrl: 'https://gatc.yesweigh.in',
      },
      { state },
    );
    assert.ok(url.startsWith('https://accounts.zoho.in/oauth/v2/auth?'));
    assert.ok(url.includes('client_id=1000.TESTCLIENT'));
    assert.ok(url.includes('access_type=offline'));
    assert.ok(url.includes(encodeURIComponent('https://ecs.benchpc.online/api/integrations/zoho/callback')));
    assert.ok(consumeOAuthState(state));
    assert.equal(consumeOAuthState(state), null);
  });

  it('detects missing client credentials', () => {
    assert.equal(zohoOAuthClientConfigured({}), false);
    assert.equal(zohoOAuthClientConfigured({ zohoClientId: 'a', zohoClientSecret: 'b' }), true);
  });
});
