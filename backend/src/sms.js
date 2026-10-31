/**
 * SMS send adapter.
 *
 * Providers (SMS_PROVIDER):
 * - log      — write delivery intent to server logs only (never returns OTP in HTTP).
 *              Default when NODE_ENV is not production, or when SMS_API_KEY is unset.
 * - http     — POST JSON to SMS_API_URL with Authorization: Bearer SMS_API_KEY
 *              Body: { to, message, sender? }
 * - msg91    — MSG91 Flow/OTP-style POST (requires SMS_API_KEY + SMS_MSG91_TEMPLATE_ID)
 * - whatsapp — Meta WhatsApp Cloud API utility template (same as service.yesweigh.in dealer OTP)
 *
 * Required for production SMS delivery:
 *   SMS_PROVIDER=http|msg91|whatsapp
 *   SMS_API_KEY=...
 *   SMS_API_URL=...          (http provider)
 *   SMS_SENDER=GATC          (optional)
 *   SMS_MSG91_TEMPLATE_ID=... (msg91)
 *   SMS_MSG91_BASE_URL=https://control.msg91.com/api/v5/flow (optional)
 *
 * WhatsApp Cloud (preferred for GATC login OTP):
 *   SMS_PROVIDER=whatsapp
 *   WHATSAPP_TOKEN / metaAccessToken
 *   WHATSAPP_PHONE_NUMBER_ID / metaPhoneNumberId
 *   WHATSAPP_OTP_TEMPLATE=otp (default)
 *   WHATSAPP_OTP_LANGUAGE=en_US (default)
 *   WHATSAPP_GRAPH_VERSION=v21.0 (default)
 *   Optional: WHATSAPP_SECRETS_FILE=C:\GATC\secrets\whatsapp-cloud.gatcdev.json
 */

function digitsOnly(phone) {
  return String(phone || '').replace(/\D+/g, '');
}

/** Normalize Indian mobiles to E.164-ish +91XXXXXXXXXX when 10 digits. */
export function normalizePhone(phone) {
  const digits = digitsOnly(phone);
  if (!digits) return '';
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (String(phone).trim().startsWith('+') && digits.length >= 10) {
    return `+${digits}`;
  }
  return digits.length >= 10 ? `+${digits}` : '';
}

export function maskPhone(phone) {
  const digits = digitsOnly(phone);
  if (digits.length < 4) return '****';
  return `${'*'.repeat(Math.max(6, digits.length - 4))}${digits.slice(-4)}`;
}

export function resolveSmsProvider(config) {
  const explicit = (config.smsProvider || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (config.nodeEnv === 'production' && config.smsApiKey) return 'http';
  return 'log';
}

function utilityBodyParameter(value) {
  const cleaned = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {5,}/g, '    ')
    .trim()
    .slice(0, 30);
  return cleaned || 'there';
}

/** Meta WhatsApp Cloud API — approved Utility template (name + code). */
async function sendWhatsAppOtp(payload, config, logger = console) {
  const to = normalizePhone(payload.to);
  const token = String(config.whatsappToken || '').trim();
  const phoneNumberId = String(config.whatsappPhoneNumberId || '').replace(/\D/g, '');
  const template = String(config.whatsappOtpTemplate || 'otp').trim() || 'otp';
  const language = String(config.whatsappOtpLanguage || 'en_US').trim() || 'en_US';
  const version = String(config.whatsappGraphVersion || 'v21.0').trim() || 'v21.0';
  const otp = String(payload.otp || '').trim();
  if (!token) {
    throw new Error('WHATSAPP_TOKEN (metaAccessToken) is required for SMS_PROVIDER=whatsapp');
  }
  if (!phoneNumberId) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID is required for SMS_PROVIDER=whatsapp');
  }
  if (!otp) {
    throw new Error('OTP code is required for WhatsApp OTP send');
  }

  const waTo = digitsOnly(to);
  const name = utilityBodyParameter(payload.name || 'there');
  const res = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waTo,
      type: 'template',
      template: {
        name: template,
        language: { code: language },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: name },
            { type: 'text', text: utilityBodyParameter(otp) },
          ],
        }],
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.error?.error_user_msg
      || body?.error?.message
      || `HTTP ${res.status}`;
    logger.error?.('SMS whatsapp provider failed', {
      status: res.status,
      detail: String(detail).slice(0, 200),
      to: maskPhone(to),
    });
    throw new Error('WhatsApp OTP delivery failed');
  }
  return {
    ok: true,
    provider: 'whatsapp',
    to,
    id: String(body?.messages?.[0]?.id || '').trim(),
  };
}

/**
 * @param {{ to: string, message: string, otp?: string, name?: string }} payload
 * @param {object} config
 * @param {{ info?: Function, warn?: Function, error?: Function }} logger
 */
export async function sendSms(payload, config, logger = console) {
  const to = normalizePhone(payload.to);
  if (!to) {
    throw new Error('SMS recipient phone is missing or invalid');
  }

  const provider = resolveSmsProvider(config);
  const message = payload.message;

  if (provider === 'log') {
    // Never returns OTP in HTTP. Logs OTP only when not production, or when
    // SMS_LOG_OTP=1 is explicitly set (bridge until a real SMS provider is configured).
    const allowOtpInLogs = config.nodeEnv !== 'production' || config.smsLogOtp === true;
    logger.info?.('SMS log provider (OTP not sent over SMS)', {
      to: maskPhone(to),
      otpPresent: Boolean(payload.otp),
      ...(allowOtpInLogs && payload.otp ? { otp: payload.otp } : {}),
      messagePreview: message.slice(0, 40),
    });
    return { ok: true, provider: 'log', to };
  }

  if (provider === 'whatsapp') {
    return sendWhatsAppOtp(payload, config, logger);
  }

  if (!config.smsApiKey) {
    throw new Error('SMS_API_KEY is required for SMS provider ' + provider);
  }

  if (provider === 'http') {
    if (!config.smsApiUrl) {
      throw new Error('SMS_API_URL is required when SMS_PROVIDER=http');
    }
    const res = await fetch(config.smsApiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.smsApiKey}`,
      },
      body: JSON.stringify({
        to,
        message,
        sender: config.smsSender || undefined,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error?.('SMS http provider failed', {
        status: res.status,
        body: text.slice(0, 200),
      });
      throw new Error('SMS delivery failed');
    }
    return { ok: true, provider: 'http', to };
  }

  if (provider === 'msg91') {
    if (!config.smsMsg91TemplateId) {
      throw new Error('SMS_MSG91_TEMPLATE_ID is required when SMS_PROVIDER=msg91');
    }
    const base = config.smsMsg91BaseUrl
      || 'https://control.msg91.com/api/v5/flow';
    const mobiles = digitsOnly(to);
    const res = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authkey: config.smsApiKey,
      },
      body: JSON.stringify({
        template_id: config.smsMsg91TemplateId,
        short_url: '0',
        recipients: [
          {
            mobiles,
            OTP: payload.otp || '',
            var: payload.otp || '',
          },
        ],
        sender: config.smsSender || undefined,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error?.('SMS msg91 provider failed', {
        status: res.status,
        body: text.slice(0, 200),
      });
      throw new Error('SMS delivery failed');
    }
    return { ok: true, provider: 'msg91', to };
  }

  throw new Error(`Unknown SMS_PROVIDER: ${provider}`);
}

export function buildLoginOtpMessage(otp, config) {
  const minutes = Math.max(1, Math.round((config.otpTtlSeconds || 300) / 60));
  return `GATC login OTP: ${otp}. Valid for ${minutes} min. Do not share.`;
}
