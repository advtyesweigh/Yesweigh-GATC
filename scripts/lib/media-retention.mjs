/**
 * VPS local media retention (DATA_ROOT/media/yesgatc/…).
 *
 * OV (Original Verification)
 * - Keep all images until the certificate is generated/certified.
 * - Once certified (status certified/approved, or signed certificate PDF exists):
 *   delete all local images except one product-with-test-weight image.
 * - Keep kind: `scale_image` (product + test weight on the scale). Prefer this over
 *   `standard_weight` — do not keep both; standard_weight is purged after cert.
 * - Delete after cert: stamping, instrument_rear, verification_seal, installation,
 *   standard_weight, performer_*, old_invoice, and any other non-kept photo kinds.
 * - Always keep PDFs (signed / unsigned / emaap / old verification certificate).
 *
 * RV (Re-Verification)
 * - Keep all images on the VPS permanently (no post-cert purge).
 * - Always keep PDFs.
 *
 * Firebase `source_url` may remain until Firebase cutover; local `file_path` under
 * media/yesgatc/ is cleared (empty string) when a file is purged.
 */

import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Single OV post-cert keep: product image with test weight. */
export const OV_POST_CERT_KEEP_IMAGE_KIND = 'scale_image';

export const OV_POST_CERT_KEEP_IMAGE_KINDS = Object.freeze([OV_POST_CERT_KEEP_IMAGE_KIND]);

/** PDF / certificate document kinds — never purge for OV or RV. */
export const PDF_MEDIA_KINDS = Object.freeze([
  'certificate_pdf',
  'signed_certificate_pdf',
  'emaap_certificate_pdf',
  'old_verification_certificate',
]);

/** Evidence / photo kinds that sync and image backfill may download. */
export const IMAGE_MEDIA_KINDS = Object.freeze([
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

const PDF_KIND_SET = new Set(PDF_MEDIA_KINDS);
const IMAGE_KIND_SET = new Set(IMAGE_MEDIA_KINDS);
const OV_KEEP_SET = new Set(OV_POST_CERT_KEEP_IMAGE_KINDS);

export function isPdfMediaKind(kind) {
  return PDF_KIND_SET.has(String(kind || ''));
}

export function isImageMediaKind(kind) {
  return IMAGE_KIND_SET.has(String(kind || ''));
}

export function isLocalVpsMediaPath(filePath) {
  if (typeof filePath !== 'string') return false;
  const trimmed = filePath.trim().replace(/\\/g, '/');
  return trimmed.startsWith('media/yesgatc/');
}

export function isVerificationCertified({ status, certifiedAt } = {}) {
  const s = String(status || '').toLowerCase();
  if (s === 'certified' || s === 'approved') return true;
  return Boolean(certifiedAt);
}

/**
 * Whether a local image file for this kind should be retained on disk.
 * PDFs always retain; RV always retains images; OV retains all until certified,
 * then only OV_POST_CERT_KEEP_IMAGE_KINDS.
 */
export function shouldRetainLocalImage({ verificationType, kind, certified } = {}) {
  const k = String(kind || '');
  if (isPdfMediaKind(k)) return true;
  if (!isImageMediaKind(k) && !k) return true;
  const type = String(verificationType || '').toUpperCase();
  if (type === 'RV') return true;
  if (type !== 'OV') return true;
  if (!certified) return true;
  return OV_KEEP_SET.has(k);
}

/** Download policy mirrors retain policy for images. */
export function shouldDownloadImageLocally(opts) {
  return shouldRetainLocalImage(opts);
}

/**
 * Purge local OV post-cert images that are not the kept scale/product image.
 * Requires OV + certified + signed_certificate_pdf row. Never touches RV or PDFs.
 *
 * @returns {Promise<object>} stats
 */
export async function purgeOvPostCertLocalImages({
  pool,
  dataRoot,
  dryRun = true,
  limit = 0,
} = {}) {
  if (!pool) throw new Error('pool required');
  if (!dataRoot) throw new Error('dataRoot required');

  const stats = {
    dryRun: Boolean(dryRun),
    keepKind: OV_POST_CERT_KEEP_IMAGE_KIND,
    candidates: 0,
    filesDeleted: 0,
    rowsCleared: 0,
    missingFiles: 0,
    skippedRv: 0,
    skippedPdf: 0,
    bytesFreed: 0,
    byKind: {},
    errors: [],
  };

  let sql = `
    SELECT m.id AS media_id, m.kind, m.file_path,
           v.id AS verification_id, v.verification_type, v.status, v.certificate_number
    FROM verification_media m
    JOIN verifications v ON v.id = m.verification_id
    WHERE v.verification_type = 'OV'
      AND (v.status IN ('certified', 'approved') OR v.certified_at IS NOT NULL)
      AND m.file_path LIKE 'media/yesgatc/%'
      AND m.kind <> ALL($1::text[])
      AND NOT (m.kind = ANY($2::text[]))
      AND EXISTS (
        SELECT 1 FROM verification_media s
        WHERE s.verification_id = v.id
          AND s.kind = 'signed_certificate_pdf'
          AND (
            (s.file_path IS NOT NULL AND BTRIM(s.file_path) <> '')
            OR (s.source_url IS NOT NULL AND s.source_url ~* '^https?://')
          )
      )
    ORDER BY m.created_at NULLS LAST`;
  const params = [[...OV_POST_CERT_KEEP_IMAGE_KINDS], [...PDF_MEDIA_KINDS]];
  if (limit > 0) {
    sql += ` LIMIT $3`;
    params.push(limit);
  }

  const { rows } = await pool.query(sql, params);
  stats.candidates = rows.length;

  for (const row of rows) {
    const kind = String(row.kind || '');
    if (String(row.verification_type || '').toUpperCase() === 'RV') {
      stats.skippedRv += 1;
      continue;
    }
    if (isPdfMediaKind(kind)) {
      stats.skippedPdf += 1;
      continue;
    }
    stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;

    const rel = String(row.file_path || '').trim().replace(/\\/g, '/');
    if (!isLocalVpsMediaPath(rel)) continue;
    const abs = join(dataRoot, rel);

    try {
      if (existsSync(abs)) {
        if (!dryRun) {
          try {
            stats.bytesFreed += statSync(abs).size || 0;
          } catch {
            /* ignore */
          }
          unlinkSync(abs);
        }
        stats.filesDeleted += 1;
      } else {
        stats.missingFiles += 1;
      }

      if (!dryRun) {
        await pool.query(
          `UPDATE verification_media
           SET file_path = ''
           WHERE id = $1 AND file_path LIKE 'media/yesgatc/%'`,
          [row.media_id],
        );
        stats.rowsCleared += 1;
      } else {
        stats.rowsCleared += 1;
      }
    } catch (error) {
      if (stats.errors.length < 25) {
        stats.errors.push({
          mediaId: row.media_id,
          kind,
          verificationId: row.verification_id,
          error: error.message,
        });
      }
    }
  }

  return stats;
}
