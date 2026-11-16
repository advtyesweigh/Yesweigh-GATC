/**
 * Hourly (or manual) incremental sync: yesgatc Firestore → GATC VPS Postgres.
 *
 * Auth (first match):
 *   1. FIREBASE_SERVICE_ACCOUNT_PATH / GOOGLE_APPLICATION_CREDENTIALS
 *   2. Yes One encrypted credentials ($DATA_ROOT/yesone/credentials.enc.json)
 *   3. YESGATC_SUPER_AADHAR + YESGATC_SUPER_PASSWORD / emaap creds file
 *
 * Usage:
 *   node scripts/sync-yesgatc.mjs
 *   node scripts/sync-yesgatc.mjs --since=2026-11-14T00:00:00.000Z
 *   node scripts/sync-yesgatc.mjs --download-media=certs
 *   node scripts/sync-yesgatc.mjs --download-media=all
 *   node scripts/sync-yesgatc.mjs --download-media=images
 *   node scripts/sync-yesgatc.mjs --purge-ov-media
 *   node scripts/sync-yesgatc.mjs --dry-run
 *   node scripts/sync-yesgatc.mjs --only=products
 *
 * Image downloads respect media retention (scripts/lib/media-retention.mjs):
 * OV certified → only scale_image; RV / OV uncertified → all images; PDFs always.
 *
 * Status / lock: $DATA_ROOT/yesone/sync-status.json + sync.lock
 */

import { createRequire } from 'node:module';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  PROJECT_ID,
  fetchDocument,
  fetchUserDoc,
  listCollection,
  queryCollectionSince,
  signInWithAadhaarPassword,
  signInSuperAdmin,
  tryExportViaAdminSdk,
} from './lib/yesgatc-firestore.mjs';
import {
  isImageMediaKind,
  isVerificationCertified,
  purgeOvPostCertLocalImages,
  shouldDownloadImageLocally,
} from './lib/media-retention.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const require = createRequire(join(REPO_ROOT, 'backend/package.json'));
const pg = require('pg');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');

dotenv.config({ path: join(REPO_ROOT, '.env') });

const { Client } = pg;

const MEDIA_FIELDS = [
  { kind: 'scale_image', url: 'scaleImageUrl', path: 'scaleImagePath', ct: 'scaleImageContentType' },
  { kind: 'instrument_rear', url: 'instrumentRearImageUrl', path: 'instrumentRearImagePath', ct: 'instrumentRearImageContentType' },
  { kind: 'stamping', url: 'stampingImageUrl', path: 'stampingImagePath', ct: 'stampingImageContentType' },
  { kind: 'standard_weight', url: 'standardWeightImageUrl', path: 'standardWeightImagePath', ct: 'standardWeightImageContentType' },
  { kind: 'verification_seal', url: 'verificationSealImageUrl', path: 'verificationSealImagePath', ct: 'verificationSealImageContentType' },
  { kind: 'installation', url: 'installationImageUrl', path: 'installationImagePath', ct: 'installationImageContentType' },
  { kind: 'performer_selfie_id', url: 'performerSelfieIdImageUrl', path: 'performerSelfieIdImagePath', ct: 'performerSelfieIdImageContentType' },
  { kind: 'performer_id_aadhaar', url: 'performerIdAadhaarImageUrl', path: 'performerIdAadhaarImagePath', ct: 'performerIdAadhaarImageContentType' },
  { kind: 'certificate_pdf', url: 'certificatePdfUrl', path: 'certificatePdfPath', ct: 'certificatePdfContentType', cert: true },
  { kind: 'signed_certificate_pdf', url: 'signedCertificatePdfUrl', path: 'signedCertificatePdfPath', ct: 'signedCertificatePdfContentType', cert: true },
  { kind: 'emaap_certificate_pdf', url: 'emaapCertificatePdfUrl', path: null, ct: null, cert: true },
  { kind: 'old_verification_certificate', url: 'oldVerificationCertificateUrl', path: 'oldVerificationCertificatePath', ct: 'oldVerificationCertificateContentType', cert: true },
  { kind: 'old_invoice', url: 'oldInvoiceUrl', path: 'oldInvoicePath', ct: 'oldInvoiceContentType' },
];

const DETAIL_KEEP = [
  'certificateNumber',
  'certificatePdfUrl',
  'certificatePdfPath',
  'signedCertificatePdfUrl',
  'signedCertificatePdfPath',
  'emaapCertificatePdfUrl',
  'emaapIssuedCertificateNumber',
  'certificateVoidedAt',
  'certificateVoidReason',
  'gstBill',
  'verificationFeeBase',
  'verificationFeeGst',
  'verificationFeeTotal',
  'serviceFee',
  'additionalFee',
  'discountFee',
  'rvPaymentStatus',
  'zohoInvoiceId',
  'zohoInvoiceNumber',
  'zohoInvoiceStatus',
  'yesonePushStatus',
  'resubmittedFromId',
  'resubmissionRootId',
  'pipelineFailedPhase',
  'pipelineFailureMessage',
  'certificationLastError',
  'clientAppVersion',
  'ovInName',
  'fileCertificateAsRc',
  'vctId',
  'vctName',
  'pendingRcAt',
  'rcApprovedAt',
  'rejectedAt',
  'productSpecificationId',
  'maximumCapacity',
  'minimumCapacity',
  'verificationScaleInterval',
  'actualScaleInterval',
  'noOfVerificationIntervals',
  'unitOfMeasurement',
  'manufacturerBrandSeries',
  'modelApprovalNo',
  'accuracyClass',
  'maximumPermissibleError',
];

const PROFILE_KEEP = [
  'firebaseUid',
  'firebaseRole',
  'companyName',
  'contactPerson',
  'place',
  'pincode',
  'state',
  'district',
  'location',
  'gstNumber',
  'panCard',
  'zohoId',
  'zohoExpenseAccountId',
  'zohoExpenseAccountName',
  'laboratorySealIdentification',
  'feesStructure',
  'rcCode',
  'certificationMethod',
  'standardWeightsCertNumber',
  'standardWeightsCertDate',
  'standardWeightsCertExpiry',
  'emaapSignerType',
  'bloodGroup',
  'policeStation',
  'secondaryContactName',
  'secondaryContactRelationship',
  'secondaryContactPhone',
  'approvalStatus',
  'ovInName',
  'allowedJobKinds',
  'createdAt',
  'createdByUid',
  'logoUrl',
  'logoPath',
  'logoName',
  'logoContentType',
  'profilePhotoUrl',
  'profilePhotoPath',
  'profilePhotoName',
  'profilePhotoContentType',
  'profilePhotoLocalPath',
  'sealUrl',
  'sealPath',
  // VCT onboarding docs + approval metadata (Firebase users collection)
  'rcId',
  'approvedAt',
  'approvedByUid',
  'forceLogoutAt',
  'deactivatedAt',
  'deactivatedByUid',
  'aadharDocUrl',
  'aadharDocPath',
  'aadharDocName',
  'aadharDocContentType',
  'aadharDocLocalPath',
  'biodataDocUrl',
  'biodataDocPath',
  'biodataDocName',
  'biodataDocContentType',
  'biodataDocLocalPath',
  'educationCertDocUrl',
  'educationCertDocPath',
  'educationCertDocName',
  'educationCertDocContentType',
  'educationCertDocLocalPath',
  'pccDocUrl',
  'pccDocPath',
  'pccDocName',
  'pccDocContentType',
  'pccDocLocalPath',
];

const ROLE_MAP = {
  super_admin: 'ADMIN',
  rc_admin: 'RC_ADMIN',
  vct: 'VCT',
};

