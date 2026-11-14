import crypto from 'node:crypto';
import {
  getZohoCredentialsStatus,
  saveZohoCredentials,
  loadZohoCredentialsSecrets,
  clearZohoCredentials,
} from './zohoCredentials.js';

/** Default India DC — matches yesgatc Cloud Functions. */
export const DEFAULT_ZOHO_ACCOUNTS_BASE = 'https://accounts.zoho.in';
export const DEFAULT_ZOHO_BOOKS_BASE = 'https://www.zohoapis.in/books/v3';

/**
 * Must match Zoho API Console → Bench Cloud Authorized Redirect URI exactly.
 * GATC reuses the ECS Monitor callback; ECS bridges gatc_zoho_* back to GATC.
 */
export const DEFAULT_ZOHO_REDIRECT_URI = 'https://ecs.benchpc.online/api/integrations/zoho/callback';

/** GATC landing page after ECS bridge (not registered in Zoho Console). */
export const GATC_ZOHO_CALLBACK_PATH = '/api/v1/integrations/zoho/oauth/callback';

export const GATC_OAUTH_STATE_PREFIX = 'gatc_zoho_';

/** Match ecs.benchpc / Bench Cloud Monitor scopes. */
export const DEFAULT_ZOHO_SCOPES = [
  'ZohoBooks.fullaccess.all',
  'ZohoBooks.settings.CREATE',
  'ZohoBooks.settings.UPDATE',
  'ZohoBooks.settings.READ',
  'ZohoBooks.items.CREATE',
  'ZohoBooks.items.UPDATE',
  'ZohoBooks.items.READ',
  'ZohoBooks.invoices.CREATE',
  'ZohoBooks.invoices.READ',
  'ZohoBooks.invoices.UPDATE',
  'ZohoBooks.contacts.CREATE',
  'ZohoBooks.contacts.READ',
  'ZohoBooks.customerpayments.CREATE',
].join(',');

const pendingStates = new Map();
const pendingOrgPicks = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;
const PICK_TTL_MS = 30 * 60 * 1000;

function cleanExpiredStates() {
  const now = Date.now();
  for (const [key, value] of pendingStates) {
    if (!value || value.expiresAt <= now) pendingStates.delete(key);
  }
}

function cleanExpiredPicks() {
  const now = Date.now();
  for (const [key, value] of pendingOrgPicks) {
    if (!value || value.expiresAt <= now) pendingOrgPicks.delete(key);
  }
}

export function resolveZohoAccountsBase(config = {}) {
  return String(config.zohoAccountsBase || process.env.ZOHO_ACCOUNTS_BASE || DEFAULT_ZOHO_ACCOUNTS_BASE)
    .trim()
    .replace(/\/+$/, '') || DEFAULT_ZOHO_ACCOUNTS_BASE;
}

