/**
 * Import yesgatc certs dump into GATC VPS Postgres.
 *
 * Maps Firebase UIDs → regional_centers / users via profile_json.firebaseUid
 * and regional_centers.fees_json.firebaseUid (from prior user import).
 *
 * Usage:
 *   node scripts/import-yesgatc-certs.mjs --in=.tmp/yesgatc-certs-export.json
 *   node scripts/import-yesgatc-certs.mjs --dry-run
 *   node scripts/import-yesgatc-certs.mjs --download-media=certs
 *   node scripts/import-yesgatc-certs.mjs --download-media=none
 *   node scripts/import-yesgatc-certs.mjs --download-media=all
 *
 * Env:
 *   DATABASE_URL (or repo .env)
 *   DATA_ROOT     for media downloads (default from .env)
 *   FORCE_IMPORT=1 when NODE_ENV=production
 */

import { createRequire } from 'node:module';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const require = createRequire(join(REPO_ROOT, 'package.json'));
const pg = require('pg');
const dotenv = require('dotenv');

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

function argValue(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1).trim() : '';
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function parseTs(value) {
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

function extFor(contentType, url, fallback = '.bin') {
  if (contentType?.includes('pdf')) return '.pdf';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('webp')) return '.webp';
  const fromUrl = extname(String(url || '').split('?')[0] || '');
  if (fromUrl && fromUrl.length <= 5) return fromUrl;
  return fallback;
}

async function downloadTo(url, destPath) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  mkdirSync(dirname(destPath), { recursive: true });
  const body = response.body;
  if (!body) throw new Error('empty body');
  await pipeline(Readable.fromWeb(body), createWriteStream(destPath));
  return destPath;
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
     RETURNING id`,
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
  return result.rows[0].id;
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
    return id;
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
  return result.rows[0].id;
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
    parseTs(doc.submittedAt),
    parseTs(doc.approvedAt),
    parseTs(doc.certifiedAt),
    parseTs(doc.createdAt) || new Date().toISOString(),
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
    return id;
  }

  // application_number is UNIQUE — if collision with another row, null it and keep in details
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
    return result.rows[0].id;
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
      return result.rows[0].id;
    }
    throw error;
  }
}

async function replaceVerificationMedia(client, verificationId, mediaRows) {
  await client.query(`DELETE FROM verification_media WHERE verification_id = $1`, [
    verificationId,
  ]);
  for (const row of mediaRows) {
    await client.query(
      `INSERT INTO verification_media (
         verification_id, kind, file_path, content_type, source_url, source_storage_path
       ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        verificationId,
        row.kind,
        row.filePath,
        row.contentType,
        row.sourceUrl,
        row.sourceStoragePath,
      ],
    );
  }
}

