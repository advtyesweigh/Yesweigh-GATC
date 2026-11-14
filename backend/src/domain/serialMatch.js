/** Ported from yesgatc `pasSerialBankMatch` — sticker family helpers (no Firestore). */

export function isGasStickerSerial(serial) {
  const key = String(serial || '').trim().toUpperCase();
  if (!key) return false;
  return /^[GX]\d/.test(key) || key.startsWith('GATC-G') || key.startsWith('GATC-X');
}

export function isPasStickerSerial(serial) {
  const key = String(serial || '').trim().toUpperCase();
  if (!key) return false;
  return /^(YJ|AS|VJ)/.test(key);
}

export function isFactoryGatcSticker(serial) {
  const key = String(serial || '').trim().toUpperCase();
  if (!key) return false;
  return key.includes('GATC') && !isPasStickerSerial(key);
}
