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

function mediaHttpUrl(sourceUrl, filePath) {
  return pickHttpUrl(sourceUrl, filePath);
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
  const signedPdfUrl = mediaHttpUrl(row.signed_pdf_source_url, row.signed_pdf_file_path);
  const certificatePdfUrl = mediaHttpUrl(row.cert_pdf_source_url, row.cert_pdf_file_path);
  const downloadUrl = signedPdfUrl || certificatePdfUrl;
  const productImageUrl = pickHttpUrl(
    row.scale_image_source_url,
    row.scale_image_file_path,
    row.product_image_path,
  );
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
      if (status) {
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
        where.push(`(name ILIKE $1 OR model_no ILIKE $1 OR model_id ILIKE $1 OR manufacturer_brand_series ILIKE $1)`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = await pool.query(`SELECT COUNT(*)::int AS total FROM products ${whereSql}`, params);
      params.push(limit, offset);
      const rows = await pool.query(
        `SELECT id, model_id, model_no, name, type_of_instrument, manufacturer_brand_series,
                accuracy_class, capacities, unit_of_measurement, model_approval_no,
                pas_pre_allotted, active, sort_order
         FROM products
         ${whereSql}
         ORDER BY sort_order ASC, name ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return res.json({
        data: { total: total.rows[0]?.total || 0, limit, offset, items: rows.rows },
      });
    } catch (error) {
      logger.error?.('Admin products list failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not list products' },
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
    return {
      configured: status.configured,
      status: status.status,
      label: status.label,
      userIdMasked: status.userIdMasked,
      passwordSet: status.passwordSet,
      baseUrl: status.baseUrl,
      updatedAt: status.updatedAt,
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
}
