# yesgatc ↔ GATC RC Admin UI comparison

Reference inspected (read-only): `/Users/mac/Projects/gatc/yesgatc`  
UI references: `design/reference/gatc-rc-admin/`

| Reference feature | yesgatc | New RC Admin UI | Reuse decision | Notes / missing |
| --- | --- | --- | --- | --- |
| Dashboard | `RCDashboard`, period filter, wallet/worker cards | Dashboard KPIs, New OV/RV, Needs attention, Recent | Modernize presentation; drop Firebase/wallet cards for Phase 1 | Sample KPIs only |
| Verification OV/RV | `JobType` OV/RV; `SiteCalibration`; job kind picker OV Self / OV Customer / RV Customer | New OV / New RV sample forms + list/details | Reuse terminology + core fields | Full multi-device / serial bank / photos later |
| Customer | `Customer`: name, phone, email, address, pincode, state, district, shop photo, devices | List + search with same core fields | Reuse field set | Create/edit/photos later |
| Product | `Product`: modelNo, capacities, accuracy class, model approval, PAS/GAS | List with model/capacity/class/approval | Reuse field set | Admin-managed catalogue later |
| Purchases | **No module** (Wallet, Zoho invoice, serial allotment exist) | Purchases nav + sample list | Scaffold only | Confirm product meaning with owner |
| VCT | `VCTManagement`, workflowMode auto/manual, approval | List with workflow + approval | Reuse labels | Create/docs later |
| Vehicle | `Vehicle` (nav label **Car** in yesgatc) | Vehicle list (brand/model/reg/validity) | Prefer UI label **Vehicle** | Docs/photos later |
| Laboratory | `LaboratorySettings.sealIdentification` | Seal ID display | Reuse seal pattern | Full lab menu later |
| Profile | `RCProfile` / My Profile | Profile placeholder | Scaffold | Auth later |
| Wallet / Verifier / Reports / Vr Allotted | Present in yesgatc RC nav | Not in Phase-1 mockup nav | Defer | Documented as intentional gap |
| Statuses | draft, pending_rc, submitted, approved, certified, rejected | UI: Draft, Pending, Awaiting PDF, Completed, Rejected | Map loosely for demo | Server statuses later |

## OV/RV fields confirmed for sample forms

From yesgatc `SiteCalibration` / customer entry:

- Customer name, phone  
- Product / instrument, serial number, maximum capacity  
- Ambient temperature, relative humidity  
- Seal identification number (lab default)  
- RV: manufacturing year  
- verificationLocation (`in_situ` / `in_premises`) — stored on draft model; UI default `in_premises`

Not invented as legal requirements: eMaap submit, fee/Zoho, image slots, serial banks (shown as future work).
