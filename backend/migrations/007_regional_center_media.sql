-- YesGATC RC media / PDF-signer layout as first-class columns
-- (previously only partially mirrored in fees_json).

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS logo_url TEXT;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS seal_url TEXT;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS standard_weights_cert_url TEXT;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS pan_card_url TEXT;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS pdf_signer_sign_url TEXT;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS pdf_signer_sign_scale DOUBLE PRECISION;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS pdf_signer_sign_x DOUBLE PRECISION;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS pdf_signer_sign_y DOUBLE PRECISION;

-- Backfill from fees_json (sync historically stored logo/seal there).
UPDATE regional_centers
SET
  logo_url = COALESCE(NULLIF(BTRIM(logo_url), ''), NULLIF(BTRIM(fees_json->>'logoUrl'), '')),
  seal_url = COALESCE(NULLIF(BTRIM(seal_url), ''), NULLIF(BTRIM(fees_json->>'sealUrl'), '')),
  standard_weights_cert_url = COALESCE(
    NULLIF(BTRIM(standard_weights_cert_url), ''),
    NULLIF(BTRIM(fees_json->>'standardWeightsCertUrl'), '')
  ),
  pan_card_url = COALESCE(
    NULLIF(BTRIM(pan_card_url), ''),
    NULLIF(BTRIM(fees_json->>'panCardUrl'), '')
  ),
  pdf_signer_sign_url = COALESCE(
    NULLIF(BTRIM(pdf_signer_sign_url), ''),
    NULLIF(BTRIM(fees_json->>'pdfSignerSignUrl'), '')
  ),
  pdf_signer_sign_scale = COALESCE(
    pdf_signer_sign_scale,
    NULLIF(fees_json->>'pdfSignerSignScale', '')::double precision
  ),
  pdf_signer_sign_x = COALESCE(
    pdf_signer_sign_x,
    NULLIF(fees_json->>'pdfSignerSignX', '')::double precision
  ),
  pdf_signer_sign_y = COALESCE(
    pdf_signer_sign_y,
    NULLIF(fees_json->>'pdfSignerSignY', '')::double precision
  ),
  updated_at = NOW()
WHERE fees_json IS NOT NULL
  AND fees_json <> '{}'::jsonb;

-- Backfill cert URL from linked RC_ADMIN profile_json when still empty.
UPDATE regional_centers rc
SET
  logo_url = COALESCE(NULLIF(BTRIM(rc.logo_url), ''), NULLIF(BTRIM(src.logo_url), '')),
  seal_url = COALESCE(NULLIF(BTRIM(rc.seal_url), ''), NULLIF(BTRIM(src.seal_url), '')),
  standard_weights_cert_url = COALESCE(
    NULLIF(BTRIM(rc.standard_weights_cert_url), ''),
    NULLIF(BTRIM(src.standard_weights_cert_url), '')
  ),
  pan_card_url = COALESCE(NULLIF(BTRIM(rc.pan_card_url), ''), NULLIF(BTRIM(src.pan_card_url), '')),
  pdf_signer_sign_url = COALESCE(
    NULLIF(BTRIM(rc.pdf_signer_sign_url), ''),
    NULLIF(BTRIM(src.pdf_signer_sign_url), '')
  ),
  pdf_signer_sign_scale = COALESCE(rc.pdf_signer_sign_scale, src.pdf_signer_sign_scale),
  pdf_signer_sign_x = COALESCE(rc.pdf_signer_sign_x, src.pdf_signer_sign_x),
  pdf_signer_sign_y = COALESCE(rc.pdf_signer_sign_y, src.pdf_signer_sign_y),
  updated_at = NOW()
FROM (
  SELECT DISTINCT ON (u.rc_id)
    u.rc_id,
    u.profile_json->>'logoUrl' AS logo_url,
    u.profile_json->>'sealUrl' AS seal_url,
    u.profile_json->>'standardWeightsCertUrl' AS standard_weights_cert_url,
    u.profile_json->>'panCardUrl' AS pan_card_url,
    u.profile_json->>'pdfSignerSignUrl' AS pdf_signer_sign_url,
    NULLIF(u.profile_json->>'pdfSignerSignScale', '')::double precision AS pdf_signer_sign_scale,
    NULLIF(u.profile_json->>'pdfSignerSignX', '')::double precision AS pdf_signer_sign_x,
    NULLIF(u.profile_json->>'pdfSignerSignY', '')::double precision AS pdf_signer_sign_y
  FROM users u
  WHERE u.role = 'RC_ADMIN'
    AND u.rc_id IS NOT NULL
  ORDER BY u.rc_id, u.updated_at DESC NULLS LAST
) src
WHERE rc.id = src.rc_id;
