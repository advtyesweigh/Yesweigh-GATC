# GATC VPS Architecture (Phase 1)

**Status:** Planning / design only. No production domain APIs or Android app yet.  
**Reference product:** yesgatc at `/Users/mac/Projects/gatc/yesgatc` (local; not modified by this repo).  
**Target:** Production-ready **native Android** GATC stamping app (OV / RV) + **Windows VPS** headless HTTPS API.

---

## 1. Hard constraints

| Constraint | Decision |
|------------|----------|
| Customer-facing app | **Native Android only** — Kotlin, Jetpack Compose, Material 3, MVVM |
| Forbidden for customer UI | React web app, website frontend, Capacitor, WebView-as-UI |
| Backend | Windows VPS; authenticated HTTPS REST; **PostgreSQL**; filesystem for images/PDFs |
| Cloud | **No Firebase** (Auth, Firestore, Storage, Hosting, Cloud Functions) |
| Roles (v1) | **ADMIN**, **RC ADMIN**, **VCT** — RC data isolation enforced **on the backend** |
| eMaap / DOCA government integration | **Phase 5 only** — deferred until after M1–M4 / Phases 2–4; ground design in yesgatc `certificate-worker` (do not invent a parallel approach) |
| Repo / process | Private `gatc-vps`; preserve CI; feature branches + PRs; explicit VPS deploy |

Existing Vite `frontend/` in this scaffold is a bootstrap status page only. Plan: **replace customer UI with Android**; keep a thin headless API (+ optional internal admin utilities later). Do not grow a Capacitor/React customer app.

---

## 2. yesgatc analysis (reference)

### 2.1 What it is

Production GATC portal for **Original Verification (OV)** and **Re-verification (RV)** of weighing instruments. Stack today:

