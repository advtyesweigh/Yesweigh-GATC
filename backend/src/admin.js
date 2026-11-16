import fs from 'node:fs';
import path from 'node:path';
import { checkDb } from './db.js';
import { createAuthMiddleware } from './auth.js';
import {
  getEmaapCredentialsStatus,
  saveEmaapCredentials,
} from './emaapCredentials.js';
import { getEmaapApiCatalog } from './emaapApiCatalog.js';
import {
  getYesoneCredentialsStatus,
  saveYesoneCredentials,
} from './yesoneCredentials.js';
import {
  readYesoneSyncStatus,
  publicYesoneSyncStatus,
  triggerYesoneSyncNow,
} from './yesoneSync.js';
import {
  getRazorpayCredentialsStatus,
  saveRazorpayCredentials,
  saveRazorpayWebhookSecret,
  bootstrapRazorpayFromEnv,
  resolveRazorpayWebhookUrl,
} from './razorpayCredentials.js';
import {
  createRazorpayTestOrder,
  verifyRazorpayPaymentSignature,
  razorpayTestLimits,
} from './razorpayPayments.js';
import { resolveRazorpayWebhookSecret } from './razorpayWebhook.js';
import {
  getZohoCredentialsStatus,
  updateZohoOrganizationId,
} from './zohoCredentials.js';
import {
  buildZohoAuthorizeUrl,
  completeZohoOAuthCallback,
  connectZohoWithRefreshToken,
  createOAuthState,
  disconnectZoho,
  ensureZohoOrganizationName,
  finalizeZohoOrgPick,
  getZohoPendingPick,
  oauthPopupResultHtml,
  zohoOAuthClientConfigured,
  zohoOAuthCompletePayload,
  zohoStatusOpts,
  resolveZohoRedirectUri,
} from './zohoOAuth.js';
import { hashPassword } from './passwords.js';
import {
  clearMediaStem,
  contentTypeForMediaPath,
  extForUpload,
  isLocalMediaPath,
  readSingleMultipartFile,
  removeLocalMediaFile,
  resolveSafeMediaPath,
  writeMediaFile,
} from './mediaStore.js';

const RC_CERT_METHODS = new Set(['auto_dsc', 'pdf_signer', 'manual_upload']);

/** RC media columns stored under DATA_ROOT/media/yesgatc/regionalCenters/<id>/ */
const RC_MEDIA_KINDS = Object.freeze({
  logo: { column: 'logo_url', stem: 'logo', label: 'Logo', accept: 'image', fallbackExt: '.png' },
  seal: { column: 'seal_url', stem: 'seal', label: 'Seal image', accept: 'image', fallbackExt: '.png' },
  standard_weights_cert: {
    column: 'standard_weights_cert_url',
    stem: 'standard_weights_cert',
    label: 'Std weights cert',
    accept: 'image_or_pdf',
    fallbackExt: '.pdf',
  },
  pan_card: {
    column: 'pan_card_url',
    stem: 'pan_card',
    label: 'PAN card image',
    accept: 'image',
    fallbackExt: '.jpg',
  },
  pdf_signer_sign: {
    column: 'pdf_signer_sign_url',
    stem: 'pdf_signer_sign',
    label: 'PDF signer signature',
    accept: 'image',
    fallbackExt: '.png',
  },
});

const PRODUCT_MEDIA_UPLOAD_KINDS = Object.freeze({
  image: {
    pathCol: 'image_path',
    urlCol: 'image_url',
    stem: 'image',
    label: 'Product image',
    accept: 'image',
    fallbackExt: '.jpg',
  },
  approval_doc: {
    pathCol: 'approval_doc_path',
    urlCol: 'approval_doc_url',
    stem: 'approval_doc',
    label: 'Approval document',
    accept: 'image_or_pdf',
    fallbackExt: '.pdf',
  },
});
/** Demo seed RC — already excluded from Super Admin RC lists. */
const DEMO_RC_CODE = 'DEMO-RC';
/** Known seed Aadhaar IDs from backend/src/seed.js (kept for local auth tests). */
const SEED_AADHAAR_IDS = ['999999999901', '999999999902', '999999999903'];

/**
 * SQL predicate: hide demo/seed users from Super Admin VCT list & dashboard.
 * Matches DEMO-RC assignment, seed Aadhaar set, or username seed_*.
 * Caller must alias users as `u` and left-join regional_centers as `rc`.
 */
function seedUserHiddenSql(params) {
  const aadhaarPh = SEED_AADHAAR_IDS.map((id) => {
    params.push(id);
    return `$${params.length}`;
  }).join(', ');
  params.push(DEMO_RC_CODE);
  const rcPh = `$${params.length}`;
  return `(
    COALESCE(rc.code, '') <> ${rcPh}
    AND u.aadhaar NOT IN (${aadhaarPh})
    AND u.username !~* '^seed_'
  )`;
}

function trimOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

function normalizeRcCodeInput(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 32);
}

function normalizeAadhaarDigits(raw) {
  return String(raw ?? '').replace(/\D/g, '');
}

