/**
 * Shared Firestore REST helpers for yesgatc export scripts.
 * Never logs passwords or service-account JSON.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PROJECT_ID = 'yesgatc';
export const WEB_API_KEY = 'AIzaSyACjIT9hQNzAXDDZW7JaMMaVQgfyZi5oT4';

const STRIP_KEYS = new Set([
  'clearTextPassword',
  'password',
  'passwordHash',
  'password_hash',
]);

export function decodeFirestoreValue(value) {
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

export function decodeFirestoreDocument(doc) {
  const id = doc.name.split('/').pop();
  const fields = doc.fields || {};
  const data = {};
  for (const [k, v] of Object.entries(fields)) {
    if (STRIP_KEYS.has(k)) continue;
    data[k] = decodeFirestoreValue(v);
  }
  return { id, ...data };
}

export function defaultEmaapCredsPath() {
  return (
    process.env.YESGATC_EMAAP_CREDENTIALS?.trim() ||
    join(homedir(), 'Library/Application Support/YesGATC/EmaapEngine/credentials.local.json')
  );
}

/** Prefer gatcdev super_admin secret; skip incomplete placeholder files. */
export function resolveSuperAdminCreds() {
  const envAadhar = String(process.env.YESGATC_SUPER_AADHAR || '').replace(/\D/g, '');
  const envPassword = process.env.YESGATC_SUPER_PASSWORD || '';
  if (envAadhar.length === 12 && envPassword) {
    return {
      aadhar: envAadhar,
      password: envPassword,
      credPath: 'env:YESGATC_SUPER_AADHAR+YESGATC_SUPER_PASSWORD',
    };
  }

  const candidates = [
    process.env.YESGATC_EMAAP_CREDENTIALS?.trim(),
    'C:/GATC/secrets/yesgatc-superadmin.gatcdev.json',
    'C:/GATC/secrets/yesgatc-superadmin.json',
    defaultEmaapCredsPath(),
  ].filter(Boolean);

  const tried = [];
  for (const credPath of candidates) {
    if (!existsSync(credPath)) {
      tried.push(`${credPath}: missing`);
      continue;
    }
    const stored = JSON.parse(readFileSync(credPath, 'utf8'));
    const entry = stored.superAdmin || stored;
    const aadhar = String(entry?.aadhar || entry?.aadhaar || '').replace(/\D/g, '');
    const password = entry?.password || '';
    if (aadhar.length === 12 && password) {
      return { aadhar, password, credPath };
    }
    tried.push(`${String(credPath).replace(/.*[/\\]/, '')}: aadhaar_digits=${aadhar.length}`);
  }
  throw new Error(
    `No usable Firebase credentials (need 12-digit aadhaar + password). Tried: ${tried.join('; ')}`,
  );
}

/**
 * Sign in to yesgatc Firebase Auth with Aadhaar (or `{aadhar}@yesgatc.auth` email) + password.
 * Used by hourly sync with Yes One stored credentials.
 */