function argValue(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1).trim() : '';
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function parseTsFixed(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function jobKind(doc) {
  const type = String(doc.verificationType || '').toUpperCase();
  if (type === 'RV') return 'rv_customer';
  const subject = String(doc.verificationSubject || '').toLowerCase();
  if (subject === 'self') return 'ov_self';
  return 'ov_customer';
}

function numOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeAadhaar(raw) {
  return String(raw ?? '').replace(/\D/g, '');
}

function slugCode(raw, fallback) {
  const cleaned = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  if (cleaned.length >= 2) return cleaned;
  return fallback;
}

function rcCodeFor(doc) {
  const explicit = String(doc.rcCode || '')
    .trim()
    .toUpperCase();
  if (/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(explicit)) return explicit;
  const fromCompany = slugCode(doc.companyName, '');
  if (fromCompany) return fromCompany.slice(0, 16);
  return `RC-${String(doc.uid || doc.id || 'X').slice(0, 8).toUpperCase()}`;
}

function buildProfile(doc) {
  const uid = doc.uid || doc.id;
  const profile = {
    firebaseUid: uid,
    firebaseRole: doc.role,
  };
  for (const key of PROFILE_KEEP) {
    if (key === 'firebaseUid' || key === 'firebaseRole') continue;
    if (doc[key] !== undefined && doc[key] !== null && doc[key] !== '') {
      profile[key] = doc[key];
    }
  }
  return profile;
}

function isActiveUser(doc) {
  if (doc.active === false) return false;
  if (doc.role === 'vct' && doc.approvalStatus === 'pending') return false;
  return true;
}

function workflowMode(doc) {
  if (doc.role !== 'vct') return null;
  return doc.workflowMode === 'auto' ? 'auto' : 'manual';
}

function extFor(contentType, url, fallback = '.bin') {
  if (contentType?.includes('pdf')) return '.pdf';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('webp')) return '.webp';
  const fromUrl = extname(String(url || '').split('?')[0] || '');
  if (fromUrl && fromUrl.length <= 5) return fromUrl;
  return fallback;
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid)';
  }
}

function isLocalMediaPath(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/');
  return p.startsWith('media/') || p.startsWith('certificates/');
}

function statusPaths(dataRoot) {
  const root = dataRoot || join(REPO_ROOT, 'data');
  return {
    statusPath: join(root, 'yesone', 'sync-status.json'),
    lockPath: join(root, 'yesone', 'sync.lock'),
  };
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function acquireLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    try {
      const prev = JSON.parse(readFileSync(lockPath, 'utf8'));
      const pid = Number(prev?.pid);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error(`Sync already running (pid ${pid})`);
        } catch (error) {
          if (error.message?.startsWith('Sync already')) throw error;
        }
      }
    } catch (error) {
      if (error.message?.startsWith('Sync already')) throw error;
    }
  }
  writeJsonAtomic(lockPath, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
}

