-- YesGATC Firebase import support: source IDs, certificate fields, DOCA certs.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS source_firebase_id TEXT;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS source_firebase_id TEXT;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS details_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE verifications
  ADD COLUMN IF NOT EXISTS source_firebase_id TEXT;

ALTER TABLE verifications
  ADD COLUMN IF NOT EXISTS certificate_number TEXT;

ALTER TABLE verifications
  ADD COLUMN IF NOT EXISTS details_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE verification_media
  ADD COLUMN IF NOT EXISTS source_url TEXT;

ALTER TABLE verification_media
  ADD COLUMN IF NOT EXISTS source_storage_path TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS products_source_firebase_id_uidx
  ON products (source_firebase_id)
  WHERE source_firebase_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS customers_source_firebase_id_uidx
  ON customers (source_firebase_id)
  WHERE source_firebase_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS verifications_source_firebase_id_uidx
  ON verifications (source_firebase_id)
  WHERE source_firebase_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS verifications_certificate_number_idx
  ON verifications (certificate_number)
  WHERE certificate_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS doca_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_firebase_id TEXT NOT NULL UNIQUE,
  gatc_certificate_no TEXT,
  instrument_name TEXT,
  machine_name TEXT,
  belong_to TEXT,
  validity_date TEXT,
  upload_date TEXT,
  scraped_at TIMESTAMPTZ,
  certificate_pdf_path TEXT,
  certificate_pdf_url TEXT,
  instrument_photo_path TEXT,
  instrument_photo_url TEXT,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS doca_certificates_gatc_no_idx
  ON doca_certificates (gatc_certificate_no)
  WHERE gatc_certificate_no IS NOT NULL;
