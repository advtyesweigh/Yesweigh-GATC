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

function isLocalMediaPath(filePath) {
  if (typeof filePath !== 'string') return false;
  const trimmed = filePath.trim().replace(/\\/g, '/');
  return trimmed.startsWith('media/yesgatc/');
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

function resolveSafeMediaPath(dataRoot, relPath) {
  if (!dataRoot || !isLocalMediaPath(relPath)) return null;
  const normalized = String(relPath).trim().replace(/\\/g, '/');
  if (normalized.includes('..')) return null;
  const abs = path.resolve(dataRoot, normalized);
  const root = path.resolve(dataRoot);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return null;
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

function productSpecRowsFromCapacities(capacities) {
  const caps = asObject(capacities);
  const specs = Array.isArray(caps.specifications) ? caps.specifications : [];
  if (specs.length) {
    return specs.map((spec, index) => {
      const s = asObject(spec);
      return {
        id: firstNonEmptyString(s.id, `spec-${index + 1}`),
        maximum_capacity: firstFiniteNumber(s.maximumCapacity, s.max),
        verification_scale_interval: firstFiniteNumber(s.verificationScaleInterval, s.e),
        maximum_permissible_error: firstFiniteNumber(s.maximumPermissibleError, s.mpe),
        minimum_capacity: firstFiniteNumber(s.minimumCapacity, s.min),
        actual_scale_interval: firstFiniteNumber(s.actualScaleInterval, s.d),
        no_of_verification_intervals: firstFiniteNumber(s.noOfVerificationIntervals, s.n),
      };
    });
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
function productMediaHttpUrl(productId, kind, filePath, sourceUrl) {
  const remote = pickHttpUrl(sourceUrl, filePath);
  const local = isLocalMediaPath(filePath);
  if (productId && kind && (local || remote)) {
    const q = new URLSearchParams({ kind: String(kind) });
    return `/api/v1/admin/products/${productId}/media?${q.toString()}`;
  }
  return remote;
}

function shapeAdminProductRow(row) {
  const capacities = asObject(row.capacities);
  const specs = productSpecRowsFromCapacities(capacities);
  const primary = specs[0] || {};
  const imageUrl = productMediaHttpUrl(row.id, 'image', row.image_path, row.image_url);
  const approvalDocUrl = productMediaHttpUrl(
    row.id,
    'approval_doc',
    row.approval_doc_path,
    row.approval_doc_url,
  );
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
    image_storage: isLocalMediaPath(row.image_path) ? 'local' : (imageUrl ? 'remote' : null),
    approval_doc_path: row.approval_doc_path || null,
    approval_doc_url: approvalDocUrl,
    approval_doc_storage: isLocalMediaPath(row.approval_doc_path)
      ? 'local'
      : (approvalDocUrl ? 'remote' : null),
    source_firebase_id: row.source_firebase_id || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
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
         WHERE u.role = 'VCT' AND u.active = TRUE
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

      const counts = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM regional_centers WHERE active AND code <> 'DEMO-RC') AS regional_centers,
           (SELECT COUNT(*)::int FROM users WHERE role = 'VCT' AND active) AS vct,
           (SELECT COUNT(*)::int FROM products WHERE active) AS products,
           (SELECT COUNT(*)::int FROM customers) AS customers,
           (SELECT COUNT(*)::int FROM verifications) AS verifications`,
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
        const { fees_json, ...rest } = row;
        return {
          ...rest,
          logoUrl: logoFromFees(fees_json),
          logoPath: fees_json?.logoPath || null,
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
        where += ` AND (rc.company_name ILIKE $1 OR rc.code ILIKE $1 OR rc.district ILIKE $1 OR rc.state ILIKE $1)`;
      }
      // Subqueries avoid cartesian inflation from joining both verifications and users.
      const rows = await pool.query(
        `SELECT rc.id, rc.code, rc.company_name AS name, rc.contact_person, rc.phone, rc.email,
                rc.address, rc.state, rc.district, rc.pincode, rc.active,
                rc.laboratory_seal_identification AS seal_id,
                (SELECT COUNT(*)::int FROM verifications v WHERE v.rc_id = rc.id) AS verifications,
                (SELECT COUNT(*)::int FROM verifications v
                  WHERE v.rc_id = rc.id
                    AND (v.status = 'certified' OR v.certified_at IS NOT NULL)) AS certified,
                (SELECT COUNT(*)::int FROM users u
                  WHERE u.rc_id = rc.id AND u.role = 'VCT' AND u.active) AS vct_count
         FROM regional_centers rc
         ${where}
         ORDER BY certified DESC, rc.company_name ASC`,
        params,
      );
      return res.json({ data: { total: rows.rows.length, items: rows.rows } });
    } catch (error) {
      logger.error?.('Admin RC list failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not list regional centers' },
      });
    }
  });

  app.get('/api/v1/admin/products', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const { limit, offset } = parsePaging(req.query, { defaultLimit: 100 });
    const q = String(req.query.q || '').trim();
    try {
      const params = [];
      const where = [];
      if (q) {
        params.push(`%${q}%`);
        where.push(`(name ILIKE $1 OR model_no ILIKE $1 OR model_id ILIKE $1 OR manufacturer_brand_series ILIKE $1 OR model_approval_no ILIKE $1 OR COALESCE(capacities->>'yesoneSku','') ILIKE $1)`);
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
      const abs = resolveSafeMediaPath(config.dataRoot, filePath);
      if (abs && fs.existsSync(abs)) {
        const lower = abs.toLowerCase();
        let ct = 'application/octet-stream';
        if (/\.(jpe?g)$/.test(lower)) ct = 'image/jpeg';
        else if (lower.endsWith('.png')) ct = 'image/png';
        else if (lower.endsWith('.webp')) ct = 'image/webp';
        else if (lower.endsWith('.gif')) ct = 'image/gif';
        else if (lower.endsWith('.pdf')) ct = 'application/pdf';
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

  app.get('/api/v1/admin/users', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const role = String(req.query.role || '').trim().toUpperCase();
    const q = String(req.query.q || '').trim();
    const { limit, offset } = parsePaging(req.query, { defaultLimit: 100 });
    try {
      const params = [];
      const clauses = [];
      if (role && ['ADMIN', 'RC_ADMIN', 'VCT'].includes(role)) {
        params.push(role);
        clauses.push(`u.role = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        const i = params.length;
        clauses.push(`(u.username ILIKE $${i} OR u.aadhaar ILIKE $${i} OR u.phone ILIKE $${i} OR rc.company_name ILIKE $${i})`);
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
        `SELECT u.id, u.aadhaar, u.username, u.role, u.phone, u.email, u.active, u.workflow_mode,
                u.created_at, rc.code AS rc_code, rc.company_name AS rc_name
         FROM users u
         LEFT JOIN regional_centers rc ON rc.id = u.rc_id
         ${whereSql}
         ORDER BY u.role ASC, u.username ASC NULLS LAST, u.aadhaar ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return res.json({
        data: { total: total.rows[0]?.total || 0, limit, offset, items: rows.rows },
      });
    } catch (error) {
      logger.error?.('Admin users list failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not list users' },
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

  function vehicleMediaApiUrl(vehicleId, kind) {
    if (!vehicleId || !kind) return null;
    return `/api/v1/admin/vehicles/${encodeURIComponent(vehicleId)}/media?kind=${encodeURIComponent(kind)}`;
  }

  function resolveVehicleMediaUrl(docs, vehicleId, kind) {
    const meta = VEHICLE_MEDIA_KINDS[kind];
    if (!meta) return null;
    const localPath = vehicleLocalPathFromDocs(docs, meta.localKeys);
    if (localPath && vehicleId) return vehicleMediaApiUrl(vehicleId, kind);
    return vehicleRemoteUrlFromDocs(docs, meta.remoteKeys);
  }

  function mapVehicleDocs(docsJson, vehicleId) {
    const docs = docsJson && typeof docsJson === 'object' ? docsJson : {};
    const photoUrl = resolveVehicleMediaUrl(docs, vehicleId, 'photo');
    const photoLocal = vehicleLocalPathFromDocs(docs, VEHICLE_MEDIA_KINDS.photo.localKeys);
    return {
      photo_url: photoUrl,
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

  app.get('/api/v1/admin/vehicles/:id/media', ...adminOnly, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const id = String(req.params.id || '').trim();
    const kind = String(req.query.kind || 'photo').trim().toLowerCase();
    const meta = VEHICLE_MEDIA_KINDS[kind];
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
      const abs = localPath ? resolveSafeMediaPath(config.dataRoot, localPath) : null;
      const fileBase = firstNonEmptyString(row.reg_number, row.id) || 'vehicle';
      if (abs && fs.existsSync(abs)) {
        const ext = path.extname(abs) || '';
        res.setHeader('Content-Type', meta.contentType);
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