export async function signInWithAadhaarPassword(userId, password, { credPath = 'yesone' } = {}) {
  const aadhar = String(userId || '').replace(/\D/g, '');
  const email = String(userId || '').includes('@')
    ? String(userId).trim()
    : aadhar.length === 12
      ? `${aadhar}@yesgatc.auth`
      : '';
  if (!email || !password) {
    throw new Error('Yes One / Firebase login requires userId (aadhaar) and password');
  }
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
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

export async function signInSuperAdmin() {
  const { aadhar, password, credPath } = resolveSuperAdminCreds();
  return signInWithAadhaarPassword(aadhar, password, { credPath });
}

/**
 * Incremental list via structured query on an ISO string field (yesgatc stores updatedAt as string).
 * Returns documents where field >= sinceIso (lexicographic ISO-8601).
 * Paginates with startAfter cursors on [field, __name__].
 */
export async function queryCollectionSince(
  idToken,
  collectionId,
  {
    field = 'updatedAt',
    sinceIso,
    pageSize = 300,
    onPage,
  } = {},
) {
  if (!sinceIso) {
    throw new Error('queryCollectionSince requires sinceIso');
  }
  const out = [];
  let cursor = null;
  for (;;) {
    const structuredQuery = {
      from: [{ collectionId }],
      where: {
        fieldFilter: {
          field: { fieldPath: field },
          op: 'GREATER_THAN_OR_EQUAL',
          value: { stringValue: String(sinceIso) },
        },
      },
      orderBy: [
        { field: { fieldPath: field }, direction: 'ASCENDING' },
        { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
      ],
      limit: pageSize,
    };
    if (cursor) {
      structuredQuery.startAt = {
        values: [
          { stringValue: cursor.fieldValue },
          { referenceValue: cursor.name },
        ],
        before: false,
      };
    }
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
      const msg = rows?.error?.message || (Array.isArray(rows) ? null : JSON.stringify(rows));
      throw new Error(`query ${collectionId} since ${sinceIso} failed: ${msg || response.status}`);
    }
    if (!Array.isArray(rows)) {
      throw new Error(`query ${collectionId}: unexpected response`);
    }
    const batch = [];
    for (const row of rows) {
      if (row.document) batch.push(row.document);
    }
    for (const doc of batch) {
      out.push(decodeFirestoreDocument(doc));
    }
    if (typeof onPage === 'function') onPage({ collectionId, soFar: out.length });
    if (batch.length < pageSize) break;
    const last = batch[batch.length - 1];
    const decoded = decodeFirestoreDocument(last);
    const fieldValue = decoded[field];
    if (fieldValue == null || !last.name) break;
    cursor = { fieldValue: String(fieldValue), name: last.name };
  }
  return out;
}

/** Fetch a single document by id (or null if missing). */
export async function fetchDocument(idToken, collectionId, docId) {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collectionId}/${docId}`,
    { headers: { Authorization: `Bearer ${idToken}` } },
  );
  if (response.status === 404) return null;
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `fetch ${collectionId}/${docId} failed: ${body.error?.message || response.status}`,
    );
  }
  return decodeFirestoreDocument(body);
}

export async function fetchUserDoc(idToken, uid) {
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

/** List all documents in a top-level collection (paginated). */
export async function listCollection(idToken, collectionId, { pageSize = 300, onPage } = {}) {
  let pageToken = '';
  const out = [];
  do {
    const url = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collectionId}`,
    );
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(
        `list ${collectionId} failed: ${body.error?.message || response.status}`,
      );
    }
    const batch = (body.documents || []).map(decodeFirestoreDocument);
    out.push(...batch);
    if (typeof onPage === 'function') onPage({ collectionId, soFar: out.length });
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return out;
}

function loadFirebaseAdmin() {
  const candidates = [
    join(homedir(), 'Projects/gatc/yesgatc/functions/node_modules/firebase-admin/package.json'),
    join(process.cwd(), 'node_modules/firebase-admin/package.json'),
  ];
  for (const pkg of candidates) {
    if (!existsSync(pkg)) continue;
    try {
      const require = createRequire(pkg);
      return {
        app: require('firebase-admin/app'),
        firestore: require('firebase-admin/firestore'),
      };
    } catch {
      // try next
    }
  }
  return null;
}

export async function tryExportViaAdminSdk(collectionIds) {
  const saPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim() ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!saPath || !existsSync(saPath)) return null;

  const admin = loadFirebaseAdmin();
  if (!admin) return null;

  const { initializeApp, cert, getApps } = admin.app;
  const { getFirestore } = admin.firestore;
  const json = JSON.parse(readFileSync(saPath, 'utf8'));
  if (!getApps().length) {
    initializeApp({
      credential: cert(json),
      projectId: json.project_id || PROJECT_ID,
    });
  }
  const db = getFirestore();
  const result = {};
  for (const name of collectionIds) {
    const snap = await db.collection(name).get();
    result[name] = snap.docs.map((d) => {
      const data = d.data() || {};
      const cleaned = {};
      for (const [k, v] of Object.entries(data)) {
        if (STRIP_KEYS.has(k)) continue;
        cleaned[k] = v;
      }
      return { id: d.id, ...cleaned };
    });
  }
  return { mode: 'admin_sdk', collections: result };
}