- **UI:** React + TypeScript + Vite, also shipped as **Capacitor Android** (WebView shell — **do not reuse as architecture**)
- **Data / auth:** Firebase Auth (Aadhaar-as-login via `{aadhar}@yesgatc.auth`), Firestore, Cloud Storage
- **Server logic:** Firebase Cloud Functions (wallet, Zoho RV, Yesone webhooks, stale/resubmit helpers, public cert lookup, serial-plate OCR helper)
- **Certificates:** Windows `.NET` workers under `certificate-worker/` (`Yesgatc.CertificateWorker`, `Yesgatc.EmaapEngine`, `Yesgatc.DscEngine`) driving eMaap/DOCA — **Phase 5 only**; see [§6](#6-phase-5--government-emaap-integration-deferred)

Live domains observed locally: `yesgatc.in`, `crm.yesgatc.in`, `yesgatc.web.app`.

### 2.2 Roles & RBAC (yesgatc)

| yesgatc role | Scope |
|--------------|--------|
| `super_admin` | Global: products, RCs, VCT approval, verifications, wallet top-ups, integrations, settings |
| `rc_admin` | Own RC: customers, VCTs, verifiers, vehicles, verification jobs, wallet, Vr Allotted serials |
| `vct` | Field staff under `rcId`; creates OV/RV; workflow `auto` \| `manual` |
| `verifier` | Temporary RC staff; job kinds gated by `allowedJobKinds`; submits → `pending_rc` |

**RC isolation pattern:** every operational row carries `rcId`. Field staff resolve owner via `parentRcUid` (VCT/verifier → parent RC uid; never their own uid for quota/serial banks). Firestore rules encode isolation; **gatc-vps must re-implement this in API middleware + SQL**, not client trust.

**gatc-vps v1 role mapping**

| Requirement | Maps from yesgatc | Notes |
|-------------|-------------------|--------|
| ADMIN | `super_admin` | Rename for clarity in API/UI |
| RC ADMIN | `rc_admin` | |
| VCT | `vct` | |
| *(defer)* | `verifier` | Useful later; not required for Phase 1 product roles |

### 2.3 Core workflows to preserve (terminology & steps)

**Job kinds** (picker language — keep):

1. **OV Self** — instrument belongs to RC/centre (or verifier belonging rules); product → serial plate → evidence photos → review/submit  
2. **OV Customer** — select/create customer → product → serial → photos → review  
3. **RV Customer** — customer device + manufacturing year + prior certificate/invoice docs + performer identity photos (mobile) + fees/wallet concepts

**Verification lifecycle** (status machine — reuse):

`draft` → (`pending_rc`) → `submitted` → `approved` → `certified` | `rejected`

- Client creates/edits drafts and submits.  
- Certificate / government fields are **server-managed** (yesgatc: Admin SDK / worker). In gatc-vps: API services only; eMaap writers deferred.  
- Application number pattern: `VC/{yy}/{n}` (preserve format when implementing allocation).

**Evidence photos** (required set — reuse labels):

| Kind | Label (yesgatc) |
|------|-----------------|
| `stamping` | Serial number plate photo |
| `scale` | Instrument with F2 test weight |
| `instrumentRear` | Instrument with F2 Corner |
| `standardWeight` | Instrument with small Weights |
| `verificationSeal` | Verification seal photo |
| `installation` | Optional |

RV extras: old verification certificate, old invoice, manufacturing year, performer selfie+ID / Aadhaar+ID.

**Location / subject:** `in_situ` \| `in_premises`; `self` \| `customer`.

**Product catalogue:** model approval, capacity specs (multi-row), MPE, accuracy class, PAS vs GAS serial-bank flags (`pasPreAllotted`), active/sortOrder.

**Serial / quota domain (complex):** Yesone allotments, PAS sticker rules (`YJ…`), GAS (`G`/`X…`), Interweighing-direct serials, Vr Allotted, OV quota seats. Reuse **business rules** carefully; redesign storage as normalized SQL — do not copy Firestore document shapes blindly.

### 2.4 Domain entities (yesgatc collections → conceptual)

| Concept | yesgatc | Notes |
|---------|---------|--------|
| Users | `users` | Aadhaar login id, role, `rcId`, profiles, seals, fees, quota fields |
| Products | `products` | Admin-managed catalogue |
| Customers | `customers` | Per-RC; devices array; GPS; shop photo |
| Verifications | `siteCalibrations` | Primary OV/RV record + images + fees + cert fields |
| Vehicles | `vehicles` | RC fleet / F2 weight docs |
| Serial bank | `serialAllotments` + user quota fields | High complexity |
| Wallet | `rcWallets`, top-ups, ledger | Razorpay / Zoho — defer or slim |
| Settings | `appSettings` | Feature flags |

### 2.5 Debt & anti-patterns (do not copy)

- **Capacitor WebView** as “Android app” — violates new hard constraint.  
- **Firebase** as source of truth + security primarily in client rules — move to server RBAC + Postgres.  
- **Cleartext password** fields on user docs — never replicate.  
- **Certificate worker corruption markers** (`System.Collections.Generic.Dictionary` string pollution) — design typed DB columns and strict serializers.  
- **Unattended CAPTCHA bypass / silent bulk government submit** — yesgatc workers may OCR captcha and auto-run; gatc-vps Phase 5 policy is **operator-assisted** CAPTCHA/OTP and **human review before submit** (reuse their workflow, not their unattended defaults).  
- Monolithic `siteCalibrations` document with dozens of optional integration fields (Zoho, Yesone, pipeline) — split core verification vs integrations tables.  
- Login via fake email domain tied to Firebase — replace with JWT (or similar) issued by VPS API after credential check.

### 2.6 What to reuse intentionally

- Terminology: OV / RV, OV Self, OV Customer, RV Customer, RC, VCT, seal ID, application number, verification location/subject.  
- Wizard step order and validation gates (GPS, pincode, photo completeness, serial pool checks).  
- Status machine and “server-managed certificate fields” boundary.  
- RC-scoped data model + `parentRcUid` mental model.  
- Product specification / MPE / capacity snapshotting onto verification rows.  
- Fee tier structure shape (`RcFeesStructure`) as optional RC config.  
- Pure TypeScript validation modules as **spec** for Kotlin/shared tests (port logic; do not ship Firebase SDK).

---

## 3. Target system architecture

```text
┌────────────────────────────┐         HTTPS REST + JWT
│  Native Android (Compose)  │◄──────────────────────────┐
│  ADMIN / RC ADMIN / VCT    │                           │
└────────────────────────────┘                           │
                                                         ▼
┌────────────────────────────────────────────────────────────────┐
│  Windows VPS (gatcdev) — Node.js API (Express or equivalent)   │
│  Auth · RBAC · validation · file upload · PDF storage          │
└───────────────┬─────────────────────────────┬──────────────────┘
                │                             │
                ▼                             ▼
        PostgreSQL                    Filesystem
        (metadata)                    C:\GATC\data\...
                                      (images, PDFs)
```

- **Optional later:** internal admin CLI / minimal operator utility; Playwright automation package remains scaffold for **Phase 5 eMaap** (see §6), not customer UI.  
- **Out of scope now:** Firebase, Capacitor, public React customer SPA growth, eMaap automation.

### 3.1 Repository layout (evolution)

| Path | Phase 1 plan |
|------|----------------|
| `backend/` | Grow into authenticated domain API + Postgres + storage |
| `android/` | **New** native app module (added in first implementation milestone) |
| `frontend/` | Deprecate as customer UI; keep or shrink to health/status until Android ships |
| `automation/` | Remain scaffold; eMaap later |
| `deployment/` | Keep PowerShell deploy/restart/rollback |
| `.github/workflows/ci.yml` | Keep; extend when Android/Postgres tests exist |
| `ARCHITECTURE.md` / `IMPLEMENTATION_PLAN.md` | This design track |

### 3.2 Roles & RBAC (gatc-vps)

| Role | Capabilities (v1 intent) |
|------|---------------------------|
| **ADMIN** | Manage RCs, global products, all verifications (read), user lifecycle for RC admins, system settings |
| **RC ADMIN** | Manage own RC users (VCTs), customers, vehicles, create/submit OV/RV, list own RC verifications, RC profile |
| **VCT** | Create/submit OV/RV for parent RC only; manage customers within RC scope as today; no cross-RC |

**Enforcement:** every query/mutation filters by `rc_id` derived from the JWT (ADMIN may omit filter). Never trust client-supplied `rcId` for authorization. VCT `rc_id` is immutable from token claims after login.

### 3.3 Initial PostgreSQL schema (draft)

Names are snake_case; UUIDs preferred for PKs unless noted.

```text
regional_centers
  id, code, company_name, contact_person, phone, email, address,
  state, district, pincode, location_lat, location_lng,
  laboratory_seal_identification, fees_json, active, created_at, updated_at

users
  id, aadhaar (unique, 12 digits), username, password_hash,
  role (ADMIN | RC_ADMIN | VCT),
  rc_id (NULL for ADMIN; required for RC_ADMIN/VCT),
  phone, email, address, profile_json,
  workflow_mode (auto|manual, VCT),
  active, created_at, updated_at, created_by

products
  id, model_id (unique), model_no, name, type_of_instrument,
  manufacturer_brand_series, accuracy_class,
  capacities / specs (jsonb or product_specifications table),
  unit_of_measurement, model_approval_no, supply_voltage,
  pas_pre_allotted, active, sort_order,
  approval_doc_path, image_path, created_at, updated_at

customers
  id, rc_id, name, phone, email, address, pincode, state, district,
  location_lat, location_lng, shop_photo_path,
  created_by, created_at, updated_at

customer_devices
  id, customer_id, serial_number, product_id, product_name, image_path

vehicles
  id, rc_id, brand, model, year, reg_number, validity dates,
  doc paths, active, created_at

verifications
  id, rc_id, application_number (unique),
  verification_type (OV|RV),
  job_kind (ov_self|ov_customer|rv_customer),
  status,
  customer_id, customer_name, device_id,
  product_id, product snapshot columns,
  serial_number, serial_source,
  ambient_temperature, relative_humidity, seal_identification_number,
  verification_location, verification_subject,
  performed_by, performer_user_id, request_source,
  manufacturing_year (RV),
  fee columns (nullable),
  certificate_* (nullable until eMaap phase),
  created_by, submitted_at, approved_at, certified_at,
  created_at, updated_at

verification_media
  id, verification_id, kind, file_path, content_type, created_at

serial_allotments (phase after core OV)
  id, rc_id, serial, bank_type, status (available|reserved|used|void),
  assigned_user_id, invoice_ref, meta jsonb

audit_events
  id, actor_user_id, action, entity_type, entity_id, payload jsonb, created_at
```

Indexes: `(rc_id, status)`, `(rc_id, serial_number)`, unique `application_number`, unique `(rc_id, serial)` on allotments as rules mature.

### 3.4 API contracts (outline)

Base: `https://<host>/api/v1` — JSON; Bearer JWT; HTTPS only in production.

| Area | Endpoints (indicative) |
|------|-------------------------|
| Auth | `POST /auth/login` (aadhaar + password) → JWT; `POST /auth/logout` (optional denylist); `GET /auth/me` |
| Health | `GET /health` (existing; keep unauthenticated) |
| RCs | ADMIN CRUD `/regional-centers` |
| Users | ADMIN/RC ADMIN create VCT; list scoped users; activate/deactivate |
| Products | ADMIN write; authenticated read for active catalogue |
| Customers | RC/VCT CRUD scoped by `rc_id` |
| Verifications | create draft, patch, submit, list/filter, get by id |
| Media | `POST /verifications/:id/media/:kind` multipart → filesystem path stored |
| Certificates | read/download when present — write path deferred with eMaap |

**Response shape:** `{ data }` / `{ error: { code, message } }`.  
**Pagination:** cursor or limit/offset with `rc_id` filter always applied for non-ADMIN.

### 3.5 Android structure (modules & screens)

**Modules (recommended):**

- `:app` — navigation, DI (Hilt/Koin), theme  
- `:core:network` — Retrofit/Ktor, auth interceptor  
- `:core:data` — repositories, Room cache (optional offline later)  
- `:core:domain` — models, validation (port from yesgatc rules)  
- `:feature:auth`  
- `:feature:verification`  
- `:feature:customers`  
- `:feature:admin` (ADMIN + RC ADMIN shells)

**Screens (v1):**

1. Login (Aadhaar + password)  
2. Role home / dashboard  
3. Job kind picker (OV Self / OV Customer / RV Customer)  
4. Verification wizard (steps aligned with yesgatc)  
5. Camera / gallery capture with geo-stamp policy (port from yesgatc intent)  
6. Verification list + detail  
7. Customers list / form  
8. Products picker (read-only catalogue)  
9. Profile  
10. ADMIN: RC list, product admin (can trail field verification)

MVVM: `ViewModel` + UI state; single activity; Navigation Compose; Material 3.

### 3.6 Filesystem layout (VPS)

```text
C:\GATC\data\
  media\verifications\{rc_id}\{verification_id}\{kind}\...
  media\customers\{rc_id}\{customer_id}\...
  media\products\{product_id}\...
  certificates\{rc_id}\{verification_id}\...   # future
C:\GATC\gatc-vps\          # app checkout
C:\GATC\tools\             # portable Node/Git (already present)
```

Store relative paths in Postgres; serve via authenticated download routes (not world-readable static).

### 3.7 VPS prerequisites (4 GB RAM)

Verified lightly (read-only): SSH host `GATC-VPS` works as `gatcdev`; project at `C:\GATC\gatc-vps`; portable tools under `C:\GATC\tools\` (`node`, `mingit`). PostgreSQL **not** confirmed installed yet — treat as a prerequisite to install carefully (another agent may be finishing setup; avoid disruptive changes).

| Prerequisite | Guidance |
|--------------|----------|
| PostgreSQL | Prefer lightweight local install or managed remote; tune `shared_buffers` small (~128–256 MB) on 4 GB host |
| Node 20+ | Already via `C:\GATC\tools\node` pattern |
| HTTPS | Reverse proxy (IIS ARR / Caddy / nginx) + certificate; API bind localhost behind TLS terminator |
| Disk | Separate data volume/path for media; backups of DB + `C:\GATC\data` |
| Memory | Single Node API process; no IDE/browser farm on prod; defer Chromium automation until eMaap phase and RAM reviewed |
| Secrets | Production `.env` on VPS only; never commit |

---

## 4. Comparison: yesgatc vs gatc-vps requirements

| Topic | yesgatc | gatc-vps target |
|-------|---------|-----------------|
| Mobile UI | Capacitor WebView | Native Compose |
| Backend | Firebase | Windows VPS REST + Postgres |
| Auth | Firebase Auth | Self-hosted JWT |
| Isolation | Firestore rules | API + SQL |
| eMaap | Active `.NET` certificate workers (Firebase-coupled) | Phase 5 — VPS worker; refer to yesgatc `certificate-worker` |
| Roles | 4 roles | 3 roles (verifier deferred) |
| Customer web | Full React SPA | No customer web app |

---

## 5. Security principles

- Private repo; individual GitHub accounts; PR + CI before merge.  
- Explicit VPS deploy (existing scripts); no auto-deploy from CI.  
- Passwords hashed (argon2/bcrypt); Aadhaar stored as login identifier with access controls.  
- HTTPS + auth on all domain routes.  
- RC isolation tested with automated API tests.  
- No Firebase.  
- Government portal: Phase 5 only; operator review; manual CAPTCHA/OTP; no bypass (§6).

---

## 6. Phase 5 — Government eMaap integration (deferred)

**Status:** Not in the first usable release. Start only **after M1–M4 / Phases 2–4** (auth, OV/RV drafts, evidence, serial bank). Do **not** implement eMaap automation in early milestones.  
**Rule:** Design Phase 5 by **referring to the yesgatc certificate worker** — do not invent a parallel portal workflow from scratch.

### 6.1 Reference: yesgatc certificate worker

Local path (read-only reference; **never modify** from gatc-vps work):

| Path | Role |
|------|------|
| `/Users/mac/Projects/gatc/yesgatc/certificate-worker/` | Root: README, publish scripts, server deploy helpers |
| `…/certificate-worker/README.md` | Product overview, auto-worker, captcha/OTP login notes |
| `…/certificate-worker/Yesgatc.CertificateWorker/` | **Primary** Super Admin Windows app — all-RC queue, Playwright eMaap fill/certify, issued-PDF download, signed-PDF upload |
| `…/certificate-worker/Yesgatc.EmaapEngine/` | RC-scoped eMaap certificate generation variant (local RC machines; README says do **not** install on VPS in yesgatc) |
| `…/certificate-worker/Yesgatc.DscEngine/` | RC-scoped **WD PROXKey** DSC sign + Firebase upload — local RC PC only, not VPS |
| `…/certificate-worker/server/README-SERVER.md` | Windows Server / RDP unattended layout |
| Key services (CertificateWorker) | `EmaapLoginAutomation`, `EmaapCertificateGenerationAutomation`, `EmaapCertificatesIssuedAutomation`, `EmaapSubmitDialog`, `AutomationService`, `FirestoreService`, `WorkerQueueStagePicker`, `PipelineFailureClassifier` |

**What it does (summary):**

1. Authenticates as Super Admin against **Firebase** (`{aadhar}@yesgatc.auth`), lists `siteCalibrations` with `status == submitted` (all RCs).  
2. Drives **headed Chrome** via **Playwright** against `emaap.gov.in/gatc` (migrated from DOCA).  
3. Login: canvas captcha (OCR providers configurable) → Send OTP → OTP from Firestore / UI paste / optional Gmail fallback.  
4. **Fill + certify:** Generate Certificates form (`frm-gatc` field ids) — party/belong-to, address, instrument, metrological, checks, fees/charges — then submit and handle acknowledgement dialogs.  
5. **Certificates Issued:** match serial / certificate number, download government PDF, mark job **certified** (and store cert number / public PDF URL fields).  
6. **Queue stages** (`WorkerQueueStagePicker`): `FillCertify` → optional local `PdfSigner` / DSC path → `SignedEmaapUpload` (upload DSC-signed PDF back to eMaap).  
7. Failures: retries then `pipelineFailedPhase=submit` (or certification); permanent data errors → `rejected`. PDFs/stamping images cached under `%LOCALAPPDATA%\YesGATC\CertificateWorker\`.

**Stack:** .NET 8 Windows desktop, Playwright + Chrome, Firebase Auth/Firestore/Storage coupling, optional captcha OCR APIs. **Not** part of the Android/Capacitor app.

### 6.2 Reuse vs do not copy (gatc-vps)

| Reuse (workflow / domain) | Do **not** copy |
|---------------------------|-----------------|
| Portal steps: login → fill Generate Certificates → submit ack → Certificates Issued → PDF | Firebase Auth / Firestore queue / Storage as source of truth |
| Field mapping & alphanumeric constraints (`belongs_to`, address, instrument blocks, fees) | yesgatc credentials, API keys, master OTPs, production Firebase project ids |
| Status intent: `submitted` → government success → `certified` (+ mid-states / `pipelineFailedPhase` concepts as Postgres columns) | Blind copy of `.NET` / Avalonia UI / yesgatc install paths (`C:\YesGATC\…`) |
| Acknowledgement / dialog handling patterns; issued-row match by serial/cert number | Hard-coded production eMaap account endpoints or session cookies from yesgatc machines |
| Preserve **exact signed / issued PDF bytes**; store paths in DB; never recompress away signatures | Unattended captcha auto-solve as default policy |
| Separation: **VPS-side worker** ≠ Android app (mirror CertificateWorker vs Capacitor split) | Running DSC Engine / USB tokens on the shared VPS without a dedicated design |

### 6.3 gatc-vps Phase 5 approach (intent)

1. **Prefer an official government API** if/when available; fall back to **browser automation** only where the yesgatc worker already proves the portal path.  
2. Implement a **VPS-side worker** (separate process from the Node API and from Android) that reads the **Postgres** verification queue — not Firebase.  
3. **Manual CAPTCHA and OTP** (operator at RDP/console); no silent bypass.  
4. **Human review before submit** — filled form or payload visible to an operator; no blind bulk fire-and-forget in v1 of Phase 5.  
5. On success: persist certificate number, acknowledgement metadata, and **raw PDF bytes** under `C:\GATC\data\certificates\…`; transition status consistently with the yesgatc machine (`submitted` → certified path; surface failed-at-submit style recovery).  
6. DSC / hardware signing remains a **later / RC-local** concern unless product explicitly moves it; do not conflate with first eMaap fill/certify slice.  
7. Revisit VPS RAM (Chromium) only when Phase 5 starts; keep `automation/` as the scaffold landing zone, informed by CertificateWorker services above.

**Explicit deferral:** Phase 5 is **out of scope** for M1–M4 and the first usable Android + API release. Track detail in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) § Phase 5 / M7.

---

## 7. Related docs

- [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) — milestones and first build slice (Phase 5 / M7 deferred)  
- [docs/setup.md](./docs/setup.md), [docs/deployment.md](./docs/deployment.md), [docs/ssh-windows.md](./docs/ssh-windows.md) — infra bootstrap  
- yesgatc field-level workflow: `/Users/mac/Projects/gatc/yesgatc` (`src/types.ts`, `src/lib/verification*.ts`, `firestore.rules`)  
- yesgatc eMaap reference: `/Users/mac/Projects/gatc/yesgatc/certificate-worker/` (see §6)
