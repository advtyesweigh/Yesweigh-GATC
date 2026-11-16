-- Regional centre profile fields mirrored from yesgatc RC admin users.
-- Fixes empty Super Admin "Location" (yesgatc uses `place`, not district/state).

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS place TEXT;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS gst_number TEXT;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS pan_card TEXT;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS zoho_customer_id TEXT;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS zoho_expense_account_id TEXT;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS zoho_expense_account_name TEXT;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS certification_method TEXT;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS standard_weights_cert_number TEXT;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS standard_weights_cert_date TEXT;

ALTER TABLE regional_centers
  ADD COLUMN IF NOT EXISTS standard_weights_cert_expiry TEXT;

CREATE INDEX IF NOT EXISTS regional_centers_place_idx
  ON regional_centers (place)
  WHERE place IS NOT NULL AND place <> '';

-- Backfill from linked RC_ADMIN profile_json (populated by yesgatc user sync).
UPDATE regional_centers rc
SET
  place = COALESCE(NULLIF(BTRIM(rc.place), ''), NULLIF(BTRIM(src.place), '')),
  gst_number = COALESCE(NULLIF(BTRIM(rc.gst_number), ''), NULLIF(BTRIM(src.gst_number), '')),
  pan_card = COALESCE(NULLIF(BTRIM(rc.pan_card), ''), NULLIF(BTRIM(src.pan_card), '')),
  zoho_customer_id = COALESCE(NULLIF(BTRIM(rc.zoho_customer_id), ''), NULLIF(BTRIM(src.zoho_id), '')),
  zoho_expense_account_id = COALESCE(
    NULLIF(BTRIM(rc.zoho_expense_account_id), ''),
    NULLIF(BTRIM(src.zoho_expense_account_id), '')
  ),
  zoho_expense_account_name = COALESCE(
    NULLIF(BTRIM(rc.zoho_expense_account_name), ''),
    NULLIF(BTRIM(src.zoho_expense_account_name), '')
  ),
  certification_method = COALESCE(
    NULLIF(BTRIM(rc.certification_method), ''),
    NULLIF(BTRIM(src.certification_method), '')
  ),
  standard_weights_cert_number = COALESCE(
    NULLIF(BTRIM(rc.standard_weights_cert_number), ''),
    NULLIF(BTRIM(src.standard_weights_cert_number), '')
  ),
  standard_weights_cert_date = COALESCE(
    NULLIF(BTRIM(rc.standard_weights_cert_date), ''),
    NULLIF(BTRIM(src.standard_weights_cert_date), '')
  ),
  standard_weights_cert_expiry = COALESCE(
    NULLIF(BTRIM(rc.standard_weights_cert_expiry), ''),
    NULLIF(BTRIM(src.standard_weights_cert_expiry), '')
  ),
  updated_at = NOW()
FROM (
  SELECT DISTINCT ON (u.rc_id)
    u.rc_id,
    u.profile_json->>'place' AS place,
    u.profile_json->>'gstNumber' AS gst_number,
    u.profile_json->>'panCard' AS pan_card,
    u.profile_json->>'zohoId' AS zoho_id,
    COALESCE(
      u.profile_json->>'zohoExpenseAccountId',
      u.profile_json->>'zoho_expense_account_id'
    ) AS zoho_expense_account_id,
    COALESCE(
      u.profile_json->>'zohoExpenseAccountName',
      u.profile_json->>'zoho_expense_account_name'
    ) AS zoho_expense_account_name,
    u.profile_json->>'certificationMethod' AS certification_method,
    u.profile_json->>'standardWeightsCertNumber' AS standard_weights_cert_number,
    u.profile_json->>'standardWeightsCertDate' AS standard_weights_cert_date,
    u.profile_json->>'standardWeightsCertExpiry' AS standard_weights_cert_expiry
  FROM users u
  WHERE u.role = 'RC_ADMIN'
    AND u.rc_id IS NOT NULL
  ORDER BY u.rc_id, u.updated_at DESC NULLS LAST
) src
WHERE rc.id = src.rc_id;
