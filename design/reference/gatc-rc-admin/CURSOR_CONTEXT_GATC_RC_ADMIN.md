# CURSOR MASTER CONTEXT — GATC RC ADMIN UI

> **Read this file before changing code.** The owner wants a production-quality **native Android APK**. The two provided HTML files are **interactive visual references only**, not a web-app specification.

## A. Project and non-negotiable constraints

- **New project/repository:** existing private GitHub repository `gatc-vps`. Preserve repository history, existing CI, configuration and collaborators.
- **Existing reference project:** `yesgatc` (the user has developed a similar GATC product previously). **Locate and inspect it first**. Its real OV/RV workflows, customer/product/purchase concepts, VCT, vehicle, laboratory terminology and field/validation rules take precedence over assumptions in this file.
- **Primary product:** native Android APK, Kotlin + Jetpack Compose + Material 3. **No React, no Capacitor, no WebView-based UI, and no website deliverable.** Do not ship the reference HTML files inside the APK.
- **Computer/desktop UI reference:** use the wide-screen HTML for adaptive layouts on Android tablets, foldables or large Android displays, **not** as authorization to create a Windows/web application. A separate desktop application would require an explicit future decision.
- **Current target user:** RC Admin. Future roles are global Admin and VCT, but do not build all roles in this first UI milestone.
- **Backend later:** existing Windows VPS, Windows Server 2019 Standard Evaluation, 4 GB RAM, public IP already configured in prior project discussion. Use authenticated HTTPS APIs in later phases. No Firebase.
- **First milestone:** create a native Android UI using local, clearly labeled sample state / mock repositories, then produce a working debug APK. **Do not deploy or change VPS services in this milestone.**

## B. Files in this reference pack

| File | Use |
| --- | --- |
| `GATC_RC_Admin_Mobile_UI.html` | Interactive phone visual and navigation reference. Open locally in a browser. |
| `GATC_RC_Admin_Desktop_UI.html` | Interactive large-screen/desktop layout reference; design only. |
| `GATC_Mobile_Dashboard.png` | Screenshot of phone first viewport. |
| `GATC_Mobile_Left_Menu.png` | Screenshot of phone left navigation drawer. |
| `GATC_Mobile_Recent_Verifications.png` | Screenshot showing phone recent verification cards lower down. |
| `GATC_Desktop_Dashboard.png` | Screenshot of computer-sized dashboard. |
| `README.md` | How to use and navigate the references. |

The HTML prototypes are self-contained (styles and interaction scripts embedded) and can be viewed offline. Their records, dates and totals are fictitious and **must not be interpreted as VPS data or official government information**.

## C. **FIRST** inspect `yesgatc` rather than reinventing flows

1. Inspect the current `gatc-vps` repository (`git status`, directory layout, README, CI and existing Android code). Work on a new feature branch; do not wipe/recreate the repo.
2. Search available local workspaces and available GitHub repositories for the **exact project name** `yesgatc` (and a case-insensitive exact-name match). Do not silently substitute an unrelated GATC project.
3. If present, read the architecture/docs and inspect screens for **RC Admin dashboard, OV, RV, Customer, Product, Purchases, VCT, Vehicle, Laboratory and Profile**.
4. Document a table: **reference feature / reference field / desired new screen / reuse decision / missing information**. Pay particular attention to request statuses, government form requirements, instrument fields and historical verification links.
5. Reuse domain knowledge and validated field definitions where applicable, but modernize the presentation. **Do not modify, delete, commit to, or deploy `yesgatc`.**
6. If the reference cannot be located, state exactly which locations were checked and proceed with an isolated UI prototype using only the known scope. Leave unknown OV/RV fields as placeholders, not invented government requirements.
7. Before significant implementation, write or update `docs/YESGATC_REFERENCE_REVIEW.md` and `docs/RC_ADMIN_UI_PLAN.md`. Do not block initial UI scaffolding if the reference project is inaccessible.

## D. User hierarchy / permissions (for navigation and future API contracts)

- **Admin**: can see all RCs, creates RC Admin users. Does not automatically perform OV/RV.
- **RC Admin**: belongs to one RC, creates/manages only that RC's VCT users, can perform OV and RV, sees own RC's authorized data.
- **VCT**: created by RC Admin, can perform OV and RV, limited to own or explicitly assigned verification records and RC data.
- Server will enforce authorization and RC isolation; hiding menus is **not** a security boundary.
- **Current UI is RC Admin only.** All sample data must visually indicate demo/mock context.

## E. Left menu — exact hierarchy

