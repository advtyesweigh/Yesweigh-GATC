# GATC RC Admin — Cursor UI Reference Pack

This package contains two interactive **visual references** for the new GATC application, plus a detailed native Android development context. Both references are original, self-contained offline HTML mockups.

## What is in the package?

- **`GATC_RC_Admin_Mobile_UI.html`** — Android phone UI reference (left slide-in menu, dashboard, OV/RV, filters, native form concept).
- **`GATC_RC_Admin_Desktop_UI.html`** — computer-sized UI reference (persistent left menu, desktop dashboard, verification table, quick access).
- **`GATC_Mobile_Dashboard.png`** — image reference for the phone dashboard.
- **`GATC_Mobile_Left_Menu.png`** — image reference for the phone drawer.
- **`GATC_Mobile_Recent_Verifications.png`** — phone dashboard scrolled to recent records.
- **`GATC_Desktop_Dashboard.png`** — image reference for the desktop dashboard.
- **`CURSOR_CONTEXT_GATC_RC_ADMIN.md`** — complete instructions for Cursor.

## How to use with Cursor

1. Extract the ZIP file into your development machine.
2. Open the existing private GitHub repository **`gatc-vps`** in Cursor.
3. Put these files under a `design/reference/gatc-rc-admin/` directory. Keeping design files in Git is useful; the production APK must **not** bundle these HTML prototypes.
4. Open `CURSOR_CONTEXT_GATC_RC_ADMIN.md` in Cursor.
5. Ask Cursor: **"Read this context and both HTML references. Locate and inspect the existing `yesgatc` project first. Build the RC Admin interface as real native Kotlin/Jetpack Compose and generate an Android debug APK. Do not create a web app."**
6. Ask Cursor to compare its Compose previews against the supplied screenshots and refine the UI.

## What works in the previews?

- Open/close the left menu on phone.
- Open/close Settings submenu.
- Navigate to Dashboard, Verification, Customer, Product, Purchases, VCT, Vehicle, Laboratory and Profile.
- Switch OV/RV verification filters and Today/This month summary.
- Enter a sample customer, product and serial number through New OV/RV and save a local demonstration draft.
- View sample record details.

**No data is sent to any VPS, government portal or external service.** Demo drafts exist in browser memory and disappear when the file is reloaded. Sample counts, dates and reference numbers are fictional. These HTML files are *references*, **not** the requested production application.

## Product direction

- Product: native Android APK.
- Layouts: phone first; responsive large-screen Android variant informed by the desktop reference.
- RC Admin left menu: Dashboard, Verification, Customer, Product, Purchases, Settings (VCT, Vehicle, Laboratory), Profile.
- The existing **`yesgatc`** project is the source for actual OV/RV business workflows and fields; never change it in the UI exercise.
- Backend, signed PDF/image storage and the Windows VPS come in a later phase.
