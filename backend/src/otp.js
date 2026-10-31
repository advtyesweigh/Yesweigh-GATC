import crypto from 'node:crypto';

const OTP_DIGITS = 6;

export function generateOtpCode(digits = OTP_DIGITS) {
  const max = 10 ** digits;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(digits, '0');
}

export function hashOtp(code, pepper) {
  if (!pepper) throw new Error('OTP pepper (JWT_SECRET) is required');
  return crypto
    .createHmac('sha256', pepper)
    .update(String(code).trim())
    .digest('hex');
}

export function verifyOtpHash(code, codeHash, pepper) {
  if (!codeHash || !pepper) return false;
  const expected = Buffer.from(codeHash, 'hex');
  const actual = Buffer.from(hashOtp(code, pepper), 'hex');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export async function createOtpChallenge(pool, {
  userId,
  phone,
  phoneHint,
  codeHash,
  ttlSeconds,
  maxAttempts = 5,
}) {
  const result = await pool.query(
    `INSERT INTO auth_otp_challenges (
       user_id, code_hash, phone_e164, phone_hint, expires_at, max_attempts
     ) VALUES (
       $1, $2, $3, $4, NOW() + ($5::text || ' seconds')::interval, $6
     )
     RETURNING id, expires_at, phone_hint, last_sent_at`,
    [userId, codeHash, phone, phoneHint, String(ttlSeconds), maxAttempts],
  );
  return result.rows[0];
}

export async function findOtpChallenge(pool, challengeId) {
  const result = await pool.query(
    `SELECT id, user_id, code_hash, phone_e164, phone_hint, created_at,
            expires_at, consumed_at, attempts, max_attempts, last_sent_at
     FROM auth_otp_challenges
     WHERE id = $1
     LIMIT 1`,
    [challengeId],
  );
  return result.rows[0] ?? null;
}

export async function consumeOtpChallenge(pool, challengeId) {
  await pool.query(
    `UPDATE auth_otp_challenges
     SET consumed_at = NOW()
     WHERE id = $1 AND consumed_at IS NULL`,
    [challengeId],
  );
}

export async function incrementOtpAttempts(pool, challengeId) {
  const result = await pool.query(
    `UPDATE auth_otp_challenges
     SET attempts = attempts + 1
     WHERE id = $1
     RETURNING attempts, max_attempts`,
    [challengeId],
  );
  return result.rows[0];
}

export async function refreshOtpChallenge(pool, challengeId, {
  codeHash,
  ttlSeconds,
}) {
  const result = await pool.query(
    `UPDATE auth_otp_challenges
     SET code_hash = $2,
         expires_at = NOW() + ($3::text || ' seconds')::interval,
         last_sent_at = NOW(),
         attempts = 0
     WHERE id = $1
       AND consumed_at IS NULL
     RETURNING id, expires_at, phone_hint, phone_e164, last_sent_at`,
    [challengeId, codeHash, String(ttlSeconds)],
  );
  return result.rows[0] ?? null;
}

export async function invalidateOpenChallenges(pool, userId) {
  await pool.query(
    `UPDATE auth_otp_challenges
     SET consumed_at = COALESCE(consumed_at, NOW())
     WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId],
  );
}
