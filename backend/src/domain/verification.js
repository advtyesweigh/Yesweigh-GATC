/**
 * Verification lifecycle helpers — ported from yesgatc types + form rules.
 */

import {
  ALL_VERIFICATION_JOB_KINDS,
  CLIENT_WRITABLE_STATUSES,
  JOB_KINDS,
  VERIFICATION_LOCATIONS,
  VERIFICATION_STATUSES,
  VERIFICATION_SUBJECTS,
  VERIFICATION_TYPES,
} from './constants.js';

export function verificationJobKindsForActor(verifierMode, allowedJobKinds) {
  if (!verifierMode) return [...ALL_VERIFICATION_JOB_KINDS];
  const allowed = Array.isArray(allowedJobKinds) ? allowedJobKinds : [];
  const set = new Set(allowed.map(String));
  const filtered = JOB_KINDS.filter((k) => set.has(k));
  return filtered.length ? filtered : ['ov_self'];
}

export function inferJobKind({ verificationType, verificationSubject }) {
  const type = String(verificationType || '').toUpperCase();
  const subject = String(verificationSubject || '').toLowerCase();
  if (type === 'RV') return 'rv_customer';
  if (subject === 'self') return 'ov_self';
  return 'ov_customer';
}

export function requestSourceForActor(role, workflowMode) {
  if (role === 'ADMIN' || role === 'RC_ADMIN') return 'rc_direct';
  if (role === 'VCT') {
    return workflowMode === 'auto' ? 'vct_auto' : 'vct_manual';
  }
  return 'verifier_manual';
}

export function initialStatusForSubmit(role, workflowMode) {
  if (role === 'VCT' && workflowMode === 'manual') return 'pending_rc';
  return 'submitted';
}

export function assertTransition(fromStatus, toStatus, { isAdmin = false } = {}) {
  const from = String(fromStatus || 'draft');
  const to = String(toStatus || '');
  if (!VERIFICATION_STATUSES.includes(to)) {
    return { ok: false, code: 'INVALID_STATUS', message: `Unknown status ${to}` };
  }
  if (from === to) return { ok: true };
  if (isAdmin) return { ok: true };
  if (!CLIENT_WRITABLE_STATUSES.includes(to) && to !== 'draft') {
    return {
      ok: false,
      code: 'FORBIDDEN_STATUS',
      message: 'Only server/admin may set approved or certified',
    };
  }
  const allowed = {
    draft: ['pending_rc', 'submitted'],
    pending_rc: ['draft', 'submitted', 'rejected'],
    submitted: ['draft'], // stale repair path
    rejected: ['draft'],
    approved: [],
    certified: [],
  };
  if (!(allowed[from] || []).includes(to)) {
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      message: `Cannot move from ${from} to ${to}`,
    };
  }
  return { ok: true };
}

export function normalizeVerificationCreateBody(body = {}) {
  const verificationType = String(body.verificationType || body.type || 'OV').toUpperCase();
  const verificationSubject = String(body.verificationSubject || body.subject || 'self').toLowerCase();
  let jobKind = String(body.jobKind || '').trim();
  if (!JOB_KINDS.includes(jobKind)) {
    jobKind = inferJobKind({ verificationType, verificationSubject });
  }
  const location = String(body.verificationLocation || 'in_premises').toLowerCase();
  return {
    verificationType: VERIFICATION_TYPES.includes(verificationType) ? verificationType : 'OV',
    jobKind,
    customerId: body.customerId || null,
    customerName: String(body.customerName || '').trim() || null,
    productId: body.productId || null,
    productSnapshot: body.productSnapshot && typeof body.productSnapshot === 'object'
      ? body.productSnapshot
      : {},
    serialNumber: String(body.serialNumber || '').trim() || null,
    serialSource: body.serialSource || null,
    ambientTemperature: body.ambientTemperature ?? null,
    relativeHumidity: body.relativeHumidity ?? null,
    sealIdentificationNumber: String(body.sealIdentificationNumber || '').trim() || null,
    verificationLocation: VERIFICATION_LOCATIONS.includes(location) ? location : 'in_premises',
    verificationSubject: VERIFICATION_SUBJECTS.includes(verificationSubject)
      ? verificationSubject
      : 'self',
    manufacturingYear: body.manufacturingYear != null
      ? Number(body.manufacturingYear)
      : null,
  };
}

export function validateDraftCreate(input) {
  if (!VERIFICATION_TYPES.includes(input.verificationType)) {
    return 'verificationType must be OV or RV';
  }
  if (!JOB_KINDS.includes(input.jobKind)) {
    return 'jobKind is invalid';
  }
  if (input.jobKind === 'ov_customer' || input.jobKind === 'rv_customer') {
    if (!input.customerName && !input.customerId) {
      return 'customerName or customerId is required for customer jobs';
    }
  }
  return null;
}
