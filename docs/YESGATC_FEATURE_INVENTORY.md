# yesgatc → gatc-vps feature inventory

**Source repo:** `/Users/mac/Projects/gatc/yesgatc`  
**Git:** `https://github.com/advtyesweigh/yesgatc.git` (origin), `https://github.com/yes-weigh/yesgatc.git` (upstream)  
**Target:** `/Users/mac/Projects/gatc-vps` (`backend/src/...`, Postgres, Express `/api/v1/...`)  
**Do not modify yesgatc** — port only.

Legend: ✅ on VPS · 🟡 partial · ❌ not yet · 🔒 Firebase-only / deferred

---

## 1. Cloud Functions (`yesgatc/functions`)

| Export | Type | Purpose | VPS status |
|--------|------|---------|------------|
| `onSiteCalibrationRvZohoInvoice` | Firestore trigger | Zoho RV invoice on submit | 🔒 → app-level hook on verification submit (Phase later) |
| `onSiteCalibrationZohoInvoiceRef` | Firestore trigger | Zoho invoice ref sync | 🔒 same |
| `submitRvWithZohoGate` | Callable | RV submit gated by Zoho | ❌ |
| `triggerRvZohoInvoice` | Callable | Manual Zoho invoice | ❌ |
| `pushLegacyRvInvoiceReference` | Callable | Legacy backfill | ❌ |
| `pushLegacyRvZohoSettlement` | Callable | Legacy settlement | ❌ |
| `pushLegacyRvZohoInvoice` | Callable | Legacy invoice | ❌ |
| `reconcileZohoOutstandingScheduled` | Schedule | Zoho reconcile cron | ❌ (node-cron / systemd later) |
| `moveStaleFailedVerificationsToDraft` | Schedule | Stale → draft | 🟡 logic port path `domain/verification.js` + cron TBD |
| `autoResubmitFailedSubmitVerifications` | Schedule | Auto-resubmit | ❌ |
| `reconcileZohoOutstanding` | Callable | Manual Zoho reconcile | ❌ |
| `migrateRcZohoExpenseAccountFields` | Callable | One-off migration | ❌ N/A |
| `pushLegacyWalletTopUpZohoTransfer` | Callable | Wallet → Zoho transfer | ❌ |
| `onUserProfileDeleted` | Firestore delete | Cleanup on user delete | 🔒 → Express delete user hook |
| `deleteAuthUser` | Callable | Delete Firebase Auth user | 🔒 → deactivate Postgres user |
| `cleanupGhostAuthUsers` | Callable | Ghost Auth cleanup | 🔒 N/A |
| `razorpayWebhook` | HTTPS | Razorpay events | ❌ `/api/v1/webhooks/razorpay` stub |
| `createWalletTopUpOrder` | Callable | Razorpay order | ❌ |
| `getWalletTopUpPaymentStatus` | Callable | Payment status | ❌ |
| `verifyWalletTopUpPayment` | Callable | Verify payment | ❌ |
| `reviewWalletTopUp` | Callable | Admin approve/reject | ❌ |
| `settleOutstandingRvWalletPayments` | Callable | Settle RV from wallet | ❌ |
| `payRvFromWallet` | Callable | Pay RV | ❌ |
| `refundRvWalletPayment` | Callable | Refund | ❌ |
| `linkWalletPaymentToRecords` | Callable | Link ledger | ❌ |
| `getWalletApiConfig` | Callable | Razorpay key config | ❌ |
| `submitWalletTopUpCallable` / `submitWalletTopUp` | Callable/HTTPS | Manual top-up | ❌ |
| `deleteWalletTopUp` / `deleteWalletLedgerEntry` / `resetRcWallet` | Callable | Admin wallet ops | ❌ |
| `revertRvSubmitTest` | Callable | Dev revert | ❌ (dev-only) |
| `devDeleteSubmittedVerification` | Callable | Dev delete | ❌ (dev-only) |
| `downloadStorageFileBytes` | Callable | Storage download | 🔒 → filesystem `DATA_ROOT` |
| `listVerificationCertificateNumbers` | Callable | Cert number list | 🟡 admin list fields |
| `readSerialPlate` | Callable | OCR serial plate | ❌ |
| `addRcGasSerials` | Callable | Allot GAS serials | ❌ (needs serial bank) |
| `emaapOtpWebhook` | HTTPS | eMaap OTP inbox | 🔒 Phase 5 |
| `lookupPublicCertificates` | HTTPS | Public cert search | ✅ `/api/v1/public/certificates` |
| `onSiteCalibrationYesoneWebhook` | Firestore trigger | Yesone push on verification | 🔒 → submit hook |
| `onUserYesoneWebhook` | Firestore trigger | Yesone push on user | 🔒 → user update hook |
| `testYesoneWebhook` | HTTPS | Test Yesone | ❌ |
| `syncYesoneOvUsed` | HTTPS | Sync OV used | ❌ |
| `mintYesweighEmbedToken` | HTTPS | Embed token | ❌ |
| `yesoneInbound` | HTTPS | Yesone inbound allotment | ❌ `/api/v1/webhooks/yesone` stub |

**Deps (functions `package.json`):** `firebase-admin`, `firebase-functions`, `razorpay`, `@fastify/busboy`.  
VPS reuses Express + `pg`; add `razorpay` only when wallet phase starts.