```text
GATC / RC Workspace
  Dashboard
  Verification
  Customer
  Product
  Purchases
  Settings   [expand/collapse]
    VCT
    Vehicle
    Laboratory
  Profile    [separate at bottom]
```

- Maintain these labels as written, unless `yesgatc` reveals an important domain naming discrepancy that should be discussed/documented.
- On phone: hamburger opens a **left modal navigation drawer**; tapping outside or pressing Back closes it; selecting a destination closes it. No permanent sidebar on small phones.
- On Android tablet/large window: persistent navigation rail or sidebar and content area with responsive grids, drawn from `GATC_RC_Admin_Desktop_UI.html`.
- Settings submenu expands/collapses; Profile stays separate at the bottom.
- Selected item must be obvious using a pale-blue background and blue icon/text, without relying on color alone.
- Respect Android edge-to-edge/system insets, navigation, IME and accessibility.

## F. Dashboard — essential widgets only

### Phone order

1. Top app bar: hamburger, GATC brand, RC Admin workspace subtitle, notifications, profile avatar.
2. Page title: Dashboard; clear current reporting period.
3. Strong blue quick-action panel: **New OV** and **New RV** in the most prominent position.
4. A compact **2×2 KPI grid**: Total Verifications, Completed, Original (OV), Re-verification (RV). All KPIs should be internally consistent and sourced from one ViewModel/state flow.
5. **Needs attention**: Pending submissions and Signed PDFs pending. Values must not be made up for real operation; use explicit demo fixtures until the API exists.
6. **Recent verifications** list with OV/RV filter, customer, instrument, reference, status and date.
7. Native scrolling with no horizontal overflow; all touch targets comfortably accessible.

### Large-screen/computer-inspired order

1. Persistent left sidebar with same hierarchy.
2. Clean topbar and dashboard header.
3. Wide dark-navy quick-action hero with blue New OV and white New RV buttons.
4. Four summary cards in a horizontal row: Total, OV, RV, Pending Actions.
5. Wider recent-verifications table on the left, narrower Needs Attention and Quick Access panels on the right.
6. Avoid large decorative charts; real verification work should stay central.

### Interactive behavior to implement natively

- Both `New OV` and `New RV` navigate to distinct native flow entry points (initially mock draft forms) and create local demo drafts only, until APIs are ready.
- Today/This Month toggles the sample reporting period and changes sample KPI values coherently.
- OV/RV/All filter switches the recent list; search works when the Verification page is open.
- Recent record opens a details route or bottom sheet.
- All menu entries navigate to real Compose screen placeholders with recognizable headers and no dead links.
- Loading, empty, validation and error states must exist.

## G. Module screens to scaffold

| Screen | Initial UI scope |
| --- | --- |
| Dashboard | KPIs, New OV/RV, attention, recent records. |
| Verification | OV/RV segmented filters, search, request list, details, New OV/RV entry. |
| Customer | Customer list, search, add, details, related records. |
| Product | Instrument/product master; models/categories/capacities from yesgatc. |
| Purchases | Purchase entries and related instruments/files, fields from yesgatc. |
| Settings → VCT | RC-scoped VCT list, create/manage user entry. |
| Settings → Vehicle | Vehicle register and details. |
| Settings → Laboratory | Laboratory details and equipment configuration. |
| Profile | RC Admin identity, RC information, security, logout entry point. |

Only implement fields confirmed by `yesgatc` or clearly generic UI demo fields. Do not invent legal verification requirements.

## H. Visual system — match the attached references closely

**Design direction:** polished, restrained, Meta-inspired: **white + blue + near-black**. This is an original design reference, not a request to copy Meta logos, artwork or protected brand assets.

Suggested Compose palette:

```kotlin
val PrimaryBlue = Color(0xFF0866FF)
val PrimaryBlueDark = Color(0xFF0750CE)
val Navy = Color(0xFF101B35)
val TextInk = Color(0xFF121A2A)
val MutedText = Color(0xFF67748A)
val ScreenBackground = Color(0xFFF5F7FB)
val CardBackground = Color(0xFFFFFFFF)
val SoftBlue = Color(0xFFEBF3FF)
val Border = Color(0xFFE7EDF4)
val SuccessGreen = Color(0xFF128260)
val WarningAmber = Color(0xFFB16D12)
```

UI principles:

