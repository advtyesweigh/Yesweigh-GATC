import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function requireInt(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return value;
}

/** Load optional WhatsApp Cloud secrets JSON (never commit; VPS: C:\\GATC\\secrets\\...). */
function loadWhatsAppSecretsFile() {
  const filePath = String(process.env.WHATSAPP_SECRETS_FILE || '').trim();
  if (!filePath) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function loadConfig() {
  const waFile = loadWhatsAppSecretsFile();
  const config = {
    appName: process.env.APP_NAME || 'gatc-vps',
    nodeEnv: process.env.NODE_ENV || 'development',
    host: process.env.APP_HOST || '127.0.0.1',
    port: requireInt('APP_PORT', 3000),
    logLevel: process.env.LOG_LEVEL || 'info',
    corsOrigin: process.env.CORS_ORIGIN || 'http://127.0.0.1:5173',
    databaseUrl: process.env.DATABASE_URL || '',
    dataRoot: process.env.DATA_ROOT || '',
    jwtSecret: process.env.JWT_SECRET || '',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
    otpTtlSeconds: requireInt('OTP_TTL_SECONDS', 300),
    otpResendSeconds: requireInt('OTP_RESEND_SECONDS', 60),
    otpMaxAttempts: requireInt('OTP_MAX_ATTEMPTS', 5),
    // Server-only: master OTP for ADMIN (super admin). Never expose to clients.
    // Prefer MASTER_OTP; ADMIN_MASTER_OTP is an accepted alias.
    masterOtp: String(process.env.MASTER_OTP || process.env.ADMIN_MASTER_OTP || '').trim(),
    smsProvider: process.env.SMS_PROVIDER || '',
    smsApiKey: process.env.SMS_API_KEY || '',
    smsApiUrl: process.env.SMS_API_URL || '',
    smsSender: process.env.SMS_SENDER || '',
    smsMsg91TemplateId: process.env.SMS_MSG91_TEMPLATE_ID || '',
    smsMsg91BaseUrl: process.env.SMS_MSG91_BASE_URL || '',
    // Explicit opt-in: log OTP plaintext to server logs when SMS_PROVIDER=log (even in production).
    // Disable once a real SMS provider is live. Never expose OTP in HTTP responses.
    smsLogOtp: process.env.SMS_LOG_OTP === '1',
    // WhatsApp Cloud API (service.yesweigh.in / yesweigh-service). Env wins over secrets file.
    whatsappToken: process.env.WHATSAPP_TOKEN
      || process.env.META_ACCESS_TOKEN
      || String(waFile.metaAccessToken || '').trim(),
    whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID
      || String(waFile.metaPhoneNumberId || '').replace(/\D/g, ''),
    whatsappWabaId: process.env.WHATSAPP_WABA_ID
      || String(waFile.metaWabaId || '').replace(/\D/g, ''),
    whatsappOtpTemplate: process.env.WHATSAPP_OTP_TEMPLATE
      || String(waFile.otpTemplate || 'otp').trim()
      || 'otp',
    whatsappOtpLanguage: process.env.WHATSAPP_OTP_LANGUAGE
      || String(waFile.otpLanguage || 'en_US').trim()
      || 'en_US',
    whatsappGraphVersion: process.env.WHATSAPP_GRAPH_VERSION
      || String(waFile.graphApiVersion || 'v21.0').trim()
      || 'v21.0',
    // Zoho Books OAuth (India DC by default — matches yesgatc). Never invent production secrets.
    publicApiUrl: String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, ''),
    zohoClientId: String(process.env.ZOHO_CLIENT_ID || '').trim(),
    zohoClientSecret: String(process.env.ZOHO_CLIENT_SECRET || '').trim(),
    zohoRefreshToken: String(process.env.ZOHO_REFRESH_TOKEN || '').trim(),
    zohoOrganizationId: String(process.env.ZOHO_ORGANIZATION_ID || '').trim(),
    zohoAccountsBase: String(process.env.ZOHO_ACCOUNTS_BASE || 'https://accounts.zoho.in').trim()
      .replace(/\/+$/, ''),
    zohoRedirectUri: String(process.env.ZOHO_REDIRECT_URI || '').trim(),
    zohoScopes: String(process.env.ZOHO_SCOPES || '').trim(),
    // Razorpay (optional env bootstrap → encrypted $DATA_ROOT/razorpay/credentials.enc.json)
    razorpayKeyId: String(process.env.RAZORPAY_KEY_ID || '').trim(),
    razorpayKeySecret: String(process.env.RAZORPAY_KEY_SECRET || '').trim(),
    razorpayWebhookSecret: String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim(),
  };

  if (config.port < 1 || config.port > 65535) {
    throw new Error(`APP_PORT out of range: ${config.port}`);
  }

  return config;
}
