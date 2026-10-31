-- Auth sessions (single active device) + OTP challenges for login MFA.

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  user_agent TEXT,
  ip TEXT
);

CREATE INDEX auth_sessions_user_id_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_active_idx ON auth_sessions (user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE auth_otp_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  phone_hint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auth_otp_attempts_nonneg CHECK (attempts >= 0)
);

CREATE INDEX auth_otp_challenges_user_id_idx ON auth_otp_challenges (user_id);
CREATE INDEX auth_otp_challenges_open_idx ON auth_otp_challenges (user_id)
  WHERE consumed_at IS NULL;
