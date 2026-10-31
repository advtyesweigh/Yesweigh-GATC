# GATC RC Admin (Android)

Native Kotlin + Jetpack Compose RC Admin UI for `gatc-vps`. **No WebView / React / Capacitor.**

## yesgatc ↔ UI (short)

| Module | yesgatc | This app |
| --- | --- | --- |
| Dashboard / Verification OV·RV | Yes | Dashboard + sample OV/RV forms |
| Customer / Product | Yes | List scaffolds with verified fields |
| Purchases | **Missing in yesgatc** | Placeholder + sample rows |
| VCT / Vehicle / Laboratory | Yes (Vehicle nav = “Car”) | Settings children |
| Wallet, Verifier, Reports, Vr Allotted | Yes | Deferred (not in mockup nav) |

See `docs/YESGATC_REFERENCE_REVIEW.md` for the full table.

## Design references

`design/reference/gatc-rc-admin/` (HTML/PNG/context). Not packaged into the APK.

## Build

```bash
export JAVA_HOME="/path/to/jdk-17-or-21"
export ANDROID_HOME="$HOME/Library/Android/sdk"
cd android
./gradlew :app:assembleDebug
```

Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk`

Sample data is labeled in-app (“Sample UI only · Not connected to VPS”).

## Package

- `applicationId`: `in.gatc.rcadmin` (debug suffix `.debug`)
- Namespace / Kotlin: `com.gatc.rcadmin`
