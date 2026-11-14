import { createAuthMiddleware } from './auth.js';
import { assertRcAccess } from './rbac.js';
import { FEATURE_CATALOG } from './domain/constants.js';
import {
  normalizeVerificationCreateBody,
  requestSourceForActor,
  validateDraftCreate,
} from './domain/verification.js';
import { parsePaging, requireDb, resolveRcIdForActor } from './http.js';

/**
 * RC-scoped domain APIs (customers, products, verifications, vehicles, laboratory).
 * Mirrors yesgatc Firestore collection access with Postgres + JWT RBAC.
 */
export function mountDomainRoutes(app, { config, pool, logger }) {
  const { requireAuth, requireRole } = createAuthMiddleware({ config, pool, logger });
  const authed = [requireAuth];
  const staff = [requireAuth, requireRole('ADMIN', 'RC_ADMIN', 'VCT')];
  const writers = [requireAuth, requireRole('ADMIN', 'RC_ADMIN', 'VCT')];
  const rcManagers = [requireAuth, requireRole('ADMIN', 'RC_ADMIN')];

  app.get('/api/v1/features', ...authed, (req, res) => {
    const role = req.user?.role;
    const items = FEATURE_CATALOG.filter(
      (f) => !f.roles.length || f.roles.includes(role),
    );
    return res.json({
      data: {
        source: 'yesgatc',
        items,
      },
    });
  });

  // —— Products (catalogue: all authenticated can list; ADMIN write later) ——
  app.get('/api/v1/products', ...staff, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const { limit, offset } = parsePaging(req.query, { defaultLimit: 100 });
    const q = String(req.query.q || '').trim();
    const activeOnly = String(req.query.active || '1') !== '0';
    try {
      const params = [];
      const where = [];
      if (activeOnly) where.push('active = TRUE');
      if (q) {
        params.push(`%${q}%`);
        where.push(
          `(name ILIKE $${params.length} OR model_no ILIKE $${params.length} OR model_id ILIKE $${params.length})`,
        );
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = await pool.query(`SELECT COUNT(*)::int AS total FROM products ${whereSql}`, params);
      params.push(limit, offset);
      const rows = await pool.query(
        `SELECT id, model_id, model_no, name, type_of_instrument, manufacturer_brand_series,
                accuracy_class, capacities, unit_of_measurement, model_approval_no,
                pas_pre_allotted, active, sort_order, image_path, image_url,
                approval_doc_path, approval_doc_url, supply_voltage
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
      logger.error?.('Products list failed', { error: error.message });
      return res.status(500).json({ error: { code: 'INTERNAL', message: 'Could not list products' } });
    }
  });

  // —— Customers ——
  app.get('/api/v1/customers', ...staff, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const scope = resolveRcIdForActor(req.user, req.query.rcId);
    if (scope.error && req.user.role !== 'ADMIN') {
      return res.status(scope.error.code === 'UNAUTHORIZED' ? 401 : 403).json({ error: scope.error });
    }
    const { limit, offset } = parsePaging(req.query);
    const q = String(req.query.q || '').trim();
    try {
      const params = [];
      const clauses = [];
      if (req.user.role !== 'ADMIN') {
        params.push(req.user.rcId);
        clauses.push(`c.rc_id = $${params.length}`);
      } else if (scope.rcId) {
        params.push(scope.rcId);
        clauses.push(`c.rc_id = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        const i = params.length;
        clauses.push(`(c.name ILIKE $${i} OR c.phone ILIKE $${i} OR c.district ILIKE $${i})`);
      }
      const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const total = await pool.query(
        `SELECT COUNT(*)::int AS total FROM customers c ${whereSql}`,
        params,
      );
      params.push(limit, offset);
      const rows = await pool.query(
        `SELECT c.id, c.rc_id, c.name, c.phone, c.email, c.address, c.pincode, c.state, c.district,
                c.location_lat, c.location_lng, c.shop_photo_path, c.created_at, c.updated_at
         FROM customers c
         ${whereSql}
         ORDER BY c.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return res.json({
        data: { total: total.rows[0]?.total || 0, limit, offset, items: rows.rows },
      });
    } catch (error) {
      logger.error?.('Customers list failed', { error: error.message });
      return res.status(500).json({ error: { code: 'INTERNAL', message: 'Could not list customers' } });
    }
  });

  app.post('/api/v1/customers', ...writers, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const scope = resolveRcIdForActor(req.user, req.body?.rcId);
    if (scope.error) {
      return res.status(scope.error.code === 'RC_REQUIRED' ? 400 : 403).json({ error: scope.error });
    }
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'name is required' } });
    }
    try {
      const rows = await pool.query(
        `INSERT INTO customers (
           rc_id, name, phone, email, address, pincode, state, district,
           location_lat, location_lng, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, rc_id, name, phone, email, address, pincode, state, district,
                   location_lat, location_lng, created_at`,
        [
          scope.rcId,
          name,
          String(req.body?.phone || '').trim() || null,
          String(req.body?.email || '').trim() || null,
          String(req.body?.address || '').trim() || null,
          String(req.body?.pincode || '').trim() || null,
          String(req.body?.state || '').trim() || null,
          String(req.body?.district || '').trim() || null,
          req.body?.locationLat ?? req.body?.location?.lat ?? null,
          req.body?.locationLng ?? req.body?.location?.lng ?? null,
          req.user.id,
        ],
      );
      return res.status(201).json({ data: rows.rows[0] });
    } catch (error) {
      logger.error?.('Customer create failed', { error: error.message });
      return res.status(500).json({ error: { code: 'INTERNAL', message: 'Could not create customer' } });
    }
  });

  // —— Verifications ——
  app.get('/api/v1/verifications', ...staff, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const { limit, offset } = parsePaging(req.query);
    const status = String(req.query.status || '').trim();
    const type = String(req.query.type || '').trim().toUpperCase();
    const q = String(req.query.q || '').trim();
    try {
      const params = [];
      const where = [];
      if (req.user.role !== 'ADMIN') {
        params.push(req.user.rcId);
        where.push(`v.rc_id = $${params.length}`);
      } else if (req.query.rcId) {
        params.push(String(req.query.rcId));
        where.push(`v.rc_id = $${params.length}`);
      }
      if (status) {
        params.push(status);
        where.push(`v.status = $${params.length}`);
      }
      if (type === 'OV' || type === 'RV') {
        params.push(type);
        where.push(`v.verification_type = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        const i = params.length;
        where.push(
          `(v.customer_name ILIKE $${i} OR v.serial_number ILIKE $${i} OR v.application_number ILIKE $${i} OR v.certificate_number ILIKE $${i})`,
        );
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = await pool.query(
        `SELECT COUNT(*)::int AS total FROM verifications v ${whereSql}`,
        params,
      );
      params.push(limit, offset);
      const rows = await pool.query(
        `SELECT v.id, v.rc_id, v.application_number, v.verification_type, v.job_kind, v.status,
                v.customer_id, v.customer_name, v.product_id, v.serial_number, v.certificate_number,
                v.ambient_temperature, v.relative_humidity, v.seal_identification_number,
                v.verification_location, v.verification_subject, v.submitted_at, v.certified_at,
                v.created_at, v.updated_at
         FROM verifications v
         ${whereSql}
         ORDER BY COALESCE(v.certified_at, v.submitted_at, v.created_at) DESC NULLS LAST
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return res.json({
        data: { total: total.rows[0]?.total || 0, limit, offset, items: rows.rows },
      });
    } catch (error) {
      logger.error?.('Verifications list failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not list verifications' },
      });
    }
  });

  app.get('/api/v1/verifications/:id', ...staff, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    try {
      const rows = await pool.query(
        `SELECT v.*,
                (SELECT COALESCE(json_agg(json_build_object(
                   'id', m.id, 'kind', m.kind, 'filePath', m.file_path, 'contentType', m.content_type
                 ) ORDER BY m.created_at), '[]'::json)
                 FROM verification_media m WHERE m.verification_id = v.id) AS media
         FROM verifications v
         WHERE v.id = $1
         LIMIT 1`,
        [req.params.id],
      );
      const row = rows.rows[0];
      if (!row) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Verification not found' } });
      }
      const access = assertRcAccess(req.user, row.rc_id);
      if (access !== true) {
        return res.status(403).json({ error: access });
      }
      return res.json({ data: row });
    } catch (error) {
      logger.error?.('Verification get failed', { error: error.message });
      return res.status(500).json({ error: { code: 'INTERNAL', message: 'Could not load verification' } });
    }
  });

  app.post('/api/v1/verifications', ...writers, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const scope = resolveRcIdForActor(req.user, req.body?.rcId);
    if (scope.error) {
      return res.status(scope.error.code === 'RC_REQUIRED' ? 400 : 403).json({ error: scope.error });
    }
    const input = normalizeVerificationCreateBody(req.body || {});
    const validationError = validateDraftCreate(input);
    if (validationError) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: validationError } });
    }

    let seal = input.sealIdentificationNumber;
    if (!seal) {
      try {
        const rc = await pool.query(
          `SELECT laboratory_seal_identification FROM regional_centers WHERE id = $1`,
          [scope.rcId],
        );
        seal = rc.rows[0]?.laboratory_seal_identification || null;
      } catch {
        /* ignore */
      }
    }

    const performedBy =
      req.user.role === 'VCT' ? 'vct' : req.user.role === 'RC_ADMIN' ? 'rc' : 'rc';
    const requestSource = requestSourceForActor(req.user.role, req.user.workflowMode);

    try {
      const rows = await pool.query(
        `INSERT INTO verifications (
           rc_id, verification_type, job_kind, status,
           customer_id, customer_name, product_id, product_snapshot,
           serial_number, serial_source, ambient_temperature, relative_humidity,
           seal_identification_number, verification_location, verification_subject,
           performed_by, performer_user_id, request_source, manufacturing_year, created_by
         ) VALUES (
           $1,$2,$3,'draft',
           $4,$5,$6,$7::jsonb,
           $8,$9,$10,$11,
           $12,$13,$14,
           $15,$16,$17,$18,$19
         )
         RETURNING id, rc_id, verification_type, job_kind, status, customer_name, serial_number,
                   seal_identification_number, created_at`,
        [
          scope.rcId,
          input.verificationType,
          input.jobKind,
          input.customerId,
          input.customerName,
          input.productId,
          JSON.stringify(input.productSnapshot || {}),
          input.serialNumber,
          input.serialSource,
          input.ambientTemperature,
          input.relativeHumidity,
          seal,
          input.verificationLocation,
          input.verificationSubject,
          performedBy,
          req.user.id,
          requestSource,
          Number.isFinite(input.manufacturingYear) ? input.manufacturingYear : null,
          req.user.id,
        ],
      );
      return res.status(201).json({ data: rows.rows[0] });
    } catch (error) {
      logger.error?.('Verification create failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Could not create verification draft' },
      });
    }
  });

  // —— Vehicles ——
  app.get('/api/v1/vehicles', ...staff, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const { limit, offset } = parsePaging(req.query);
    try {
      const params = [];
      const where = ['v.active = TRUE'];
      if (req.user.role !== 'ADMIN') {
        params.push(req.user.rcId);
        where.push(`v.rc_id = $${params.length}`);
      } else if (req.query.rcId) {
        params.push(String(req.query.rcId));
        where.push(`v.rc_id = $${params.length}`);
      }
      const whereSql = `WHERE ${where.join(' AND ')}`;
      const total = await pool.query(
        `SELECT COUNT(*)::int AS total FROM vehicles v ${whereSql}`,
        params,
      );
      params.push(limit, offset);
      const rows = await pool.query(
        `SELECT v.id, v.rc_id, v.brand, v.model, v.year, v.reg_number,
                v.rc_validity, v.insurance_validity, v.pollution_validity, v.f2_weight_validity,
                v.active, v.created_at
         FROM vehicles v
         ${whereSql}
         ORDER BY v.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return res.json({
        data: { total: total.rows[0]?.total || 0, limit, offset, items: rows.rows },
      });
    } catch (error) {
      if (String(error.message || '').includes('vehicles')) {
        return res.json({ data: { total: 0, limit, offset, items: [], note: 'Run migration 004_domain_parity.sql' } });
      }
      logger.error?.('Vehicles list failed', { error: error.message });
      return res.status(500).json({ error: { code: 'INTERNAL', message: 'Could not list vehicles' } });
    }
  });

  app.post('/api/v1/vehicles', ...rcManagers, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const scope = resolveRcIdForActor(req.user, req.body?.rcId);
    if (scope.error) {
      return res.status(scope.error.code === 'RC_REQUIRED' ? 400 : 403).json({ error: scope.error });
    }
    const brand = String(req.body?.brand || '').trim();
    const model = String(req.body?.model || '').trim();
    const regNumber = String(req.body?.regNumber || req.body?.reg_number || '').trim();
    if (!brand || !model || !regNumber) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'brand, model, and regNumber are required' },
      });
    }
    try {
      const rows = await pool.query(
        `INSERT INTO vehicles (
           rc_id, brand, model, year, reg_number,
           rc_validity, insurance_validity, pollution_validity, f2_weight_validity, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, rc_id, brand, model, year, reg_number, created_at`,
        [
          scope.rcId,
          brand,
          model,
          String(req.body?.year || '').trim() || null,
          regNumber,
          req.body?.rcValidity || null,
          req.body?.insuranceValidity || null,
          req.body?.pollutionValidity || null,
          req.body?.f2WeightValidity || null,
          req.user.id,
        ],
      );
      return res.status(201).json({ data: rows.rows[0] });
    } catch (error) {
      logger.error?.('Vehicle create failed', { error: error.message });
      return res.status(500).json({ error: { code: 'INTERNAL', message: 'Could not create vehicle' } });
    }
  });

  // —— Laboratory (seal on regional_centers) ——
  app.get('/api/v1/laboratory', ...staff, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const scope = resolveRcIdForActor(
      req.user,
      req.query.rcId || (req.user.role === 'ADMIN' ? null : req.user.rcId),
    );
    if (scope.error) {
      return res.status(scope.error.code === 'RC_REQUIRED' ? 400 : 403).json({ error: scope.error });
    }
    try {
      const rows = await pool.query(
        `SELECT id, code, company_name AS name, laboratory_seal_identification AS seal_id,
                district, state
         FROM regional_centers WHERE id = $1`,
        [scope.rcId],
      );
      if (!rows.rows[0]) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Regional center not found' } });
      }
      return res.json({ data: rows.rows[0] });
    } catch (error) {
      logger.error?.('Laboratory get failed', { error: error.message });
      return res.status(500).json({ error: { code: 'INTERNAL', message: 'Could not load laboratory' } });
    }
  });

  app.patch('/api/v1/laboratory', ...rcManagers, async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const scope = resolveRcIdForActor(req.user, req.body?.rcId);
    if (scope.error) {
      return res.status(scope.error.code === 'RC_REQUIRED' ? 400 : 403).json({ error: scope.error });
    }
    const seal = String(req.body?.sealId || req.body?.laboratorySealIdentification || '').trim();
    if (!seal) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'sealId is required' } });
    }
    try {
      const rows = await pool.query(
        `UPDATE regional_centers
         SET laboratory_seal_identification = $2, updated_at = NOW()
         WHERE id = $1
         RETURNING id, code, company_name AS name, laboratory_seal_identification AS seal_id`,
        [scope.rcId, seal],
      );
      if (!rows.rows[0]) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Regional center not found' } });
      }
      return res.json({ data: rows.rows[0] });
    } catch (error) {
      logger.error?.('Laboratory patch failed', { error: error.message });
      return res.status(500).json({ error: { code: 'INTERNAL', message: 'Could not update laboratory' } });
    }
  });

  // Wallet read stub (tables in 004; mutations later)
  app.get('/api/v1/wallet', ...[requireAuth, requireRole('ADMIN', 'RC_ADMIN')], async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const scope = resolveRcIdForActor(req.user, req.query.rcId);
    if (scope.error) {
      return res.status(scope.error.code === 'RC_REQUIRED' ? 400 : 403).json({ error: scope.error });
    }
    try {
      const bal = await pool.query(
        `SELECT rc_id, balance_inr, updated_at FROM rc_wallets WHERE rc_id = $1`,
        [scope.rcId],
      );
      return res.json({
        data: {
          rcId: scope.rcId,
          balanceInr: Number(bal.rows[0]?.balance_inr ?? 0),
          updatedAt: bal.rows[0]?.updated_at ?? null,
          status: 'scaffold',
          note: 'Razorpay / top-up callables not ported yet — see YESGATC_FEATURE_INVENTORY.md',
        },
      });
    } catch (error) {
      if (String(error.message || '').includes('rc_wallets')) {
        return res.json({
          data: {
            rcId: scope.rcId,
            balanceInr: 0,
            status: 'migration_pending',
            note: 'Run migration 004_domain_parity.sql',
          },
        });
      }
      logger.error?.('Wallet get failed', { error: error.message });
      return res.status(500).json({ error: { code: 'INTERNAL', message: 'Could not load wallet' } });
    }
  });
}
