-- Domain parity tables for yesgatc features (vehicles, wallet, serial banks).
-- Scaffold only: wallet/serial business APIs land in later phases.

CREATE TABLE IF NOT EXISTS vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rc_id UUID NOT NULL REFERENCES regional_centers (id),
  brand TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  year TEXT,
  reg_number TEXT NOT NULL DEFAULT '',
  rc_validity DATE,
  insurance_validity DATE,
  pollution_validity DATE,
  f2_weight_validity DATE,
  docs_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  source_firebase_id TEXT UNIQUE,
  created_by UUID REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vehicles_rc_id_idx ON vehicles (rc_id);

CREATE TABLE IF NOT EXISTS rc_wallets (
  rc_id UUID PRIMARY KEY REFERENCES regional_centers (id),
  balance_inr NUMERIC(12, 2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_top_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rc_id UUID NOT NULL REFERENCES regional_centers (id),
  amount_inr NUMERIC(12, 2) NOT NULL,
  gross_amount_inr NUMERIC(12, 2),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  recharge_method TEXT CHECK (recharge_method IS NULL OR recharge_method IN ('manual', 'razorpay')),
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  screenshot_path TEXT,
  note TEXT,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_firebase_id TEXT UNIQUE,
  submitted_by UUID REFERENCES users (id),
  reviewed_by UUID REFERENCES users (id),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT
);

CREATE INDEX IF NOT EXISTS wallet_top_ups_rc_status_idx ON wallet_top_ups (rc_id, status);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rc_id UUID NOT NULL REFERENCES regional_centers (id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('top_up_credit', 'rv_payment', 'rv_refund')),
  amount_inr NUMERIC(12, 2) NOT NULL,
  balance_after_inr NUMERIC(12, 2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'refunded')),
  top_up_id UUID REFERENCES wallet_top_ups (id),
  verification_ids UUID[] NOT NULL DEFAULT '{}',
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_firebase_id TEXT UNIQUE,
  created_by UUID REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wallet_ledger_rc_id_idx ON wallet_ledger (rc_id);

CREATE TABLE IF NOT EXISTS serial_allotments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rc_id UUID NOT NULL REFERENCES regional_centers (id),
  pool TEXT NOT NULL DEFAULT 'gas' CHECK (pool IN ('gas', 'pas', 'interweighing')),
  serial_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'reserved', 'used', 'voided')),
  invoice_no TEXT,
  product_id UUID REFERENCES products (id),
  used_verification_id UUID REFERENCES verifications (id),
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rc_id, serial_number)
);

CREATE INDEX IF NOT EXISTS serial_allotments_rc_status_idx ON serial_allotments (rc_id, status);

CREATE TABLE IF NOT EXISTS serial_inward_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rc_id UUID NOT NULL REFERENCES regional_centers (id),
  invoice_no TEXT,
  serial_from TEXT,
  serial_to TEXT,
  qty INTEGER,
  pool TEXT NOT NULL DEFAULT 'gas',
  reserved BOOLEAN NOT NULL DEFAULT FALSE,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS serial_inward_batches_rc_id_idx ON serial_inward_batches (rc_id);

CREATE TABLE IF NOT EXISTS pas_serial_bank (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'available',
  product_id UUID REFERENCES products (id),
  rc_id UUID REFERENCES regional_centers (id),
  invoice_no TEXT,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optional certificate PDF URL columns used by public lookup (import may already set JSON).
ALTER TABLE verifications
  ADD COLUMN IF NOT EXISTS certificate_pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS signed_certificate_pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS certificate_number TEXT,
  ADD COLUMN IF NOT EXISTS payload_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS verifications_certificate_number_idx
  ON verifications (certificate_number)
  WHERE certificate_number IS NOT NULL;
