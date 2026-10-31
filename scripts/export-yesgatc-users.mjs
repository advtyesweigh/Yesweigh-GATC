/**
 * Export yesgatc Firestore users (super_admin / rc_admin / vct) to a JSON dump
 * suitable for Postgres import. Never writes passwords or service-account JSON.
 *
 * Auth (first match wins):
 *   1. FIREBASE_SERVICE_ACCOUNT_PATH or GOOGLE_APPLICATION_CREDENTIALS
 *      → Firebase Admin SDK (preferred for bulk)
 *   2. YESGATC_SUPER_AADHAR + YESGATC_SUPER_PASSWORD
 *      → sign in as superAdmin via client Auth + Firestore REST
 *   3. YESGATC_EMAAP_CREDENTIALS or default:
 *      ~/Library/Application Support/YesGATC/EmaapEngine/credentials.local.json
 *      → sign in as superAdmin via client Auth + Firestore REST
 *
 * Usage (Mac):
 *   node scripts/export-yesgatc-users.mjs
 *   node scripts/export-yesgatc-users.mjs --out=.tmp/yesgatc-users-export.json
 *   node scripts/export-yesgatc-users.mjs --allow-rc-scope   # only if login is rc_admin
 *
 * Env:
 *   FIREBASE_SERVICE_ACCOUNT_PATH=/absolute/path/to/yesgatc-*-firebase-adminsdk-*.json
 *   YESGATC_SUPER_AADHAR / YESGATC_SUPER_PASSWORD  (prefer over credentials file)
 *   YESGATC_EMAAP_CREDENTIALS=/absolute/path/to/credentials.local.json
 *
 * Typical SA path (create locally, never commit):
 *   ~/.config/yesgatc/firebase-adminsdk.json
 *   Download: Firebase Console → yesgatc → Project settings → Service accounts
 *   Or mirror GitHub Actions secret name FIREBASE_SERVICE_ACCOUNT_YESGATC (advtyesweigh/yesgatc).
 *
 * Output omits clearTextPassword and other secret-like fields.
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PROJECT_ID = 'yesgatc';
const WEB_API_KEY = 'AIzaSyACjIT9hQNzAXDDZW7JaMMaVQgfyZi5oT4';
const ROLES = ['super_admin', 'rc_admin', 'vct'];

const STRIP_KEYS = new Set([
  'clearTextPassword',
  'password',
  'passwordHash',
  'password_hash',
]);

const DROP_BULKY = new Set([
  'yesoneAllottedSerials',
  'yesoneVoidedSerials',
  'yesoneReservedSerials',
  'yesoneReservedInvoices',
  'yesoneReservedForUids',
  'yesoneReservedAssignments',
  'yesoneVerifierAllottedByUid',
  'interweighingDirectSerials',
  'interweighingDirectBatches',
]);

function argValue(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1).trim() : '';
}

function defaultOutPath() {
  return join(REPO_ROOT, '.tmp', 'yesgatc-users-export.json');
}

function defaultEmaapCredsPath() {
  return (
    process.env.YESGATC_EMAAP_CREDENTIALS?.trim() ||
    join(homedir(), 'Library/Application Support/YesGATC/EmaapEngine/credentials.local.json')
  );
}

function normalizeAadhaar(raw) {
  return String(raw ?? '').replace(/\D/g, '');
}

function stripDoc(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (STRIP_KEYS.has(k)) continue;
    if (DROP_BULKY.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function decodeFirestoreValue(value) {
  if (value == null) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('geoPointValue' in value) {
    return { lat: value.geoPointValue.latitude, lng: value.geoPointValue.longitude };
  }
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map(decodeFirestoreValue);
  }
  if ('mapValue' in value) {
    const fields = value.mapValue.fields || {};
    const obj = {};
    for (const [k, v] of Object.entries(fields)) obj[k] = decodeFirestoreValue(v);
    return obj;
  }
  return null;
}

function decodeFirestoreDocument(doc) {
  const uid = doc.name.split('/').pop();
  const fields = doc.fields || {};
  const data = {};
  for (const [k, v] of Object.entries(fields)) data[k] = decodeFirestoreValue(v);
  return { uid, ...stripDoc(data) };
}

async function exportViaAdminSdk() {
  const saPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim() ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!saPath || !existsSync(saPath)) {
    return null;
  }

  const yesgatcFunctions = join(
    homedir(),
    'Projects/gatc/yesgatc/functions/node_modules/firebase-admin/package.json',
  );
  const require = createRequire(
    existsSync(yesgatcFunctions)
      ? yesgatcFunctions
      : join(REPO_ROOT, 'package.json'),
  );
  let adminApp;
  try {
    adminApp = require('firebase-admin/app');
  } catch {
    console.error(
      'firebase-admin not found. Install under yesgatc/functions or set NODE_PATH.',
    );
    return null;
  }
  const { getFirestore } = require('firebase-admin/firestore');
  const { initializeApp, cert, getApps } = adminApp;
  const json = JSON.parse(readFileSync(saPath, 'utf8'));
  if (!getApps().length) {
    initializeApp({
      credential: cert(json),
      projectId: json.project_id || PROJECT_ID,
    });
  }
  console.log('Auth mode: Firebase Admin SDK (service account file present)');
  const db = getFirestore();
  const users = [];
  for (const role of ROLES) {
    const snap = await db.collection('users').where('role', '==', role).get();
    for (const doc of snap.docs) {
      users.push({ uid: doc.id, ...stripDoc(doc.data()) });
    }
  }
  return users;
}

function credentialHelp() {
  return [
    'Need Firebase Admin SDK JSON or a real Firestore super_admin login.',
    'Preferred:',
    '  mkdir -p ~/.config/yesgatc',
    '  # Firebase Console → project yesgatc → Project settings → Service accounts → Generate new private key',
    '  # save as ~/.config/yesgatc/firebase-adminsdk.json (never commit)',
    '  FIREBASE_SERVICE_ACCOUNT_PATH=$HOME/.config/yesgatc/firebase-adminsdk.json node scripts/export-yesgatc-users.mjs',
    'Alternate:',
    '  Put real super_admin aadhar+password in:',
    '  ~/Library/Application Support/YesGATC/EmaapEngine/credentials.local.json  (key: superAdmin)',
    'Note: GitHub Actions secret FIREBASE_SERVICE_ACCOUNT_YESGATC exists on advtyesweigh/yesgatc (values are not readable via gh).',
    'Partial one-RC export (current file is often an rc_admin):',
    '  node scripts/export-yesgatc-users.mjs --allow-rc-scope',
  ].join('\n');
}

function resolveSuperAdminCreds() {
  const envAadhar = normalizeAadhaar(process.env.YESGATC_SUPER_AADHAR);
  const envPassword = process.env.YESGATC_SUPER_PASSWORD || '';
  if (envAadhar.length === 12 && envPassword) {
    return {
      aadhar: envAadhar,
      password: envPassword,
      credPath: 'env:YESGATC_SUPER_AADHAR+YESGATC_SUPER_PASSWORD',
    };
  }

  const credPath = defaultEmaapCredsPath();
  if (!existsSync(credPath)) {
    throw new Error(`No Firebase Admin credentials and missing ${credPath}\n${credentialHelp()}`);
  }
  const stored = JSON.parse(readFileSync(credPath, 'utf8'));
  const entry = stored.superAdmin;
  const aadhar = normalizeAadhaar(entry?.aadhar);
  const password = entry?.password || '';
  if (aadhar.length !== 12 || !password) {
    throw new Error(`superAdmin entry incomplete in ${credPath} (need aadhar + password)`);
  }
  return { aadhar, password, credPath };
}

async function signInFromEmaapCreds() {
  const { aadhar, password, credPath } = resolveSuperAdminCreds();

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `${aadhar}@yesgatc.auth`,
        password,
        returnSecureToken: true,
      }),
    },
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `Login failed (${body.error?.message || response.status}). Check credentials — do not paste secrets here.`,
    );
  }
  return { idToken: body.idToken, uid: body.localId, credPath };
}

async function fetchUserDoc(idToken, uid) {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}`,
    { headers: { Authorization: `Bearer ${idToken}` } },
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Failed to load users/${uid}: ${body.error?.message || response.status}`);
  }
  return decodeFirestoreDocument(body);
}

async function runFirestoreQuery(idToken, structuredQuery) {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ structuredQuery }),
    },
  );
  const rows = await response.json();
  if (!response.ok) {
    throw new Error(`Firestore query failed: ${JSON.stringify(rows)}`);
  }
  if (!Array.isArray(rows)) {
    throw new Error('Unexpected Firestore response');
  }
  const out = [];
  for (const row of rows) {
    if (row.error) throw new Error(JSON.stringify(row.error));
    if (!row.document?.name) continue;
    out.push(decodeFirestoreDocument(row.document));
  }
  return out;
}

async function listUsersByRoleRest(idToken, role) {
  return runFirestoreQuery(idToken, {
    from: [{ collectionId: 'users' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'role' },
        op: 'EQUAL',
        value: { stringValue: role },
      },
    },
  });
}

async function listVctsForRc(idToken, rcUid) {
  return runFirestoreQuery(idToken, {
    from: [{ collectionId: 'users' }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: [
          {
            fieldFilter: {
              field: { fieldPath: 'role' },
              op: 'EQUAL',
              value: { stringValue: 'vct' },
            },
          },
          {
            fieldFilter: {
              field: { fieldPath: 'rcId' },
              op: 'EQUAL',
              value: { stringValue: rcUid },
            },
          },
        ],
      },
    },
  });
}

async function exportViaClientAuth(allowRcScope) {
  const session = await signInFromEmaapCreds();
  const me = await fetchUserDoc(session.idToken, session.uid);
  const role = me.role || '';

  if (role === 'super_admin') {
    console.log('Auth mode: client Auth (Firestore role=super_admin)');
    const users = [];
    for (const r of ROLES) {
      users.push(...(await listUsersByRoleRest(session.idToken, r)));
    }
    return { users, scope: 'all' };
  }

  if (role === 'rc_admin' && allowRcScope) {
    console.log(
      'Auth mode: client Auth (Firestore role=rc_admin) — RC-scoped export only',
    );
    const vcts = await listVctsForRc(session.idToken, session.uid);
    return { users: [me, ...vcts], scope: 'rc_only', rcFirebaseUid: session.uid };
  }

  throw new Error(
    [
      `Signed-in Firestore role is "${role || 'unknown'}", not super_admin.`,
      `Credential file: ${session.credPath}`,
      'That file\'s superAdmin entry currently authenticates an RC account, so global user list is denied by Firestore rules.',
      credentialHelp(),
    ].join('\n'),
  );
}

function summarize(users) {
  const byRole = {};
  let missingAadhaar = 0;
  for (const u of users) {
    const role = u.role || '(missing)';
    byRole[role] = (byRole[role] || 0) + 1;
    if (normalizeAadhaar(u.aadhar).length !== 12) missingAadhaar += 1;
  }
  return { total: users.length, byRole, missingAadhaar };
}

async function main() {
  const outPath = resolve(argValue('--out') || defaultOutPath());
  const allowRcScope = process.argv.includes('--allow-rc-scope');
  let users;
  let scope = 'all';
  let rcFirebaseUid = null;

  const adminUsers = await exportViaAdminSdk();
  if (adminUsers) {
    users = adminUsers;
  } else {
    const client = await exportViaClientAuth(allowRcScope);
    users = client.users;
    scope = client.scope || 'all';
    rcFirebaseUid = client.rcFirebaseUid || null;
  }

  const payload = {
    source: 'yesgatc-firestore',
    projectId: PROJECT_ID,
    exportedAt: new Date().toISOString(),
    scope,
    rcFirebaseUid,
    roles: ROLES,
    note:
      'Firebase Auth password hashes are not included. Import uses IMPORT_PASSWORD or SEED_PASSWORD.',
    users,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });

  const summary = summarize(users);
  console.log(
    JSON.stringify(
      {
        ok: true,
        out: outPath,
        scope,
        summary,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