- Native Material 3 components, customized colors, shapes and typography to resemble the reference.
- High-contrast near-black body text; blue action color; muted metadata text.
- White cards on cool very-light-gray background; hairline borders; minimal elevation.
- Rounded cards (approximately 12–16 dp), compact but accessible row sizing and hierarchy.
- Avoid unnecessary whitespace, oversized headers and crowded dense tables on phones.
- Touch targets ~48dp or larger for primary controls; ensure readable type, dynamic type scaling and accessibility labels.
- Status is encoded with **label + color**, never color alone.
- Phone layout must work at ~360–430dp content widths and on typical 6-inch devices.
- Adapt to 600dp+ and 840dp+ using window-size classes, not hard-coded physical device assumptions.
- Do not put an interactive HTML file into WebView to simulate native UI.
- Maintain a single source of truth for counts, filters, draft records and menu selection.

## I. Recommended Android implementation

- Kotlin, Jetpack Compose, Material 3, Navigation Compose.
- MVVM, ViewModels, StateFlow, lifecycle-aware collection.
- Reusable components: `GatcTopBar`, `RcDrawer`, `VerificationActionCard`, `KpiCard`, `AttentionList`, `VerificationRow`, `VerificationTable`, `StatusChip`, and `EmptyState`.
- Screen destinations: `Dashboard`, `Verification`, `Customer`, `Product`, `Purchases`, `VCT`, `Vehicle`, `Laboratory`, `Profile`, `NewVerification`, `VerificationDetails`.
- Navigation destinations should use typed arguments or otherwise safe, explicit parameters.
- Repository interfaces and a **mock in-memory implementation** for Phase 1, ready to be replaced with VPS REST clients in Phase 2.
- Avoid excessive dependencies and heavy animations; target smooth operation on regular Android phones.
- Compose previews for phone and expanded-width layouts. Include screenshot/golden testing if available.

## J. Later backend/data behavior — planning, not Phase 1 scope

- The Windows VPS will eventually hold structured RC/customer/instrument/verification data in PostgreSQL, protected image files, and original final signed PDFs.
- PDFs must be stored **unchanged** to preserve any authentic digital signatures; retain secure metadata, hashes, authenticated retrieval and audit history.
- Images stored outside a public web root with server-side access control, safe upload validation, backups and retention.
- Android app uses authenticated HTTPS APIs; RC isolation is enforced on the server.
- eMaap/government interaction is a **separate later phase**; prefer official authorized APIs; if using browser automation, confirm portal permission, require human CAPTCHA/OTP handling and final human confirmation. No auto-CAPTCHA solving or bypass.
- No direct database connection from Android devices, and no Firebase.

## K. Implementation and acceptance sequence

1. Inspect `gatc-vps` and the exact `yesgatc` project; produce the comparison notes above.
2. Add the two references to `design/reference/` **without** using them as production source code.
3. Create native Android project or extend existing one without destructive changes.
4. Implement the phone drawer and RC Admin Dashboard to match the mobile screenshot.
5. Implement the adaptive large-screen dashboard and sidebar matching the desktop screenshot.
6. Scaffold all RC Admin destinations, OV/RV mock draft flow and verification details.
7. Wire mock data, date/OV/RV filters, functional navigation and proper empty/loading/error states.
8. Run formatting, static checks, tests and Gradle assembleDebug; generate a working debug APK.
9. Provide actual Compose previews or device screenshots at phone and tablet widths; compare against reference PNGs and fix spacing/overflow issues.
10. Commit on a feature branch, run GitHub CI and summarize changes. Do not deploy unapproved builds to the VPS.

### Acceptance checklist

- [ ] Native Android Kotlin/Compose UI; **no WebView or web frontend**.
- [ ] Responsive phone dashboard and left drawer.
- [ ] Adaptive large-screen layout with persistent side navigation.
- [ ] Exact menu order and Settings children.
- [ ] Working New OV / New RV sample forms and local sample drafts.
- [ ] Verification filter, period selector, record navigation.
- [ ] All other RC Admin routes scaffolded and navigable.
- [ ] Clear demo indication where data is mocked.
- [ ] No mutation of `yesgatc`.
- [ ] `gatc-vps` GitHub repository and CI preserved.
- [ ] Gradle debug APK builds; screenshots/previews generated.
- [ ] VPS and government portal untouched during UI phase.

## L. Cursor task to run now

> Open this file, inspect the two HTML designs and attached PNG screenshots, and inspect the **existing exact `yesgatc` project before implementing RC Admin business fields**. Keep `gatc-vps` as the target repository. Build a **native Kotlin + Jetpack Compose** RC Admin dashboard for phone and adaptive large-screen Android layouts. Match the white/blue/black references closely, keep the specified left menu, use isolated mock data, add Compose previews/tests, and produce a debug APK. Do not create a React/web/WebView app or change the Windows VPS in this first milestone. Report what was confirmed from `yesgatc`, what remains unknown, and the build/test status.