function releaseLock(lockPath) {
  try {
    if (!existsSync(lockPath)) return;
    const prev = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (Number(prev?.pid) === process.pid) unlinkSync(lockPath);
  } catch {
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

async function downloadTo(url, destPath) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  mkdirSync(dirname(destPath), { recursive: true });
  const body = response.body;
  if (!body) throw new Error('empty body');
  await pipeline(Readable.fromWeb(body), createWriteStream(destPath));
  return destPath;
}

async function resolveAuth(dataRoot, jwtSecret) {
  const saPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim() ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (saPath && existsSync(saPath)) {
    return { mode: 'admin_sdk', saPath };
  }

  // Yes One encrypted portal credentials (aadhaar + password)
  try {
    const { loadYesoneCredentialsSecrets } = await import(
      join(REPO_ROOT, 'backend/src/yesoneCredentials.js')
    );
    const secrets = loadYesoneCredentialsSecrets({ dataRoot, jwtSecret });
    if (secrets?.userId && secrets?.password) {
      const session = await signInWithAadhaarPassword(secrets.userId, secrets.password, {
        credPath: 'yesone:credentials.enc.json',
      });
      const me = await fetchUserDoc(session.idToken, session.uid);
      if (me.role !== 'super_admin') {
        throw new Error(
          `Yes One login role is "${me.role || 'unknown'}", need super_admin for global sync`,
        );
      }
      return { mode: 'yesone_credentials', ...session, role: me.role };
    }
  } catch (error) {
    if (String(error.message || '').includes('need super_admin')) throw error;
    // fall through to env/file super admin
  }

  const session = await signInSuperAdmin();
  const me = await fetchUserDoc(session.idToken, session.uid);
  if (me.role !== 'super_admin') {
    throw new Error(
      `Signed-in role is "${me.role || 'unknown'}", need super_admin for global sync`,
    );
  }
  return { mode: 'client_auth', ...session, role: me.role };
}

async function resolveSince(client, statusPath, override) {
  if (override) {
    const iso = parseTsFixed(override);
    if (!iso) throw new Error(`Invalid --since=${override}`);
    return { since: iso, source: 'cli' };
  }
  const status = readJson(statusPath);
  if (status?.lastSuccessAt) {
    // Overlap 10 minutes so in-flight updates are not missed
    const t = new Date(status.lastSuccessAt).getTime() - 10 * 60 * 1000;
    return { since: new Date(t).toISOString(), source: 'lastSuccessAt' };
  }
  const row = await client.query(
    `SELECT MAX(updated_at) AS max_u FROM verifications WHERE source_firebase_id IS NOT NULL`,
  );
  const maxU = row.rows[0]?.max_u;
  if (maxU) {
    const t = new Date(maxU).getTime() - 10 * 60 * 1000;
    return { since: new Date(t).toISOString(), source: 'postgres_max_updated_at' };
  }
  // Safety: last 48h only — never full 6k re-import on first hourly run
  const t = Date.now() - 48 * 60 * 60 * 1000;
  return { since: new Date(t).toISOString(), source: 'fallback_48h' };
}

async function loadUidMaps(client) {
  const users = await client.query(
    `SELECT id, rc_id, role, profile_json->>'firebaseUid' AS firebase_uid
     FROM users
     WHERE profile_json ? 'firebaseUid'`,
  );
  const rcs = await client.query(
    `SELECT id, fees_json->>'firebaseUid' AS firebase_uid FROM regional_centers`,
  );
  const userByFirebase = new Map();
  const rcByFirebase = new Map();
  for (const row of rcs.rows) {
    if (row.firebase_uid) rcByFirebase.set(row.firebase_uid, row.id);
  }
  for (const row of users.rows) {
    if (!row.firebase_uid) continue;
    userByFirebase.set(row.firebase_uid, {
      id: row.id,
      rcId: row.rc_id,
      role: row.role,
    });
    if (row.role === 'RC_ADMIN' && row.rc_id) {
      rcByFirebase.set(row.firebase_uid, row.rc_id);
    }
  }
  return { userByFirebase, rcByFirebase };
}

async function ensureUniqueRcCode(client, desired, firebaseUid) {
  let code = desired;
  let n = 0;
  while (true) {
    const existing = await client.query(
      `SELECT id, fees_json FROM regional_centers WHERE code = $1 LIMIT 1`,
      [code],
    );
    if (existing.rowCount === 0) return code;
    const fees = existing.rows[0].fees_json || {};
    if (fees.firebaseUid === firebaseUid) return code;
    n += 1;
    code = `${desired.slice(0, 20)}-${n}`;
  }
}

async function upsertRegionalCenter(client, doc) {
  const uid = doc.uid || doc.id;
  const desired = rcCodeFor({ ...doc, uid });
  const code = await ensureUniqueRcCode(client, desired, uid);
  const fees = {
    ...(doc.feesStructure && typeof doc.feesStructure === 'object'
      ? { feesStructure: doc.feesStructure }
      : {}),
    firebaseUid: uid,
  };
  if (doc.logoUrl) fees.logoUrl = doc.logoUrl;
  if (doc.logoPath) fees.logoPath = doc.logoPath;
  if (doc.sealUrl) fees.sealUrl = doc.sealUrl;
  if (doc.sealPath) fees.sealPath = doc.sealPath;
  if (doc.standardWeightsCertUrl) fees.standardWeightsCertUrl = doc.standardWeightsCertUrl;
  if (doc.panCardUrl) fees.panCardUrl = doc.panCardUrl;
  if (doc.pdfSignerSignUrl) fees.pdfSignerSignUrl = doc.pdfSignerSignUrl;
  if (doc.pdfSignerSignScale != null) fees.pdfSignerSignScale = doc.pdfSignerSignScale;
  if (doc.pdfSignerSignX != null) fees.pdfSignerSignX = doc.pdfSignerSignX;
  if (doc.pdfSignerSignY != null) fees.pdfSignerSignY = doc.pdfSignerSignY;
  // Preserve / refresh RC Quota fields used by Super Admin RC Quota page.
  if (doc.ovQuota != null) fees.ovQuota = doc.ovQuota;
  if (doc.ovQuotaUsed != null) fees.ovQuotaUsed = doc.ovQuotaUsed;
  if (doc.ovQuotaPeriod) fees.ovQuotaPeriod = doc.ovQuotaPeriod;
  if (doc.ovQuotaUpdatedAt) fees.ovQuotaUpdatedAt = doc.ovQuotaUpdatedAt;
  if (doc.ovQuotaSource) fees.ovQuotaSource = doc.ovQuotaSource;
  if (Array.isArray(doc.yesoneReservedSerials)) {
    fees.ovQuotaReserved = doc.yesoneReservedSerials.length;
  }
  const result = await client.query(
    `INSERT INTO regional_centers (
       code, company_name, contact_person, phone, email, address, place,
       state, district, pincode, location_lat, location_lng,
       gst_number, pan_card, zoho_customer_id, zoho_expense_account_id,
       zoho_expense_account_name, certification_method,
       laboratory_seal_identification, standard_weights_cert_number,
       standard_weights_cert_date, standard_weights_cert_expiry,
       logo_url, seal_url, standard_weights_cert_url, pan_card_url,
       pdf_signer_sign_url, pdf_signer_sign_scale, pdf_signer_sign_x,
       pdf_signer_sign_y, fees_json, active
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
       $23,$24,$25,$26,$27,$28,$29,$30,
       $31::jsonb,TRUE
     )
     ON CONFLICT (code) DO UPDATE SET
       company_name = EXCLUDED.company_name,
       contact_person = EXCLUDED.contact_person,
       phone = EXCLUDED.phone,
       email = EXCLUDED.email,
       address = EXCLUDED.address,
       place = COALESCE(EXCLUDED.place, regional_centers.place),
       state = EXCLUDED.state,
       district = EXCLUDED.district,
       pincode = EXCLUDED.pincode,
       location_lat = EXCLUDED.location_lat,
       location_lng = EXCLUDED.location_lng,
       gst_number = COALESCE(EXCLUDED.gst_number, regional_centers.gst_number),
       pan_card = COALESCE(EXCLUDED.pan_card, regional_centers.pan_card),
       zoho_customer_id = COALESCE(EXCLUDED.zoho_customer_id, regional_centers.zoho_customer_id),
       zoho_expense_account_id = COALESCE(EXCLUDED.zoho_expense_account_id, regional_centers.zoho_expense_account_id),
       zoho_expense_account_name = COALESCE(EXCLUDED.zoho_expense_account_name, regional_centers.zoho_expense_account_name),
       certification_method = COALESCE(EXCLUDED.certification_method, regional_centers.certification_method),
       laboratory_seal_identification = EXCLUDED.laboratory_seal_identification,
       standard_weights_cert_number = COALESCE(EXCLUDED.standard_weights_cert_number, regional_centers.standard_weights_cert_number),
       standard_weights_cert_date = COALESCE(EXCLUDED.standard_weights_cert_date, regional_centers.standard_weights_cert_date),
       standard_weights_cert_expiry = COALESCE(EXCLUDED.standard_weights_cert_expiry, regional_centers.standard_weights_cert_expiry),
       logo_url = COALESCE(EXCLUDED.logo_url, regional_centers.logo_url),
       seal_url = COALESCE(EXCLUDED.seal_url, regional_centers.seal_url),
       standard_weights_cert_url = COALESCE(EXCLUDED.standard_weights_cert_url, regional_centers.standard_weights_cert_url),
       pan_card_url = COALESCE(EXCLUDED.pan_card_url, regional_centers.pan_card_url),
       pdf_signer_sign_url = COALESCE(EXCLUDED.pdf_signer_sign_url, regional_centers.pdf_signer_sign_url),
       pdf_signer_sign_scale = COALESCE(EXCLUDED.pdf_signer_sign_scale, regional_centers.pdf_signer_sign_scale),
       pdf_signer_sign_x = COALESCE(EXCLUDED.pdf_signer_sign_x, regional_centers.pdf_signer_sign_x),
       pdf_signer_sign_y = COALESCE(EXCLUDED.pdf_signer_sign_y, regional_centers.pdf_signer_sign_y),
       fees_json = COALESCE(regional_centers.fees_json, '{}'::jsonb) || EXCLUDED.fees_json,
       active = TRUE,
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      code,
      doc.companyName || doc.username || code,
      doc.contactPerson || doc.username || null,
      doc.phone || null,
      doc.email || null,
      doc.address || null,
      doc.place || null,
      doc.state || null,
      doc.district || null,
      doc.pincode || null,
      doc.location?.lat ?? null,
      doc.location?.lng ?? null,
      doc.gstNumber || null,
      doc.panCard || null,
      doc.zohoId || null,
      doc.zohoExpenseAccountId || null,
      doc.zohoExpenseAccountName || null,
      doc.certificationMethod || null,
      doc.laboratorySealIdentification || null,
      doc.standardWeightsCertNumber || null,
      doc.standardWeightsCertDate || null,
      doc.standardWeightsCertExpiry || null,
      doc.logoUrl || null,
      doc.sealUrl || null,
      doc.standardWeightsCertUrl || null,
      doc.panCardUrl || null,
      doc.pdfSignerSignUrl || null,
      doc.pdfSignerSignScale ?? null,
      doc.pdfSignerSignX ?? null,
      doc.pdfSignerSignY ?? null,
      JSON.stringify(fees),
    ],
  );
  return result.rows[0];
}

async function upsertUserPreservePassword(client, {
  aadhaar,
  username,
  passwordHash,
  role,
  rcId,
  phone,
  email,
  address,
  profile,
  workflow,
  active,
}) {
  const existing = await client.query(
    `SELECT id FROM users WHERE aadhaar = $1 LIMIT 1`,
    [aadhaar],
  );
  if (existing.rowCount) {
    const result = await client.query(
      `UPDATE users SET
         username = $2,
         role = $3,
         rc_id = $4,
         phone = $5,
         email = $6,
         address = $7,
         profile_json = $8::jsonb,
         workflow_mode = $9,
         active = $10,
         updated_at = NOW()
       WHERE aadhaar = $1
       RETURNING id, false AS inserted`,
      [
        aadhaar,
        username || null,
        role,
        rcId,
        phone || null,
        email || null,
        address || null,
        JSON.stringify(profile),
        workflow,
        active,
      ],
    );
    return { ...result.rows[0], inserted: false };
  }
  const result = await client.query(
    `INSERT INTO users (
       aadhaar, username, password_hash, role, rc_id,
       phone, email, address, profile_json, workflow_mode, active
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
     RETURNING id, true AS inserted`,
    [
      aadhaar,
      username || null,
      passwordHash,
      role,
      rcId,
      phone || null,
      email || null,
      address || null,
      JSON.stringify(profile),
      workflow,
      active,
    ],
  );
  return result.rows[0];
}

async function upsertProduct(client, doc) {
  const modelId = String(doc.modelid || doc.modelId || doc.id || '').trim();
  if (!modelId) return null;
  const capacities = {
    maximumCapacity: doc.maximumCapacity ?? null,
    minimumCapacity: doc.minimumCapacity ?? null,
    verificationScaleInterval: doc.verificationScaleInterval ?? null,
    actualScaleInterval: doc.actualScaleInterval ?? null,
    noOfVerificationIntervals: doc.noOfVerificationIntervals ?? null,
    maximumPermissibleError: doc.maximumPermissibleError ?? null,
    specifications: doc.specifications || [],
    yesoneSku: doc.yesoneSku || null,
  };
  const imageUrl =
    typeof doc.productImageUrl === 'string' && /^https?:\/\//i.test(doc.productImageUrl.trim())
      ? doc.productImageUrl.trim()
      : null;
  const approvalDocUrl =
    typeof doc.modelApprovalDocUrl === 'string'
    && /^https?:\/\//i.test(doc.modelApprovalDocUrl.trim())
      ? doc.modelApprovalDocUrl.trim()
      : null;
  const result = await client.query(
    `INSERT INTO products (
       model_id, model_no, name, type_of_instrument, manufacturer_brand_series,
       accuracy_class, capacities, unit_of_measurement, model_approval_no,
       supply_voltage, pas_pre_allotted, active, sort_order,
       approval_doc_path, approval_doc_url, image_path, image_url, source_firebase_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
     )
     ON CONFLICT (model_id) DO UPDATE SET
       model_no = EXCLUDED.model_no,
       name = EXCLUDED.name,
       type_of_instrument = EXCLUDED.type_of_instrument,
       manufacturer_brand_series = EXCLUDED.manufacturer_brand_series,
       accuracy_class = EXCLUDED.accuracy_class,
       capacities = EXCLUDED.capacities,
       unit_of_measurement = EXCLUDED.unit_of_measurement,
       model_approval_no = EXCLUDED.model_approval_no,
       supply_voltage = EXCLUDED.supply_voltage,
       pas_pre_allotted = EXCLUDED.pas_pre_allotted,
       active = EXCLUDED.active,
       sort_order = EXCLUDED.sort_order,
       approval_doc_path = CASE
         WHEN products.approval_doc_path LIKE 'media/yesgatc/%' THEN products.approval_doc_path
         ELSE COALESCE(EXCLUDED.approval_doc_path, products.approval_doc_path)
       END,
       approval_doc_url = COALESCE(EXCLUDED.approval_doc_url, products.approval_doc_url),
       image_path = CASE
         WHEN products.image_path LIKE 'media/yesgatc/%' THEN products.image_path
         ELSE COALESCE(EXCLUDED.image_path, products.image_path)
       END,
       image_url = COALESCE(EXCLUDED.image_url, products.image_url),
       source_firebase_id = EXCLUDED.source_firebase_id,
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      modelId,
      doc.modelNo || null,
      doc.name || modelId,
      doc.typeOfInstrument || null,
      doc.manufacturerBrandSeries || null,
      doc.accuracyClass || null,
      JSON.stringify(capacities),
      doc.unitOfMeasurement || null,
      doc.modelApprovalNo || null,
      doc.supplyVoltage || null,
      Boolean(doc.pasPreAllotted),
      doc.active !== false,
      Number.isFinite(Number(doc.sortOrder)) ? Number(doc.sortOrder) : 0,
      doc.modelApprovalDocPath || null,
      approvalDocUrl,
      doc.productImagePath || null,
      imageUrl,
      doc.id,
    ],
  );
  return result.rows[0];
}

async function upsertCustomer(client, doc, rcId, createdBy) {
  const details = {
    devices: doc.devices || [],
    shopPhotoUrl: doc.shopPhotoUrl || null,
    shopPhotoPath: doc.shopPhotoPath || null,
    customerPhotoUrl: doc.customerPhotoUrl || null,
    firebaseCreatedAt: doc.createdAt || null,
  };
  const existing = await client.query(
    `SELECT id FROM customers WHERE source_firebase_id = $1 LIMIT 1`,
    [doc.id],
  );
  if (existing.rowCount) {
    const id = existing.rows[0].id;
    await client.query(
      `UPDATE customers SET
         rc_id = $2, name = $3, phone = $4, email = $5, address = $6,
         pincode = $7, state = $8, district = $9,
         location_lat = $10, location_lng = $11,
         shop_photo_path = COALESCE($12, shop_photo_path),
         created_by = COALESCE($13, created_by),
         details_json = $14::jsonb,
         updated_at = NOW()
       WHERE id = $1`,
      [
        id,
        rcId,
        doc.name || 'Customer',
        doc.phone || null,
        doc.email || null,
        doc.address || null,
        doc.pincode || null,
        doc.state || null,
        doc.district || null,
        doc.location?.lat ?? null,
        doc.location?.lng ?? null,
        doc.shopPhotoPath || null,
        createdBy,
        JSON.stringify(details),
      ],
    );
    return { id, inserted: false };
  }
  const result = await client.query(
    `INSERT INTO customers (
       rc_id, name, phone, email, address, pincode, state, district,
       location_lat, location_lng, shop_photo_path, created_by,
       source_firebase_id, details_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
     RETURNING id`,
    [
      rcId,
      doc.name || 'Customer',
      doc.phone || null,
      doc.email || null,
      doc.address || null,
      doc.pincode || null,
      doc.state || null,
      doc.district || null,
      doc.location?.lat ?? null,
      doc.location?.lng ?? null,
      doc.shopPhotoPath || null,
      createdBy,
      doc.id,
      JSON.stringify(details),
    ],
  );
  return { id: result.rows[0].id, inserted: true };
}

function buildProductSnapshot(doc) {
  const snap = { productName: doc.productName || null, firebaseProductId: doc.productId || null };
  for (const key of [
    'maximumCapacity',
    'minimumCapacity',
    'verificationScaleInterval',
    'actualScaleInterval',
    'noOfVerificationIntervals',
    'unitOfMeasurement',
    'manufacturerBrandSeries',
    'modelApprovalNo',
    'accuracyClass',
    'maximumPermissibleError',
    'productSpecificationId',
  ]) {
    if (doc[key] !== undefined && doc[key] !== null && doc[key] !== '') snap[key] = doc[key];
  }
  return snap;
}

function buildDetails(doc) {
  const details = { firebaseId: doc.id };
  for (const key of DETAIL_KEEP) {
    if (doc[key] !== undefined && doc[key] !== null && doc[key] !== '') {
      details[key] = doc[key];
    }
  }
  return details;
}

async function upsertVerification(client, doc, {
  rcId,
  customerId,
  productId,
  performerUserId,
  createdBy,
}) {
  const type = String(doc.verificationType || 'OV').toUpperCase() === 'RV' ? 'RV' : 'OV';
  const status = String(doc.status || 'draft').slice(0, 64) || 'draft';
  const appNo = doc.applicationNumber ? String(doc.applicationNumber) : null;
  const details = buildDetails(doc);

  const existing = await client.query(
    `SELECT id FROM verifications WHERE source_firebase_id = $1 LIMIT 1`,
    [doc.id],
  );

  const params = [
    rcId,
    appNo,
    type,
    jobKind(doc),
    status,
    customerId,
    doc.customerName || null,
    productId,
    JSON.stringify(buildProductSnapshot(doc)),
    doc.serialNumber || null,
    doc.serialSource || null,
    numOrNull(doc.ambientTemperature),
    numOrNull(doc.relativeHumidity),
    doc.sealIdentificationNumber || null,
    doc.verificationLocation || null,
    doc.verificationSubject || null,
    doc.performedBy || null,
    performerUserId,
    doc.requestSource || null,
    numOrNull(doc.manufacturingYear) != null
      ? Math.trunc(numOrNull(doc.manufacturingYear))
      : null,
    createdBy,
    parseTsFixed(doc.submittedAt),
    parseTsFixed(doc.approvedAt),
    parseTsFixed(doc.certifiedAt),
    parseTsFixed(doc.createdAt) || new Date().toISOString(),
    doc.certificateNumber || null,
    JSON.stringify(details),
    doc.id,
  ];

  if (existing.rowCount) {
    const id = existing.rows[0].id;
    await client.query(
      `UPDATE verifications SET
         rc_id=$2, application_number=$3, verification_type=$4, job_kind=$5, status=$6,
         customer_id=$7, customer_name=$8, product_id=$9, product_snapshot=$10::jsonb,
         serial_number=$11, serial_source=$12, ambient_temperature=$13, relative_humidity=$14,
         seal_identification_number=$15, verification_location=$16, verification_subject=$17,
         performed_by=$18, performer_user_id=$19, request_source=$20, manufacturing_year=$21,
         created_by=$22, submitted_at=$23, approved_at=$24, certified_at=$25,
         created_at=COALESCE($26::timestamptz, created_at),
         certificate_number=$27, details_json=$28::jsonb, updated_at=NOW()
       WHERE id=$1`,
      [id, ...params.slice(0, -1)],
    );
    return { id, inserted: false };
  }

  try {
    const result = await client.query(
      `INSERT INTO verifications (
         rc_id, application_number, verification_type, job_kind, status,
         customer_id, customer_name, product_id, product_snapshot,
         serial_number, serial_source, ambient_temperature, relative_humidity,
         seal_identification_number, verification_location, verification_subject,
         performed_by, performer_user_id, request_source, manufacturing_year,
         created_by, submitted_at, approved_at, certified_at, created_at,
         certificate_number, details_json, source_firebase_id
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
         $21,$22,$23,$24,$25::timestamptz,$26,$27::jsonb,$28
       ) RETURNING id`,
      params,
    );
    return { id: result.rows[0].id, inserted: true };
  } catch (error) {
    if (error.code === '23505' && appNo) {
      details.applicationNumberConflict = appNo;
      params[1] = null;
      params[26] = JSON.stringify(details);
      const result = await client.query(
        `INSERT INTO verifications (
           rc_id, application_number, verification_type, job_kind, status,
           customer_id, customer_name, product_id, product_snapshot,
           serial_number, serial_source, ambient_temperature, relative_humidity,
           seal_identification_number, verification_location, verification_subject,
           performed_by, performer_user_id, request_source, manufacturing_year,
           created_by, submitted_at, approved_at, certified_at, created_at,
           certificate_number, details_json, source_firebase_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
           $21,$22,$23,$24,$25::timestamptz,$26,$27::jsonb,$28
         ) RETURNING id`,
        params,
      );
      return { id: result.rows[0].id, inserted: true };
    }
    throw error;
  }
}

/** Merge media rows — preserve local file_path so PDF backfill is not clobbered. */
async function mergeVerificationMedia(client, verificationId, mediaRows) {
  for (const row of mediaRows) {
    const existing = await client.query(
      `SELECT id, file_path, source_url FROM verification_media
       WHERE verification_id = $1 AND kind = $2
       LIMIT 1`,
      [verificationId, row.kind],
    );
    if (existing.rowCount) {
      const prev = existing.rows[0];
      const keepLocal = isLocalMediaPath(prev.file_path);
      const nextPath = keepLocal
        ? prev.file_path
        : (isLocalMediaPath(row.filePath) ? row.filePath : (row.filePath || prev.file_path || ''));
      await client.query(
        `UPDATE verification_media SET
           file_path = $2,
           content_type = COALESCE($3, content_type),
           source_url = COALESCE($4, source_url),
           source_storage_path = COALESCE($5, source_storage_path)
         WHERE id = $1`,
        [
          prev.id,
          nextPath,
          row.contentType,
          row.sourceUrl,
          row.sourceStoragePath,
        ],
      );
    } else {
      await client.query(
        `INSERT INTO verification_media (
           verification_id, kind, file_path, content_type, source_url, source_storage_path
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          verificationId,
          row.kind,
          row.filePath || '',
          row.contentType,
          row.sourceUrl,
          row.sourceStoragePath,
        ],
      );
    }
  }
}

async function upsertVehicle(client, doc, rcId) {
  const docs = {
    sourceFirebaseId: doc.id,
    rcDocUrl: doc.rcDocUrl || null,
    insuranceDocUrl: doc.insuranceDocUrl || null,
    pollutionDocUrl: doc.pollutionDocUrl || null,
    f2WeightDocUrl: doc.f2WeightDocUrl || null,
    vehiclePhotoUrl: doc.vehiclePhotoUrl || null,
    approvalStatus: doc.approvalStatus || null,
    firebaseCreatedAt: doc.createdAt || null,
  };
  const existing = await client.query(
    `SELECT id FROM vehicles
     WHERE source_firebase_id = $1
        OR docs_json->>'sourceFirebaseId' = $1
     LIMIT 1`,
    [doc.id],
  );
  const dateOrNull = (v) => {
    const s = String(v || '').trim();
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  };
  const vals = [
    rcId,
    doc.brand || '',
    doc.model || '',
    doc.year || null,
    doc.regNumber || '',
    dateOrNull(doc.rcValidity),
    dateOrNull(doc.insuranceValidity),
    dateOrNull(doc.pollutionValidity),
    dateOrNull(doc.f2WeightValidity),
    JSON.stringify(docs),
    doc.active !== false,
    doc.id,
  ];
  if (existing.rowCount) {
    await client.query(
      `UPDATE vehicles SET
         rc_id=$2, brand=$3, model=$4, year=$5, reg_number=$6,
         rc_validity=$7, insurance_validity=$8, pollution_validity=$9,
         f2_weight_validity=$10, docs_json=$11::jsonb, active=$12,
         source_firebase_id=COALESCE(source_firebase_id, $13),
         updated_at=NOW()
       WHERE id=$1`,
      [existing.rows[0].id, ...vals],
    );
    return { id: existing.rows[0].id, inserted: false };
  }
  const result = await client.query(
    `INSERT INTO vehicles (
       rc_id, brand, model, year, reg_number,
       rc_validity, insurance_validity, pollution_validity, f2_weight_validity,
       docs_json, active, source_firebase_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
     RETURNING id`,
    vals,
  );
  return { id: result.rows[0].id, inserted: true };
}

async function maybeDownloadMedia({
  url,
  storagePath,
  contentType,
  dataRoot,
  relDir,
  kind,
  mode,
  existingLocalPath,
  stats,
  isCert = false,
  defaultExt = '.pdf',
}) {
  if (!url) {
    return { filePath: existingLocalPath || storagePath || '', downloaded: false };
  }
  if (isLocalMediaPath(existingLocalPath) && existsSync(join(dataRoot, existingLocalPath))) {
    return { filePath: existingLocalPath, downloaded: false, skippedExisting: true };
  }
  const should =
    mode === 'all' ||
    (isCert && (mode === 'certs' || mode === 'all')) ||
    (!isCert && (mode === 'images' || mode === 'all'));
  if (!should || !dataRoot) {
    return { filePath: existingLocalPath || storagePath || url, downloaded: false };
  }
  const ext = extFor(contentType, url, defaultExt);
  const rel = join(relDir, `${kind}${ext}`).replace(/\\/g, '/');
  const abs = join(dataRoot, rel);
  if (existsSync(abs)) {
    return { filePath: rel, downloaded: false, skippedExisting: true };
  }
  try {
    await downloadTo(url, abs);
    if (isCert) stats.pdfDownloaded += 1;
    else stats.imageDownloaded = (stats.imageDownloaded || 0) + 1;
    return { filePath: rel, downloaded: true };
  } catch (error) {
    if (isCert) {
      stats.pdfFailed += 1;
      stats.pdfErrors.push({ kind, error: error.message, urlHost: safeHost(url) });
      stats.pdfEnqueued += 1;
    } else {
      stats.imageFailed = (stats.imageFailed || 0) + 1;
      if (!stats.imageErrors) stats.imageErrors = [];
      if (stats.imageErrors.length < 25) {
        stats.imageErrors.push({ kind, error: error.message, urlHost: safeHost(url) });
      }
    }
    return { filePath: existingLocalPath || storagePath || url, downloaded: false };
  }
}

async function maybeDownloadCert(opts) {
  return maybeDownloadMedia({ ...opts, isCert: true, defaultExt: '.pdf' });
}

async function fetchDeltas(auth, sinceIso, stats) {
  const fetched = {
    products: 0,
    customers: 0,
    siteCalibrations: 0,
    users: 0,
    vehicles: 0,
    docaCertificates: 0,
  };

  if (auth.mode === 'admin_sdk') {
    const admin = await tryExportViaAdminSdk([
      'products',
      'customers',
      'siteCalibrations',
      'users',
      'vehicles',
      'docaCertificates',
    ]);
    if (!admin) throw new Error('Admin SDK export failed');
    const filterSince = (docs, field = 'updatedAt') =>
      (docs || []).filter((d) => {
        const t = d[field] || d.createdAt;
        return t && String(t) >= sinceIso;
      });
    const products = filterSince(admin.collections.products) ;
    // products: sync all (small catalog) for safety
    const allProducts = admin.collections.products || [];
    const siteCalibrations = filterSince(admin.collections.siteCalibrations);
    const customersNeeded = new Set(
      siteCalibrations.map((d) => d.customerId).filter(Boolean),
    );
    const customers = (admin.collections.customers || []).filter(
      (d) => customersNeeded.has(d.id) || (d.updatedAt && String(d.updatedAt) >= sinceIso),
    );
    const users = (admin.collections.users || []).filter((d) =>
      ['super_admin', 'rc_admin', 'vct'].includes(d.role),
    );
    const vehicles = admin.collections.vehicles || [];
    const docaCertificates = filterSince(admin.collections.docaCertificates, 'scrapedAt');
    fetched.products = allProducts.length;
    fetched.customers = customers.length;
    fetched.siteCalibrations = siteCalibrations.length;
    fetched.users = users.length;
    fetched.vehicles = vehicles.length;
    fetched.docaCertificates = docaCertificates.length;
    stats.fetched = fetched;
    return {
      products: allProducts,
      customers,
      siteCalibrations,
      users,
      vehicles,
      docaCertificates,
    };
  }

  const idToken = auth.idToken;
  let siteCalibrations = [];
  try {
    siteCalibrations = await queryCollectionSince(idToken, 'siteCalibrations', {
      field: 'updatedAt',
      sinceIso,
      onPage: ({ soFar }) => {
        if (soFar % 300 === 0) process.stderr.write(`  siteCalibrations: ${soFar}\n`);
      },
    });
  } catch (error) {
    // Index may be missing for updatedAt+__name__; fall back to createdAt window via full list filter
    process.stderr.write(
      `  siteCalibrations query failed (${error.message}); falling back to list+filter\n`,
    );
    const all = await listCollection(idToken, 'siteCalibrations', {
      onPage: ({ soFar }) => {
        if (soFar % 900 === 0) process.stderr.write(`  siteCalibrations list: ${soFar}\n`);
      },
    });
    siteCalibrations = all.filter((d) => {
      const t = d.updatedAt || d.createdAt;
      return t && String(t) >= sinceIso;
    });
  }

  const products = await listCollection(idToken, 'products');
  const users = (await listCollection(idToken, 'users')).filter((d) =>
    ['super_admin', 'rc_admin', 'vct'].includes(d.role),
  );
  let vehicles = [];
  try {
    vehicles = await listCollection(idToken, 'vehicles');
  } catch (error) {
    process.stderr.write(`  vehicles skipped: ${error.message}\n`);
  }

  const customerIds = [...new Set(siteCalibrations.map((d) => d.customerId).filter(Boolean))];
  const customers = [];
  for (const cid of customerIds) {
    const doc = await fetchDocument(idToken, 'customers', cid);
    if (doc) customers.push(doc);
  }

  let docaCertificates = [];
  try {
    docaCertificates = await queryCollectionSince(idToken, 'docaCertificates', {
      field: 'updatedAt',
      sinceIso,
    });
  } catch {
    try {
      const all = await listCollection(idToken, 'docaCertificates');
      docaCertificates = all.filter((d) => {
        const t = d.updatedAt || d.scrapedAt || d.createdAt;
        return t && String(t) >= sinceIso;
      });
    } catch (error) {
      process.stderr.write(`  docaCertificates skipped: ${error.message}\n`);
    }
  }

  fetched.products = products.length;
  fetched.customers = customers.length;
  fetched.siteCalibrations = siteCalibrations.length;
  fetched.users = users.length;
  fetched.vehicles = vehicles.length;
  fetched.docaCertificates = docaCertificates.length;
  stats.fetched = fetched;

  return {
    products,
    customers,
    siteCalibrations,
    users,
    vehicles,
    docaCertificates,
  };
}

async function fetchProductsOnly(auth, stats) {
  const fetched = {
    products: 0,
    customers: 0,
    siteCalibrations: 0,
    users: 0,
    vehicles: 0,
    docaCertificates: 0,
  };
  if (auth.mode === 'admin_sdk') {
    const admin = await tryExportViaAdminSdk(['products']);
    if (!admin) throw new Error('Admin SDK export failed');
    const products = admin.collections.products || [];
    fetched.products = products.length;
    stats.fetched = fetched;
    return {
      products,
      customers: [],
      siteCalibrations: [],
      users: [],
      vehicles: [],
      docaCertificates: [],
    };
  }
  const products = await listCollection(auth.idToken, 'products');
  fetched.products = products.length;
  stats.fetched = fetched;
  return {
    products,
    customers: [],
    siteCalibrations: [],
    users: [],
    vehicles: [],
    docaCertificates: [],
  };
}

async function main() {
  const startedAt = Date.now();
  const dryRun = hasFlag('--dry-run');
  const downloadMode = (argValue('--download-media') || 'certs').toLowerCase();
  if (!['none', 'certs', 'images', 'all'].includes(downloadMode)) {
    throw new Error('--download-media must be none|certs|images|all');
  }
  const onlyMode = (argValue('--only') || '').toLowerCase();
  if (onlyMode && onlyMode !== 'products') {
    throw new Error('--only currently supports products');
  }
  const onlyProducts = onlyMode === 'products';
  const purgeOvMedia = hasFlag('--purge-ov-media');
  const trigger = argValue('--trigger') || 'cli';
  const sinceOverride = argValue('--since');

  const databaseUrl = process.env.DATABASE_URL || '';
  const dataRoot = process.env.DATA_ROOT || join(REPO_ROOT, 'data');
  const jwtSecret = process.env.JWT_SECRET || '';
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const { statusPath, lockPath } = statusPaths(dataRoot);
  acquireLock(lockPath);

  const prevStatus = readJson(statusPath) || {};
  writeJsonAtomic(statusPath, {
    ...prevStatus,
    running: true,
    lastStartedAt: new Date().toISOString(),
    lastError: null,
    trigger,
  });

  const stats = {
    ok: false,
    dryRun,
    trigger,
    projectId: PROJECT_ID,
    downloadMode: onlyProducts ? 'none' : downloadMode,
    only: onlyProducts ? 'products' : null,
    authMode: null,
    since: null,
    sinceSource: null,
    fetched: {},
    upserted: {
      productsInserted: 0,
      productsUpdated: 0,
      customersInserted: 0,
      customersUpdated: 0,
      verificationsInserted: 0,
      verificationsUpdated: 0,
      regionalCenters: 0,
      usersInserted: 0,
      usersUpdated: 0,
      vehiclesInserted: 0,
      vehiclesUpdated: 0,
      docaCertificates: 0,
    },
    skipped: {
      customersMissingRc: 0,
      verificationsMissingRc: 0,
      usersInvalidAadhaar: 0,
      vehiclesMissingRc: 0,
    },
    pdfDownloaded: 0,
    pdfFailed: 0,
    pdfEnqueued: 0,
    pdfErrors: [],
    imageDownloaded: 0,
    imageFailed: 0,
    imageErrors: [],
    purgeOvMedia,
    ovMediaPurge: null,
    errors: [],
  };

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const auth = await resolveAuth(dataRoot, jwtSecret);
    stats.authMode = auth.mode;
    process.stderr.write(`Auth mode: ${auth.mode}\n`);

    const sinceInfo = await resolveSince(client, statusPath, sinceOverride);
    stats.since = sinceInfo.since;
    stats.sinceSource = sinceInfo.source;
    process.stderr.write(`Since: ${stats.since} (${stats.sinceSource})\n`);

    if (dryRun) {
      stats.ok = true;
      stats.durationMs = Date.now() - startedAt;
      console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
      writeJsonAtomic(statusPath, {
        running: false,
        lastStartedAt: prevStatus.lastStartedAt || new Date().toISOString(),
        lastFinishedAt: new Date().toISOString(),
        lastSuccessAt: prevStatus.lastSuccessAt || null,
        lastError: null,
        lastRun: stats,
        trigger,
      });
      return;
    }

    process.stderr.write(
      onlyProducts ? 'Fetching products catalogue from yesgatc…\n' : 'Fetching deltas from yesgatc…\n',
    );
    const dump = onlyProducts
      ? await fetchProductsOnly(auth, stats)
      : await fetchDeltas(auth, stats.since, stats);
    process.stderr.write(
      `Fetched: verifications=${dump.siteCalibrations.length} products=${dump.products.length} customers=${dump.customers.length} users=${dump.users.length} vehicles=${dump.vehicles.length}\n`,
    );

    if (onlyProducts) {
      await client.query('BEGIN');
      try {
        for (const doc of dump.products) {
          const row = await upsertProduct(client, doc);
          if (row) {
            if (row.inserted) stats.upserted.productsInserted += 1;
            else stats.upserted.productsUpdated += 1;
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      stats.ok = true;
      stats.durationMs = Date.now() - startedAt;
      const finishedAt = new Date().toISOString();
      writeJsonAtomic(statusPath, {
        running: false,
        lastStartedAt: new Date(startedAt).toISOString(),
        lastFinishedAt: finishedAt,
        lastSuccessAt: finishedAt,
        lastError: null,
        lastRun: stats,
        trigger,
      });
      console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
      return;
    }

    // --- Users / RCs first (needed for FK maps) ---
    const seedPassword = process.env.IMPORT_PASSWORD || process.env.SEED_PASSWORD || '';
    let passwordHash = null;
    const newUserCandidates = dump.users.filter((u) => normalizeAadhaar(u.aadhar).length === 12);
    // Only hash if we might insert
    if (newUserCandidates.length && seedPassword.length >= 8) {
      passwordHash = await bcrypt.hash(seedPassword, 12);
    }

    await client.query('BEGIN');
    try {
      const rcAdmins = dump.users.filter((u) => u.role === 'rc_admin');
      const admins = dump.users.filter((u) => u.role === 'super_admin');
      const vcts = dump.users.filter((u) => u.role === 'vct');
      const rcByFirebaseLocal = new Map();

      for (const doc of rcAdmins) {
        const aadhaar = normalizeAadhaar(doc.aadhar);
        if (aadhaar.length !== 12) {
          stats.skipped.usersInvalidAadhaar += 1;
          continue;
        }
        const rc = await upsertRegionalCenter(client, doc);
        rcByFirebaseLocal.set(doc.uid || doc.id, rc.id);
        if (doc.rcId) rcByFirebaseLocal.set(doc.rcId, rc.id);
        stats.upserted.regionalCenters += 1;

        if (!passwordHash) {
          // Existing user update only — skip insert without password
          const exists = await client.query(
            `SELECT id FROM users WHERE aadhaar = $1 LIMIT 1`,
            [aadhaar],
          );
          if (!exists.rowCount) {
            stats.errors.push({
              entity: 'user',
              uid: doc.uid || doc.id,
              error: 'SEED_PASSWORD required to insert new RC_ADMIN',
            });
            continue;
          }
        }
        const row = await upsertUserPreservePassword(client, {
          aadhaar,
          username: doc.username || doc.companyName || doc.contactPerson || null,
          passwordHash: passwordHash || '!',
          role: 'RC_ADMIN',
          rcId: rc.id,
          phone: doc.phone,
          email: doc.email,
          address: doc.address,
          profile: buildProfile(doc),
          workflow: null,
          active: isActiveUser(doc),
        });
        if (row.inserted) stats.upserted.usersInserted += 1;
        else stats.upserted.usersUpdated += 1;
      }

      for (const doc of admins) {
        const aadhaar = normalizeAadhaar(doc.aadhar);
        if (aadhaar.length !== 12) {
          stats.skipped.usersInvalidAadhaar += 1;
          continue;
        }
        if (!passwordHash) {
          const exists = await client.query(
            `SELECT id FROM users WHERE aadhaar = $1 LIMIT 1`,
            [aadhaar],
          );
          if (!exists.rowCount) continue;
        }
        const row = await upsertUserPreservePassword(client, {
          aadhaar,
          username: doc.username || 'admin',
          passwordHash: passwordHash || '!',
          role: 'ADMIN',
          rcId: null,
          phone: doc.phone,
          email: doc.email,
          address: doc.address,
          profile: buildProfile(doc),
          workflow: null,
          active: isActiveUser(doc),
        });
        if (row.inserted) stats.upserted.usersInserted += 1;
        else stats.upserted.usersUpdated += 1;
      }

      // Refresh maps including newly upserted RCs
      const maps = await loadUidMaps(client);
      for (const [k, v] of rcByFirebaseLocal) maps.rcByFirebase.set(k, v);

      for (const doc of vcts) {
        const aadhaar = normalizeAadhaar(doc.aadhar);
        if (aadhaar.length !== 12) {
          stats.skipped.usersInvalidAadhaar += 1;
          continue;
        }
        const parent = doc.rcId || null;
        const rcId = parent
          ? maps.rcByFirebase.get(parent) || rcByFirebaseLocal.get(parent)
          : null;
        if (!rcId) continue;
        if (!passwordHash) {
          const exists = await client.query(
            `SELECT id FROM users WHERE aadhaar = $1 LIMIT 1`,
            [aadhaar],
          );
          if (!exists.rowCount) continue;
        }
        const row = await upsertUserPreservePassword(client, {
          aadhaar,
          username: doc.username || null,
          passwordHash: passwordHash || '!',
          role: 'VCT',
          rcId,
          phone: doc.phone,
          email: doc.email,
          address: doc.address,
          profile: buildProfile(doc),
          workflow: workflowMode(doc),
          active: isActiveUser(doc),
        });
        if (row.inserted) stats.upserted.usersInserted += 1;
        else stats.upserted.usersUpdated += 1;
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    const { userByFirebase, rcByFirebase } = await loadUidMaps(client);

    // --- Products ---
    await client.query('BEGIN');
    const productByFirebase = new Map();
    try {
      for (const doc of dump.products) {
        const row = await upsertProduct(client, doc);
        if (row) {
          productByFirebase.set(doc.id, row.id);
          if (row.inserted) stats.upserted.productsInserted += 1;
          else stats.upserted.productsUpdated += 1;
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    // --- Customers (referenced by delta verifications) ---
    await client.query('BEGIN');
    const customerByFirebase = new Map();
    try {
      for (const doc of dump.customers) {
        const rcId = rcByFirebase.get(doc.rcId);
        if (!rcId) {
          stats.skipped.customersMissingRc += 1;
          continue;
        }
        const createdBy = doc.createdByUid
          ? userByFirebase.get(doc.createdByUid)?.id || null
          : null;
        const row = await upsertCustomer(client, doc, rcId, createdBy);
        customerByFirebase.set(doc.id, row.id);
        if (row.inserted) stats.upserted.customersInserted += 1;
        else stats.upserted.customersUpdated += 1;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    // --- Verifications + media merge / PDF download ---
    for (const doc of dump.siteCalibrations) {
      const rcId = rcByFirebase.get(doc.rcId);
      if (!rcId) {
        stats.skipped.verificationsMissingRc += 1;
        continue;
      }
      let customerId = doc.customerId ? customerByFirebase.get(doc.customerId) || null : null;
      if (!customerId && doc.customerId) {
        const hit = await client.query(
          `SELECT id FROM customers WHERE source_firebase_id = $1 LIMIT 1`,
          [doc.customerId],
        );
        if (hit.rowCount) {
          customerId = hit.rows[0].id;
          customerByFirebase.set(doc.customerId, customerId);
        }
      }
      let productId = doc.productId ? productByFirebase.get(doc.productId) || null : null;
      if (!productId && doc.productId) {
        const hit = await client.query(
          `SELECT id FROM products WHERE source_firebase_id = $1 OR model_id = $1 LIMIT 1`,
          [doc.productId],
        );
        if (hit.rowCount) {
          productId = hit.rows[0].id;
          productByFirebase.set(doc.productId, productId);
        }
      }
      const performerUserId = doc.vctId
        ? userByFirebase.get(doc.vctId)?.id || null
        : null;
      const createdBy = doc.createdByUid
        ? userByFirebase.get(doc.createdByUid)?.id || null
        : null;

      // Load existing media locals before download decisions
      const existingVer = await client.query(
        `SELECT id FROM verifications WHERE source_firebase_id = $1 LIMIT 1`,
        [doc.id],
      );
      const existingMediaByKind = new Map();
      if (existingVer.rowCount) {
        const media = await client.query(
          `SELECT kind, file_path, source_url FROM verification_media WHERE verification_id = $1`,
          [existingVer.rows[0].id],
        );
        for (const m of media.rows) existingMediaByKind.set(m.kind, m);
      }

      const verType = String(doc.verificationType || doc.type || 'OV').toUpperCase();
      const certified = isVerificationCertified({
        status: doc.status,
        certifiedAt: doc.certifiedAt || doc.certificateIssuedAt,
      });

      const mediaRows = [];
      for (const spec of MEDIA_FIELDS) {
        const url = doc[spec.url];
        const storagePath = spec.path ? doc[spec.path] : null;
        if (!url && !storagePath) continue;
        const prev = existingMediaByKind.get(spec.kind);
        let filePath = prev?.file_path || storagePath || url || '';
        const relDir = join('media', 'yesgatc', 'siteCalibrations', doc.id);
        if (spec.cert && downloadMode !== 'none' && downloadMode !== 'images' && url) {
          const dl = await maybeDownloadCert({
            url,
            storagePath,
            contentType: spec.ct ? doc[spec.ct] : null,
            dataRoot,
            relDir,
            kind: spec.kind,
            mode: downloadMode === 'all' ? 'all' : 'certs',
            existingLocalPath: prev?.file_path,
            stats,
          });
          filePath = dl.filePath;
        } else if (
          !spec.cert &&
          isImageMediaKind(spec.kind) &&
          (downloadMode === 'all' || downloadMode === 'images') &&
          url &&
          shouldDownloadImageLocally({
            verificationType: verType,
            kind: spec.kind,
            certified,
          })
        ) {
          const dl = await maybeDownloadMedia({
            url,
            storagePath,
            contentType: spec.ct ? doc[spec.ct] : null,
            dataRoot,
            relDir,
            kind: spec.kind,
            mode: downloadMode,
            existingLocalPath: prev?.file_path,
            stats,
            isCert: false,
            defaultExt: '.jpg',
          });
          filePath = dl.filePath;
        } else if (isLocalMediaPath(prev?.file_path)) {
          filePath = prev.file_path;
        }
        mediaRows.push({
          kind: spec.kind,
          filePath,
          contentType: spec.ct ? doc[spec.ct] || null : null,
          sourceUrl: url || null,
          sourceStoragePath: storagePath || null,
        });
      }

      await client.query('BEGIN');
      try {
        const row = await upsertVerification(client, doc, {
          rcId,
          customerId,
          productId,
          performerUserId,
          createdBy,
        });
        if (row.inserted) stats.upserted.verificationsInserted += 1;
        else stats.upserted.verificationsUpdated += 1;
        if (mediaRows.length) {
          await mergeVerificationMedia(client, row.id, mediaRows);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        stats.errors.push({
          entity: 'verification',
          id: doc.id,
          error: error.message,
        });
      }
    }

    // --- Vehicles ---
    for (const doc of dump.vehicles) {
      const rcId = rcByFirebase.get(String(doc.rcId || ''));
      if (!rcId) {
        stats.skipped.vehiclesMissingRc += 1;
        continue;
      }
      try {
        const row = await upsertVehicle(client, doc, rcId);
        if (row.inserted) stats.upserted.vehiclesInserted += 1;
        else stats.upserted.vehiclesUpdated += 1;
      } catch (error) {
        stats.errors.push({ entity: 'vehicle', id: doc.id, error: error.message });
      }
    }

    // --- Wallets + RC quota (Super Admin pages; idempotent companion script) ---
    try {
      const { spawnSync } = await import('node:child_process');
      const walletScript = join(REPO_ROOT, 'scripts/sync-yesgatc-quota-car-wallet.mjs');
      if (existsSync(walletScript)) {
        process.stderr.write('Syncing wallets + RC quota…\n');
        const child = spawnSync(process.execPath, [walletScript], {
          cwd: REPO_ROOT,
          env: process.env,
          encoding: 'utf8',
          timeout: 180000,
        });
        if (child.status === 0) {
          try {
            stats.walletQuota = JSON.parse(child.stdout);
          } catch {
            stats.walletQuota = { ok: true };
          }
        } else {
          stats.errors.push({
            entity: 'wallet_quota',
            error: String(child.stderr || child.stdout || `exit ${child.status}`).slice(0, 500),
          });
        }
      }
    } catch (error) {
      stats.errors.push({ entity: 'wallet_quota', error: error.message });
    }

    // --- DOCA (optional) ---
    for (const doc of dump.docaCertificates) {
      try {
        await client.query(
          `INSERT INTO doca_certificates (
             source_firebase_id, gatc_certificate_no, instrument_name, machine_name,
             belong_to, validity_date, upload_date, scraped_at,
             certificate_pdf_path, certificate_pdf_url,
             instrument_photo_path, instrument_photo_url, details_json
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12,$13::jsonb)
           ON CONFLICT (source_firebase_id) DO UPDATE SET
             gatc_certificate_no = EXCLUDED.gatc_certificate_no,
             instrument_name = EXCLUDED.instrument_name,
             machine_name = EXCLUDED.machine_name,
             belong_to = EXCLUDED.belong_to,
             validity_date = EXCLUDED.validity_date,
             upload_date = EXCLUDED.upload_date,
             scraped_at = EXCLUDED.scraped_at,
             certificate_pdf_url = EXCLUDED.certificate_pdf_url,
             instrument_photo_url = EXCLUDED.instrument_photo_url,
             details_json = EXCLUDED.details_json,
             certificate_pdf_path = COALESCE(doca_certificates.certificate_pdf_path, EXCLUDED.certificate_pdf_path),
             instrument_photo_path = COALESCE(doca_certificates.instrument_photo_path, EXCLUDED.instrument_photo_path),
             updated_at = NOW()`,
          [
            doc.id,
            doc.gatcCertificateNo || null,
            doc.instrumentName || null,
            doc.machineName || null,
            doc.belongTo || null,
            doc.validityDate || null,
            doc.uploadDate || null,
            parseTsFixed(doc.scrapedAt),
            doc.certificatePdfPath || null,
            doc.certificatePdfUrl || null,
            doc.instrumentPhotoPath || null,
            doc.instrumentPhotoUrl || null,
            JSON.stringify({ ...doc, id: undefined }),
          ],
        );
        stats.upserted.docaCertificates += 1;
      } catch (error) {
        stats.errors.push({ entity: 'doca', id: doc.id, error: error.message });
      }
    }

    if (stats.pdfErrors.length > 20) {
      stats.pdfErrors = stats.pdfErrors.slice(0, 20);
      stats.pdfErrorsTruncated = true;
    }
    if (stats.imageErrors.length > 20) {
      stats.imageErrors = stats.imageErrors.slice(0, 20);
      stats.imageErrorsTruncated = true;
    }
    if (stats.errors.length > 30) {
      stats.errors = stats.errors.slice(0, 30);
      stats.errorsTruncated = true;
    }

    if (purgeOvMedia && !dryRun) {
      try {
        stats.ovMediaPurge = await purgeOvPostCertLocalImages({
          pool: client,
          dataRoot,
          dryRun: false,
        });
      } catch (error) {
        stats.errors.push({ entity: 'ov_media_purge', error: error.message });
      }
    }

    stats.ok = true;
    stats.durationMs = Date.now() - startedAt;
    const finishedAt = new Date().toISOString();
    writeJsonAtomic(statusPath, {
      running: false,
      lastStartedAt: new Date(startedAt).toISOString(),
      lastFinishedAt: finishedAt,
      lastSuccessAt: finishedAt,
      lastError: null,
      lastRun: stats,
      trigger,
    });
    console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
  } catch (error) {
    stats.ok = false;
    stats.durationMs = Date.now() - startedAt;
    stats.lastError = error.message;
    writeJsonAtomic(statusPath, {
      running: false,
      lastStartedAt: new Date(startedAt).toISOString(),
      lastFinishedAt: new Date().toISOString(),
      lastSuccessAt: prevStatus.lastSuccessAt || null,
      lastError: error.message,
      lastRun: stats,
      trigger,
    });
    console.error(JSON.stringify({ ok: false, error: error.message, ...stats }, null, 2));
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
    releaseLock(lockPath);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