async function upsertDoca(client, doc) {
  const details = { ...doc };
  delete details.id;
  const scrapedAt = parseTs(doc.scrapedAt);
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
       certificate_pdf_path = COALESCE(EXCLUDED.certificate_pdf_path, doca_certificates.certificate_pdf_path),
       certificate_pdf_url = EXCLUDED.certificate_pdf_url,
       instrument_photo_path = COALESCE(EXCLUDED.instrument_photo_path, doca_certificates.instrument_photo_path),
       instrument_photo_url = EXCLUDED.instrument_photo_url,
       details_json = EXCLUDED.details_json,
       updated_at = NOW()`,
    [
      doc.id,
      doc.gatcCertificateNo || null,
      doc.instrumentName || null,
      doc.machineName || null,
      doc.belongTo || null,
      doc.validityDate || null,
      doc.uploadDate || null,
      scrapedAt,
      doc.certificatePdfPath || null,
      doc.certificatePdfUrl || null,
      doc.instrumentPhotoPath || null,
      doc.instrumentPhotoUrl || null,
      JSON.stringify(details),
    ],
  );
}

async function maybeDownload({
  url,
  storagePath,
  contentType,
  dataRoot,
  relDir,
  kind,
  mode,
  isCert,
  stats,
}) {
  if (!url) {
    return {
      filePath: storagePath || '',
      downloaded: false,
    };
  }
  const should =
    mode === 'all' || (mode === 'certs' && isCert);
  if (!should || !dataRoot) {
    return { filePath: storagePath || url, downloaded: false };
  }
  const ext = extFor(contentType, url, isCert ? '.pdf' : '.bin');
  const rel = join(relDir, `${kind}${ext}`).replace(/\\/g, '/');
  const abs = join(dataRoot, rel);
  try {
    await downloadTo(url, abs);
    stats.downloaded += 1;
    return { filePath: rel, downloaded: true };
  } catch (error) {
    stats.downloadFailed += 1;
    stats.downloadErrors.push({ kind, error: error.message, urlHost: safeHost(url) });
    return { filePath: storagePath || url, downloaded: false };
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid)';
  }
}

async function main() {
  const dryRun = hasFlag('--dry-run');
  const downloadMode = (argValue('--download-media') || 'certs').toLowerCase();
  if (!['none', 'certs', 'all'].includes(downloadMode)) {
    throw new Error('--download-media must be none|certs|all');
  }
  const inPath = resolve(
    argValue('--in') || join(REPO_ROOT, '.tmp', 'yesgatc-certs-export.json'),
  );
  if (!existsSync(inPath)) throw new Error(`Dump not found: ${inPath}`);

  const databaseUrl = process.env.DATABASE_URL || '';
  const dataRoot = process.env.DATA_ROOT || '';
  const nodeEnv = process.env.NODE_ENV || 'development';
  const force = process.env.FORCE_IMPORT === '1';

  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (nodeEnv === 'production' && !force && !dryRun) {
    throw new Error('Refusing import in production without FORCE_IMPORT=1');
  }

  const dump = JSON.parse(readFileSync(inPath, 'utf8'));
  const products = Array.isArray(dump.products) ? dump.products : [];
  const customers = Array.isArray(dump.customers) ? dump.customers : [];
  const siteCalibrations = Array.isArray(dump.siteCalibrations)
    ? dump.siteCalibrations
    : [];
  const docaCertificates = Array.isArray(dump.docaCertificates)
    ? dump.docaCertificates
    : [];

  const stats = {
    dryRun,
    downloadMode,
    source: inPath,
    considered: {
      products: products.length,
      customers: customers.length,
      siteCalibrations: siteCalibrations.length,
      docaCertificates: docaCertificates.length,
    },
    imported: {
      products: 0,
      customers: 0,
      verifications: 0,
      verificationMedia: 0,
      docaCertificates: 0,
    },
    skipped: {
      customersMissingRc: 0,
      verificationsMissingRc: 0,
    },
    downloaded: 0,
    downloadFailed: 0,
    downloadErrors: [],
    mediaGap:
      downloadMode === 'none'
        ? 'URLs/paths only — no binary download'
        : downloadMode === 'certs'
          ? 'Downloaded certificate PDFs when URLs reachable; device photos kept as URL metadata'
          : 'Attempted all media downloads',
  };

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const { userByFirebase, rcByFirebase } = await loadUidMaps(client);
    if (rcByFirebase.size === 0) {
      throw new Error(
        'No regional_centers with fees_json.firebaseUid — run user import first',
      );
    }

    const productByFirebase = new Map();
    const customerByFirebase = new Map();

    // Short transactions per batch — downloads happen outside DB locks.
    await client.query('BEGIN');
    for (const doc of products) {
      const id = await upsertProduct(client, doc);
      if (id) {
        productByFirebase.set(doc.id, id);
        stats.imported.products += 1;
      }
    }
    await client.query('COMMIT');

    await client.query('BEGIN');
    for (const doc of customers) {
      const rcId = rcByFirebase.get(doc.rcId);
      if (!rcId) {
        stats.skipped.customersMissingRc += 1;
        continue;
      }
      const createdBy = doc.createdByUid
        ? userByFirebase.get(doc.createdByUid)?.id || null
        : null;
      const id = await upsertCustomer(client, doc, rcId, createdBy);
      customerByFirebase.set(doc.id, id);
      stats.imported.customers += 1;
    }
    await client.query('COMMIT');

    let i = 0;
    for (const doc of siteCalibrations) {
      i += 1;
      if (i % 500 === 0) {
        process.stderr.write(`verifications ${i}/${siteCalibrations.length}\n`);
      }
      const rcId = rcByFirebase.get(doc.rcId);
      if (!rcId) {
        stats.skipped.verificationsMissingRc += 1;
        continue;
      }
      const customerId = doc.customerId
        ? customerByFirebase.get(doc.customerId) || null
        : null;
      const productId = doc.productId
        ? productByFirebase.get(doc.productId) || null
        : null;
      const performerUserId = doc.vctId
        ? userByFirebase.get(doc.vctId)?.id || null
        : null;
      const createdBy = doc.createdByUid
        ? userByFirebase.get(doc.createdByUid)?.id || null
        : null;

      const mediaRows = [];
      for (const spec of MEDIA_FIELDS) {
        const url = doc[spec.url];
        const storagePath = spec.path ? doc[spec.path] : null;
        if (!url && !storagePath) continue;
        const dl = await maybeDownload({
          url,
          storagePath,
          contentType: spec.ct ? doc[spec.ct] : null,
          dataRoot,
          relDir: join('media', 'yesgatc', 'siteCalibrations', doc.id),
          kind: spec.kind,
          mode: downloadMode,
          isCert: Boolean(spec.cert),
          stats,
        });
        mediaRows.push({
          kind: spec.kind,
          filePath: dl.filePath || storagePath || url || '',
          contentType: spec.ct ? doc[spec.ct] || null : null,
          sourceUrl: url || null,
          sourceStoragePath: storagePath || null,
        });
      }

      await client.query('BEGIN');
      try {
        const verificationId = await upsertVerification(client, doc, {
          rcId,
          customerId,
          productId,
          performerUserId,
          createdBy,
        });
        stats.imported.verifications += 1;
        if (mediaRows.length) {
          await replaceVerificationMedia(client, verificationId, mediaRows);
          stats.imported.verificationMedia += mediaRows.length;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    for (const doc of docaCertificates) {
      let pdfPath = doc.certificatePdfPath || null;
      let photoPath = doc.instrumentPhotoPath || null;
      if (downloadMode !== 'none' && dataRoot && doc.certificatePdfUrl) {
        const dl = await maybeDownload({
          url: doc.certificatePdfUrl,
          storagePath: doc.certificatePdfPath,
          contentType: doc.certificatePdfContentType,
          dataRoot,
          relDir: join('media', 'yesgatc', 'docaCertificates', doc.id),
          kind: 'certificate_pdf',
          mode: downloadMode === 'all' || downloadMode === 'certs' ? 'certs' : 'none',
          isCert: true,
          stats,
        });
        if (dl.downloaded) pdfPath = dl.filePath;
      }
      if (downloadMode === 'all' && dataRoot && doc.instrumentPhotoUrl) {
        const dl = await maybeDownload({
          url: doc.instrumentPhotoUrl,
          storagePath: doc.instrumentPhotoPath,
          contentType: doc.instrumentPhotoContentType,
          dataRoot,
          relDir: join('media', 'yesgatc', 'docaCertificates', doc.id),
          kind: 'instrument_photo',
          mode: 'all',
          isCert: false,
          stats,
        });
        if (dl.downloaded) photoPath = dl.filePath;
      }
      await client.query('BEGIN');
      try {
        await upsertDoca(client, {
          ...doc,
          certificatePdfPath: pdfPath,
          instrumentPhotoPath: photoPath,
        });
        stats.imported.docaCertificates += 1;
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    const counts = await client.query(`
      SELECT 'products' AS t, COUNT(*)::int AS n FROM products
      UNION ALL SELECT 'customers', COUNT(*)::int FROM customers
      UNION ALL SELECT 'verifications', COUNT(*)::int FROM verifications
      UNION ALL SELECT 'verification_media', COUNT(*)::int FROM verification_media
      UNION ALL SELECT 'doca_certificates', COUNT(*)::int FROM doca_certificates
      UNION ALL SELECT 'verifications_with_cert_no', COUNT(*)::int FROM verifications WHERE certificate_number IS NOT NULL
    `);
    stats.dbCounts = Object.fromEntries(counts.rows.map((r) => [r.t, r.n]));

    if (stats.downloadErrors.length > 20) {
      stats.downloadErrors = stats.downloadErrors.slice(0, 20);
      stats.downloadErrorsTruncated = true;
    }

    console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