---

## 2. App features (UI / roles)

### Super Admin (`super_admin` → VPS `ADMIN`)

| Feature | yesgatc path | VPS |
|---------|--------------|-----|
| Dashboard KPIs | `/admin` | ✅ `/api/v1/admin/dashboard` |
| Verifications list | `/admin/verifications` | ✅ `/api/v1/admin/verifications` |
| RC quota | `/admin/rc-quota` | ❌ (schema seats TBD) |
| Products CRUD | `/admin/products` | 🟡 list only |
| Wallet top-ups | `/admin/wallet` | ❌ |
| Vehicles (all RCs) | `/admin/vehicles` | 🟡 schema + RC API |
| Regional Centers | `/admin/rc` | ✅ list |
| VCT list / approve | `/admin/technicians` | 🟡 users list |
| Laboratory | `/admin/laboratory` | 🟡 seal on RC |
| Notifications | `/admin/notifications` | ❌ |
| Reports | `/admin/reports` | ❌ |
| Contractor fee | `/admin/contractor-fee` | ❌ |
| Integrations (Yesone/Zoho/worker) | `/admin/integrations` | ❌ |
| Settings | `/admin/settings` | ❌ |
| Ops / eMaap session | integrations worker | ✅ `/api/v1/admin/ops-status` |

### RC Admin (`rc_admin` → `RC_ADMIN`)

| Feature | Path | VPS |
|---------|------|-----|
| Dashboard | `/rc` | 🟡 period KPIs via scoped lists |
| Verification OV/RV wizard | `/rc/verification` | 🟡 draft create + list |
| Vr Allotted | `/rc/vr-allotted` | ❌ |
| Customers | `/rc/customers` | ✅ RC-scoped CRUD |
| Wallet | `/rc/wallet` | ❌ (tables ready) |
| Products (read) | `/rc/products` | ✅ catalogue read |
| VCT management | `/rc/vct` | 🟡 list via users; create TBD |
| Verifier management | `/rc/verifier` | ❌ (role deferred) |
| Vehicles | `/rc/vehicles` | ✅ RC-scoped CRUD |
| Laboratory | `/rc/laboratory` | ✅ seal get/patch |
| Reports / Settings / Profile | `/rc/...` | ❌ / 🟡 profile via `/me` |

### VCT (`vct` → `VCT`)

| Feature | VPS |
|---------|-----|
| Verification (scoped) | 🟡 same draft/list with `rc_id` |
| Customers / Products / Vehicles / Lab (read) | ✅ where RC-scoped |
| Training / Certificates / Sign | ❌ / Phase 5 |

### Verifier

🔒 Deferred in gatc-vps Phase 1 roles (ARCHITECTURE).

### Public

| Feature | VPS |
|---------|-----|
| Certificate download / lookup | ✅ `/api/v1/public/certificates` |

---

## 3. Firestore collections → Postgres

| Collection / doc | Postgres |
|------------------|----------|
| `users` | `users` (+ `profile_json`) |
| `aadharIndex` | unique `users.aadhaar` |
| `products` | `products` |
| `customers` | `customers` |
| `siteCalibrations` | `verifications` + `verification_media` |
| `vehicles` | `vehicles` (004) |
| `rcWallets` / `walletTopUps` / ledger | `rc_wallets`, `wallet_top_ups`, `wallet_ledger` (004) |
| `serialAllotments` / `serialInwardBatches` / `pasSerialBank*` | `serial_allotments`, `serial_inward_batches`, `pas_serial_bank` (004 scaffold) |
| `appSettings` | TBD `app_settings` |
| `yesoneInboundEvents` | TBD |
| `docaCertificates` | `doca_certificates` / `legacy_certificates` (import) |
| `automationWorker*` | Phase 5 |
| Storage files | `DATA_ROOT` filesystem paths |

---

## 4. Security rules → Express

| Firestore rule idea | Express |
|---------------------|---------|
| `isSuperAdmin` | `requireRole('ADMIN')` |
| `isRCAdmin` + `rcId == uid` | `requireRole('RC_ADMIN')` + `assertRcAccess` |
| VCT/verifier `vctRcId()` | user.`rc_id` + `assertRcAccess` |
| Products write admin-only | ADMIN write; all auth read |
| Customers/vehicles RC-scoped | `rc_id` filter on every query |
| Certificate server-only fields | Never accept `certified` / cert numbers from client body |

---

## 5. Port phases

| Phase | Scope | Status |
|-------|-------|--------|
| **P0** | Inventory + domain constants + public cert + RC customers/products/verifications/vehicles/lab | ✅ this pass |
| **P1** | Full verification submit lifecycle, media upload, application numbers | Next |
| **P2** | Wallet + Razorpay routes | Later |
| **P3** | Serial / quota / Vr Allotted / Yesone inbound | Later |
| **P4** | Zoho RV + schedules | Later |
| **P5** | eMaap / DOCA / certificate-worker | Deferred (ARCHITECTURE) |

---

## 6. Deploy readiness

- **Code in repo:** yes — routes mount under Express; migration `004_domain_parity.sql`.
- **Deploy to VPS now:** only after `db:migrate` on VPS and smoke of admin login + new list routes.
- **Do not** cut over live Yesone/Razorpay webhooks until secrets + handlers are complete.