export function resolveZohoRedirectUri(config = {}) {
  const explicit = String(config.zohoRedirectUri || process.env.ZOHO_REDIRECT_URI || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  // Always use the Console-registered ECS URI — never invent a GATC-only callback.
  return DEFAULT_ZOHO_REDIRECT_URI;
}

/** Absolute GATC callback URL (ECS forwards here after Zoho consent). */
export function resolveGatcZohoCallbackUrl(config = {}) {
  const explicit = String(config.gatcZohoCallbackUrl || process.env.GATC_ZOHO_CALLBACK_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const publicUrl = String(config.publicApiUrl || process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  if (publicUrl) return `${publicUrl}${GATC_ZOHO_CALLBACK_PATH}`;
  return `https://gatc.yesweigh.in${GATC_ZOHO_CALLBACK_PATH}`;
}

export function zohoOAuthClientConfigured(config = {}) {
  return Boolean(
    String(config.zohoClientId || '').trim()
    && String(config.zohoClientSecret || '').trim(),
  );
}

export function zohoStatusOpts(config = {}) {
  return {
    dataRoot: config.dataRoot,
    jwtSecret: config.jwtSecret,
    oauthClientConfigured: zohoOAuthClientConfigured(config),
    redirectUri: resolveZohoRedirectUri(config),
  };
}

/**
 * If env has ZOHO_REFRESH_TOKEN (+ client id/secret) and no encrypted file yet,
 * bootstrap the encrypted store so status can show Connected without inventing secrets.
 */
export function bootstrapZohoFromEnv(config = {}) {
  const refreshToken = String(config.zohoRefreshToken || process.env.ZOHO_REFRESH_TOKEN || '').trim();
  const clientId = String(config.zohoClientId || '').trim();
  const clientSecret = String(config.zohoClientSecret || '').trim();
  if (!refreshToken || !clientId || !clientSecret || !config.jwtSecret) {
    return getZohoCredentialsStatus(zohoStatusOpts(config));
  }

  const existing = loadZohoCredentialsSecrets({
    dataRoot: config.dataRoot,
    jwtSecret: config.jwtSecret,
  });
  if (existing?.refreshToken) {
    return getZohoCredentialsStatus(zohoStatusOpts(config));
  }

  return saveZohoCredentials(
    {
      refreshToken,
      clientId,
      organizationId: String(config.zohoOrganizationId || '').trim() || null,
      accountsBase: resolveZohoAccountsBase(config),
      connectedVia: 'env',
    },
    zohoStatusOpts(config),
  );
}

export function createOAuthState({ adminUserId } = {}) {
  cleanExpiredStates();
  // Prefix lets ECS callback forward to GATC without consuming ecs_zoho_* / ecs_lite_*.
  const state = `${GATC_OAUTH_STATE_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
  pendingStates.set(state, {
    adminUserId: adminUserId || null,
    expiresAt: Date.now() + STATE_TTL_MS,
  });
  return state;
}

export function consumeOAuthState(state) {
  cleanExpiredStates();
  const key = String(state || '');
  const entry = pendingStates.get(key);
  if (!entry) return null;
  pendingStates.delete(key);
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}

export function buildZohoAuthorizeUrl(config, { state, scopes } = {}) {
  if (!zohoOAuthClientConfigured(config)) {
    const err = new Error('ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET must be set on the server');
    err.code = 'ZOHO_MISCONFIGURED';
    throw err;
  }
  const accountsBase = resolveZohoAccountsBase(config);
  const redirectUri = resolveZohoRedirectUri(config);
  const scope = String(scopes || config.zohoScopes || DEFAULT_ZOHO_SCOPES).trim();
  const params = new URLSearchParams({
    scope,
    client_id: String(config.zohoClientId).trim(),
    response_type: 'code',
    access_type: 'offline',
    redirect_uri: redirectUri,
    prompt: 'consent',
    state: String(state || ''),
  });
  return `${accountsBase}/oauth/v2/auth?${params.toString()}`;
}

async function postZohoToken(accountsBase, body) {
  const url = `${accountsBase}/oauth/v2/token`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!response.ok || json.error) {
    const err = new Error(json.error_description || json.error || `Zoho token HTTP ${response.status}`);
    err.code = 'ZOHO_TOKEN';
    err.details = json;
    throw err;
  }
  return json;
}

export async function exchangeZohoAuthCode(config, { code }) {
  const accountsBase = resolveZohoAccountsBase(config);
  const redirectUri = resolveZohoRedirectUri(config);
  return postZohoToken(accountsBase, {
    grant_type: 'authorization_code',
    client_id: String(config.zohoClientId).trim(),
    client_secret: String(config.zohoClientSecret).trim(),
    redirect_uri: redirectUri,
    code: String(code || '').trim(),
  });
}

function apiDomainFromToken(token, accountsBase) {
  const fromToken = String(token?.api_domain || '').trim();
  if (fromToken) return fromToken.replace(/\/+$/, '');
  return String(accountsBase || DEFAULT_ZOHO_ACCOUNTS_BASE)
    .replace('://accounts.', '://www.zohoapis.')
    .replace(/\/+$/, '');
}

async function fetchZohoOrganizations({ accessToken, apiDomain }) {
  const base = String(apiDomain || '').replace(/\/+$/, '') || 'https://www.zohoapis.in';
  const response = await fetch(`${base}/books/v3/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  if (!response.ok) {
    const err = new Error(json.message || json.error || `Zoho organizations HTTP ${response.status}`);
    err.code = 'ZOHO_ORGS';
    throw err;
  }
  return (json.organizations || [])
    .map((org) => ({
      organizationId: String(org.organization_id ?? '').trim(),
      name: String(org.name ?? '').trim() || 'Organization',
      contactName: String(org.contact_name ?? '').trim(),
    }))
    .filter((org) => org.organizationId);
}

/**
 * OAuth callback: exchange code, list orgs, hold tokens until admin picks an organization.
 * Does not mark Connected until finalizeZohoOrgPick.
 */
export async function completeZohoOAuthCallback(config, { code, state }) {
  const pending = consumeOAuthState(state);
  if (!pending) {
    const err = new Error('Invalid or expired OAuth state');
    err.code = 'OAUTH_STATE';
    throw err;
  }
  if (!zohoOAuthClientConfigured(config)) {
    const err = new Error('ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET must be set on the server');
    err.code = 'ZOHO_MISCONFIGURED';
    throw err;
  }

  const token = await exchangeZohoAuthCode(config, { code });
  let refreshToken = String(token.refresh_token || '').trim();
  if (!refreshToken) {
    const existing = loadZohoCredentialsSecrets({
      dataRoot: config.dataRoot,
      jwtSecret: config.jwtSecret,
    });
    refreshToken = String(existing?.refreshToken || '').trim();
    if (!refreshToken) {
      const err = new Error(
        'Zoho did not return a refresh_token. Re-consent with prompt=consent, or paste a Self Client refresh token.',
      );
      err.code = 'ZOHO_NO_REFRESH';
      throw err;
    }
  }

  const accessToken = String(token.access_token || '').trim();
  if (!accessToken) {
    const err = new Error('Zoho did not return an access token');
    err.code = 'ZOHO_TOKEN';
    throw err;
  }

  const accountsBase = resolveZohoAccountsBase(config);
  const apiDomain = apiDomainFromToken(token, accountsBase);
  const organizations = await fetchZohoOrganizations({ accessToken, apiDomain });
  if (!organizations.length) {
    const err = new Error('No Zoho Books organizations are linked to this login');
    err.code = 'ZOHO_NO_ORGS';
    throw err;
  }

  cleanExpiredPicks();
  const pickState = `gatc_pick_${crypto.randomBytes(16).toString('hex')}`;
  const expiresIn = Number(token.expires_in || 3600);
  pendingOrgPicks.set(pickState, {
    refreshToken,
    accessToken,
    expiresAtToken: Date.now() + expiresIn * 1000,
    clientId: String(config.zohoClientId).trim(),
    accountsBase,
    apiDomain,
    organizations,
    expiresAt: Date.now() + PICK_TTL_MS,
    adminUserId: pending.adminUserId || null,
  });

  return {
    needsOrgPick: true,
    pickState,
    organizations,
    configured: false,
    redirectUri: resolveZohoRedirectUri(config),
  };
}

export function getZohoPendingPick(pickState) {
  cleanExpiredPicks();
  const key = String(pickState || '').trim();
  const row = pendingOrgPicks.get(key);
  if (!row || row.expiresAt <= Date.now()) {
    if (key) pendingOrgPicks.delete(key);
    return null;
  }
  return {
    pickState: key,
    organizations: row.organizations || [],
  };
}

/**
 * Persist chosen organization + tokens (ecs.benchpc Save step).
 */
export function finalizeZohoOrgPick(config, { pickState, organizationId } = {}) {
  cleanExpiredPicks();
  const key = String(pickState || '').trim();
  const row = pendingOrgPicks.get(key);
  if (!row || row.expiresAt <= Date.now()) {
    pendingOrgPicks.delete(key);
    const err = new Error('Organization pick expired — Sign in with Zoho again');
    err.code = 'PICK_EXPIRED';
    throw err;
  }
  const orgId = String(organizationId || '').trim();
  const match = (row.organizations || []).find((o) => o.organizationId === orgId);
  if (!match) {
    const err = new Error('Choose a Zoho Books organization');
    err.code = 'VALIDATION';
    throw err;
  }
  pendingOrgPicks.delete(key);
  return saveZohoCredentials(
    {
      refreshToken: row.refreshToken,
      accessToken: row.accessToken || null,
      expiresAt: row.expiresAtToken || null,
      clientId: row.clientId,
      organizationId: orgId,
      organizationName: match.name || null,
      accountsBase: row.accountsBase,
      apiDomain: row.apiDomain || null,
      connectedVia: 'oauth',
    },
    zohoStatusOpts(config),
  );
}

/**
 * Optional manual connect: Self Client refresh token + server client credentials.
 */
export function connectZohoWithRefreshToken(config, { refreshToken, organizationId } = {}) {
  if (!zohoOAuthClientConfigured(config)) {
    const err = new Error('ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET must be set on the server');
    err.code = 'ZOHO_MISCONFIGURED';
    throw err;
  }
  const token = String(refreshToken || '').trim();
  if (!token) {
    const err = new Error('refreshToken is required');
    err.code = 'VALIDATION';
    throw err;
  }
  return saveZohoCredentials(
    {
      refreshToken: token,
      clientId: String(config.zohoClientId).trim(),
      organizationId: organizationId != null
        ? String(organizationId).trim() || null
        : (String(config.zohoOrganizationId || '').trim() || null),
      accountsBase: resolveZohoAccountsBase(config),
      connectedVia: 'refresh_token',
    },
    zohoStatusOpts(config),
  );
}

/** Disconnect: clear encrypted store. Caller should also clear ZOHO_REFRESH_TOKEN env to avoid re-bootstrap. */
export function disconnectZoho(config = {}) {
  return clearZohoCredentials(zohoStatusOpts(config));
}

/**
 * If Connected with organizationId but no name (older stores), refresh token and
 * look up the org name once, then persist it for the card / Configure modal.
 */
export async function ensureZohoOrganizationName(config = {}) {
  const opts = zohoStatusOpts(config);
  const status = getZohoCredentialsStatus(opts);
  if (!status.configured || !status.organizationId || status.organizationName) {
    return status;
  }
  if (!zohoOAuthClientConfigured(config)) return status;

  const secrets = loadZohoCredentialsSecrets(opts);
  if (!secrets?.refreshToken) return status;

  try {
    const accountsBase = String(secrets.accountsBase || resolveZohoAccountsBase(config)).replace(/\/+$/, '');
    const token = await postZohoToken(accountsBase, {
      grant_type: 'refresh_token',
      client_id: String(config.zohoClientId).trim(),
      client_secret: String(config.zohoClientSecret).trim(),
      refresh_token: secrets.refreshToken,
    });
    const accessToken = String(token.access_token || '').trim();
    if (!accessToken) return status;
    const apiDomain = apiDomainFromToken(token, accountsBase) || secrets.apiDomain;
    const organizations = await fetchZohoOrganizations({ accessToken, apiDomain });
    const match = organizations.find((o) => o.organizationId === String(status.organizationId));
    if (!match?.name) return status;
    return saveZohoCredentials(
      {
        ...secrets,
        accessToken,
        expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
        organizationId: status.organizationId,
        organizationName: match.name,
        apiDomain: apiDomain || secrets.apiDomain || null,
      },
      opts,
    );
  } catch {
    return status;
  }
}

/** Origins that may host the GATC admin opener (popup may run on ECS). */
export const GATC_ZOHO_OPENER_ORIGINS = [
  'https://gatc.yesweigh.in',
  'https://www.gatc.yesweigh.in',
];

/**
 * Popup result page. Always postMessages org-pick payload to known GATC opener
 * origins (and same-origin). Never auto-connects an org — parent shows picker.
 */
export function oauthPopupResultHtml({
  ok,
  message,
  configured,
  needsOrgPick,
  pickState,
  organizations,
  openerOrigins,
} = {}) {
  const orgs = Array.isArray(organizations) ? organizations : [];
  const forcePick = Boolean(ok) && Boolean(pickState) && orgs.length > 0;
  const payload = JSON.stringify({
    source: 'gatc-zoho-oauth',
    type: 'zoho-oauth',
    ok: Boolean(ok),
    message: String(message || ''),
    configured: false, // never claim Connected from callback — Save after org pick
    needsOrgPick: forcePick || Boolean(needsOrgPick),
    pickState: pickState || null,
    organizations: orgs,
  });
  const targets = JSON.stringify([
    ...new Set([
      ...(Array.isArray(openerOrigins) ? openerOrigins : []),
      ...GATC_ZOHO_OPENER_ORIGINS,
    ].filter(Boolean)),
  ]);
  const safeMsg = String(message || '').replace(/[<>&]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]
  ));
  const title = !ok ? 'Connection failed' : (forcePick ? 'Choose organization' : 'Signed in');
  const hint = !ok
    ? 'Close this window and try Sign in again.'
    : (forcePick
      ? 'Return to GATC Settings and choose an organization, then Save.'
      : 'You can close this window.');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Zoho Books</title>
<style>
  body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f8fafc;color:#0f172a}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px 28px;max-width:400px;text-align:center;box-shadow:0 8px 30px rgba(15,23,42,.06)}
  h1{font-size:16px;margin:0 0 8px}p{font-size:13px;color:#64748b;margin:0}
  .muted{margin-top:12px;font-size:11px;color:#94a3b8}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${safeMsg}</p><p class="muted">${hint}</p></div>
<script>
(function(){
  var data = ${payload};
  var targets = ${targets};
  function notify() {
    if (!window.opener || window.opener.closed) return false;
    var list = targets.slice();
    try { list.push(window.location.origin); } catch (e) {}
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var origin = list[i];
      if (!origin || seen[origin]) continue;
      seen[origin] = true;
      try { window.opener.postMessage(data, origin); } catch (e) {}
    }
    return true;
  }
  var okNotify = notify();
  var n = 0;
  var timer = setInterval(function(){
    n += 1;
    if (notify()) okNotify = true;
    if (n >= 8) clearInterval(timer);
  }, 400);
  setTimeout(function(){
    if (okNotify) {
      try { window.close(); } catch (e) {}
    }
  }, 1800);
})();
</script></body></html>`;
}

/** JSON shape used by ECS bridge (server-side) after Zoho redirects to ECS. */
export function zohoOAuthCompletePayload(pick) {
  const organizations = Array.isArray(pick?.organizations) ? pick.organizations : [];
  return {
    source: 'gatc-zoho-oauth',
    type: 'zoho-oauth',
    ok: true,
    message: 'Signed in — choose a Zoho Books organization in Settings.',
    configured: false,
    needsOrgPick: true,
    pickState: pick?.pickState || null,
    organizations,
  };
}
