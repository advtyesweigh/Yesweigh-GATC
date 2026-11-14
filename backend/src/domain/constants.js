/** Ported from yesgatc roles / verification types (Firestore → VPS). */

export const YESGATC_ROLE_TO_VPS = Object.freeze({
  super_admin: 'ADMIN',
  rc_admin: 'RC_ADMIN',
  vct: 'VCT',
  verifier: null, // deferred
});

export const VERIFICATION_TYPES = Object.freeze(['OV', 'RV']);

export const JOB_KINDS = Object.freeze(['ov_self', 'ov_customer', 'rv_customer']);

export const ALL_VERIFICATION_JOB_KINDS = [...JOB_KINDS];

export const VERIFICATION_STATUSES = Object.freeze([
  'draft',
  'pending_rc',
  'submitted',
  'approved',
  'certified',
  'rejected',
]);

/** Client may set these; certificate server / admin sets approved+certified. */
export const CLIENT_WRITABLE_STATUSES = Object.freeze(['draft', 'pending_rc', 'submitted']);

export const VERIFICATION_LOCATIONS = Object.freeze(['in_situ', 'in_premises']);

export const VERIFICATION_SUBJECTS = Object.freeze(['self', 'customer']);

export const REQUEST_SOURCES = Object.freeze([
  'rc_direct',
  'vct_manual',
  'vct_auto',
  'verifier_manual',
]);

export const MEDIA_KINDS = Object.freeze([
  'stamping',
  'scale',
  'instrumentRear',
  'performer',
  'invoice',
  'other',
]);

/**
 * Feature catalogue for Super Admin / RC menus (API readiness).
 * status: ready | partial | planned | deferred
 */
export const FEATURE_CATALOG = Object.freeze([
  { id: 'dashboard', label: 'Dashboard', roles: ['ADMIN', 'RC_ADMIN', 'VCT'], status: 'ready' },
  { id: 'verifications', label: 'Verification', roles: ['ADMIN', 'RC_ADMIN', 'VCT'], status: 'partial' },
  { id: 'customers', label: 'Customers', roles: ['ADMIN', 'RC_ADMIN', 'VCT'], status: 'ready' },
  { id: 'products', label: 'Products', roles: ['ADMIN', 'RC_ADMIN', 'VCT'], status: 'partial' },
  { id: 'regional_centers', label: 'Regional Centers', roles: ['ADMIN'], status: 'partial' },
  { id: 'vct', label: 'VCT', roles: ['ADMIN', 'RC_ADMIN'], status: 'partial' },
  { id: 'vehicles', label: 'Vehicle', roles: ['ADMIN', 'RC_ADMIN', 'VCT'], status: 'partial' },
  { id: 'laboratory', label: 'Laboratory', roles: ['ADMIN', 'RC_ADMIN', 'VCT'], status: 'partial' },
  { id: 'wallet', label: 'Wallet', roles: ['ADMIN', 'RC_ADMIN'], status: 'planned' },
  { id: 'rc_quota', label: 'RC quota', roles: ['ADMIN'], status: 'planned' },
  { id: 'vr_allotted', label: 'Vr Allotted', roles: ['RC_ADMIN'], status: 'planned' },
  { id: 'reports', label: 'Reports', roles: ['ADMIN', 'RC_ADMIN', 'VCT'], status: 'planned' },
  { id: 'notifications', label: 'Notifications', roles: ['ADMIN'], status: 'planned' },
  { id: 'integrations', label: 'Integrations', roles: ['ADMIN'], status: 'planned' },
  { id: 'settings', label: 'Settings', roles: ['ADMIN', 'RC_ADMIN'], status: 'planned' },
  { id: 'public_certificates', label: 'Public certificates', roles: [], status: 'ready' },
  { id: 'emaap', label: 'eMaap / DOCA', roles: ['ADMIN'], status: 'deferred' },
]);
