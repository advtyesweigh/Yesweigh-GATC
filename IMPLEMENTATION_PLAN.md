# GATC VPS Implementation Plan (Phase 1)

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md).  
**Phase 1 deliverable:** analysis, architecture, schema/API/Android outline, and a clear **first implementation milestone** — not a full rewrite.

---

## 0. Current state (gatc-vps)

| Area | State |
|------|--------|
| Repo | Private GitHub `faisalweighvox/gatc-vps`; CI on PR/push to `main` |
| Backend | Express health + `/api/status` only |
| Frontend | Vite status page (bootstrap) — **not** the future customer UI |
| Automation | Playwright scaffold; eMaap deferred |
| Deploy | PowerShell Deploy / Restart / Rollback |
| VPS | `GATC-VPS` SSH OK; `C:\GATC\gatc-vps` present; `C:\GATC\tools\` has Node/Git |
| Postgres / HTTPS / data dirs | **Prerequisites** — install without disrupting parallel setup work |

yesgatc remains the business-logic reference at `/Users/mac/Projects/gatc/yesgatc`. **Do not modify yesgatc** in this track.

---

## 1. Reuse strategy

### Reuse (port / mirror)

- Job kinds, wizard steps, photo kinds, status machine, application-number format  
- RC isolation via `rc_id` + parent RC for VCT  
- Product catalogue fields and capacity snapshotting  
- Customer + GPS / pincode gates  
- Validation rules from yesgatc `src/lib/*` (TypeScript → Kotlin domain tests)  
- Terminology for operators who already know yesgatc

### Redesign

- Auth, storage, and security model (JWT + Postgres + filesystem)  
- Normalized schema vs monolithic Firestore docs  
- Native Compose UI (no Capacitor)  
- Server-side RBAC as sole authority  

### Defer

- **Phase 5 — eMaap / DOCA / DSC** (see §8): ground in yesgatc `certificate-worker`, not a greenfield portal design  
- Verifier role, Vr Allotted UX, full Yesone/PAS/GAS complexity (introduce serial bank after core OV drafts work)  
- Razorpay wallet, Zoho Books, Yesone webhooks  
- Public certificate download SPA  
- Growing Vite customer frontend  

### Explicitly avoid

- Copying Firebase into VPS  
- Shipping WebView customer app  
- Inventing new government-mandated certificate field names beyond what yesgatc already models (when unsure, leave nullable / future)  
- Inventing a Phase 5 eMaap flow that ignores the yesgatc certificate worker  
- Disruptive VPS changes while another agent finishes bootstrap  

---

## 2. Phased milestones

### M0 — Phase 1 docs (this branch) ✅

- yesgatc located and analyzed  
- `ARCHITECTURE.md` + `IMPLEMENTATION_PLAN.md`  
- Hard constraints recorded; first build slice defined  

### M1 — **First implementation milestone** (next coding phase)

**Goal:** End-to-end “thin vertical” with **no eMaap**, proving auth, RC isolation, Postgres, and Android shell.

| Deliverable | Detail |
|-------------|--------|
| Postgres | Migrations for `regional_centers`, `users`, `products` (minimal), `customers`, `verifications`, `verification_media` |
| Auth API | Login (Aadhaar + password), JWT, `GET /me`, password hashing |
| RBAC middleware | ADMIN / RC_ADMIN / VCT; force `rc_id` scope |
| Seed | One ADMIN, one RC ADMIN, one VCT, one sample product |
| Verifications API | Create draft OV Self, list by RC, get by id (no cert write) |
| Media | Upload serial-plate image to filesystem; store path |
| Android | Project under `android/`; Login + empty home + draft list + create OV Self draft (minimal fields) |
| CI | Keep existing Node CI; add migration/API smoke when ready; Android lint optional initially |
| Frontend | Do **not** expand Vite customer UI; leave or mark deprecated in README |

**Exit criteria:** RC ADMIN and VCT can log into Android, create an OV Self draft scoped to their RC; ADMIN can list across RCs; VCT cannot read another RC’s rows; files land under `C:\GATC\data\` (or local Mac path in dev).

### M2 — OV Customer + evidence photos

- Customer CRUD  
- Full photo set + validation gates  
- Product picker from catalogue  
- Submit → `submitted` (still no eMaap)  

### M3 — RV Customer (app-side)

- RV docs, manufacturing year, performer photos  
- Fee fields stored; payment integrations still deferred  

### M4 — Serial bank + OV quota

- Port allotment rules incrementally (GAS first, then PAS)  
- Seat reservation / used marking on submit  

### M5 — ADMIN product & RC management on Android (or thin admin utility)

### M6 — VPS hardening

- HTTPS terminator, backups, log rotation, 4 GB memory budget review  

### M7 — Phase 5 eMaap (future; after M1–M4)

See **§8 Phase 5** below and [ARCHITECTURE.md §6](./ARCHITECTURE.md#6-phase-5--government-emaap-integration-deferred).  
Not part of the first usable release.

---

## 3. First implementation milestone — work breakdown

Suggested feature branch after docs merge: `feat/m1-auth-postgres-android-shell`.

1. **Backend foundation**  
   - Add `pg` + migration tool (e.g. `node-pg-migrate` / Prisma / Knex — pick one and stick)  
   - Config for `DATABASE_URL`, `JWT_SECRET`, `DATA_ROOT`  
   - Health remains; add `/api/v1/auth/*`  

2. **Domain slice**  
   - Tables listed in M1  
   - Seed script  
   - Verification create/list/get with RC filter tests  

3. **Storage**  
   - Multer (or equivalent) → `DATA_ROOT`; MIME/size limits  
   - Authenticated GET for media  

4. **Android shell**  
   - Gradle Kotlin DSL, Compose Material 3, MVVM  
   - Secure token storage  
   - Screens: Login, Home, VerificationList, OvSelfDraftForm  

5. **Docs / CI**  
   - Update `docs/setup.md` for Postgres local + Android Studio  
   - Extend CI carefully (don’t break existing health job)  

6. **VPS (read-only until ready)**  
   - Confirm Postgres install path with whoever finishes bootstrap  
   - Create `C:\GATC\data` with ACLs for `gatcdev` when deploying M1  

**Non-goals for M1:** eMaap, wallet, Zoho, serial allotment UI, Capacitor, rewriting yesgatc, deleting Vite overnight (can deprecate later).

---

## 4. Testing strategy (from M1)

- API: role isolation tests (VCT A cannot read RC B)  
- Migration up/down smoke in CI (when Postgres service added)  
- Android: ViewModel unit tests for validation ports  
- Manual: create draft on emulator against local API  

---

## 5. Risk register

| Risk | Mitigation |
|------|------------|
| 4 GB VPS exhaustion | No Chromium in M1–M5; single Node process; small Postgres buffers |
| Parallel VPS setup conflicts | Prefer Mac-local Postgres for M1; read-only VPS checks |
| yesgatc field drift | Treat yesgatc types as reference; nullable columns for uncertain gov fields |
| Scope creep (wallet/eMaap) | Hard defer until Phase 5 / M7; design must cite yesgatc `certificate-worker` |
| Vite frontend confusion | README pointer: customer UI = Android |

---

## 6. Decision log (Phase 1)

| Decision | Choice |
|----------|--------|
| Customer UI | Native Android Compose |
| Backend DB | PostgreSQL |
| Files | VPS filesystem |
| Firebase | None |
| eMaap | Phase 5 only — refer to yesgatc `certificate-worker` (ARCHITECTURE §6) |
| Verifier role | Deferred |
| First code milestone | M1 thin vertical (auth + RC isolation + OV Self draft + media) |

---

## 7. Immediate next action after this PR

Merge `docs/phase1-architecture` → open `feat/m1-auth-postgres-android-shell` and implement M1 only.

---

## 8. Phase 5 — Government eMaap (deferred)

**When:** Only after **M1–M4** (and preferably M5–M6 hardening): first usable product is Android + VPS API + Postgres **without** government submit.  
**Reference (mandatory):** yesgatc certificate worker — do not invent a blind alternative.

### 8.1 Reference: yesgatc certificate worker

| Item | Detail |
|------|--------|
| Root | `/Users/mac/Projects/gatc/yesgatc/certificate-worker/` |
| Docs | `README.md`, `server/README-SERVER.md`, `Yesgatc.DscEngine/README.md` |
| Primary app | `Yesgatc.CertificateWorker` — Super Admin, all-RC Playwright eMaap fill/certify + issued PDF + signed upload |
| Related | `Yesgatc.EmaapEngine` (RC-scoped eMaap); `Yesgatc.DscEngine` (RC USB DSC sign — not VPS) |
| Tech | .NET 8, Playwright/Chrome (headed), Firebase queue today |
| Inputs | Submitted verifications + party/instrument/photos/fees resolved per `rcId` |
| Outputs | Portal acknowledgement, certificate number, issued/signed PDF bytes, Firebase status → certified (gatc-vps will use Postgres + filesystem instead) |
| Manual steps today | Captcha / OTP / RDP session for Chrome; operator intervention when portal challenges |

Full architectural summary: [ARCHITECTURE.md §6](./ARCHITECTURE.md#6-phase-5--government-emaap-integration-deferred).

### 8.2 Reuse strategy for gatc-vps

**Reuse**

- Portal workflow and form field mapping proven in `EmaapCertificateGenerationAutomation` / Certificates Issued services  
- Status transitions and failure phases (`submitted` → certified; failed-at-submit recovery)  
- Acknowledgement dialog handling; serial/cert matching for PDF download  
- Preserve exact government / DSC-signed PDF bytes on disk  

**Do not copy**

- Firebase coupling, yesgatc credentials, OCR API keys, production portal logins  
- Default unattended captcha auto-solve as product policy  
- Shipping DSC Engine or CertificateWorker binaries unchanged onto gatc-vps without a Postgres-backed redesign  

**gatc-vps shape**

1. Prefer **official API**, then automation modeled on the certificate worker.  
2. **VPS-side worker** separate from Android and from the public REST surface.  
3. **Manual CAPTCHA/OTP**; **human review before submit**.  
4. Land under `automation/` (or a dedicated worker package) when Phase 5 opens — scaffold only until then.

### 8.3 Explicit non-goals until Phase 5

- No eMaap login, form fill, or PDF sync in M1–M4  
- No Chromium memory budget commitment on the 4 GB VPS before Phase 5  
- No modifications to yesgatc `certificate-worker` from this repo’s track  
