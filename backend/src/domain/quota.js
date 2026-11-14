/**
 * Ported from yesgatc `rcQuotaMath` / seat helpers (pure; no Firebase).
 * Wire to `serial_allotments` + verification counts in a later phase.
 */

import {
  isFactoryGatcSticker,
  isGasStickerSerial,
  isPasStickerSerial,
} from './serialMatch.js';

export function resolveRcQuotaUsedQty(input) {
  const recordUsed = Math.max(0, Number(input.recordUsedCount) || 0);
  if (input.storedUsed == null) return recordUsed;
  if (input.recordsAreRcWide) return recordUsed;
  return Math.max(recordUsed, Number(input.storedUsed) || 0);
}

export function recordUsesPasQuota(productId, pasProductIds) {
  const id = String(productId || '').trim();
  if (!id || !pasProductIds) return false;
  const set =
    pasProductIds instanceof Set
      ? pasProductIds
      : new Set([...pasProductIds].map((item) => String(item).trim()).filter(Boolean));
  return set.has(id);
}

export function excludePasQuotaSerials(serials, pasSerials) {
  const blocked = new Set(
    [...(pasSerials || [])].map((serial) => serial.trim().toUpperCase()).filter(Boolean),
  );
  return serials.filter((serial) => {
    const key = serial.trim().toUpperCase();
    if (!key) return false;
    if (isGasStickerSerial(key) || isFactoryGatcSticker(key)) return true;
    if (isPasStickerSerial(key)) return false;
    return !blocked.has(key);
  });
}

export function countReservedOverlaySeats(serials, reservedSerials, voidedSerials = []) {
  const voided = new Set(
    voidedSerials.map((serial) => serial.trim().toUpperCase()).filter(Boolean),
  );
  const reserved = new Set(
    reservedSerials.map((serial) => serial.trim().toUpperCase()).filter(Boolean),
  );
  return serials.filter((serial) => {
    const key = serial.trim().toUpperCase();
    if (!key || voided.has(key)) return false;
    return reserved.has(key);
  }).length;
}

export function pickQuotaToDoSerials(remaining, reservedSerials, balanceQty) {
  const reserved = new Set(
    reservedSerials.map((serial) => serial.trim().toUpperCase()).filter(Boolean),
  );
  const free = [];
  for (const serial of remaining) {
    const key = serial.trim().toUpperCase();
    if (!key || reserved.has(key)) continue;
    free.push(serial);
  }
  if (balanceQty == null || balanceQty < 0) return free;
  return free.slice(0, balanceQty);
}
