/**
 * Export yesgatc Firestore certification-related collections to JSON.
 *
 * Collections:
 *   products, customers, siteCalibrations, docaCertificates
 *   (+ empty certificates/manualPdfs listed for completeness)
 *
 * Auth (first match):
 *   1. FIREBASE_SERVICE_ACCOUNT_PATH / GOOGLE_APPLICATION_CREDENTIALS
 *   2. YESGATC_SUPER_AADHAR + YESGATC_SUPER_PASSWORD
 *   3. YESGATC_EMAAP_CREDENTIALS or VPS secrets:
 *        C:\GATC\secrets\yesgatc-superadmin.gatcdev.json
 *        C:\GATC\secrets\yesgatc-superadmin.json
 *      or Mac EmaapEngine credentials.local.json
 *
 * Usage:
 *   node scripts/export-yesgatc-certs.mjs
 *   node scripts/export-yesgatc-certs.mjs --out=.tmp/yesgatc-certs-export.json
 *
 * Never prints passwords or service-account JSON.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_ID,
  fetchUserDoc,
  listCollection,
  signInSuperAdmin,
  tryExportViaAdminSdk,
} from './lib/yesgatc-firestore.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const COLLECTIONS = [
  'products',
  'customers',
  'siteCalibrations',
  'docaCertificates',
  'certificates',
  'manualPdfs',
];

function argValue(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1).trim() : '';
}

function defaultOutPath() {
  return join(REPO_ROOT, '.tmp', 'yesgatc-certs-export.json');
}

async function exportViaClientAuth() {
  const session = await signInSuperAdmin();
  const me = await fetchUserDoc(session.idToken, session.uid);
  const role = me.role || '';
  if (role !== 'super_admin') {
    throw new Error(
      `Signed-in Firestore role is "${role || 'unknown'}", not super_admin. ` +
        `Credential source: ${session.credPath.replace(/.*[/\\]/, '')}. ` +
        'Global cert export requires super_admin (or a service account).',
    );
  }
  console.error('Auth mode: client Auth (Firestore role=super_admin)');
  const collections = {};
  for (const name of COLLECTIONS) {
    process.stderr.write(`exporting ${name}...\n`);
    collections[name] = await listCollection(session.idToken, name, {
      onPage: ({ soFar }) => {
        if (soFar % 900 === 0) process.stderr.write(`  ${name}: ${soFar}\n`);
      },
    });
    process.stderr.write(`  ${name}: ${collections[name].length}\n`);
  }
  return { mode: 'client_auth', collections };
}

async function main() {
  const outPath = resolve(argValue('--out') || defaultOutPath());

  let mode = 'client_auth';
  let collections;

  const admin = await tryExportViaAdminSdk(COLLECTIONS);
  if (admin) {
    console.error('Auth mode: Firebase Admin SDK');
    mode = admin.mode;
    collections = admin.collections;
    for (const name of COLLECTIONS) {
      process.stderr.write(`  ${name}: ${(collections[name] || []).length}\n`);
    }
  } else {
    const client = await exportViaClientAuth();
    mode = client.mode;
    collections = client.collections;
  }

  const counts = Object.fromEntries(
    COLLECTIONS.map((name) => [name, (collections[name] || []).length]),
  );

  const payload = {
    source: 'yesgatc-firestore',
    projectId: PROJECT_ID,
    exportedAt: new Date().toISOString(),
    authMode: mode,
    collections: COLLECTIONS,
    counts,
    note:
      'Certification-related dump. Media binary files are not embedded — URLs/paths only. Import may download into DATA_ROOT.',
    products: collections.products || [],
    customers: collections.customers || [],
    siteCalibrations: collections.siteCalibrations || [],
    docaCertificates: collections.docaCertificates || [],
    certificates: collections.certificates || [],
    manualPdfs: collections.manualPdfs || [],
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });

  console.log(
    JSON.stringify(
      {
        ok: true,
        out: outPath,
        authMode: mode,
        counts,
        bytes: Buffer.byteLength(JSON.stringify(payload)),
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
