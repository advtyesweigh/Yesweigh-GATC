import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  excludePasQuotaSerials,
  resolveRcQuotaUsedQty,
} from '../src/domain/quota.js';
import {
  assertTransition,
  inferJobKind,
  normalizeVerificationCreateBody,
  validateDraftCreate,
  verificationJobKindsForActor,
} from '../src/domain/verification.js';
import { FEATURE_CATALOG } from '../src/domain/constants.js';
import { isGasStickerSerial, isPasStickerSerial } from '../src/domain/serialMatch.js';

describe('domain serial / quota (yesgatc port)', () => {
  it('classifies GAS vs PAS stickers', () => {
    assert.equal(isGasStickerSerial('G12345'), true);
    assert.equal(isPasStickerSerial('YJ100'), true);
    assert.equal(isPasStickerSerial('G12345'), false);
  });

  it('excludePasQuotaSerials keeps GAS', () => {
    const out = excludePasQuotaSerials(['G1', 'YJ9', 'AS2'], ['YJ9']);
    assert.deepEqual(out, ['G1']);
  });

  it('resolveRcQuotaUsedQty prefers live when RC-wide', () => {
    assert.equal(
      resolveRcQuotaUsedQty({ recordUsedCount: 3, storedUsed: 10, recordsAreRcWide: true }),
      3,
    );
    assert.equal(
      resolveRcQuotaUsedQty({ recordUsedCount: 3, storedUsed: 10, recordsAreRcWide: false }),
      10,
    );
  });
});

describe('domain verification helpers', () => {
  it('infers job kinds', () => {
    assert.equal(inferJobKind({ verificationType: 'RV' }), 'rv_customer');
    assert.equal(inferJobKind({ verificationType: 'OV', verificationSubject: 'self' }), 'ov_self');
    assert.equal(inferJobKind({ verificationType: 'OV', verificationSubject: 'customer' }), 'ov_customer');
  });

  it('limits verifier job kinds', () => {
    assert.deepEqual(verificationJobKindsForActor(false), [
      'ov_self',
      'ov_customer',
      'rv_customer',
    ]);
    assert.deepEqual(verificationJobKindsForActor(true, ['ov_customer']), ['ov_customer']);
    assert.deepEqual(verificationJobKindsForActor(true, []), ['ov_self']);
  });

  it('blocks client certified transition', () => {
    const bad = assertTransition('submitted', 'certified', { isAdmin: false });
    assert.equal(bad.ok, false);
    const ok = assertTransition('draft', 'submitted', { isAdmin: false });
    assert.equal(ok.ok, true);
  });

  it('validates draft create', () => {
    const body = normalizeVerificationCreateBody({
      verificationType: 'OV',
      verificationSubject: 'customer',
    });
    assert.equal(body.jobKind, 'ov_customer');
    assert.equal(validateDraftCreate(body), 'customerName or customerId is required for customer jobs');
    assert.equal(
      validateDraftCreate(normalizeVerificationCreateBody({ verificationSubject: 'self' })),
      null,
    );
  });

  it('exposes feature catalog entries', () => {
    assert.ok(FEATURE_CATALOG.some((f) => f.id === 'verifications'));
    assert.ok(FEATURE_CATALOG.some((f) => f.id === 'wallet' && f.status === 'planned'));
  });
});
