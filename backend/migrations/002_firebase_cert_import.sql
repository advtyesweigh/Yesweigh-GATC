-- Minimal columns for faithful yesgatc Firebase cert/verification import.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS source_firebase_id TEXT;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS source_firebase_id TEXT;

ALTER TABLE verifications
  ADD COLUMN IF NOT EXISTS source_firebase_id TEXT,
  ADD COLUMN IF NOT EXISTS certificate_number TEXT,
  ADD COLUMN IF NOT EXISTS payload_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE verification_media
  ADD COLUMN IF NOT EXISTS source_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS products_source_firebase_id_uidx
  ON products (source_firebase_id)
  WHERE source_firebase_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS customers_source_firebase_id_uidx
  ON customers (source_firebase_id)
  WHERE source_firebase_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS verifications_source_firebase_id_uidx
  ON verifications (source_firebase_id)
  WHERE source_firebase_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS legacy_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_firebase_id TEXT NOT NULL UNIQUE,
  job_id TEXT,
  issued_at TIMESTAMPTZ,
  assigned_to TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