function parseOptionalCoord(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** YesGATC: cert date + 1 year → YYYY-MM-DD */
function standardWeightsCertExpiryFromDate(certDate) {
  const raw = String(certDate || '').trim();
  if (!raw) return null;
  const d = new Date(`${raw.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function storedRcMediaValue(row, column, feesKeys = []) {
  const direct = typeof row?.[column] === 'string' ? row[column].trim() : '';
  if (direct) return direct;
  const fees = row?.fees_json && typeof row.fees_json === 'object' ? row.fees_json : {};
  for (const key of feesKeys) {
    const v = typeof fees[key] === 'string' ? fees[key].trim() : '';
    if (v) return v;
  }
  return null;
}

function rcMediaHttpUrl(rcId, kind, stored) {
  if (!rcId || !kind || !stored) return null;
  const value = String(stored).trim();
  if (!value) return null;
  if (isLocalMediaPath(value) || /^https?:\/\//i.test(value)) {
    return `/api/v1/admin/regional-centers/${encodeURIComponent(rcId)}/media?kind=${encodeURIComponent(kind)}`;
  }
  return value;
}

function rcMediaStorage(stored) {
  if (!stored) return null;
  if (isLocalMediaPath(stored)) return 'local';
  if (/^https?:\/\//i.test(String(stored))) return 'remote';
  return null;
}

function shapeAdminRcRow(row) {
  if (!row) return null;
  const fees = row.fees_json && typeof row.fees_json === 'object' ? row.fees_json : {};
  const place = row.place || null;
  const district = row.district || null;
  const state = row.state || null;
  const locationParts = [place, district, state].filter(Boolean);
  const location_label = locationParts.length
    ? locationParts.join(', ')
    : (row.pincode || (row.address ? String(row.address).split(/\n/)[0].trim() : '') || null);
  const logoStored = storedRcMediaValue(row, 'logo_url', ['logoUrl', 'logoURL', 'companyLogo', 'logo']);
  const sealStored = storedRcMediaValue(row, 'seal_url', ['sealUrl']);
  const certStored = storedRcMediaValue(row, 'standard_weights_cert_url', ['standardWeightsCertUrl']);
  const panStored = storedRcMediaValue(row, 'pan_card_url', ['panCardUrl']);
  const signStored = storedRcMediaValue(row, 'pdf_signer_sign_url', ['pdfSignerSignUrl']);
  return {
    id: row.id,
    code: row.code,
    name: row.name || row.company_name,
    company_name: row.company_name || row.name,
    contact_person: row.contact_person || null,
    phone: row.phone || null,
    email: row.email || null,
    address: row.address || null,
    place,
    district,
    state,
    pincode: row.pincode || null,
    location_label: location_label || null,
    location_lat: row.location_lat ?? null,
    location_lng: row.location_lng ?? null,
    gst_number: row.gst_number || null,
    pan_card: row.pan_card || null,
    zoho_customer_id: row.zoho_customer_id || null,
    zoho_expense_account_id: row.zoho_expense_account_id || null,
    zoho_expense_account_name: row.zoho_expense_account_name || null,
    certification_method: row.certification_method || null,
    seal_id: row.seal_id || row.laboratory_seal_identification || null,
    laboratory_seal_identification: row.seal_id || row.laboratory_seal_identification || null,
    standard_weights_cert_number: row.standard_weights_cert_number || null,
    standard_weights_cert_date: row.standard_weights_cert_date || null,
    standard_weights_cert_expiry: row.standard_weights_cert_expiry || null,
    logo_url: rcMediaHttpUrl(row.id, 'logo', logoStored),
    logo_path: isLocalMediaPath(logoStored) ? logoStored : null,
    logo_storage: rcMediaStorage(logoStored),
    seal_url: rcMediaHttpUrl(row.id, 'seal', sealStored),
    seal_path: isLocalMediaPath(sealStored) ? sealStored : null,
    seal_storage: rcMediaStorage(sealStored),
    standard_weights_cert_url: rcMediaHttpUrl(row.id, 'standard_weights_cert', certStored),
    standard_weights_cert_path: isLocalMediaPath(certStored) ? certStored : null,
    standard_weights_cert_storage: rcMediaStorage(certStored),
    pan_card_url: rcMediaHttpUrl(row.id, 'pan_card', panStored),
    pan_card_path: isLocalMediaPath(panStored) ? panStored : null,
    pan_card_storage: rcMediaStorage(panStored),
    pdf_signer_sign_url: rcMediaHttpUrl(row.id, 'pdf_signer_sign', signStored),
    pdf_signer_sign_path: isLocalMediaPath(signStored) ? signStored : null,
    pdf_signer_sign_storage: rcMediaStorage(signStored),
    pdf_signer_sign_scale:
      row.pdf_signer_sign_scale ?? parseOptionalNumber(fees.pdfSignerSignScale) ?? null,
    pdf_signer_sign_x:
      row.pdf_signer_sign_x ?? parseOptionalNumber(fees.pdfSignerSignX) ?? null,
    pdf_signer_sign_y:
      row.pdf_signer_sign_y ?? parseOptionalNumber(fees.pdfSignerSignY) ?? null,
    active: row.active !== false,
    firebase_uid: fees.firebaseUid || null,
    fees_structure: fees.feesStructure || null,
    verifications: Number(row.verifications) || 0,
    certified: Number(row.certified) || 0,
    /** Original Verification count (`verifications.verification_type = 'OV'`). */
    ov: Number(row.ov_count ?? row.ov) || 0,
    ov_count: Number(row.ov_count ?? row.ov) || 0,
    /** Re-verification count (`verifications.verification_type = 'RV'`). */
    rv: Number(row.rv_count ?? row.rv) || 0,
    rv_count: Number(row.rv_count ?? row.rv) || 0,
    /** Total jobs = all verifications for the RC (OV + RV + any other type). */
    total: Number(row.total ?? row.verifications) || 0,
    /** Active vehicles (`vehicles` table) — Super Admin RC list “Car” column. */
    car_count: Number(row.car_count ?? row.vehicle_count) || 0,
    vehicle_count: Number(row.car_count ?? row.vehicle_count) || 0,
    vct_count: Number(row.vct_count) || 0,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

const RC_SELECT_COLS = `rc.id, rc.code, rc.company_name, rc.company_name AS name,
  rc.contact_person, rc.phone, rc.email, rc.address, rc.place, rc.state, rc.district,
  rc.pincode, rc.location_lat, rc.location_lng, rc.gst_number, rc.pan_card,
  rc.zoho_customer_id, rc.zoho_expense_account_id, rc.zoho_expense_account_name,
  rc.certification_method, rc.laboratory_seal_identification AS seal_id,
  rc.standard_weights_cert_number, rc.standard_weights_cert_date,
  rc.standard_weights_cert_expiry, rc.logo_url, rc.seal_url,
  rc.standard_weights_cert_url, rc.pan_card_url, rc.pdf_signer_sign_url,
  rc.pdf_signer_sign_scale, rc.pdf_signer_sign_x, rc.pdf_signer_sign_y,
  rc.fees_json, rc.active, rc.created_at, rc.updated_at`;

/** Per-RC verification/VCT aggregates for list + detail shaping. */
const RC_STATS_SELECT = `(SELECT COUNT(*)::int FROM verifications v WHERE v.rc_id = rc.id) AS verifications,
                (SELECT COUNT(*)::int FROM verifications v
                  WHERE v.rc_id = rc.id
                    AND UPPER(COALESCE(v.verification_type, '')) = 'OV') AS ov_count,
                (SELECT COUNT(*)::int FROM verifications v
                  WHERE v.rc_id = rc.id
                    AND UPPER(COALESCE(v.verification_type, '')) = 'RV') AS rv_count,
                (SELECT COUNT(*)::int FROM verifications v WHERE v.rc_id = rc.id) AS total,
                (SELECT COUNT(*)::int FROM verifications v
                  WHERE v.rc_id = rc.id
                    AND (v.status = 'certified' OR v.certified_at IS NOT NULL)) AS certified,
                (SELECT COUNT(*)::int FROM vehicles veh
                  WHERE veh.rc_id = rc.id AND veh.active) AS car_count,
                (SELECT COUNT(*)::int FROM users u
                  WHERE u.rc_id = rc.id AND u.role = 'VCT' AND u.active) AS vct_count`;

const RC_STATS_ZERO = `0 AS verifications, 0 AS ov_count, 0 AS rv_count, 0 AS total, 0 AS certified, 0 AS car_count, 0 AS vct_count`;

function readRcBody(body = {}) {
  const certificationMethod = trimOrNull(body.certification_method || body.certificationMethod);
  if (certificationMethod && !RC_CERT_METHODS.has(certificationMethod)) {
    return { error: { code: 'VALIDATION', message: 'Invalid certification_method' } };
  }
  const certDate = trimOrNull(
    body.standard_weights_cert_date || body.standardWeightsCertDate,
  );
  let certExpiry = trimOrNull(
    body.standard_weights_cert_expiry || body.standardWeightsCertExpiry,
  );
  if (!certExpiry && certDate) {
    certExpiry = standardWeightsCertExpiryFromDate(certDate);
  }
  return {
    company_name: trimOrNull(body.company_name || body.companyName || body.name),
    contact_person: trimOrNull(body.contact_person || body.contactPerson),
    phone: trimOrNull(body.phone)?.replace(/\D/g, '').slice(0, 15) || null,
    email: trimOrNull(body.email),
    address: trimOrNull(body.address),
    place: trimOrNull(body.place),
    state: trimOrNull(body.state),
    district: trimOrNull(body.district),
    pincode: trimOrNull(body.pincode)?.replace(/\D/g, '').slice(0, 6) || null,
    location_lat: parseOptionalCoord(body.location_lat ?? body.latitude ?? body.location?.lat),
    location_lng: parseOptionalCoord(body.location_lng ?? body.longitude ?? body.location?.lng),
    gst_number: trimOrNull(body.gst_number || body.gstNumber),
    pan_card: trimOrNull(body.pan_card || body.panCard)?.toUpperCase() || null,
    zoho_customer_id: trimOrNull(body.zoho_customer_id || body.zohoId || body.zoho_id)?.replace(/\D/g, '') || null,
    zoho_expense_account_id: trimOrNull(
      body.zoho_expense_account_id || body.zohoExpenseAccountId,
    )?.replace(/\D/g, '') || null,
    zoho_expense_account_name: trimOrNull(
      body.zoho_expense_account_name || body.zohoExpenseAccountName,
    ),
    certification_method: certificationMethod,
    laboratory_seal_identification: trimOrNull(
      body.laboratory_seal_identification || body.seal_id || body.sealId,
    ),
    standard_weights_cert_number: trimOrNull(
      body.standard_weights_cert_number || body.standardWeightsCertNumber,
    ),
    standard_weights_cert_date: certDate,
    standard_weights_cert_expiry: certExpiry,
    // Media columns are updated via /regional-centers/:id/media upload/clear,
    // not via paste-Firebase URL fields on the entity form.
    logo_url: undefined,
    seal_url: undefined,
    standard_weights_cert_url: undefined,
    pan_card_url: undefined,
    pdf_signer_sign_url: undefined,
    pdf_signer_sign_scale: parseOptionalNumber(
      body.pdf_signer_sign_scale ?? body.pdfSignerSignScale,
    ),
    pdf_signer_sign_x: parseOptionalNumber(
      body.pdf_signer_sign_x ?? body.pdfSignerSignX,
    ),
    pdf_signer_sign_y: parseOptionalNumber(
      body.pdf_signer_sign_y ?? body.pdfSignerSignY,
    ),
    active: body.active == null ? undefined : Boolean(body.active),
  };
}

function requireDb(res, pool, config) {
  if (!pool || !config.databaseUrl) {
    res.status(503).json({
      error: { code: 'DB_UNCONFIGURED', message: 'Database is not configured' },
    });
    return false;
  }
  return true;
}

function parsePaging(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limit = Math.min(maxLimit, Math.max(1, Number(query.limit) || defaultLimit));
  const page = Number(query.page);
  if (Number.isFinite(page) && page >= 1 && (query.offset == null || query.offset === '')) {
    return { limit, offset: (page - 1) * limit };
  }
  const offset = Math.max(0, Number(query.offset) || 0);
  return { limit, offset };
}

function pickHttpUrl(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
    }
  }
  return null;
}

function logoFromFees(fees) {
  const f = fees && typeof fees === 'object' ? fees : {};
  return pickHttpUrl(f.logoUrl, f.logoURL, f.companyLogo, f.logo);
}

function photoFromProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  return pickHttpUrl(
    p.profilePhotoUrl,
    p.photoUrl,
    p.photoURL,
    p.profileImageUrl,
    p.imageUrl,
    p.avatarUrl,
  );
}

function parseDashboardPeriod(periodRaw) {
  const period = String(periodRaw || 'month').toLowerCase();
  const now = new Date();
  let since = null;
  if (period === 'today') {
    since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === 'week' || period === '7d') {
    since = new Date(now.getTime() - 7 * 86400000);
  } else if (period === 'month' || period === '30d') {
    since = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (period === 'quarter' || period === 'qtr') {
    const q = Math.floor(now.getMonth() / 3) * 3;
    since = new Date(now.getFullYear(), q, 1);
  } else if (period === 'year') {
    since = new Date(now.getFullYear(), 0, 1);
  }
  // 'all' / 'lifetime' / 'custom' → since null (full history)
  return { period, since, now };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstFiniteNumber(...candidates) {
  for (const value of candidates) {
    if (value == null || value === '') continue;
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstNonEmptyString(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function formatMaxCapacity(max, unit) {
  if (max == null) return null;
  const u = firstNonEmptyString(unit) || 'kg';
  return `${max} ${u}`;
}

function formatMinCapacity(min) {
  if (min == null || min === 0) return null;
  const rounded = Math.round(min * 1e6) / 1e6;
  return `${rounded} g`;
}

/**
 * Media retention (VPS): see scripts/lib/media-retention.mjs
 * OV post-cert keeps only scale_image (+ PDFs); RV keeps all images; PDFs always.
 * SA list thumbnails use the kept scale/product image via local media API when present.
 */
const ADMIN_IMAGE_MEDIA_KINDS = new Set([
  'scale_image',
  'instrument_rear',
  'stamping',
  'standard_weight',
  'verification_seal',
  'installation',
  'performer_selfie_id',
  'performer_id_aadhaar',
  'old_invoice',
]);

/** Display order + labels for SA image gallery. */
const ADMIN_IMAGE_GALLERY_ORDER = [
  'scale_image',
  'stamping',
  'standard_weight',
  'instrument_rear',
  'verification_seal',
  'installation',
  'performer_selfie_id',
  'performer_id_aadhaar',
  'old_invoice',
];

const ADMIN_IMAGE_KIND_LABELS = {
  scale_image: 'Scale',
  instrument_rear: 'Rear',
  stamping: 'Stamping',
  standard_weight: 'Weight',
  verification_seal: 'Seal',
  installation: 'Installation',
  performer_selfie_id: 'Selfie ID',
  performer_id_aadhaar: 'Aadhaar',
  old_invoice: 'Old invoice',
};

function imageKindLabel(kind) {
  const k = String(kind || '');
  return ADMIN_IMAGE_KIND_LABELS[k] || k.replace(/_/g, ' ') || 'Image';
}

/**
 * Same-origin media API URL when we can serve/redirect via admin media routes.
 * Prefer this over raw Firebase URLs so <img> uses access_token and local disk when present.
 */
function mediaHttpUrl(sourceUrl, filePath, { verificationId, kind } = {}) {
  const remote = pickHttpUrl(sourceUrl, filePath);
  const local = isLocalMediaPath(filePath);
  if (verificationId && kind && (local || remote)) {
    const q = new URLSearchParams({ kind: String(kind) });
    const endpoint =
      ADMIN_IMAGE_MEDIA_KINDS.has(String(kind))
        ? `/api/v1/admin/verifications/${verificationId}/media`
        : `/api/v1/admin/verifications/${verificationId}/pdf`;
    return `${endpoint}?${q.toString()}`;
  }
  if (local && verificationId) {
    return `/api/v1/admin/verifications/${verificationId}/pdf`;
  }
  return remote;
}

/** Prefer sibling `name.thumb.jpg` (from scripts/generate-media-thumbs.mjs) for list rows. */
function resolveMediaAbsWithThumb(dataRoot, relPath, { thumb = false } = {}) {
  const abs = resolveSafeMediaPath(dataRoot, relPath);
  if (!abs || !fs.existsSync(abs)) return abs;
  if (!thumb) return abs;
  const ext = path.extname(abs);
  const thumbAbs = `${abs.slice(0, abs.length - ext.length)}.thumb.jpg`;
  if (fs.existsSync(thumbAbs)) return thumbAbs;
  return abs;
}

/** Sanitize certificate/application/GATC number for Content-Disposition filename. */
function pdfDownloadFileName({ certificateNumber, applicationNumber, fallbackId } = {}) {
  const raw = firstNonEmptyString(certificateNumber, applicationNumber, fallbackId) || 'certificate';
  let base = String(raw)
    .trim()
    .replace(/\.pdf$/i, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[\s._-]+|[\s._-]+$/g, '');
  if (!base) base = 'certificate';
  // Cap length for common FS limits while keeping the meaningful tail (cert suffix).
  if (base.length > 180) base = base.slice(-180);
  return `${base}.pdf`;
}

function newProductSpecId(index = 0) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `spec-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
}

/** YesGATC parity: Min = e×20, d = e, n = Max×1000÷e (Max in kg, e in g). */
function computeProductDerived(maximumCapacity, verificationScaleInterval) {
  const max = Number(maximumCapacity) || 0;
  const e = Number(verificationScaleInterval) || 0;
  return {
    minimumCapacity: e * 20,
    actualScaleInterval: e,
    noOfVerificationIntervals: e > 0 ? (max * 1000) / e : 0,
  };
}

/**
 * Normalize one capacity/spec row to YesGATC camelCase shape.
 * Returns null when Max/e are missing or non-positive.
 */
function normalizeProductSpecification(raw, index = 0) {
  const s = asObject(raw);
  const max = firstFiniteNumber(s.maximumCapacity, s.maximum_capacity, s.max);
  const e = firstFiniteNumber(
    s.verificationScaleInterval,
    s.verification_scale_interval,
    s.e,
  );
  if (max == null || max <= 0 || e == null || e <= 0) return null;
  const derived = computeProductDerived(max, e);
  const mpe = firstFiniteNumber(
    s.maximumPermissibleError,
    s.maximum_permissible_error,
    s.mpe,
  );
  return {
    id: firstNonEmptyString(s.id, `spec-${index + 1}`) || newProductSpecId(index),
    maximumCapacity: max,
    verificationScaleInterval: e,
    maximumPermissibleError: mpe != null ? mpe : 0,
    minimumCapacity:
      firstFiniteNumber(s.minimumCapacity, s.minimum_capacity, s.min)
      ?? derived.minimumCapacity,
    actualScaleInterval:
      firstFiniteNumber(s.actualScaleInterval, s.actual_scale_interval, s.d)
      ?? derived.actualScaleInterval,
    noOfVerificationIntervals:
      firstFiniteNumber(s.noOfVerificationIntervals, s.no_of_verification_intervals, s.n)
      ?? derived.noOfVerificationIntervals,
  };
}

function applySpecificationsToCapacities(caps, specifications) {
  const next = { ...asObject(caps) };
  if (!Array.isArray(specifications) || !specifications.length) {
    delete next.specifications;
    return next;
  }
  const primary = specifications[0];
  next.specifications = specifications;
  next.maximumCapacity = primary.maximumCapacity;
  next.verificationScaleInterval = primary.verificationScaleInterval;
  next.maximumPermissibleError = primary.maximumPermissibleError;
  next.minimumCapacity = primary.minimumCapacity;
  next.actualScaleInterval = primary.actualScaleInterval;
  next.noOfVerificationIntervals = primary.noOfVerificationIntervals;
  return next;
}

function productSpecRowsFromCapacities(capacities) {
  const caps = asObject(capacities);
  const specs = Array.isArray(caps.specifications) ? caps.specifications : [];
  const normalized = specs
    .map((spec, index) => normalizeProductSpecification(spec, index))
    .filter(Boolean);
  if (normalized.length) {
    return normalized.map((s) => ({
      id: s.id,
      maximum_capacity: s.maximumCapacity,
      verification_scale_interval: s.verificationScaleInterval,
      maximum_permissible_error: s.maximumPermissibleError,
      minimum_capacity: s.minimumCapacity,
      actual_scale_interval: s.actualScaleInterval,
      no_of_verification_intervals: s.noOfVerificationIntervals,
    }));
  }
  const legacy = normalizeProductSpecification({
    id: 'primary',
    maximumCapacity: firstFiniteNumber(caps.maximumCapacity),
    verificationScaleInterval: firstFiniteNumber(caps.verificationScaleInterval),
    maximumPermissibleError: firstFiniteNumber(caps.maximumPermissibleError),
    minimumCapacity: firstFiniteNumber(caps.minimumCapacity),
    actualScaleInterval: firstFiniteNumber(caps.actualScaleInterval),
    noOfVerificationIntervals: firstFiniteNumber(caps.noOfVerificationIntervals),
  }, 0);
  if (legacy) {
    return [{
      id: legacy.id,
      maximum_capacity: legacy.maximumCapacity,
      verification_scale_interval: legacy.verificationScaleInterval,
      maximum_permissible_error: legacy.maximumPermissibleError,
      minimum_capacity: legacy.minimumCapacity,
      actual_scale_interval: legacy.actualScaleInterval,
      no_of_verification_intervals: legacy.noOfVerificationIntervals,
    }];
  }
  return [{
    id: 'primary',
    maximum_capacity: firstFiniteNumber(caps.maximumCapacity),
    verification_scale_interval: firstFiniteNumber(caps.verificationScaleInterval),
    maximum_permissible_error: firstFiniteNumber(caps.maximumPermissibleError),
    minimum_capacity: firstFiniteNumber(caps.minimumCapacity),
    actual_scale_interval: firstFiniteNumber(caps.actualScaleInterval),
    no_of_verification_intervals: firstFiniteNumber(caps.noOfVerificationIntervals),
  }];
}

/**
 * Prefer same-origin product media API when local disk path exists under media/yesgatc/;
 * else Firebase/http download URL. Mirrors verification mediaHttpUrl behaviour.
 */
function productMediaHttpUrl(productId, kind, filePath, sourceUrl, { thumb = false } = {}) {
  const remote = pickHttpUrl(sourceUrl, filePath);
  const local = isLocalMediaPath(filePath);
  if (productId && kind && (local || remote)) {
    const q = new URLSearchParams({ kind: String(kind) });
    if (thumb) q.set('variant', 'thumb');
    return `/api/v1/admin/products/${productId}/media?${q.toString()}`;
  }
  return remote;
}

function shapeAdminProductRow(row) {
  const capacities = asObject(row.capacities);
  const specs = productSpecRowsFromCapacities(capacities);
  const primary = specs[0] || {};
  const imageUrl = productMediaHttpUrl(row.id, 'image', row.image_path, row.image_url);
  const imageThumbUrl = productMediaHttpUrl(row.id, 'image', row.image_path, row.image_url, {
    thumb: true,
  });
  const approvalDocUrl = productMediaHttpUrl(
    row.id,
    'approval_doc',
    row.approval_doc_path,
    row.approval_doc_url,
  );
  const rawImageUrl = pickHttpUrl(row.image_url) || (typeof row.image_url === 'string' ? row.image_url.trim() : null);
  const rawApprovalDocUrl = pickHttpUrl(row.approval_doc_url)
    || (typeof row.approval_doc_url === 'string' ? row.approval_doc_url.trim() : null);
  return {
    id: row.id,
    model_id: row.model_id,
    model_no: row.model_no,
    name: row.name,
    yesone_sku: firstNonEmptyString(capacities.yesoneSku, row.yesone_sku),
    type_of_instrument: row.type_of_instrument,
    manufacturer_brand_series: row.manufacturer_brand_series,
    accuracy_class: row.accuracy_class,
    unit_of_measurement: row.unit_of_measurement,
    model_approval_no: row.model_approval_no,
    supply_voltage: row.supply_voltage,
    pas_pre_allotted: Boolean(row.pas_pre_allotted),
    serial_pool: row.pas_pre_allotted ? 'PAS' : 'GAS',
    active: Boolean(row.active),
    sort_order: row.sort_order,
    capacities,
    specifications: specs,
    maximum_capacity: primary.maximum_capacity ?? null,
    verification_scale_interval: primary.verification_scale_interval ?? null,
    maximum_permissible_error: primary.maximum_permissible_error ?? null,
    minimum_capacity: primary.minimum_capacity ?? null,
    actual_scale_interval: primary.actual_scale_interval ?? null,
    no_of_verification_intervals: primary.no_of_verification_intervals ?? null,
    image_path: row.image_path || null,
    image_url: imageUrl,
    image_source_url: rawImageUrl || null,
    image_thumb_url: imageThumbUrl || imageUrl,
    image_storage: isLocalMediaPath(row.image_path) ? 'local' : (imageUrl ? 'remote' : null),
    approval_doc_path: row.approval_doc_path || null,
    approval_doc_url: approvalDocUrl,
    approval_doc_source_url: rawApprovalDocUrl || null,
    approval_doc_storage: isLocalMediaPath(row.approval_doc_path)
      ? 'local'
      : (approvalDocUrl ? 'remote' : null),
    source_firebase_id: row.source_firebase_id || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function userDocMediaUrl(userId, kind, localPath, remoteUrl) {
  const local = isLocalMediaPath(localPath);
  const remote = pickHttpUrl(remoteUrl);
  if (userId && kind && (local || remote)) {
    const q = new URLSearchParams({ kind: String(kind) });
    return `/api/v1/admin/users/${encodeURIComponent(userId)}/media?${q.toString()}`;
  }
  return remote;
}

function shapeAdminUserRow(row, { includeProfile = false } = {}) {
  const profile = asObject(row.profile_json);
  const photoLocal = firstNonEmptyString(profile.profilePhotoLocalPath);
  const photoRemote = photoFromProfile(profile);
  const photoUrl = userDocMediaUrl(row.id, 'profile', photoLocal, photoRemote);
  const photoThumbUrl = photoUrl
    ? `${photoUrl}${photoUrl.includes('?') ? '&' : '?'}variant=thumb`
    : null;
  const docs = {
    aadhaar_url: userDocMediaUrl(row.id, 'aadhaar', profile.aadharDocLocalPath, profile.aadharDocUrl),
    biodata_url: userDocMediaUrl(
      row.id,
      'biodata',
      profile.biodataDocLocalPath,
      profile.biodataDocUrl,
    ),
    education_url: userDocMediaUrl(
      row.id,
      'education',
      profile.educationCertDocLocalPath,
      profile.educationCertDocUrl,
    ),
    pcc_url: userDocMediaUrl(row.id, 'pcc', profile.pccDocLocalPath, profile.pccDocUrl),
  };
  const out = {
    id: row.id,
    aadhaar: row.aadhaar,
    username: row.username,
    role: row.role,
    phone: row.phone,
    email: row.email,
    address: row.address || null,
    active: Boolean(row.active),
    workflow_mode: row.workflow_mode,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    rc_id: row.rc_id || null,
    rc_code: row.rc_code || null,
    rc_name: row.rc_name || null,
    photo_url: photoUrl,
    photo_thumb_url: photoThumbUrl || photoUrl,
    photo_path: isLocalMediaPath(photoLocal) ? photoLocal : null,
    photo_storage: isLocalMediaPath(photoLocal) ? 'local' : (photoUrl ? 'remote' : null),
    approval_status: firstNonEmptyString(profile.approvalStatus) || null,
    blood_group: firstNonEmptyString(profile.bloodGroup) || null,
    police_station: firstNonEmptyString(profile.policeStation) || null,
    pincode: firstNonEmptyString(profile.pincode) || null,
    secondary_contact_name: firstNonEmptyString(profile.secondaryContactName) || null,
    secondary_contact_relationship:
      firstNonEmptyString(profile.secondaryContactRelationship) || null,
    secondary_contact_phone: firstNonEmptyString(profile.secondaryContactPhone) || null,
    approved_at: profile.approvedAt || null,
    firebase_uid: firstNonEmptyString(profile.firebaseUid) || null,
    docs,
  };
  if (includeProfile) out.profile = profile;
  return out;
}

function shapeAdminVerificationRow(row) {
  const snap = asObject(row.product_snapshot);
  const details = asObject(row.details_json);
  const capacities = asObject(row.product_capacities);
  const profile = asObject(row.performer_profile);

  const max = firstFiniteNumber(
    snap.maximumCapacity,
    details.maximumCapacity,
    capacities.maximumCapacity,
  );
  const min = firstFiniteNumber(
    snap.minimumCapacity,
    details.minimumCapacity,
    capacities.minimumCapacity,
  );
  const unit = firstNonEmptyString(
    snap.unitOfMeasurement,
    details.unitOfMeasurement,
    row.product_unit,
  );
  const accuracyClass = firstNonEmptyString(
    snap.accuracyClass,
    details.accuracyClass,
    row.product_accuracy_class,
  );
  const vctName = firstNonEmptyString(
    details.vctName,
    profile.displayName,
    profile.fullName,
    profile.name,
    row.performer_username,
    row.performed_by && row.performed_by.toLowerCase() !== 'vct' ? row.performed_by : null,
  );
  const signedPdfUrl = mediaHttpUrl(row.signed_pdf_source_url, row.signed_pdf_file_path, {
    verificationId: row.id,
    kind: 'signed',
  });
  const certificatePdfUrl = mediaHttpUrl(row.cert_pdf_source_url, row.cert_pdf_file_path, {
    verificationId: row.id,
    kind: 'certificate',
  });
  const downloadUrl = signedPdfUrl || certificatePdfUrl;
  const pdfStorage =
    isLocalMediaPath(row.signed_pdf_file_path) || isLocalMediaPath(row.cert_pdf_file_path)
      ? 'local'
      : downloadUrl
        ? 'remote'
        : null;
  // Scale/product thumb for all statuses (submitted/draft/pending_rc/certified…).
  // Prefer same-origin media API (local file or Firebase redirect); catalog path last.
  const productImageUrl =
    mediaHttpUrl(row.scale_image_source_url, row.scale_image_file_path, {
      verificationId: row.id,
      kind: 'scale_image',
    })
    || pickHttpUrl(row.product_image_path);
  const status = String(row.status || '');
  const statusLabel =
    status.toLowerCase() === 'certified' || status.toLowerCase() === 'approved'
      ? 'Verified'
      : status || null;

  return {
    id: row.id,
    application_number: row.application_number,
    certificate_number: row.certificate_number,
    reference: firstNonEmptyString(row.certificate_number, row.application_number),
    verification_type: row.verification_type,
    job_kind: row.job_kind,
    status: row.status,
    status_label: statusLabel,
    customer_name: row.customer_name,
    serial_number: row.serial_number,
    max_capacity: max,
    min_capacity: min,
    unit_of_measurement: unit,
    max_display: formatMaxCapacity(max, unit),
    min_display: formatMinCapacity(min),
    accuracy_class: accuracyClass,
    product_name: firstNonEmptyString(snap.productName, row.product_name),
    product_image_url: productImageUrl,
    rc_code: row.rc_code,
    rc_name: row.rc_name,
    rc_district: row.rc_district,
    vct_name: vctName,
    performed_by: row.performed_by,
    submitted_at: row.submitted_at,
    certified_at: row.certified_at,
    created_at: row.created_at,
    has_signed_pdf: Boolean(signedPdfUrl),
    signed_pdf_url: signedPdfUrl,
    certificate_pdf_url: certificatePdfUrl,
    download_url: downloadUrl,
    pdf_storage: pdfStorage,
  };
}

/**
 * Super Admin ops + list routes (ADMIN role only).
 */
export function mountAdminRoutes(app, { config, pool, logger, startedAt = new Date() }) {
  const { requireAuth, requireRole } = createAuthMiddleware({ config, pool, logger });
  const adminOnly = [requireAuth, requireRole('ADMIN')];

  app.get('/api/v1/admin/ops-status', ...adminOnly, async (_req, res) => {
    let dbState = 'unconfigured';
    if (config.databaseUrl) {
      try {
        const db = await checkDb(pool);
        dbState = db.ok ? 'up' : 'down';
      } catch (error) {
        dbState = 'down';
        logger.warn?.('Admin ops DB check failed', { error: error.message });
      }
    }

    const uptimeSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
    const dbOnline = dbState === 'up';
    const systemHealthy = dbState === 'up' || dbState === 'unconfigured';

    return res.json({
      data: {
        checkedAt: new Date().toISOString(),
        system: {
          healthy: systemHealthy,
          label: systemHealthy ? 'System Healthy' : 'System Degraded',
          uptimeSeconds,
          uptimePercent: null,
        },
        services: {
          api: {
            id: 'api',
            name: 'API',
            status: 'online',
            label: 'Online',
            online: true,
          },
          db: {
            id: 'db',
            name: 'DB',
            status: dbOnline ? 'online' : dbState === 'unconfigured' ? 'unknown' : 'offline',
            label: dbOnline ? 'Online' : dbState === 'unconfigured' ? 'Unconfigured' : 'Offline',
            online: dbOnline,
          },
        },
      },
    });
  });

  app.get('/api/v1/admin/dashboard', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;

    const { period, since, now } = parseDashboardPeriod(req.query.period);

    try {
      const params = [];
      const stamp = 'COALESCE(v.certified_at, v.submitted_at, v.created_at)';
      const sinceClause = since
        ? (params.push(since.toISOString()), `AND ${stamp} >= $1::timestamptz`)
        : '';

      const typeRows = await pool.query(
        `SELECT verification_type AS type, COUNT(*)::int AS count
         FROM verifications v
         WHERE 1=1 ${sinceClause}
         GROUP BY verification_type`,
        params,
      );
      const statusRows = await pool.query(
        `SELECT status, COUNT(*)::int AS count
         FROM verifications v
         WHERE 1=1 ${sinceClause}
         GROUP BY status`,
        params,
      );

      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
      const certifiedMonths = await pool.query(
        `SELECT
           COUNT(*) FILTER (
             WHERE status = 'certified'
               AND COALESCE(certified_at, submitted_at, created_at) >= $1::timestamptz
           )::int AS this_month,
           COUNT(*) FILTER (
             WHERE status = 'certified'
               AND COALESCE(certified_at, submitted_at, created_at) >= $2::timestamptz
               AND COALESCE(certified_at, submitted_at, created_at) < $1::timestamptz
           )::int AS last_month,
           COUNT(*) FILTER (WHERE status = 'certified' OR certified_at IS NOT NULL)::int AS lifetime
         FROM verifications`,
        [monthStart, prevMonthStart],
      );

      const rcParams = [...params];
      const rcRows = await pool.query(
        `SELECT rc.id, rc.code, rc.company_name AS name, rc.district, rc.state, rc.fees_json,
                rc.logo_url,
                COUNT(v.id) FILTER (
                  WHERE (v.status = 'certified' OR v.certified_at IS NOT NULL)
                  ${sinceClause}
                )::int AS certified
         FROM regional_centers rc
         LEFT JOIN verifications v ON v.rc_id = rc.id
         WHERE rc.active = TRUE AND rc.code <> 'DEMO-RC'
         GROUP BY rc.id
         ORDER BY certified DESC, rc.company_name ASC`,
        rcParams,
      );

      const vctParams = [...params];
      const seedHidden = seedUserHiddenSql(vctParams);
      const vctRows = await pool.query(
        `SELECT u.id, u.username AS name, u.aadhaar, u.profile_json,
                rc.code AS rc_code, rc.company_name AS rc_name,
                COUNT(v.id) FILTER (
                  WHERE (v.status = 'certified' OR v.certified_at IS NOT NULL)
                  ${sinceClause}
                )::int AS certified
         FROM users u
         LEFT JOIN regional_centers rc ON rc.id = u.rc_id
         LEFT JOIN verifications v ON v.performer_user_id = u.id
         WHERE u.role = 'VCT' AND u.active = TRUE AND ${seedHidden}
         GROUP BY u.id, rc.id
         ORDER BY certified DESC, u.username ASC NULLS LAST`,
        vctParams,
      );

      const trendSince = since
        || new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
      const trendRows = await pool.query(
        `SELECT date_trunc('day', COALESCE(certified_at, submitted_at, created_at))::date AS day,
                COUNT(*) FILTER (WHERE status = 'certified' OR certified_at IS NOT NULL)::int AS certified
         FROM verifications
         WHERE COALESCE(certified_at, submitted_at, created_at) >= $1::timestamptz
         GROUP BY 1
         ORDER BY 1 ASC`,
        [trendSince.toISOString()],
      );

      const countParams = [];
      const seedHiddenCount = seedUserHiddenSql(countParams);
      const counts = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM regional_centers WHERE active AND code <> 'DEMO-RC') AS regional_centers,
           (SELECT COUNT(*)::int
              FROM users u
              LEFT JOIN regional_centers rc ON rc.id = u.rc_id
             WHERE u.role = 'VCT' AND u.active AND ${seedHiddenCount}) AS vct,
           (SELECT COUNT(*)::int FROM products WHERE active AND model_id <> 'SEED-MODEL-001') AS products,
           (SELECT COUNT(*)::int FROM customers) AS customers,
           (SELECT COUNT(*)::int FROM verifications) AS verifications`,
        countParams,
      );

      const byType = { OV: 0, RV: 0 };
      for (const row of typeRows.rows) {
        const key = String(row.type || '').toUpperCase();
        if (key === 'OV' || key === 'RV') byType[key] = row.count;
      }
      const byStatus = {};
      for (const row of statusRows.rows) {
        byStatus[row.status] = row.count;
      }

      const regionalCenters = rcRows.rows.map((row) => {
        const { fees_json, logo_url, ...rest } = row;
        const logoStored = storedRcMediaValue(
          { logo_url, fees_json },
          'logo_url',
          ['logoUrl', 'logoURL', 'companyLogo', 'logo'],
        );
        return {
          ...rest,
          logoUrl: rcMediaHttpUrl(row.id, 'logo', logoStored) || logoFromFees(fees_json),
          logoPath: isLocalMediaPath(logoStored) ? logoStored : (fees_json?.logoPath || null),
        };
      });

      const topVcts = vctRows.rows.map((row) => {
        const { profile_json, aadhaar, ...rest } = row;
        return {
          ...rest,
          photoUrl: photoFromProfile(profile_json),
          photoPath: profile_json?.profilePhotoPath || null,
        };
      });

      return res.json({
        data: {
          period,
          checkedAt: new Date().toISOString(),
          byType,
          byStatus,
          certified: certifiedMonths.rows[0] || { this_month: 0, last_month: 0, lifetime: 0 },
          regionalCenters,
          topVcts,
          trend: trendRows.rows.map((r) => ({
            day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
            certified: r.certified,
          })),
          totals: counts.rows[0] || {},
        },
      });
    } catch (error) {
      logger.error?.('Admin dashboard failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Dashboard query failed' },
      });
    }
  });

  app.get('/api/v1/admin/verifications', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const { limit, offset } = parsePaging(req.query, { defaultLimit: 10 });
    const status = String(req.query.status || '').trim();
    const type = String(req.query.type || '').trim().toUpperCase();
    const q = String(req.query.q || '').trim();
    const rcId = String(req.query.rcId || req.query.rc || '').trim();
    const { since } = parseDashboardPeriod(req.query.period);

    try {
      const where = [];
      const params = [];
      const statusKey = status.toLowerCase();
      // Signed / unsigned: match list shaping (verification_media kind=signed_certificate_pdf).
      const signedPdfExistsSql = `EXISTS (
          SELECT 1 FROM verification_media m
          WHERE m.verification_id = v.id
            AND m.kind = 'signed_certificate_pdf'
            AND (
              NULLIF(BTRIM(COALESCE(m.file_path, '')), '') IS NOT NULL
              OR NULLIF(BTRIM(COALESCE(m.source_url, '')), '') IS NOT NULL
            )
        )`;
      if (statusKey === 'signed') {
        where.push(signedPdfExistsSql);
      } else if (statusKey === 'unsigned') {
        where.push(`NOT ${signedPdfExistsSql}`);
      } else if (status) {
        params.push(status);
        where.push(`v.status = $${params.length}`);
      }
      if (type === 'OV' || type === 'RV') {
        params.push(type);
        where.push(`v.verification_type = $${params.length}`);
      }
      if (rcId) {
        params.push(rcId);
        where.push(`v.rc_id = $${params.length}`);
      }
      if (since) {
        params.push(since.toISOString());
        where.push(
          `COALESCE(v.certified_at, v.submitted_at, v.created_at) >= $${params.length}::timestamptz`,
        );
      }
      if (q) {
        params.push(`%${q}%`);
        const i = params.length;
        where.push(`(
          v.customer_name ILIKE $${i}
          OR v.serial_number ILIKE $${i}
          OR v.certificate_number ILIKE $${i}
          OR v.application_number ILIKE $${i}
          OR rc.company_name ILIKE $${i}
          OR rc.code ILIKE $${i}
          OR v.performed_by ILIKE $${i}
          OR COALESCE(v.details_json->>'vctName','') ILIKE $${i}
        )`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const countRes = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM verifications v
         LEFT JOIN regional_centers rc ON rc.id = v.rc_id
         ${whereSql}`,
        params,
      );

      params.push(limit);
      params.push(offset);
      const rows = await pool.query(
        `SELECT v.id, v.application_number, v.verification_type, v.job_kind, v.status,
                v.customer_name, v.serial_number, v.certificate_number,
                v.performed_by, v.product_snapshot, v.details_json,
                v.submitted_at, v.certified_at, v.created_at,
                rc.code AS rc_code, rc.company_name AS rc_name, rc.district AS rc_district,
                p.name AS product_name, p.accuracy_class AS product_accuracy_class,
                p.capacities AS product_capacities, p.unit_of_measurement AS product_unit,
                p.image_path AS product_image_path,
                u.username AS performer_username, u.profile_json AS performer_profile,
                signed_pdf.source_url AS signed_pdf_source_url,
                signed_pdf.file_path AS signed_pdf_file_path,
                cert_pdf.source_url AS cert_pdf_source_url,
                cert_pdf.file_path AS cert_pdf_file_path,
                scale_img.source_url AS scale_image_source_url,
                scale_img.file_path AS scale_image_file_path
         FROM verifications v
         LEFT JOIN regional_centers rc ON rc.id = v.rc_id
         LEFT JOIN products p ON p.id = v.product_id
         LEFT JOIN users u ON u.id = v.performer_user_id
         LEFT JOIN LATERAL (
           SELECT m.source_url, m.file_path
           FROM verification_media m
           WHERE m.verification_id = v.id AND m.kind = 'signed_certificate_pdf'
           ORDER BY m.created_at DESC NULLS LAST
           LIMIT 1
         ) signed_pdf ON TRUE
         LEFT JOIN LATERAL (
           SELECT m.source_url, m.file_path
           FROM verification_media m
           WHERE m.verification_id = v.id
             AND m.kind IN ('certificate_pdf', 'emaap_certificate_pdf')
           ORDER BY CASE m.kind WHEN 'certificate_pdf' THEN 0 ELSE 1 END,
                    m.created_at DESC NULLS LAST
           LIMIT 1
         ) cert_pdf ON TRUE
         LEFT JOIN LATERAL (
           SELECT m.source_url, m.file_path
           FROM verification_media m
           WHERE m.verification_id = v.id AND m.kind = 'scale_image'
           ORDER BY m.created_at DESC NULLS LAST
           LIMIT 1
         ) scale_img ON TRUE
         ${whereSql}
         ORDER BY COALESCE(v.certified_at, v.submitted_at, v.created_at) DESC NULLS LAST
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return res.json({
        data: {
          total: countRes.rows[0]?.total || 0,
          limit,
          offset,
          items: rows.rows.map(shapeAdminVerificationRow),
        },
      });
    } catch (error) {
      logger.error?.('Admin verifications list failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not list verifications' },
      });
    }
  });

  /**
   * Stream verification media from DATA_ROOT when local, else redirect to Firebase/http.
   * PDF aliases: kind=signed|certificate (default signed → certificate fallback).
   * Image kinds (e.g. scale_image): exact kind match — used for SA product thumbnails.
   */
  async function serveVerificationMedia(req, res, { defaultToPdf = true } = {}) {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'id required' } });
    }
    const kindRaw = String(req.query.kind || '').trim().toLowerCase();
    const disposition =
      String(req.query.disposition || '').toLowerCase() === 'attachment' ? 'attachment' : 'inline';

    let kindOrder;
    if (ADMIN_IMAGE_MEDIA_KINDS.has(kindRaw) || kindRaw === 'old_verification_certificate') {
      kindOrder = [kindRaw];
    } else if (kindRaw === 'certificate' || kindRaw === 'cert' || kindRaw === 'unsigned') {
      kindOrder = ['certificate_pdf', 'emaap_certificate_pdf', 'signed_certificate_pdf'];
    } else if (kindRaw === 'signed' || kindRaw === 'signed_certificate_pdf') {
      kindOrder = ['signed_certificate_pdf', 'certificate_pdf', 'emaap_certificate_pdf'];
    } else if (kindRaw && kindRaw.endsWith('_pdf')) {
      kindOrder = [kindRaw];
    } else if (defaultToPdf) {
      kindOrder = ['signed_certificate_pdf', 'certificate_pdf', 'emaap_certificate_pdf'];
    } else {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'kind query required for media' },
      });
    }

    try {
      const media = await pool.query(
        `SELECT m.kind, m.file_path, m.source_url, m.content_type, v.certificate_number, v.application_number
         FROM verification_media m
         JOIN verifications v ON v.id = m.verification_id
         WHERE m.verification_id = $1
           AND m.kind = ANY($2::text[])
         ORDER BY array_position($2::text[], m.kind), m.created_at DESC NULLS LAST
         LIMIT 1`,
        [id, kindOrder],
      );
      const row = media.rows[0];
      if (!row) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: defaultToPdf
              ? 'No certificate PDF for this verification'
              : 'No media for this verification',
      },
    });
      }

      const isImage = ADMIN_IMAGE_MEDIA_KINDS.has(String(row.kind || ''));
      const fileName = isImage
        ? `${firstNonEmptyString(row.certificate_number, row.application_number, id) || 'media'}-${row.kind}`
        : pdfDownloadFileName({
            certificateNumber: row.certificate_number,
            applicationNumber: row.application_number,
            fallbackId: id,
          });
      const abs = resolveSafeMediaPath(config.dataRoot, row.file_path);
      if (abs && fs.existsSync(abs)) {
        const ct =
          row.content_type ||
          (isImage ? 'image/jpeg' : 'application/pdf');
        res.setHeader('Content-Type', ct);
        res.setHeader(
          'Content-Disposition',
          `${disposition}; filename="${String(fileName).replace(/"/g, '')}"`,
        );
        res.setHeader('Cache-Control', 'private, max-age=300');
        return fs.createReadStream(abs).pipe(res);
      }

      const remote = pickHttpUrl(row.source_url, row.file_path);
      if (remote) {
        return res.redirect(302, remote);
      }
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: isImage
            ? 'Image not available locally or remotely'
            : 'PDF file not available locally or remotely',
        },
      });
    } catch (error) {
      logger.error?.('Admin verification media failed', { error: error.message, id });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not serve verification media' },
      });
    }
  }

  app.get('/api/v1/admin/verifications/:id/pdf', ...adminOnly, (req, res) =>
    serveVerificationMedia(req, res, { defaultToPdf: true }),
  );

  app.get('/api/v1/admin/verifications/:id/media', ...adminOnly, (req, res) =>
    serveVerificationMedia(req, res, { defaultToPdf: false }),
  );

  /**
   * List all available evidence images for a verification (gallery).
   * Prefers local VPS media API URLs when file_path is under media/yesgatc/; else Firebase/http.
   */
  app.get('/api/v1/admin/verifications/:id/images', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'id required' } });
    }
    try {
      const ver = await pool.query(
        `SELECT id, application_number, certificate_number, verification_type, status,
                customer_name, serial_number
         FROM verifications WHERE id = $1 LIMIT 1`,
        [id],
      );
      if (!ver.rowCount) {
        return res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Verification not found' },
        });
      }
      const v = ver.rows[0];
      const media = await pool.query(
        `SELECT kind, file_path, source_url, content_type
         FROM verification_media
         WHERE verification_id = $1
           AND kind = ANY($2::text[])
         ORDER BY created_at NULLS LAST`,
        [id, [...ADMIN_IMAGE_GALLERY_ORDER]],
      );

      const byKind = new Map();
      for (const row of media.rows) {
        const kind = String(row.kind || '');
        if (!ADMIN_IMAGE_MEDIA_KINDS.has(kind)) continue;
        const url = mediaHttpUrl(row.source_url, row.file_path, {
          verificationId: id,
          kind,
        });
        if (!url) continue;
        // Keep first usable row per kind (stable gallery order later).
        if (!byKind.has(kind)) {
          byKind.set(kind, {
            kind,
            label: imageKindLabel(kind),
            url,
            storage: isLocalMediaPath(row.file_path) ? 'local' : 'remote',
            content_type: row.content_type || null,
          });
        }
      }

      const images = ADMIN_IMAGE_GALLERY_ORDER.map((k) => byKind.get(k)).filter(Boolean);
      // Any unexpected image kinds still included at the end.
      for (const [k, item] of byKind) {
        if (!ADMIN_IMAGE_GALLERY_ORDER.includes(k)) images.push(item);
      }

    return res.json({
      data: {
          id: v.id,
          application_number: v.application_number,
          certificate_number: v.certificate_number,
          reference: firstNonEmptyString(v.certificate_number, v.application_number),
          verification_type: v.verification_type,
          status: v.status,
          customer_name: v.customer_name,
          serial_number: v.serial_number,
          images,
      },
    });
    } catch (error) {
      logger.error?.('Admin verification images failed', { error: error.message, id });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not list verification images' },
      });
    }
  });

  app.get('/api/v1/admin/regional-centers', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const q = String(req.query.q || '').trim();
    try {
      const params = [];
      let where = `WHERE rc.code <> 'DEMO-RC'`;
      if (q) {
        params.push(`%${q}%`);
        where += ` AND (rc.company_name ILIKE $1 OR rc.code ILIKE $1 OR rc.place ILIKE $1
          OR rc.district ILIKE $1 OR rc.state ILIKE $1 OR rc.contact_person ILIKE $1
          OR rc.phone ILIKE $1 OR rc.gst_number ILIKE $1 OR rc.address ILIKE $1)`;
      }
      const rows = await pool.query(
        `SELECT ${RC_SELECT_COLS},
                ${RC_STATS_SELECT}
         FROM regional_centers rc
         ${where}
         ORDER BY rc.company_name ASC`,
        params,
      );
      const items = rows.rows.map((row) => shapeAdminRcRow(row));
      const summary = {
        centres: items.length,
        active: items.filter((r) => r.active !== false).length,
        inactive: items.filter((r) => r.active === false).length,
        vct_count: items.reduce((s, r) => s + (Number(r.vct_count) || 0), 0),
        ov_count: items.reduce((s, r) => s + (Number(r.ov_count ?? r.ov) || 0), 0),
        rv_count: items.reduce((s, r) => s + (Number(r.rv_count ?? r.rv) || 0), 0),
        car_count: items.reduce((s, r) => s + (Number(r.car_count ?? r.vehicle_count) || 0), 0),
      };
      return res.json({
        data: {
          total: items.length,
          items,
          summary,
        },
      });
    } catch (error) {
      logger.error?.('Admin RC list failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not list regional centers' },
      });
    }
  });

  app.get('/api/v1/admin/regional-centers/:id', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Regional centre id required' } });
    }
    try {
      const rows = await pool.query(
        `SELECT ${RC_SELECT_COLS},
                ${RC_STATS_SELECT}
         FROM regional_centers rc
         WHERE rc.id::text = $1 OR rc.code = $1
            OR COALESCE(rc.fees_json->>'firebaseUid', '') = $1
         LIMIT 1`,
        [id],
      );
      if (!rows.rowCount) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Regional centre not found' } });
      }
      return res.json({ data: shapeAdminRcRow(rows.rows[0]) });
    } catch (error) {
      logger.error?.('Admin RC detail failed', { error: error.message, id });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not load regional centre' },
      });
    }
  });

  app.post('/api/v1/admin/regional-centers', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const code = normalizeRcCodeInput(req.body?.code || req.body?.rcCode);
    const fields = readRcBody(req.body || {});
    if (fields.error) return res.status(400).json({ error: fields.error });
    if (!code || code.length < 2) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'code is required (2–32 letters/digits)' },
      });
    }
    if (!fields.company_name) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'company_name is required' },
      });
    }
    const aadhaar = normalizeAadhaarDigits(req.body?.aadhaar || req.body?.aadhar);
    const password = String(req.body?.password || '');
    if (aadhaar && aadhaar.length !== 12) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'aadhaar must be 12 digits when provided' },
      });
    }
    if (aadhaar && password.length < 8) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'password must be at least 8 characters when creating RC admin login' },
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
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
           '{}'::jsonb, COALESCE($31, TRUE)
         )
         RETURNING id`,
        [
          code,
          fields.company_name,
          fields.contact_person,
          fields.phone,
          fields.email,
          fields.address,
          fields.place,
          fields.state,
          fields.district,
          fields.pincode,
          fields.location_lat,
          fields.location_lng,
          fields.gst_number,
          fields.pan_card,
          fields.zoho_customer_id,
          fields.zoho_expense_account_id,
          fields.zoho_expense_account_name,
          fields.certification_method,
          fields.laboratory_seal_identification,
          fields.standard_weights_cert_number,
          fields.standard_weights_cert_date,
          fields.standard_weights_cert_expiry,
          fields.logo_url,
          fields.seal_url,
          fields.standard_weights_cert_url,
          fields.pan_card_url,
          fields.pdf_signer_sign_url,
          fields.pdf_signer_sign_scale,
          fields.pdf_signer_sign_x,
          fields.pdf_signer_sign_y,
          fields.active !== false,
        ],
      );
      const rcId = inserted.rows[0].id;
      if (aadhaar) {
        const passwordHash = await hashPassword(password);
        await client.query(
          `INSERT INTO users (
             aadhaar, username, password_hash, role, rc_id, phone, email, address, active
           ) VALUES ($1,$2,$3,'RC_ADMIN',$4,$5,$6,$7,TRUE)`,
          [
            aadhaar,
            fields.contact_person || fields.company_name,
            passwordHash,
            rcId,
            fields.phone,
            fields.email,
            fields.address,
          ],
        );
      }
      await client.query('COMMIT');
      const rows = await pool.query(
        `SELECT ${RC_SELECT_COLS}, ${RC_STATS_ZERO}
         FROM regional_centers rc WHERE rc.id = $1`,
        [rcId],
      );
      return res.status(201).json({ data: shapeAdminRcRow(rows.rows[0]) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (String(error.code) === '23505') {
        return res.status(409).json({
          error: { code: 'CONFLICT', message: 'Regional centre code or Aadhaar already exists' },
        });
      }
      logger.error?.('Admin RC create failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not create regional centre' },
      });
    } finally {
      client.release();
    }
  });

  app.patch('/api/v1/admin/regional-centers/:id', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Regional centre id required' } });
    }
    const fields = readRcBody(req.body || {});
    if (fields.error) return res.status(400).json({ error: fields.error });
    const nextCode = req.body?.code != null || req.body?.rcCode != null
      ? normalizeRcCodeInput(req.body.code || req.body.rcCode)
      : null;
    try {
      const existing = await pool.query(
        `SELECT id FROM regional_centers
         WHERE id::text = $1 OR code = $1
         LIMIT 1`,
        [id],
      );
      if (!existing.rowCount) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Regional centre not found' } });
      }
      const rcId = existing.rows[0].id;
      const rows = await pool.query(
        `UPDATE regional_centers SET
           code = COALESCE($2, code),
           company_name = COALESCE($3, company_name),
           contact_person = COALESCE($4, contact_person),
           phone = COALESCE($5, phone),
           email = COALESCE($6, email),
           address = COALESCE($7, address),
           place = COALESCE($8, place),
           state = COALESCE($9, state),
           district = COALESCE($10, district),
           pincode = COALESCE($11, pincode),
           location_lat = COALESCE($12, location_lat),
           location_lng = COALESCE($13, location_lng),
           gst_number = COALESCE($14, gst_number),
           pan_card = COALESCE($15, pan_card),
           zoho_customer_id = COALESCE($16, zoho_customer_id),
           zoho_expense_account_id = COALESCE($17, zoho_expense_account_id),
           zoho_expense_account_name = COALESCE($18, zoho_expense_account_name),
           certification_method = COALESCE($19, certification_method),
           laboratory_seal_identification = COALESCE($20, laboratory_seal_identification),
           standard_weights_cert_number = COALESCE($21, standard_weights_cert_number),
           standard_weights_cert_date = COALESCE($22, standard_weights_cert_date),
           standard_weights_cert_expiry = COALESCE($23, standard_weights_cert_expiry),
           logo_url = COALESCE($24, logo_url),
           seal_url = COALESCE($25, seal_url),
           standard_weights_cert_url = COALESCE($26, standard_weights_cert_url),
           pan_card_url = COALESCE($27, pan_card_url),
           pdf_signer_sign_url = COALESCE($28, pdf_signer_sign_url),
           pdf_signer_sign_scale = COALESCE($29, pdf_signer_sign_scale),
           pdf_signer_sign_x = COALESCE($30, pdf_signer_sign_x),
           pdf_signer_sign_y = COALESCE($31, pdf_signer_sign_y),
           active = COALESCE($32, active),
           updated_at = NOW()
         WHERE id = $1
         RETURNING id`,
        [
          rcId,
          nextCode || null,
          fields.company_name,
          fields.contact_person,
          fields.phone,
          fields.email,
          fields.address,
          fields.place,
          fields.state,
          fields.district,
          fields.pincode,
          fields.location_lat,
          fields.location_lng,
          fields.gst_number,
          fields.pan_card,
          fields.zoho_customer_id,
          fields.zoho_expense_account_id,
          fields.zoho_expense_account_name,
          fields.certification_method,
          fields.laboratory_seal_identification,
          fields.standard_weights_cert_number,
          fields.standard_weights_cert_date,
          fields.standard_weights_cert_expiry,
          fields.logo_url,
          fields.seal_url,
          fields.standard_weights_cert_url,
          fields.pan_card_url,
          fields.pdf_signer_sign_url,
          fields.pdf_signer_sign_scale,
          fields.pdf_signer_sign_x,
          fields.pdf_signer_sign_y,
          fields.active,
        ],
      );
      const full = await pool.query(
        `SELECT ${RC_SELECT_COLS},
                ${RC_STATS_SELECT}
         FROM regional_centers rc WHERE rc.id = $1`,
        [rows.rows[0].id],
      );
      return res.json({ data: shapeAdminRcRow(full.rows[0]) });
    } catch (error) {
      if (String(error.code) === '23505') {
        return res.status(409).json({
          error: { code: 'CONFLICT', message: 'Regional centre code already exists' },
        });
      }
      logger.error?.('Admin RC update failed', { error: error.message, id });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not update regional centre' },
      });
    }
  });

  async function loadAdminRcById(rcId) {
    const full = await pool.query(
      `SELECT ${RC_SELECT_COLS},
              ${RC_STATS_SELECT}
       FROM regional_centers rc WHERE rc.id = $1`,
      [rcId],
    );
    return full.rows[0] || null;
  }

  async function resolveAdminRcId(id) {
    const existing = await pool.query(
      `SELECT id FROM regional_centers
       WHERE id::text = $1 OR code = $1
       LIMIT 1`,
      [id],
    );
    return existing.rows[0]?.id || null;
  }

  function normalizeRcMediaKind(raw) {
    const key = String(raw || '').trim().toLowerCase().replace(/-/g, '_');
    if (RC_MEDIA_KINDS[key]) return key;
    if (key === 'cert' || key === 'std_weights_cert' || key === 'standard_weights') {
      return 'standard_weights_cert';
    }
    if (key === 'pan' || key === 'pancard') return 'pan_card';
    if (key === 'signer' || key === 'sign' || key === 'pdf_signer') return 'pdf_signer_sign';
    return null;
  }

  function assertUploadContentType(meta, contentType, filename) {
    const ct = String(contentType || '').toLowerCase();
    const ext = path.extname(String(filename || '')).toLowerCase();
    const isPdf = ct.includes('pdf') || ext === '.pdf';
    const isImage = ct.startsWith('image/')
      || ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext);
    if (meta.accept === 'image' && !isImage) {
      return { code: 'VALIDATION', message: `${meta.label} must be an image file` };
    }
    if (meta.accept === 'image_or_pdf' && !isImage && !isPdf) {
      return { code: 'VALIDATION', message: `${meta.label} must be an image or PDF` };
    }
    return null;
  }

  /**
   * Stream RC media from DATA_ROOT when local; else redirect to remote http(s).
   * kind=logo|seal|standard_weights_cert|pan_card|pdf_signer_sign
   */
  app.get('/api/v1/admin/regional-centers/:id/media', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    const kind = normalizeRcMediaKind(req.query.kind);
    if (!id || !kind) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Regional centre id and kind are required' },
      });
    }
    const meta = RC_MEDIA_KINDS[kind];
    const disposition =
      String(req.query.disposition || '').toLowerCase() === 'attachment' ? 'attachment' : 'inline';
    try {
      const rcId = await resolveAdminRcId(id);
      if (!rcId) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Regional centre not found' } });
      }
      const rows = await pool.query(
        `SELECT id, code, company_name, logo_url, seal_url, standard_weights_cert_url,
                pan_card_url, pdf_signer_sign_url, fees_json
         FROM regional_centers WHERE id = $1`,
        [rcId],
      );
      const row = rows.rows[0];
      const feesKeys = {
        logo: ['logoUrl', 'logoURL', 'companyLogo', 'logo'],
        seal: ['sealUrl'],
        standard_weights_cert: ['standardWeightsCertUrl'],
        pan_card: ['panCardUrl'],
        pdf_signer_sign: ['pdfSignerSignUrl'],
      };
      const stored = storedRcMediaValue(row, meta.column, feesKeys[kind] || []);
      const abs = resolveMediaAbsWithThumb(config.dataRoot, stored, { thumb: false });
      if (abs && fs.existsSync(abs)) {
        const ct = contentTypeForMediaPath(abs);
        const baseName = String(row.code || row.company_name || row.id || kind)
          .replace(/[^\w.\-]+/g, '_')
          .slice(0, 80);
        const ext = path.extname(abs) || (ct === 'application/pdf' ? '.pdf' : '.jpg');
        res.setHeader('Content-Type', ct);
        res.setHeader(
          'Content-Disposition',
          `${disposition}; filename="${baseName}-${kind}${ext}"`,
        );
        res.setHeader('Cache-Control', 'private, max-age=300');
        return fs.createReadStream(abs).pipe(res);
      }
      const remote = pickHttpUrl(stored);
      if (remote) return res.redirect(302, remote);
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `${meta.label} not available` },
      });
    } catch (error) {
      logger.error?.('Admin RC media get failed', { error: error.message, id, kind });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not serve regional centre media' },
      });
    }
  });

  /**
   * Upload RC media → DATA_ROOT/media/yesgatc/regionalCenters/<id>/<stem>.<ext>
   * Stores relative path in the matching *_url column (not Firebase).
   */
  app.post('/api/v1/admin/regional-centers/:id/media', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    if (!config.dataRoot) {
      return res.status(503).json({
        error: { code: 'DATA_UNCONFIGURED', message: 'DATA_ROOT is not configured' },
      });
    }
    const id = String(req.params.id || '').trim();
    const kind = normalizeRcMediaKind(req.query.kind || req.headers['x-media-kind']);
    if (!id || !kind) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Regional centre id and kind are required' },
      });
    }
    const meta = RC_MEDIA_KINDS[kind];
    try {
      const rcId = await resolveAdminRcId(id);
      if (!rcId) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Regional centre not found' } });
      }
      const uploaded = await readSingleMultipartFile(req);
      const typeErr = assertUploadContentType(meta, uploaded.contentType, uploaded.filename);
      if (typeErr) return res.status(400).json({ error: typeErr });
      const ext = extForUpload({
        contentType: uploaded.contentType,
        filename: uploaded.filename,
        fallback: meta.fallbackExt,
      });
      const relDir = `media/yesgatc/regionalCenters/${rcId}`;
      clearMediaStem(config.dataRoot, relDir, meta.stem);
      const relPath = `${relDir}/${meta.stem}${ext}`;
      writeMediaFile(config.dataRoot, relPath, uploaded.buffer);
      await pool.query(
        `UPDATE regional_centers
         SET ${meta.column} = $2, updated_at = NOW()
         WHERE id = $1`,
        [rcId, relPath],
      );
      const full = await loadAdminRcById(rcId);
      return res.json({
        data: shapeAdminRcRow(full),
        media: {
          kind,
          path: relPath,
          bytes: uploaded.buffer.length,
          contentType: uploaded.contentType,
        },
      });
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status < 500) {
        return res.status(status).json({
          error: { code: error.code || 'BAD_REQUEST', message: error.message },
        });
      }
      logger.error?.('Admin RC media upload failed', { error: error.message, id, kind });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not upload regional centre media' },
      });
    }
  });

  /** Clear RC media file + null the DB column. */
  app.delete('/api/v1/admin/regional-centers/:id/media', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    const kind = normalizeRcMediaKind(req.query.kind);
    if (!id || !kind) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Regional centre id and kind are required' },
      });
    }
    const meta = RC_MEDIA_KINDS[kind];
    try {
      const rcId = await resolveAdminRcId(id);
      if (!rcId) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Regional centre not found' } });
      }
      const rows = await pool.query(
        `SELECT ${meta.column} AS stored FROM regional_centers WHERE id = $1`,
        [rcId],
      );
      const stored = rows.rows[0]?.stored;
      if (isLocalMediaPath(stored)) {
        removeLocalMediaFile(config.dataRoot, stored);
        clearMediaStem(
          config.dataRoot,
          `media/yesgatc/regionalCenters/${rcId}`,
          meta.stem,
        );
      }
      await pool.query(
        `UPDATE regional_centers
         SET ${meta.column} = NULL, updated_at = NOW()
         WHERE id = $1`,
        [rcId],
      );
      const full = await loadAdminRcById(rcId);
      return res.json({ data: shapeAdminRcRow(full), media: { kind, cleared: true } });
    } catch (error) {
      logger.error?.('Admin RC media delete failed', { error: error.message, id, kind });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not clear regional centre media' },
      });
    }
  });

  app.get('/api/v1/admin/products', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const { limit, offset } = parsePaging(req.query, { defaultLimit: 100 });
    const q = String(req.query.q || '').trim();
    const tab = String(req.query.tab || req.query.status || 'Active').trim();
    try {
      const params = [];
      const where = [];
      if (tab === 'Active') where.push('active = TRUE');
      else if (tab === 'Inactive') where.push('active = FALSE');
      if (q) {
        params.push(`%${q}%`);
        const i = params.length;
        where.push(
          `(name ILIKE $${i} OR model_no ILIKE $${i} OR model_id ILIKE $${i} OR manufacturer_brand_series ILIKE $${i} OR model_approval_no ILIKE $${i} OR COALESCE(capacities->>'yesoneSku','') ILIKE $${i})`,
        );
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = await pool.query(`SELECT COUNT(*)::int AS total FROM products ${whereSql}`, params);
      params.push(limit, offset);
      const rows = await pool.query(
        `SELECT id, model_id, model_no, name, type_of_instrument, manufacturer_brand_series,
                accuracy_class, capacities, unit_of_measurement, model_approval_no,
                supply_voltage, pas_pre_allotted, active, sort_order,
                approval_doc_path, approval_doc_url, image_path, image_url,
                source_firebase_id, created_at, updated_at
         FROM products
         ${whereSql}
         ORDER BY sort_order ASC, name ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return res.json({
        data: {
          total: total.rows[0]?.total || 0,
          limit,
          offset,
          tab,
          items: rows.rows.map(shapeAdminProductRow),
        },
      });
    } catch (error) {
      logger.error?.('Admin products list failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not list products' },
      });
    }
  });

  app.get('/api/v1/admin/products/:id', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Product id required' } });
    }
    try {
      const rows = await pool.query(
        `SELECT id, model_id, model_no, name, type_of_instrument, manufacturer_brand_series,
                accuracy_class, capacities, unit_of_measurement, model_approval_no,
                supply_voltage, pas_pre_allotted, active, sort_order,
                approval_doc_path, approval_doc_url, image_path, image_url,
                source_firebase_id, created_at, updated_at
         FROM products
         WHERE id::text = $1 OR model_id = $1 OR source_firebase_id = $1
         LIMIT 1`,
        [id],
      );
      if (!rows.rowCount) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Product not found' } });
      }
      return res.json({ data: shapeAdminProductRow(rows.rows[0]) });
    } catch (error) {
      logger.error?.('Admin product detail failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not load product' },
      });
    }
  });

  function readProductBody(body = {}, { existingCapacities = {} } = {}) {
    const name = trimOrNull(body.name);
    const modelId = trimOrNull(body.model_id || body.modelId);
    const modelNo = trimOrNull(body.model_no || body.modelNo);
    const pas = body.pas_pre_allotted != null
      ? Boolean(body.pas_pre_allotted)
      : (body.serial_pool != null ? String(body.serial_pool).toUpperCase() === 'PAS' : undefined);
    let caps = { ...asObject(existingCapacities) };
    const yesoneSku = trimOrNull(body.yesone_sku || body.yesoneSku);
    if (yesoneSku != null) caps.yesoneSku = yesoneSku;
    else if (body.yesone_sku === '' || body.yesoneSku === '') delete caps.yesoneSku;

    const rawSpecs = body.specifications ?? body.capacity_rows ?? body.capacityRows;
    let specsApplied = false;
    if (Array.isArray(rawSpecs)) {
      const normalized = rawSpecs
        .map((spec, index) => normalizeProductSpecification(spec, index))
        .filter(Boolean);
      if (normalized.length) {
        caps = applySpecificationsToCapacities(caps, normalized);
        specsApplied = true;
      }
    }

    const specPatch = {
      maximumCapacity: firstFiniteNumber(body.maximum_capacity, body.maximumCapacity),
      verificationScaleInterval: firstFiniteNumber(
        body.verification_scale_interval,
        body.verificationScaleInterval,
      ),
      maximumPermissibleError: firstFiniteNumber(
        body.maximum_permissible_error,
        body.maximumPermissibleError,
      ),
      minimumCapacity: firstFiniteNumber(body.minimum_capacity, body.minimumCapacity),
      actualScaleInterval: firstFiniteNumber(body.actual_scale_interval, body.actualScaleInterval),
      noOfVerificationIntervals: firstFiniteNumber(
        body.no_of_verification_intervals,
        body.noOfVerificationIntervals,
      ),
    };
    const hasSpecPatch = Object.values(specPatch).some((v) => v != null);
    if (hasSpecPatch && !specsApplied) {
      for (const [k, v] of Object.entries(specPatch)) {
        if (v != null) caps[k] = v;
      }
      const existingSpecs = Array.isArray(caps.specifications) ? caps.specifications : [];
      if (existingSpecs.length) {
        const first = { ...asObject(existingSpecs[0]) };
        for (const [k, v] of Object.entries(specPatch)) {
          if (v != null) first[k] = v;
        }
        const normalizedFirst = normalizeProductSpecification(first, 0);
        const rest = existingSpecs
          .slice(1)
          .map((spec, index) => normalizeProductSpecification(spec, index + 1))
          .filter(Boolean);
        if (normalizedFirst) {
          caps = applySpecificationsToCapacities(caps, [normalizedFirst, ...rest]);
        }
      } else {
        const only = normalizeProductSpecification({ id: 'primary', ...specPatch }, 0);
        if (only) caps = applySpecificationsToCapacities(caps, [only]);
      }
    }

    const imageKeyPresent = Object.prototype.hasOwnProperty.call(body, 'image_url')
      || Object.prototype.hasOwnProperty.call(body, 'imageUrl')
      || Object.prototype.hasOwnProperty.call(body, 'image_source_url')
      || Object.prototype.hasOwnProperty.call(body, 'imageSourceUrl');
    const approvalKeyPresent = Object.prototype.hasOwnProperty.call(body, 'approval_doc_url')
      || Object.prototype.hasOwnProperty.call(body, 'approvalDocUrl')
      || Object.prototype.hasOwnProperty.call(body, 'approval_doc_source_url')
      || Object.prototype.hasOwnProperty.call(body, 'approvalDocSourceUrl');

    return {
      model_id: modelId,
      model_no: modelNo,
      name,
      type_of_instrument: trimOrNull(body.type_of_instrument || body.typeOfInstrument),
      manufacturer_brand_series: trimOrNull(
        body.manufacturer_brand_series || body.manufacturerBrandSeries,
      ),
      accuracy_class: trimOrNull(body.accuracy_class || body.accuracyClass),
      unit_of_measurement: trimOrNull(body.unit_of_measurement || body.unitOfMeasurement) || 'kg',
      model_approval_no: trimOrNull(body.model_approval_no || body.modelApprovalNo),
      supply_voltage: trimOrNull(body.supply_voltage || body.supplyVoltage),
      pas_pre_allotted: pas,
      active: body.active == null ? undefined : Boolean(body.active),
      sort_order: body.sort_order != null ? Number(body.sort_order) || 0 : undefined,
      capacities: caps,
      image_url: imageKeyPresent
        ? trimOrNull(
          body.image_source_url
            ?? body.imageSourceUrl
            ?? body.image_url
            ?? body.imageUrl,
        )
        : undefined,
      image_url_set: imageKeyPresent,
      approval_doc_url: approvalKeyPresent
        ? trimOrNull(
          body.approval_doc_source_url
            ?? body.approvalDocSourceUrl
            ?? body.approval_doc_url
            ?? body.approvalDocUrl,
        )
        : undefined,
      approval_doc_url_set: approvalKeyPresent,
    };
  }

  app.post('/api/v1/admin/products', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const fields = readProductBody(req.body || {});
    if (!fields.name) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'name is required' } });
    }
    if (!fields.model_id) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'model_id is required' } });
    }
    try {
      const rows = await pool.query(
        `INSERT INTO products (
           model_id, model_no, name, type_of_instrument, manufacturer_brand_series,
           accuracy_class, capacities, unit_of_measurement, model_approval_no,
           supply_voltage, pas_pre_allotted, active, sort_order,
           image_url, approval_doc_url
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,COALESCE($11,FALSE),COALESCE($12,TRUE),COALESCE($13,0),$14,$15)
         RETURNING id, model_id, model_no, name, type_of_instrument, manufacturer_brand_series,
                   accuracy_class, capacities, unit_of_measurement, model_approval_no,
                   supply_voltage, pas_pre_allotted, active, sort_order,
                   approval_doc_path, approval_doc_url, image_path, image_url,
                   source_firebase_id, created_at, updated_at`,
        [
          fields.model_id,
          fields.model_no,
          fields.name,
          fields.type_of_instrument,
          fields.manufacturer_brand_series,
          fields.accuracy_class,
          JSON.stringify(fields.capacities || {}),
          fields.unit_of_measurement,
          fields.model_approval_no,
          fields.supply_voltage,
          fields.pas_pre_allotted === true,
          fields.active !== false,
          fields.sort_order || 0,
          fields.image_url_set ? fields.image_url : null,
          fields.approval_doc_url_set ? fields.approval_doc_url : null,
        ],
      );
      return res.status(201).json({ data: shapeAdminProductRow(rows.rows[0]) });
    } catch (error) {
      if (String(error.code) === '23505') {
        return res.status(409).json({
          error: { code: 'CONFLICT', message: 'Product model_id already exists' },
        });
      }
      logger.error?.('Admin product create failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not create product' },
      });
    }
  });

  app.patch('/api/v1/admin/products/:id', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Product id required' } });
    }
    try {
      const existing = await pool.query(
        `SELECT id, capacities FROM products
         WHERE id::text = $1 OR model_id = $1 OR source_firebase_id = $1
         LIMIT 1`,
        [id],
      );
      if (!existing.rowCount) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Product not found' } });
      }
      const fields = readProductBody(req.body || {}, {
        existingCapacities: existing.rows[0].capacities,
      });
      const rows = await pool.query(
        `UPDATE products SET
           model_id = COALESCE($2, model_id),
           model_no = COALESCE($3, model_no),
           name = COALESCE($4, name),
           type_of_instrument = COALESCE($5, type_of_instrument),
           manufacturer_brand_series = COALESCE($6, manufacturer_brand_series),
           accuracy_class = COALESCE($7, accuracy_class),
           capacities = COALESCE($8::jsonb, capacities),
           unit_of_measurement = COALESCE($9, unit_of_measurement),
           model_approval_no = COALESCE($10, model_approval_no),
           supply_voltage = COALESCE($11, supply_voltage),
           pas_pre_allotted = COALESCE($12, pas_pre_allotted),
           active = COALESCE($13, active),
           sort_order = COALESCE($14, sort_order),
           image_url = CASE WHEN $15::boolean THEN $16 ELSE image_url END,
           approval_doc_url = CASE WHEN $17::boolean THEN $18 ELSE approval_doc_url END,
           updated_at = NOW()
         WHERE id = $1
         RETURNING id, model_id, model_no, name, type_of_instrument, manufacturer_brand_series,
                   accuracy_class, capacities, unit_of_measurement, model_approval_no,
                   supply_voltage, pas_pre_allotted, active, sort_order,
                   approval_doc_path, approval_doc_url, image_path, image_url,
                   source_firebase_id, created_at, updated_at`,
        [
          existing.rows[0].id,
          fields.model_id,
          fields.model_no,
          fields.name,
          fields.type_of_instrument,
          fields.manufacturer_brand_series,
          fields.accuracy_class,
          JSON.stringify(fields.capacities || {}),
          fields.unit_of_measurement,
          fields.model_approval_no,
          fields.supply_voltage,
          fields.pas_pre_allotted,
          fields.active,
          fields.sort_order,
          Boolean(fields.image_url_set),
          fields.image_url_set ? fields.image_url : null,
          Boolean(fields.approval_doc_url_set),
          fields.approval_doc_url_set ? fields.approval_doc_url : null,
        ],
      );
      return res.json({ data: shapeAdminProductRow(rows.rows[0]) });
    } catch (error) {
      if (String(error.code) === '23505') {
        return res.status(409).json({
          error: { code: 'CONFLICT', message: 'Product model_id already exists' },
        });
      }
      logger.error?.('Admin product update failed', { error: error.message, id });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not update product' },
      });
    }
  });

  /**
   * Stream product image / approval doc from DATA_ROOT when local, else redirect to Firebase/http.
   * kind=image|approval_doc (default image).
   */
  app.get('/api/v1/admin/products/:id/media', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Product id required' } });
    }
    const kindRaw = String(req.query.kind || 'image').trim().toLowerCase();
    const kind = kindRaw === 'approval' || kindRaw === 'approval_doc' || kindRaw === 'doc'
      ? 'approval_doc'
      : 'image';
    const wantThumb = String(req.query.variant || '').toLowerCase() === 'thumb';
    const disposition =
      String(req.query.disposition || '').toLowerCase() === 'attachment' ? 'attachment' : 'inline';
    try {
      const rows = await pool.query(
        `SELECT id, model_id, name, image_path, image_url, approval_doc_path, approval_doc_url
         FROM products
         WHERE id::text = $1 OR model_id = $1 OR source_firebase_id = $1
         LIMIT 1`,
        [id],
      );
      const row = rows.rows[0];
      if (!row) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Product not found' } });
      }
      const filePath = kind === 'approval_doc' ? row.approval_doc_path : row.image_path;
      const sourceUrl = kind === 'approval_doc' ? row.approval_doc_url : row.image_url;
      const abs = resolveMediaAbsWithThumb(config.dataRoot, filePath, {
        thumb: wantThumb && kind === 'image',
      });
      if (abs && fs.existsSync(abs)) {
        const ct = contentTypeForMediaPath(abs);
        const baseName = String(row.model_id || row.name || row.id || kind)
          .replace(/[^\w.\-]+/g, '_')
          .slice(0, 80);
        const ext = path.extname(abs) || (ct === 'application/pdf' ? '.pdf' : '.jpg');
        res.setHeader('Content-Type', ct);
        res.setHeader(
          'Content-Disposition',
          `${disposition}; filename="${baseName}-${kind}${ext}"`,
        );
        res.setHeader('Cache-Control', 'private, max-age=300');
        return fs.createReadStream(abs).pipe(res);
      }
      const remote = pickHttpUrl(sourceUrl, filePath);
      if (remote) {
        return res.redirect(302, remote);
      }
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: kind === 'approval_doc' ? 'Approval document not available' : 'Product image not available',
        },
      });
    } catch (error) {
      logger.error?.('Admin product media failed', { error: error.message, id });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not serve product media' },
      });
    }
  });

  /**
   * Upload product image / approval doc → DATA_ROOT/media/yesgatc/products/<id>/…
   * Writes local path columns; keeps remote *_url only if previously set (not required).
   */
  app.post('/api/v1/admin/products/:id/media', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    if (!config.dataRoot) {
      return res.status(503).json({
        error: { code: 'DATA_UNCONFIGURED', message: 'DATA_ROOT is not configured' },
      });
    }
    const id = String(req.params.id || '').trim();
    const kindRaw = String(req.query.kind || 'image').trim().toLowerCase();
    const kind = kindRaw === 'approval' || kindRaw === 'approval_doc' || kindRaw === 'doc'
      ? 'approval_doc'
      : 'image';
    const meta = PRODUCT_MEDIA_UPLOAD_KINDS[kind];
    try {
      const rows = await pool.query(
        `SELECT id, model_id, source_firebase_id
         FROM products
         WHERE id::text = $1 OR model_id = $1 OR source_firebase_id = $1
         LIMIT 1`,
        [id],
      );
      const row = rows.rows[0];
      if (!row) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Product not found' } });
      }
      const uploaded = await readSingleMultipartFile(req);
      const typeErr = assertUploadContentType(meta, uploaded.contentType, uploaded.filename);
      if (typeErr) return res.status(400).json({ error: typeErr });
      const ext = extForUpload({
        contentType: uploaded.contentType,
        filename: uploaded.filename,
        fallback: meta.fallbackExt,
      });
      const folderId = String(row.source_firebase_id || row.id);
      const relDir = `media/yesgatc/products/${folderId}`;
      clearMediaStem(config.dataRoot, relDir, meta.stem);
      const relPath = `${relDir}/${meta.stem}${ext}`;
      writeMediaFile(config.dataRoot, relPath, uploaded.buffer);
      const updated = await pool.query(
        `UPDATE products
         SET ${meta.pathCol} = $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, model_id, model_no, name, type_of_instrument, manufacturer_brand_series,
                   accuracy_class, capacities, unit_of_measurement, model_approval_no,
                   supply_voltage, pas_pre_allotted, active, sort_order,
                   approval_doc_path, approval_doc_url, image_path, image_url,
                   source_firebase_id, created_at, updated_at`,
        [row.id, relPath],
      );
      return res.json({
        data: shapeAdminProductRow(updated.rows[0]),
        media: {
          kind,
          path: relPath,
          bytes: uploaded.buffer.length,
          contentType: uploaded.contentType,
        },
      });
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status < 500) {
        return res.status(status).json({
          error: { code: error.code || 'BAD_REQUEST', message: error.message },
        });
      }
      logger.error?.('Admin product media upload failed', { error: error.message, id, kind });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not upload product media' },
      });
    }
  });

  app.get('/api/v1/admin/users', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const role = String(req.query.role || '').trim().toUpperCase();
    const q = String(req.query.q || '').trim();
    const tab = String(req.query.tab || req.query.status || '').trim();
    const { limit, offset } = parsePaging(req.query, { defaultLimit: 100 });
    try {
      const params = [];
      const clauses = [];
      if (role && ['ADMIN', 'RC_ADMIN', 'VCT'].includes(role)) {
        params.push(role);
        clauses.push(`u.role = $${params.length}`);
      }
      // Super Admin VCT page: hide demo seed technicians (keep row for local tests).
      if (!role || role === 'VCT') {
        clauses.push(seedUserHiddenSql(params));
      }
      // Active | Inactive tabs (Products-style). Default Active when role=VCT and tab omitted.
      const statusTab = tab
        || (role === 'VCT' ? 'Active' : '');
      if (statusTab === 'Active') clauses.push('u.active = TRUE');
      else if (statusTab === 'Inactive') clauses.push('u.active = FALSE');
      if (q) {
        params.push(`%${q}%`);
        const i = params.length;
        clauses.push(
          `(u.username ILIKE $${i} OR u.aadhaar ILIKE $${i} OR u.phone ILIKE $${i} OR u.address ILIKE $${i} OR rc.company_name ILIKE $${i})`,
        );
      }
      const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const total = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM users u
         LEFT JOIN regional_centers rc ON rc.id = u.rc_id
         ${whereSql}`,
        params,
      );
      params.push(limit, offset);
      const rows = await pool.query(
        `SELECT u.id, u.aadhaar, u.username, u.role, u.phone, u.email, u.address, u.active,
                u.workflow_mode, u.created_at, u.updated_at, u.rc_id, u.profile_json,
                rc.code AS rc_code, rc.company_name AS rc_name
         FROM users u
         LEFT JOIN regional_centers rc ON rc.id = u.rc_id
         ${whereSql}
         ORDER BY u.role ASC, u.username ASC NULLS LAST, u.aadhaar ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return res.json({
        data: {
          total: total.rows[0]?.total || 0,
          limit,
          offset,
          tab: statusTab || null,
          items: rows.rows.map((row) => shapeAdminUserRow(row)),
        },
      });
    } catch (error) {
      logger.error?.('Admin users list failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not list users' },
      });
    }
  });

  app.get('/api/v1/admin/users/:id', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'User id required' } });
    }
    try {
      const rows = await pool.query(
        `SELECT u.id, u.aadhaar, u.username, u.role, u.phone, u.email, u.address, u.active,
                u.workflow_mode, u.created_at, u.updated_at, u.rc_id, u.profile_json,
                rc.code AS rc_code, rc.company_name AS rc_name
         FROM users u
         LEFT JOIN regional_centers rc ON rc.id = u.rc_id
         WHERE u.id::text = $1
            OR u.aadhaar = $1
            OR COALESCE(u.profile_json->>'firebaseUid', '') = $1
         LIMIT 1`,
        [id],
      );
      if (!rows.rows.length) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
      }
      return res.json({ data: shapeAdminUserRow(rows.rows[0], { includeProfile: true }) });
    } catch (error) {
      logger.error?.('Admin user detail failed', { error: error.message, id });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not load user' },
      });
    }
  });

  async function loadUserDetailById(poolRef, userId) {
    const rows = await poolRef.query(
      `SELECT u.id, u.aadhaar, u.username, u.role, u.phone, u.email, u.address, u.active,
              u.workflow_mode, u.created_at, u.updated_at, u.rc_id, u.profile_json,
              rc.code AS rc_code, rc.company_name AS rc_name
       FROM users u
       LEFT JOIN regional_centers rc ON rc.id = u.rc_id
       WHERE u.id = $1
       LIMIT 1`,
      [userId],
    );
    return rows.rows[0] ? shapeAdminUserRow(rows.rows[0], { includeProfile: true }) : null;
  }

  app.post('/api/v1/admin/users', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const body = req.body || {};
    const role = String(body.role || 'VCT').trim().toUpperCase();
    if (!['VCT', 'RC_ADMIN'].includes(role)) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'role must be VCT or RC_ADMIN' },
      });
    }
    const aadhaar = normalizeAadhaarDigits(body.aadhaar || body.aadhar);
    const password = String(body.password || '');
    const username = trimOrNull(body.username || body.name);
    const rcId = trimOrNull(body.rc_id || body.rcId);
    if (aadhaar.length !== 12) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'aadhaar must be 12 digits' },
      });
    }
    if (password.length < 8) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'password must be at least 8 characters' },
      });
    }
    if (!rcId) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'rc_id is required' },
      });
    }
    const workflow = trimOrNull(body.workflow_mode || body.workflowMode);
    if (workflow && !['auto', 'manual'].includes(workflow)) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'workflow_mode must be auto or manual' },
      });
    }
    const profile = {
      bloodGroup: trimOrNull(body.blood_group || body.bloodGroup) || undefined,
      policeStation: trimOrNull(body.police_station || body.policeStation) || undefined,
      pincode: trimOrNull(body.pincode)?.replace(/\D/g, '').slice(0, 6) || undefined,
      secondaryContactName: trimOrNull(body.secondary_contact_name || body.secondaryContactName) || undefined,
      secondaryContactRelationship: trimOrNull(
        body.secondary_contact_relationship || body.secondaryContactRelationship,
      ) || undefined,
      secondaryContactPhone: trimOrNull(
        body.secondary_contact_phone || body.secondaryContactPhone,
      ) || undefined,
      approvalStatus: trimOrNull(body.approval_status || body.approvalStatus) || 'approved',
    };
    Object.keys(profile).forEach((k) => profile[k] === undefined && delete profile[k]);
    try {
      const passwordHash = await hashPassword(password);
      const rows = await pool.query(
        `INSERT INTO users (
           aadhaar, username, password_hash, role, rc_id, phone, email, address,
           profile_json, workflow_mode, active
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,COALESCE($11,TRUE))
         RETURNING id`,
        [
          aadhaar,
          username || aadhaar,
          passwordHash,
          role,
          rcId,
          trimOrNull(body.phone)?.replace(/\D/g, '').slice(0, 15) || null,
          trimOrNull(body.email),
          trimOrNull(body.address),
          JSON.stringify(profile),
          role === 'VCT' ? (workflow || 'manual') : null,
          body.active !== false,
        ],
      );
      const data = await loadUserDetailById(pool, rows.rows[0].id);
      return res.status(201).json({ data });
    } catch (error) {
      if (String(error.code) === '23505') {
        return res.status(409).json({
          error: { code: 'CONFLICT', message: 'Aadhaar already exists' },
        });
      }
      if (String(error.code) === '23503') {
        return res.status(400).json({
          error: { code: 'VALIDATION', message: 'rc_id does not match a regional centre' },
        });
      }
      logger.error?.('Admin user create failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not create user' },
      });
    }
  });

  app.patch('/api/v1/admin/users/:id', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'User id required' } });
    }
    const body = req.body || {};
    const workflow = body.workflow_mode != null || body.workflowMode != null
      ? trimOrNull(body.workflow_mode || body.workflowMode)
      : undefined;
    if (workflow && !['auto', 'manual'].includes(workflow)) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'workflow_mode must be auto or manual' },
      });
    }
    try {
      const existing = await pool.query(
        `SELECT id, profile_json, role FROM users
         WHERE id::text = $1 OR aadhaar = $1
            OR COALESCE(profile_json->>'firebaseUid', '') = $1
         LIMIT 1`,
        [id],
      );
      if (!existing.rowCount) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
      }
      const row = existing.rows[0];
      const profile = { ...asObject(row.profile_json) };
      const profilePatches = [
        ['bloodGroup', body.blood_group ?? body.bloodGroup],
        ['policeStation', body.police_station ?? body.policeStation],
        ['pincode', body.pincode],
        ['secondaryContactName', body.secondary_contact_name ?? body.secondaryContactName],
        ['secondaryContactRelationship',
          body.secondary_contact_relationship ?? body.secondaryContactRelationship],
        ['secondaryContactPhone', body.secondary_contact_phone ?? body.secondaryContactPhone],
        ['approvalStatus', body.approval_status ?? body.approvalStatus],
      ];
      for (const [key, raw] of profilePatches) {
        if (raw === undefined) continue;
        const val = trimOrNull(raw);
        if (val) profile[key] = key === 'pincode' ? val.replace(/\D/g, '').slice(0, 6) : val;
        else delete profile[key];
      }
      let passwordHash = null;
      if (body.password != null && String(body.password).length) {
        if (String(body.password).length < 8) {
          return res.status(400).json({
            error: { code: 'VALIDATION', message: 'password must be at least 8 characters' },
          });
        }
        passwordHash = await hashPassword(String(body.password));
      }
      await pool.query(
        `UPDATE users SET
           username = COALESCE($2, username),
           phone = COALESCE($3, phone),
           email = COALESCE($4, email),
           address = COALESCE($5, address),
           rc_id = COALESCE($6, rc_id),
           workflow_mode = COALESCE($7, workflow_mode),
           active = COALESCE($8, active),
           profile_json = $9::jsonb,
           password_hash = COALESCE($10, password_hash),
           updated_at = NOW()
         WHERE id = $1`,
        [
          row.id,
          trimOrNull(body.username || body.name),
          trimOrNull(body.phone)?.replace(/\D/g, '').slice(0, 15) || null,
          trimOrNull(body.email),
          trimOrNull(body.address),
          trimOrNull(body.rc_id || body.rcId),
          workflow,
          body.active == null ? undefined : Boolean(body.active),
          JSON.stringify(profile),
          passwordHash,
        ],
      );
      const data = await loadUserDetailById(pool, row.id);
      return res.json({ data });
    } catch (error) {
      if (String(error.code) === '23503') {
        return res.status(400).json({
          error: { code: 'VALIDATION', message: 'rc_id does not match a regional centre' },
        });
      }
      logger.error?.('Admin user update failed', { error: error.message, id });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not update user' },
      });
    }
  });

  const USER_MEDIA_KINDS = {
    profile: {
      localKeys: ['profilePhotoLocalPath'],
      remoteKeys: ['profilePhotoUrl', 'photoUrl', 'photoURL', 'profileImageUrl', 'imageUrl', 'avatarUrl'],
      contentType: 'image/jpeg',
    },
    aadhaar: {
      localKeys: ['aadharDocLocalPath'],
      remoteKeys: ['aadharDocUrl'],
      contentType: 'application/pdf',
    },
    biodata: {
      localKeys: ['biodataDocLocalPath'],
      remoteKeys: ['biodataDocUrl'],
      contentType: 'application/pdf',
    },
    education: {
      localKeys: ['educationCertDocLocalPath'],
      remoteKeys: ['educationCertDocUrl'],
      contentType: 'application/pdf',
    },
    pcc: {
      localKeys: ['pccDocLocalPath'],
      remoteKeys: ['pccDocUrl'],
      contentType: 'application/pdf',
    },
  };

  app.get('/api/v1/admin/users/:id/media', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    const kind = String(req.query.kind || 'profile').trim().toLowerCase();
    const meta = USER_MEDIA_KINDS[kind];
    const wantThumb = String(req.query.variant || '').toLowerCase() === 'thumb';
    if (!id) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'User id is required' } });
    }
    if (!meta) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'kind must be profile|aadhaar|biodata|education|pcc' },
      });
    }
    const disposition =
      String(req.query.disposition || '').toLowerCase() === 'attachment' ? 'attachment' : 'inline';
    try {
      const result = await pool.query(
        `SELECT id, username, aadhaar, profile_json
         FROM users
         WHERE id::text = $1
            OR aadhaar = $1
            OR COALESCE(profile_json->>'firebaseUid', '') = $1
         LIMIT 1`,
        [id],
      );
      if (!result.rows.length) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
      }
      const row = result.rows[0];
      const profile = asObject(row.profile_json);
      let localPath = null;
      for (const key of meta.localKeys) {
        if (isLocalMediaPath(profile[key])) {
          localPath = String(profile[key]).trim().replace(/\\/g, '/');
          break;
        }
      }
      const abs = localPath
        ? resolveMediaAbsWithThumb(config.dataRoot, localPath, {
          thumb: wantThumb && kind === 'profile',
        })
        : null;
      const fileBase = firstNonEmptyString(row.username, row.aadhaar, row.id) || 'user';
      if (abs && fs.existsSync(abs)) {
        const ext = path.extname(abs) || '';
        res.setHeader('Content-Type', contentTypeForMediaPath(abs, meta.contentType));
        res.setHeader(
          'Content-Disposition',
          `${disposition}; filename="${String(`${fileBase}-${kind}${ext}`).replace(/"/g, '')}"`,
        );
        res.setHeader('Cache-Control', 'private, max-age=300');
        return fs.createReadStream(abs).pipe(res);
      }
      const remote = pickHttpUrl(...meta.remoteKeys.map((k) => profile[k]));
      if (remote) return res.redirect(302, remote);
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'User media not available' },
      });
    } catch (error) {
      logger.error?.('Admin user media failed', { error: error.message, id, kind });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not serve user media' },
      });
    }
  });

  app.get('/api/v1/admin/integrations/emaap', ...adminOnly, async (_req, res) => {
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }
    const status = getEmaapCredentialsStatus({
      dataRoot: config.dataRoot,
      jwtSecret: config.jwtSecret,
    });
    // Never include path or decrypt notes in client responses.
    return res.json({
      data: {
        configured: status.configured,
        status: status.status,
        label: status.label,
        userIdMasked: status.userIdMasked,
        passwordSet: status.passwordSet,
        masterOtpSet: status.masterOtpSet,
        updatedAt: status.updatedAt,
      },
    });
  });

  app.put('/api/v1/admin/integrations/emaap', ...adminOnly, async (req, res) => {
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const status = saveEmaapCredentials(
        {
          userId: body.userId,
          password: body.password,
          masterOtp: body.masterOtp,
        },
        { dataRoot: config.dataRoot, jwtSecret: config.jwtSecret },
      );
      logger.info?.('eMaap credentials saved', {
        configured: status.configured,
        userIdMasked: status.userIdMasked,
      });
      return res.json({
        data: {
          configured: status.configured,
          status: status.status,
          label: status.label,
          userIdMasked: status.userIdMasked,
          passwordSet: status.passwordSet,
          masterOtpSet: status.masterOtpSet,
          updatedAt: status.updatedAt,
        },
      });
    } catch (error) {
      if (error.code === 'VALIDATION') {
        return res.status(400).json({
          error: { code: 'VALIDATION', message: error.message },
        });
      }
      logger.error?.('eMaap credentials save failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not save eMaap credentials' },
      });
    }
  });

  function yesonePublicData(status) {
    const sync = publicYesoneSyncStatus(
      readYesoneSyncStatus({ dataRoot: config.dataRoot }),
      { dataRoot: config.dataRoot },
    );
    return {
      configured: status.configured,
      status: status.status,
      label: status.label,
      userIdMasked: status.userIdMasked,
      passwordSet: status.passwordSet,
      baseUrl: status.baseUrl,
      updatedAt: status.updatedAt,
      sync,
    };
  }

  app.get('/api/v1/admin/integrations/yesone', ...adminOnly, async (_req, res) => {
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }
    const status = getYesoneCredentialsStatus({
      dataRoot: config.dataRoot,
      jwtSecret: config.jwtSecret,
    });
    return res.json({ data: yesonePublicData(status) });
  });

  app.put('/api/v1/admin/integrations/yesone', ...adminOnly, async (req, res) => {
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const status = saveYesoneCredentials(
        {
          userId: body.userId,
          password: body.password,
          baseUrl: body.baseUrl,
        },
        { dataRoot: config.dataRoot, jwtSecret: config.jwtSecret },
      );
      logger.info?.('Yes One credentials saved', {
        configured: status.configured,
        userIdMasked: status.userIdMasked,
        baseUrl: status.baseUrl,
      });
      return res.json({ data: yesonePublicData(status) });
    } catch (error) {
      if (error.code === 'VALIDATION') {
        return res.status(400).json({
          error: { code: 'VALIDATION', message: error.message },
        });
      }
      logger.error?.('Yes One credentials save failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not save Yes One credentials' },
      });
    }
  });

  app.post('/api/v1/admin/integrations/yesone/sync', ...adminOnly, async (_req, res) => {
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }
    const creds = getYesoneCredentialsStatus({
      dataRoot: config.dataRoot,
      jwtSecret: config.jwtSecret,
    });
    if (!creds.configured) {
      return res.status(400).json({
        error: {
          code: 'YESONE_NOT_CONFIGURED',
          message: 'Connect Yes One credentials before syncing',
        },
      });
    }
    try {
      const syncStatus = triggerYesoneSyncNow({
        dataRoot: config.dataRoot,
        trigger: 'manual',
      });
      logger.info?.('Yes One sync triggered', {
        running: syncStatus.running,
        trigger: 'manual',
      });
      return res.json({
        data: yesonePublicData(creds),
      });
    } catch (error) {
      if (error.code === 'SYNC_BUSY') {
        return res.status(409).json({
          error: { code: 'SYNC_BUSY', message: error.message },
        });
      }
      logger.error?.('Yes One sync trigger failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not start yesgatc sync' },
      });
    }
  });

  function razorpayPublicData(status) {
    const webhookUrl = resolveRazorpayWebhookUrl(config);
    const envSecret = resolveRazorpayWebhookSecret({
      dataRoot: config.dataRoot,
      jwtSecret: config.jwtSecret,
      webhookSecretEnv: config.razorpayWebhookSecret,
    });
    return {
      configured: status.configured,
      status: status.status,
      label: status.label,
      keyIdMasked: status.keyIdMasked,
      keySecretSet: status.keySecretSet,
      webhookSecretSet: Boolean(status.webhookSecretSet || envSecret.source === 'env'),
      webhookUrl,
      webhookUrlAlias: 'https://gatc.yesweigh.in/api/v1/webhooks/razorpay',
      updatedAt: status.updatedAt,
    };
  }

  app.get('/api/v1/admin/integrations/razorpay', ...adminOnly, async (_req, res) => {
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }
    let status;
    try {
      status = bootstrapRazorpayFromEnv(config);
    } catch (error) {
      logger.warn?.('Razorpay env bootstrap skipped', { error: error.message });
      status = getRazorpayCredentialsStatus({
        dataRoot: config.dataRoot,
        jwtSecret: config.jwtSecret,
      });
    }
    return res.json({ data: razorpayPublicData(status) });
  });

  app.put('/api/v1/admin/integrations/razorpay', ...adminOnly, async (req, res) => {
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const keyId = String(body.keyId || '').trim();
      const keySecret = String(body.keySecret || '').trim();
      const webhookOnly = Boolean(String(body.webhookSecret || '').trim()) && !keyId && !keySecret;
      const status = webhookOnly
        ? saveRazorpayWebhookSecret(
          { webhookSecret: body.webhookSecret },
          { dataRoot: config.dataRoot, jwtSecret: config.jwtSecret },
        )
        : saveRazorpayCredentials(
          {
            keyId: body.keyId,
            keySecret: body.keySecret,
            ...(Object.prototype.hasOwnProperty.call(body, 'webhookSecret')
              ? { webhookSecret: body.webhookSecret }
              : {}),
          },
          { dataRoot: config.dataRoot, jwtSecret: config.jwtSecret },
        );
      logger.info?.('Razorpay credentials saved', {
        configured: status.configured,
        keyIdMasked: status.keyIdMasked,
        webhookSecretSet: status.webhookSecretSet,
        webhookOnly,
      });
      return res.json({ data: razorpayPublicData(status) });
    } catch (error) {
      if (error.code === 'VALIDATION' || error.code === 'NOT_CONFIGURED') {
        return res.status(400).json({
          error: { code: error.code, message: error.message },
        });
      }
      logger.error?.('Razorpay credentials save failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not save Razorpay credentials' },
      });
    }
  });

  app.post('/api/v1/admin/integrations/razorpay/test-order', ...adminOnly, async (req, res) => {
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const order = await createRazorpayTestOrder(
        {
          amountInr: body.amountInr ?? body.amount,
          receipt: body.receipt,
          note: body.note || body.notes,
        },
        { dataRoot: config.dataRoot, jwtSecret: config.jwtSecret },
      );
      logger.info?.('Razorpay test order created', {
        orderId: order.orderId,
        amountInr: order.amountInr,
        live: order.live,
      });
      return res.json({
        data: {
          ...order,
          limits: razorpayTestLimits,
          warning: order.live
            ? 'LIVE keys — this charges real money. Keep the amount small.'
            : 'Test-mode keys.',
        },
      });
    } catch (error) {
      if (error.code === 'VALIDATION' || error.code === 'NOT_CONFIGURED') {
        return res.status(error.code === 'NOT_CONFIGURED' ? 400 : 400).json({
          error: { code: error.code, message: error.message },
        });
      }
      if (error.code === 'RAZORPAY') {
        logger.warn?.('Razorpay test order API error', { status: error.status, message: error.message });
        return res.status(502).json({
          error: { code: 'RAZORPAY', message: error.message },
        });
      }
      logger.error?.('Razorpay test order failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not create Razorpay test order' },
      });
    }
  });

  app.post('/api/v1/admin/integrations/razorpay/verify-payment', ...adminOnly, async (req, res) => {
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const result = verifyRazorpayPaymentSignature(body, {
        dataRoot: config.dataRoot,
        jwtSecret: config.jwtSecret,
      });
      logger.info?.('Razorpay payment signature checked', {
        verified: result.verified,
        orderId: result.orderId,
        paymentId: result.paymentId,
      });
      if (!result.verified) {
        logger.warn?.('Razorpay Checkout signature mismatch', {
          orderId: result.orderId,
          paymentId: result.paymentId,
          hint: 'HMAC uses key_secret over order_id|payment_id (hex); not webhook secret',
        });
        return res.status(400).json({
          error: { code: 'SIGNATURE_INVALID', message: 'Payment signature verification failed' },
          data: result,
        });
      }
      return res.json({ data: result });
    } catch (error) {
      if (error.code === 'VALIDATION' || error.code === 'NOT_CONFIGURED') {
        return res.status(400).json({
          error: { code: error.code, message: error.message },
        });
      }
      logger.error?.('Razorpay payment verify failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not verify Razorpay payment' },
      });
    }
  });

  app.get('/api/v1/admin/integrations/emaap/apis', ...adminOnly, async (_req, res) => {
    try {
      const catalog = getEmaapApiCatalog({ dataRoot: config.dataRoot });
      return res.json({
        data: {
          version: catalog.version,
          source: catalog.source,
          updatedAt: catalog.updatedAt,
          baseUrl: catalog.baseUrl,
          notes: catalog.notes,
          counts: catalog.counts,
          v1: catalog.v1,
          v2: catalog.v2,
        },
      });
    } catch (error) {
      logger.error?.('eMaap API catalog load failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not load eMaap API catalog' },
      });
    }
  });

  function publicZohoStatus(status) {
    return {
      configured: status.configured,
      status: status.status,
      label: status.label,
      organizationId: status.organizationId,
      organizationName: status.organizationName || null,
      clientIdMasked: status.clientIdMasked,
      refreshTokenSet: status.refreshTokenSet,
      accountsBase: status.accountsBase,
      connectedVia: status.connectedVia,
      updatedAt: status.updatedAt,
      oauthClientConfigured: status.oauthClientConfigured,
      redirectUri: status.redirectUri,
      embedMode: 'popup',
      note: status.oauthClientConfigured
        ? null
        : 'Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET on the VPS (Bench Cloud client from ecs.benchpc). OAuth uses the registered ECS redirect and bridges back to GATC.',
    };
  }

  app.get('/api/v1/admin/integrations/zoho', ...adminOnly, async (_req, res) => {
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }
    // Status from encrypted store only — do not re-bootstrap from ZOHO_REFRESH_TOKEN after Disconnect.
    // Backfill organizationName for older Connected stores that only saved the id.
    let status = getZohoCredentialsStatus(zohoStatusOpts(config));
    if (status.configured && status.organizationId && !status.organizationName) {
      try {
        status = await ensureZohoOrganizationName(config);
      } catch {
        /* keep id-only status */
      }
    }
    return res.json({ data: publicZohoStatus(status) });
  });

  app.get('/api/v1/admin/integrations/zoho/oauth/start', ...adminOnly, async (req, res) => {
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }
    if (!zohoOAuthClientConfigured(config)) {
      return res.status(503).json({
        error: {
          code: 'ZOHO_MISCONFIGURED',
          message: 'ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET are not set on the server',
          redirectUri: resolveZohoRedirectUri(config),
        },
      });
    }
    try {
      const state = createOAuthState({ adminUserId: req.user?.id || req.user?.sub || null });
      const authorizeUrl = buildZohoAuthorizeUrl(config, { state });
      return res.json({
        data: {
          authorizeUrl,
          redirectUri: resolveZohoRedirectUri(config),
          embedMode: 'popup',
          accountsBase: String(config.zohoAccountsBase || 'https://accounts.zoho.in'),
        },
      });
    } catch (error) {
      logger.error?.('Zoho OAuth start failed', { error: error.message });
      return res.status(500).json({
        error: { code: error.code || 'INTERNAL', message: error.message || 'Could not start Zoho OAuth' },
      });
    }
  });

  async function runZohoOAuthComplete(req, res, { asJson }) {
    const code = String((req.body && req.body.code) || req.query.code || '').trim();
    const state = String((req.body && req.body.state) || req.query.state || '').trim();
    const zohoError = String((req.body && req.body.error) || req.query.error || '').trim();

    const sendFail = (status, message) => {
      if (asJson) {
        return res.status(status).json({
          error: { code: 'ZOHO_OAUTH', message },
          data: {
            source: 'gatc-zoho-oauth',
            type: 'zoho-oauth',
            ok: false,
            message,
            configured: false,
            needsOrgPick: false,
            pickState: null,
            organizations: [],
          },
        });
      }
      return res.status(status).type('html').send(oauthPopupResultHtml({
        ok: false,
        message,
        configured: false,
      }));
    };

    if (zohoError) {
      const desc = String((req.body && req.body.error_description) || req.query.error_description || zohoError);
      return sendFail(400, desc);
    }
    if (!code || !state) {
      return sendFail(400, 'Missing authorization code or state');
    }
    if (!config.jwtSecret) {
      return sendFail(503, 'Server auth is misconfigured');
    }

    try {
      const pick = await completeZohoOAuthCallback(config, { code, state });
      logger.info?.('Zoho OAuth awaiting org pick', {
        orgs: (pick.organizations || []).length,
        pickState: Boolean(pick.pickState),
      });
      if (asJson) {
        return res.status(200).json({ data: zohoOAuthCompletePayload(pick) });
      }
      return res.status(200).type('html').send(oauthPopupResultHtml({
        ok: true,
        message: 'Signed in — choose a Zoho Books organization in Settings.',
        configured: false,
        needsOrgPick: true,
        pickState: pick.pickState,
        organizations: pick.organizations,
      }));
    } catch (error) {
      logger.error?.('Zoho OAuth callback failed', { error: error.message, code: error.code });
      return sendFail(400, error.message || 'OAuth failed');
    }
  }

  // Public callback (Zoho / ECS bridge). Validated via one-time state — no Bearer token.
  app.get('/api/v1/integrations/zoho/oauth/callback', async (req, res) => {
    await runZohoOAuthComplete(req, res, { asJson: false });
  });

  // JSON complete for ECS server-side bridge (popup stays on ecs.benchpc.online).
  app.get('/api/v1/integrations/zoho/oauth/complete', async (req, res) => {
    await runZohoOAuthComplete(req, res, { asJson: true });
  });
  app.post('/api/v1/integrations/zoho/oauth/complete', async (req, res) => {
    await runZohoOAuthComplete(req, res, { asJson: true });
  });

  app.get('/api/v1/admin/integrations/zoho/pending', ...adminOnly, async (req, res) => {
    const pickState = String(req.query.pickState || '').trim();
    const pending = getZohoPendingPick(pickState);
    if (!pending) {
      return res.status(404).json({
        error: { code: 'PICK_EXPIRED', message: 'Organization pick expired — Sign in with Zoho again' },
      });
    }
    return res.json({ data: pending });
  });

  app.post('/api/v1/admin/integrations/zoho/save', ...adminOnly, async (req, res) => {
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const status = finalizeZohoOrgPick(config, {
        pickState: body.pickState,
        organizationId: body.organizationId,
      });
      logger.info?.('Zoho org saved', {
        configured: status.configured,
        organizationId: status.organizationId,
      });
      return res.json({ data: publicZohoStatus(status) });
    } catch (error) {
      if (error.code === 'VALIDATION' || error.code === 'PICK_EXPIRED' || error.code === 'ZOHO_MISCONFIGURED') {
        return res.status(error.code === 'PICK_EXPIRED' ? 409 : 400).json({
          error: { code: error.code, message: error.message },
        });
      }
      logger.error?.('Zoho org save failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not save Zoho organization' },
      });
    }
  });

  app.put('/api/v1/admin/integrations/zoho', ...adminOnly, async (req, res) => {
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      let status;
      const refreshToken = String(body.refreshToken || '').trim();
      if (refreshToken) {
        status = connectZohoWithRefreshToken(config, {
          refreshToken,
          organizationId: body.organizationId,
        });
      } else if (body.organizationId != null) {
        status = updateZohoOrganizationId(body.organizationId, zohoStatusOpts(config));
      } else {
        return res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: 'Provide refreshToken to connect, or organizationId to update mapping',
          },
        });
      }
      logger.info?.('Zoho credentials updated', {
        configured: status.configured,
        connectedVia: status.connectedVia,
      });
      return res.json({ data: publicZohoStatus(status) });
    } catch (error) {
      if (error.code === 'VALIDATION' || error.code === 'ZOHO_MISCONFIGURED' || error.code === 'NOT_CONNECTED') {
        return res.status(error.code === 'NOT_CONNECTED' ? 409 : 400).json({
          error: { code: error.code, message: error.message },
        });
      }
      logger.error?.('Zoho credentials update failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not update Zoho credentials' },
      });
    }
  });

  app.delete('/api/v1/admin/integrations/zoho', ...adminOnly, async (_req, res) => {
    if (!config.jwtSecret) {
      return res.status(503).json({
        error: { code: 'AUTH_MISCONFIGURED', message: 'JWT_SECRET is not configured' },
      });
    }
    try {
      const status = disconnectZoho(config);
      logger.info?.('Zoho credentials cleared');
      return res.json({ data: publicZohoStatus(status) });
    } catch (error) {
      logger.error?.('Zoho disconnect failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not disconnect Zoho' },
      });
    }
  });

  app.get('/api/v1/admin/customers', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const { limit, offset } = parsePaging(req.query);
    const q = String(req.query.q || '').trim();
    try {
      const params = [];
      const clauses = [];
      if (q) {
        params.push(`%${q}%`);
        const i = params.length;
        clauses.push(`(c.name ILIKE $${i} OR c.phone ILIKE $${i} OR c.district ILIKE $${i} OR rc.company_name ILIKE $${i})`);
      }
      const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const total = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM customers c
         LEFT JOIN regional_centers rc ON rc.id = c.rc_id
         ${whereSql}`,
        params,
      );
      params.push(limit, offset);
      const rows = await pool.query(
        `SELECT c.id, c.name, c.phone, c.email, c.address, c.pincode, c.state, c.district,
                c.created_at, rc.code AS rc_code, rc.company_name AS rc_name
         FROM customers c
         LEFT JOIN regional_centers rc ON rc.id = c.rc_id
         ${whereSql}
         ORDER BY c.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return res.json({
        data: { total: total.rows[0]?.total || 0, limit, offset, items: rows.rows },
      });
    } catch (error) {
      logger.error?.('Admin customers list failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not list customers' },
      });
    }
  });

  app.get('/api/v1/admin/quota', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const { limit, offset } = parsePaging(req.query);
    const q = String(req.query.q || '').trim();
    try {
      const params = [];
      const clauses = [`rc.code <> 'DEMO-RC'`, 'rc.active = TRUE'];
      if (q) {
        params.push(`%${q}%`);
        const i = params.length;
        clauses.push(`(rc.code ILIKE $${i} OR rc.company_name ILIKE $${i} OR rc.district ILIKE $${i})`);
      }
      const whereSql = `WHERE ${clauses.join(' AND ')}`;
      const total = await pool.query(
        `SELECT COUNT(*)::int AS total FROM regional_centers rc ${whereSql}`,
        params,
      );
      params.push(limit, offset);
      const rows = await pool.query(
        `SELECT rc.id, rc.code, rc.company_name AS name, rc.district, rc.state, rc.fees_json,
                COALESCE((rc.fees_json->>'ovQuota')::numeric, 0)::int AS allotted,
                COALESCE((rc.fees_json->>'ovQuotaUsed')::numeric, 0)::int AS used,
                COALESCE((rc.fees_json->>'ovQuotaReserved')::numeric, 0)::int AS reserved,
                rc.fees_json->>'ovQuotaPeriod' AS period,
                rc.fees_json->>'ovQuotaUpdatedAt' AS quota_updated_at
         FROM regional_centers rc
         ${whereSql}
         ORDER BY rc.company_name ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const items = rows.rows.map((row) => {
        const allotted = Number(row.allotted) || 0;
        const used = Number(row.used) || 0;
        const reserved = Number(row.reserved) || 0;
        const available = Math.max(0, allotted - used);
        const { fees_json, ...rest } = row;
        return {
          ...rest,
          allotted,
          used,
          reserved,
          available,
          utilization_pct: allotted > 0 ? Math.round((used / allotted) * 1000) / 10 : 0,
        };
      });
      const summary = items.reduce(
        (acc, row) => {
          acc.allotted += row.allotted;
          acc.used += row.used;
          acc.reserved += row.reserved;
          acc.available += row.available;
          return acc;
        },
        { allotted: 0, used: 0, reserved: 0, available: 0 },
      );
      return res.json({
        data: {
          total: total.rows[0]?.total || 0,
          limit,
          offset,
          items,
          summary,
        },
      });
    } catch (error) {
      logger.error?.('Admin quota list failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not list RC quota' },
      });
    }
  });

  const VEHICLE_MEDIA_KINDS = {
    photo: {
      localKeys: ['vehiclePhotoLocalPath', 'vehiclePhotoPath'],
      remoteKeys: ['vehiclePhotoUrl', 'photoUrl', 'photo_url'],
      contentType: 'image/jpeg',
    },
    rc: {
      localKeys: ['rcDocLocalPath', 'rcDocPath'],
      remoteKeys: ['rcDocUrl', 'rc_url'],
      contentType: 'application/pdf',
    },
    insurance: {
      localKeys: ['insuranceDocLocalPath', 'insuranceDocPath'],
      remoteKeys: ['insuranceDocUrl', 'insurance_url'],
      contentType: 'application/pdf',
    },
    pollution: {
      localKeys: ['pollutionDocLocalPath', 'pollutionDocPath'],
      remoteKeys: ['pollutionDocUrl', 'pollution_url'],
      contentType: 'application/pdf',
    },
    f2_weight: {
      localKeys: ['f2WeightDocLocalPath', 'f2WeightDocPath'],
      remoteKeys: ['f2WeightDocUrl', 'f2_weight_url'],
      contentType: 'application/pdf',
    },
  };

  function vehicleLocalPathFromDocs(docs, localKeys = []) {
    for (const key of localKeys) {
      const value = docs?.[key];
      if (isLocalMediaPath(value)) return String(value).trim().replace(/\\/g, '/');
    }
    return null;
  }

  function vehicleRemoteUrlFromDocs(docs, remoteKeys = []) {
    return pickHttpUrl(...remoteKeys.map((k) => docs?.[k]));
  }

  function vehicleMediaApiUrl(vehicleId, kind, { thumb = false } = {}) {
    if (!vehicleId || !kind) return null;
    const q = new URLSearchParams({ kind: String(kind) });
    if (thumb) q.set('variant', 'thumb');
    return `/api/v1/admin/vehicles/${encodeURIComponent(vehicleId)}/media?${q.toString()}`;
  }

  function resolveVehicleMediaUrl(docs, vehicleId, kind, { thumb = false } = {}) {
    const meta = VEHICLE_MEDIA_KINDS[kind];
    if (!meta) return null;
    const localPath = vehicleLocalPathFromDocs(docs, meta.localKeys);
    if (localPath && vehicleId) return vehicleMediaApiUrl(vehicleId, kind, { thumb });
    return vehicleRemoteUrlFromDocs(docs, meta.remoteKeys);
  }

  function mapVehicleDocs(docsJson, vehicleId) {
    const docs = docsJson && typeof docsJson === 'object' ? docsJson : {};
    const photoUrl = resolveVehicleMediaUrl(docs, vehicleId, 'photo');
    const photoThumbUrl = resolveVehicleMediaUrl(docs, vehicleId, 'photo', { thumb: true });
    const photoLocal = vehicleLocalPathFromDocs(docs, VEHICLE_MEDIA_KINDS.photo.localKeys);
    return {
      photo_url: photoUrl,
      photo_thumb_url: photoThumbUrl || photoUrl,
      vehicle_photo_url: photoUrl,
      photo_path: photoLocal,
      photo_storage: photoLocal ? 'local' : (photoUrl ? 'remote' : null),
      docs: {
        rc_url: resolveVehicleMediaUrl(docs, vehicleId, 'rc'),
        insurance_url: resolveVehicleMediaUrl(docs, vehicleId, 'insurance'),
        pollution_url: resolveVehicleMediaUrl(docs, vehicleId, 'pollution'),
        f2_weight_url: resolveVehicleMediaUrl(docs, vehicleId, 'f2_weight'),
      },
      approval_status: docs.approvalStatus || docs.approval_status || null,
      source_firebase_id: docs.sourceFirebaseId || null,
    };
  }

  function shapeVehicleRow(row, { includeDocsJson = false } = {}) {
    const mapped = mapVehicleDocs(row.docs_json, row.id);
    const out = {
      id: row.id,
      rc_id: row.rc_id,
      brand: row.brand,
      model: row.model,
      year: row.year,
      reg_number: row.reg_number,
      rc_validity: row.rc_validity,
      insurance_validity: row.insurance_validity,
      pollution_validity: row.pollution_validity,
      f2_weight_validity: row.f2_weight_validity,
      active: row.active,
      created_at: row.created_at,
      updated_at: row.updated_at,
      source_firebase_id: row.source_firebase_id || mapped.source_firebase_id,
      rc_code: row.rc_code,
      rc_name: row.rc_name,
      photo_url: mapped.photo_url,
      photo_thumb_url: mapped.photo_thumb_url,
      vehicle_photo_url: mapped.vehicle_photo_url,
      photo_path: mapped.photo_path,
      photo_storage: mapped.photo_storage,
      docs: mapped.docs,
      approval_status: mapped.approval_status,
    };
    if (includeDocsJson) out.docs_json = row.docs_json || {};
    return out;
  }

  app.get('/api/v1/admin/vehicles', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const { limit, offset } = parsePaging(req.query);
    const q = String(req.query.q || '').trim();
    const tab = String(req.query.tab || req.query.status || 'All').trim();
    try {
      const params = [];
      const clauses = [];
      if (q) {
        params.push(`%${q}%`);
        const i = params.length;
        clauses.push(
          `(v.brand ILIKE $${i} OR v.model ILIKE $${i} OR v.reg_number ILIKE $${i} OR rc.company_name ILIKE $${i} OR rc.code ILIKE $${i})`,
        );
      }
      if (tab === 'Active') clauses.push('v.active = TRUE');
      else if (tab === 'Inactive') clauses.push('v.active = FALSE');
      else if (tab === 'Expired') {
        clauses.push(`(
          (v.rc_validity IS NOT NULL AND v.rc_validity < CURRENT_DATE)
          OR (v.insurance_validity IS NOT NULL AND v.insurance_validity < CURRENT_DATE)
          OR (v.pollution_validity IS NOT NULL AND v.pollution_validity < CURRENT_DATE)
          OR (v.f2_weight_validity IS NOT NULL AND v.f2_weight_validity < CURRENT_DATE)
        )`);
      }
      const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const total = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM vehicles v
         LEFT JOIN regional_centers rc ON rc.id = v.rc_id
         ${whereSql}`,
        params,
      );
      const counts = await pool.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE active)::int AS active,
           COUNT(*) FILTER (WHERE NOT active)::int AS inactive,
           COUNT(*) FILTER (WHERE
             (rc_validity IS NOT NULL AND rc_validity < CURRENT_DATE)
             OR (insurance_validity IS NOT NULL AND insurance_validity < CURRENT_DATE)
             OR (pollution_validity IS NOT NULL AND pollution_validity < CURRENT_DATE)
             OR (f2_weight_validity IS NOT NULL AND f2_weight_validity < CURRENT_DATE)
           )::int AS expired
         FROM vehicles`,
      );
      params.push(limit, offset);
      const rows = await pool.query(
        `SELECT v.id, v.rc_id, v.brand, v.model, v.year, v.reg_number,
                v.rc_validity, v.insurance_validity, v.pollution_validity, v.f2_weight_validity,
                v.active, v.created_at, v.updated_at, v.source_firebase_id, v.docs_json,
                rc.code AS rc_code, rc.company_name AS rc_name
         FROM vehicles v
         LEFT JOIN regional_centers rc ON rc.id = v.rc_id
         ${whereSql}
         ORDER BY v.updated_at DESC NULLS LAST, v.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return res.json({
        data: {
          total: total.rows[0]?.total || 0,
          limit,
          offset,
          tab,
          items: rows.rows.map((row) => shapeVehicleRow(row)),
          summary: counts.rows[0] || { total: 0, active: 0, inactive: 0, expired: 0 },
        },
      });
    } catch (error) {
      if (String(error.message || '').includes('vehicles')) {
        return res.json({
          data: {
            total: 0,
            limit,
            offset,
            items: [],
            summary: { total: 0, active: 0, inactive: 0, expired: 0 },
            note: 'Run migration 004_domain_parity.sql',
          },
        });
      }
      logger.error?.('Admin vehicles list failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not list vehicles' },
      });
    }
  });

  app.get('/api/v1/admin/vehicles/:id', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'Vehicle id is required' },
      });
    }
    try {
      const result = await pool.query(
        `SELECT v.id, v.rc_id, v.brand, v.model, v.year, v.reg_number,
                v.rc_validity, v.insurance_validity, v.pollution_validity, v.f2_weight_validity,
                v.active, v.created_at, v.updated_at, v.source_firebase_id, v.docs_json,
                rc.code AS rc_code, rc.company_name AS rc_name
         FROM vehicles v
         LEFT JOIN regional_centers rc ON rc.id = v.rc_id
         WHERE v.id::text = $1 OR v.source_firebase_id = $1
         LIMIT 1`,
        [id],
      );
      if (!result.rows.length) {
        return res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Vehicle not found' },
        });
      }
      return res.json({ data: shapeVehicleRow(result.rows[0], { includeDocsJson: true }) });
    } catch (error) {
      if (String(error.message || '').includes('vehicles')) {
        return res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Vehicle not found' },
        });
      }
      logger.error?.('Admin vehicle detail failed', { error: error.message, id });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not load vehicle' },
      });
    }
  });

  function parseOptionalDate(value) {
    if (value == null || value === '') return null;
    const s = String(value).trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }

  function readVehicleBody(body = {}) {
    return {
      rc_id: trimOrNull(body.rc_id || body.rcId),
      brand: trimOrNull(body.brand) || '',
      model: trimOrNull(body.model) || '',
      year: trimOrNull(body.year),
      reg_number: trimOrNull(body.reg_number || body.regNumber) || '',
      rc_validity: parseOptionalDate(body.rc_validity || body.rcValidity),
      insurance_validity: parseOptionalDate(body.insurance_validity || body.insuranceValidity),
      pollution_validity: parseOptionalDate(body.pollution_validity || body.pollutionValidity),
      f2_weight_validity: parseOptionalDate(body.f2_weight_validity || body.f2WeightValidity),
      active: body.active == null ? undefined : Boolean(body.active),
    };
  }

  app.post('/api/v1/admin/vehicles', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const fields = readVehicleBody(req.body || {});
    if (!fields.rc_id) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'rc_id is required' },
      });
    }
    if (!fields.brand && !fields.reg_number) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'brand or reg_number is required' },
      });
    }
    try {
      const rows = await pool.query(
        `INSERT INTO vehicles (
           rc_id, brand, model, year, reg_number,
           rc_validity, insurance_validity, pollution_validity, f2_weight_validity, active
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,TRUE))
         RETURNING id, rc_id, brand, model, year, reg_number,
                   rc_validity, insurance_validity, pollution_validity, f2_weight_validity,
                   active, created_at, updated_at, source_firebase_id, docs_json`,
        [
          fields.rc_id,
          fields.brand,
          fields.model,
          fields.year,
          fields.reg_number,
          fields.rc_validity,
          fields.insurance_validity,
          fields.pollution_validity,
          fields.f2_weight_validity,
          fields.active !== false,
        ],
      );
      const joined = await pool.query(
        `SELECT v.id, v.rc_id, v.brand, v.model, v.year, v.reg_number,
                v.rc_validity, v.insurance_validity, v.pollution_validity, v.f2_weight_validity,
                v.active, v.created_at, v.updated_at, v.source_firebase_id, v.docs_json,
                rc.code AS rc_code, rc.company_name AS rc_name
         FROM vehicles v
         LEFT JOIN regional_centers rc ON rc.id = v.rc_id
         WHERE v.id = $1`,
        [rows.rows[0].id],
      );
      return res.status(201).json({
        data: shapeVehicleRow(joined.rows[0], { includeDocsJson: true }),
      });
    } catch (error) {
      if (String(error.code) === '23503') {
        return res.status(400).json({
          error: { code: 'VALIDATION', message: 'rc_id does not match a regional centre' },
        });
      }
      logger.error?.('Admin vehicle create failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not create vehicle' },
      });
    }
  });

  app.patch('/api/v1/admin/vehicles/:id', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'Vehicle id is required' },
      });
    }
    const fields = readVehicleBody(req.body || {});
    try {
      const existing = await pool.query(
        `SELECT id FROM vehicles WHERE id::text = $1 OR source_firebase_id = $1 LIMIT 1`,
        [id],
      );
      if (!existing.rowCount) {
        return res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Vehicle not found' },
        });
      }
      await pool.query(
        `UPDATE vehicles SET
           rc_id = COALESCE($2, rc_id),
           brand = COALESCE($3, brand),
           model = COALESCE($4, model),
           year = COALESCE($5, year),
           reg_number = COALESCE($6, reg_number),
           rc_validity = COALESCE($7, rc_validity),
           insurance_validity = COALESCE($8, insurance_validity),
           pollution_validity = COALESCE($9, pollution_validity),
           f2_weight_validity = COALESCE($10, f2_weight_validity),
           active = COALESCE($11, active),
           updated_at = NOW()
         WHERE id = $1`,
        [
          existing.rows[0].id,
          fields.rc_id,
          fields.brand || null,
          fields.model || null,
          fields.year,
          fields.reg_number || null,
          fields.rc_validity,
          fields.insurance_validity,
          fields.pollution_validity,
          fields.f2_weight_validity,
          fields.active,
        ],
      );
      const joined = await pool.query(
        `SELECT v.id, v.rc_id, v.brand, v.model, v.year, v.reg_number,
                v.rc_validity, v.insurance_validity, v.pollution_validity, v.f2_weight_validity,
                v.active, v.created_at, v.updated_at, v.source_firebase_id, v.docs_json,
                rc.code AS rc_code, rc.company_name AS rc_name
         FROM vehicles v
         LEFT JOIN regional_centers rc ON rc.id = v.rc_id
         WHERE v.id = $1`,
        [existing.rows[0].id],
      );
      return res.json({
        data: shapeVehicleRow(joined.rows[0], { includeDocsJson: true }),
      });
    } catch (error) {
      if (String(error.code) === '23503') {
        return res.status(400).json({
          error: { code: 'VALIDATION', message: 'rc_id does not match a regional centre' },
        });
      }
      logger.error?.('Admin vehicle update failed', { error: error.message, id });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not update vehicle' },
      });
    }
  });

  app.get('/api/v1/admin/vehicles/:id/media', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    const kind = String(req.query.kind || 'photo').trim().toLowerCase();
    const meta = VEHICLE_MEDIA_KINDS[kind];
    const wantThumb = String(req.query.variant || '').toLowerCase() === 'thumb';
    if (!id) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Vehicle id is required' } });
    }
    if (!meta) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'kind must be photo|rc|insurance|pollution|f2_weight' },
      });
    }
    const disposition =
      String(req.query.disposition || '').toLowerCase() === 'attachment' ? 'attachment' : 'inline';
    try {
      const result = await pool.query(
        `SELECT id, reg_number, docs_json
         FROM vehicles
         WHERE id::text = $1 OR source_firebase_id = $1
         LIMIT 1`,
        [id],
      );
      if (!result.rows.length) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Vehicle not found' } });
      }
      const row = result.rows[0];
      const docs = row.docs_json && typeof row.docs_json === 'object' ? row.docs_json : {};
      const localPath = vehicleLocalPathFromDocs(docs, meta.localKeys);
      const abs = localPath
        ? resolveMediaAbsWithThumb(config.dataRoot, localPath, {
          thumb: wantThumb && kind === 'photo',
        })
        : null;
      const fileBase = firstNonEmptyString(row.reg_number, row.id) || 'vehicle';
      if (abs && fs.existsSync(abs)) {
        const ext = path.extname(abs) || '';
        res.setHeader('Content-Type', contentTypeForMediaPath(abs, meta.contentType));
        res.setHeader(
          'Content-Disposition',
          `${disposition}; filename="${String(`${fileBase}-${kind}${ext}`).replace(/"/g, '')}"`,
        );
        res.setHeader('Cache-Control', 'private, max-age=300');
        return fs.createReadStream(abs).pipe(res);
      }
      const remote = vehicleRemoteUrlFromDocs(docs, meta.remoteKeys);
      if (remote) return res.redirect(302, remote);
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Vehicle media not available locally or remotely' },
      });
    } catch (error) {
      logger.error?.('Admin vehicle media failed', { error: error.message, id, kind });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not serve vehicle media' },
      });
    }
  });

  app.get('/api/v1/admin/wallets', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const { limit, offset } = parsePaging(req.query);
    const q = String(req.query.q || '').trim();
    const view = String(req.query.view || req.query.tab || 'balances').trim().toLowerCase();
    try {
      if (view === 'tx' || view === 'ledger') {
        const params = [];
        const clauses = [];
        if (q) {
          params.push(`%${q}%`);
          const i = params.length;
          clauses.push(`(rc.code ILIKE $${i} OR rc.company_name ILIKE $${i} OR wl.entry_type ILIKE $${i})`);
        }
        const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const total = await pool.query(
          `SELECT COUNT(*)::int AS total
           FROM wallet_ledger wl
           LEFT JOIN regional_centers rc ON rc.id = wl.rc_id
           ${whereSql}`,
          params,
        );
        params.push(limit, offset);
        const rows = await pool.query(
          `SELECT wl.id, wl.rc_id, wl.entry_type, wl.amount_inr, wl.balance_after_inr,
                  wl.status, wl.created_at, rc.code AS rc_code, rc.company_name AS rc_name
           FROM wallet_ledger wl
           LEFT JOIN regional_centers rc ON rc.id = wl.rc_id
           ${whereSql}
           ORDER BY wl.created_at DESC
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        );
        const spendCredit = await pool.query(
          `SELECT
             COALESCE(SUM(ABS(amount_inr)) FILTER (WHERE entry_type = 'rv_payment'), 0)::float AS spend,
             COALESCE(SUM(ABS(amount_inr)) FILTER (WHERE entry_type IN ('top_up_credit', 'rv_refund')), 0)::float AS credits
           FROM wallet_ledger`,
        );
        const bal = await pool.query(
          `SELECT COALESCE(SUM(balance_inr), 0)::float AS total_balance,
                  COUNT(*)::int AS wallet_count
           FROM rc_wallets`,
        );
        return res.json({
          data: {
            total: total.rows[0]?.total || 0,
            limit,
            offset,
            view: 'tx',
            items: rows.rows,
            summary: {
              total_balance: bal.rows[0]?.total_balance || 0,
              spend: spendCredit.rows[0]?.spend || 0,
              credits: spendCredit.rows[0]?.credits || 0,
              wallet_count: bal.rows[0]?.wallet_count || 0,
            },
          },
        });
      }

      if (view === 'dues' || view === 'topup') {
        const params = [];
        const clauses = [];
        if (view === 'dues') clauses.push(`wt.status = 'pending'`);
        if (q) {
          params.push(`%${q}%`);
          const i = params.length;
          clauses.push(`(rc.code ILIKE $${i} OR rc.company_name ILIKE $${i} OR wt.note ILIKE $${i})`);
        }
        const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const total = await pool.query(
          `SELECT COUNT(*)::int AS total
           FROM wallet_top_ups wt
           LEFT JOIN regional_centers rc ON rc.id = wt.rc_id
           ${whereSql}`,
          params,
        );
        params.push(limit, offset);
        const rows = await pool.query(
          `SELECT wt.id, wt.rc_id, wt.amount_inr, wt.gross_amount_inr, wt.status,
                  wt.recharge_method, wt.note, wt.submitted_at, wt.reviewed_at,
                  rc.code AS rc_code, rc.company_name AS rc_name
           FROM wallet_top_ups wt
           LEFT JOIN regional_centers rc ON rc.id = wt.rc_id
           ${whereSql}
           ORDER BY wt.submitted_at DESC
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        );
        const bal = await pool.query(
          `SELECT COALESCE(SUM(balance_inr), 0)::float AS total_balance,
                  COUNT(*)::int AS wallet_count
           FROM rc_wallets`,
        );
        return res.json({
          data: {
            total: total.rows[0]?.total || 0,
            limit,
            offset,
            view,
            items: rows.rows,
            summary: {
              total_balance: bal.rows[0]?.total_balance || 0,
              spend: 0,
              credits: 0,
              wallet_count: bal.rows[0]?.wallet_count || 0,
            },
          },
        });
      }

      const params = [];
      const clauses = [`rc.code <> 'DEMO-RC'`, 'rc.active = TRUE'];
      if (q) {
        params.push(`%${q}%`);
        const i = params.length;
        clauses.push(`(rc.code ILIKE $${i} OR rc.company_name ILIKE $${i})`);
      }
      const whereSql = `WHERE ${clauses.join(' AND ')}`;
      const total = await pool.query(
        `SELECT COUNT(*)::int AS total FROM regional_centers rc ${whereSql}`,
        params,
      );
      params.push(limit, offset);
      const rows = await pool.query(
        `SELECT rc.id AS rc_id, rc.code AS rc_code, rc.company_name AS rc_name,
                COALESCE(w.balance_inr, 0)::float AS balance_inr,
                w.updated_at
         FROM regional_centers rc
         LEFT JOIN rc_wallets w ON w.rc_id = rc.id
         ${whereSql}
         ORDER BY COALESCE(w.balance_inr, 0) DESC, rc.company_name ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const spendCredit = await pool.query(
        `SELECT
           COALESCE(SUM(ABS(amount_inr)) FILTER (WHERE entry_type = 'rv_payment'), 0)::float AS spend,
           COALESCE(SUM(ABS(amount_inr)) FILTER (WHERE entry_type IN ('top_up_credit', 'rv_refund')), 0)::float AS credits
         FROM wallet_ledger`,
      );
      const bal = await pool.query(
        `SELECT COALESCE(SUM(balance_inr), 0)::float AS total_balance,
                COUNT(*)::int AS wallet_count
         FROM rc_wallets`,
      );
      return res.json({
        data: {
          total: total.rows[0]?.total || 0,
          limit,
          offset,
          view: 'balances',
          items: rows.rows,
          summary: {
            total_balance: bal.rows[0]?.total_balance || 0,
            spend: spendCredit.rows[0]?.spend || 0,
            credits: spendCredit.rows[0]?.credits || 0,
            wallet_count: bal.rows[0]?.wallet_count || 0,
          },
        },
      });
    } catch (error) {
      if (String(error.message || '').includes('rc_wallets')
        || String(error.message || '').includes('wallet_')) {
        return res.json({
          data: {
            total: 0,
            limit,
            offset,
            items: [],
            summary: { total_balance: 0, spend: 0, credits: 0, wallet_count: 0 },
            note: 'Run migration 004_domain_parity.sql',
          },
        });
      }
      logger.error?.('Admin wallets list failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not list wallets' },
      });
    }
  });
}
