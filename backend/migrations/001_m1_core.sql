-- M1 core schema: regional_centers, users, products, customers,
-- verifications, verification_media (lean OV Self draft support).

CREATE TABLE regional_centers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  state TEXT,
  district TEXT,
  pincode TEXT,
  location_lat DOUBLE PRECISION,
  location_lng DOUBLE PRECISION,
  laboratory_seal_identification TEXT,
  fees_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aadhaar CHAR(12) NOT NULL UNIQUE,
  username TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'RC_ADMIN', 'VCT')),
  rc_id UUID REFERENCES regional_centers (id),
  phone TEXT,
  email TEXT,
  address TEXT,
  profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  workflow_mode TEXT CHECK (workflow_mode IS NULL OR workflow_mode IN ('auto', 'manual')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  CONSTRAINT users_rc_role_chk CHECK (
    (role = 'ADMIN' AND rc_id IS NULL)
    OR (role IN ('RC_ADMIN', 'VCT') AND rc_id IS NOT NULL)
  ),
  CONSTRAINT users_aadhaar_digits_chk CHECK (aadhaar ~ '^[0-9]{12}$')
);

CREATE INDEX users_rc_id_idx ON users (rc_id);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id TEXT NOT NULL UNIQUE,
  model_no TEXT,
  name TEXT NOT NULL,
  type_of_instrument TEXT,
  manufacturer_brand_series TEXT,
  accuracy_class TEXT,
  capacities JSONB NOT NULL DEFAULT '{}'::jsonb,
  unit_of_measurement TEXT,
  model_approval_no TEXT,
  supply_voltage TEXT,
  pas_pre_allotted BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  approval_doc_path TEXT,
  image_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rc_id UUID NOT NULL REFERENCES regional_centers (id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  pincode TEXT,
  state TEXT,
  district TEXT,
  location_lat DOUBLE PRECISION,
  location_lng DOUBLE PRECISION,
  shop_photo_path TEXT,
  created_by UUID REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX customers_rc_id_idx ON customers (rc_id);

CREATE TABLE verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rc_id UUID NOT NULL REFERENCES regional_centers (id),
  application_number TEXT UNIQUE,
  verification_type TEXT NOT NULL CHECK (verification_type IN ('OV', 'RV')),
  job_kind TEXT NOT NULL CHECK (job_kind IN ('ov_self', 'ov_customer', 'rv_customer')),
  status TEXT NOT NULL DEFAULT 'draft',
  customer_id UUID REFERENCES customers (id),
  customer_name TEXT,
  device_id UUID,
  product_id UUID REFERENCES products (id),
  product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  serial_number TEXT,
  serial_source TEXT,
  ambient_temperature NUMERIC(6, 2),
  relative_humidity NUMERIC(6, 2),
  seal_identification_number TEXT,
  verification_location TEXT,
  verification_subject TEXT,
  performed_by TEXT,
  performer_user_id UUID REFERENCES users (id),
  request_source TEXT,
  manufacturing_year INTEGER,
  created_by UUID REFERENCES users (id),
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  certified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX verifications_rc_status_idx ON verifications (rc_id, status);
CREATE INDEX verifications_rc_serial_idx ON verifications (rc_id, serial_number);

CREATE TABLE verification_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id UUID NOT NULL REFERENCES verifications (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX verification_media_verification_id_idx ON verification_media (verification_id);
