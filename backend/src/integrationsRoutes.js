import { createAuthMiddleware } from './auth.js';
import { requireDb } from './http.js';
import { handleRazorpayWebhook } from './razorpayWebhook.js';

const MIN_QUERY_LENGTH = 3;
const MAX_QUERY_LENGTH = 80;
const MAX_RESULTS = 20;

/** Ported from yesgatc `lookupPublicCertificates.js` (Postgres instead of Firestore). */
function normalizeLookupQuery(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

function compactCertificateQuery(query) {
  return query.replace(/\\/g, '/').replace(/\s+/g, '').toUpperCase();
}

/**
 * HTTPS / webhook mirrors for yesgatc Cloud Functions that are portable as Express routes.
 * Firestore triggers are documented as app-level hooks (not auto-fired here).
 */
export function mountIntegrationsRoutes(app, { config, pool, logger }) {
  const { requireAuth, requireRole } = createAuthMiddleware({ config, pool, logger });

  app.get('/api/v1/public/certificates', async (req, res) => {
    if (!requireDb(res, pool, config)) return;
    const query = normalizeLookupQuery(req.query.q || req.query.query || '');
    if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: `Query must be ${MIN_QUERY_LENGTH}–${MAX_QUERY_LENGTH} characters`,
        },
      });
    }

    const compact = compactCertificateQuery(query);
    try {
      const rows = await pool.query(
        `SELECT v.id, v.certificate_number, v.serial_number, v.customer_name,
                v.verification_type, v.status, v.certified_at,
                v.certificate_pdf_url, v.signed_certificate_pdf_url,
                v.product_snapshot, v.payload_json,
                rc.company_name AS rc_name, rc.code AS rc_code
         FROM verifications v
         LEFT JOIN regional_centers rc ON rc.id = v.rc_id
         WHERE v.certificate_number IS NOT NULL
           AND (
             upper(replace(v.certificate_number, ' ', '')) = $1
             OR upper(v.serial_number) = upper($2)
             OR v.serial_number ILIKE $3
             OR v.certificate_number ILIKE $3
           )
         ORDER BY v.certified_at DESC NULLS LAST
         LIMIT $4`,
        [compact, query, `%${query}%`, MAX_RESULTS],
      );

      const items = rows.rows.map((row) => {
        const pdf =
          row.signed_certificate_pdf_url
          || row.certificate_pdf_url
          || row.payload_json?.signedCertificatePdfUrl
          || row.payload_json?.certificatePdfUrl
          || null;
        return {
          id: row.id,
          certificateNumber: row.certificate_number,
          serialNumber: row.serial_number,
          customerName: row.customer_name,
          verificationType: row.verification_type,
          status: row.status,
          certifiedAt: row.certified_at,
          pdfUrl: pdf,
          rcName: row.rc_name,
          rcCode: row.rc_code,
          productName: row.product_snapshot?.name || row.product_snapshot?.productName || null,
        };
      });

      return res.json({ data: { query, total: items.length, items } });
    } catch (error) {
      logger.error?.('Public certificate lookup failed', { error: error.message });
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Certificate lookup failed' },
      });
    }
  });

  const razorpayWebhookHandler = (req, res) => {
    const result = handleRazorpayWebhook(req, {
      dataRoot: config.dataRoot,
      jwtSecret: config.jwtSecret,
      webhookSecretEnv: config.razorpayWebhookSecret,
    });
    if (result.ok) {
      logger.info?.('Razorpay webhook accepted', {
        event: result.body?.data?.event,
        paymentId: result.body?.data?.paymentId,
        orderId: result.body?.data?.orderId,
        stored: result.body?.data?.stored,
      });
    } else {
      logger.warn?.('Razorpay webhook rejected', {
        status: result.status,
        code: result.body?.error?.code,
        hasSignature: Boolean(req.headers['x-razorpay-signature']),
      });
    }
    return res.status(result.status).json(result.body);
  };

  // Primary URL shown in Configure UI (paste into Razorpay Dashboard → Webhooks).
  app.post('/api/v1/integrations/razorpay/webhook', razorpayWebhookHandler);
  // Alias kept for older docs / yesgatc path parity.
  app.post('/api/v1/webhooks/razorpay', razorpayWebhookHandler);

  app.post('/api/v1/webhooks/yesone', (req, res) => {
    logger.info?.('Yesone inbound webhook received (stub)', {
      keys: req.body && typeof req.body === 'object' ? Object.keys(req.body).slice(0, 12) : [],
    });
    return res.status(501).json({
      error: {
        code: 'NOT_IMPLEMENTED',
        message: 'Yesone inbound not ported yet (yesgatc yesoneInbound)',
      },
    });
  });

  app.post('/api/v1/webhooks/emaap-otp', (req, res) => {
    return res.status(501).json({
      error: {
        code: 'NOT_IMPLEMENTED',
        message: 'eMaap OTP webhook deferred to Phase 5 (yesgatc emaapOtpWebhook)',
      },
    });
  });

  /** Inventory of Cloud Function → Express mapping (admin). */
  app.get(
    '/api/v1/admin/cloud-functions-map',
    requireAuth,
    requireRole('ADMIN'),
    (_req, res) => {
      return res.json({
        data: {
          sourceRepo: '/Users/mac/Projects/gatc/yesgatc/functions',
          portableHttp: [
            { firebase: 'lookupPublicCertificates', vps: 'GET /api/v1/public/certificates', status: 'ported' },
            { firebase: 'razorpayWebhook', vps: 'POST /api/v1/integrations/razorpay/webhook', status: 'ported', alias: 'POST /api/v1/webhooks/razorpay' },
            { firebase: 'yesoneInbound', vps: 'POST /api/v1/webhooks/yesone', status: 'stub' },
            { firebase: 'emaapOtpWebhook', vps: 'POST /api/v1/webhooks/emaap-otp', status: 'deferred' },
          ],
          callableNeedsAuthApi: [
            'createWalletTopUpOrder',
            'payRvFromWallet',
            'addRcGasSerials',
            'readSerialPlate',
            'submitRvWithZohoGate',
          ],
          firestoreTriggersNeedAppHooks: [
            'onSiteCalibrationRvZohoInvoice',
            'onSiteCalibrationYesoneWebhook',
            'onUserYesoneWebhook',
            'onUserProfileDeleted',
          ],
          schedulesNeedCron: [
            'reconcileZohoOutstandingScheduled',
            'moveStaleFailedVerificationsToDraft',
            'autoResubmitFailedSubmitVerifications',
          ],
        },
      });
    },
  );
}
