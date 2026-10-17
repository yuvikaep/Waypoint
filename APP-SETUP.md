# Waypoint Android app

The Android app is the same customer web app (`src/customer`, login, admin console) packaged with
[Capacitor](https://capacitorjs.com). The UI is bundled inside the APK; only API calls go to the cloud
(`https://waypoint-eta-pied.vercel.app`). Native plugins are added only where the browser cannot do the
job: background driver location, push notifications and native Google Maps.

## Why Capacitor, not a plain WebView or a native rewrite

- A plain WebView wrapper stops location sharing when the phone locks, cannot receive reliable push,
  and is likely to be rejected by Google Play as a repackaged website.
- A native rewrite duplicates ~1,000 lines of customer UI plus maps, reports and i18n, and every later
  change would have to be made twice.
- Capacitor keeps one codebase and adds real Android permissions, a foreground location service and
  FCM where needed. Individual screens can still be rebuilt natively later if one feels slow.

## How API calls work in the app

The UI is served from `https://localhost` inside the app, so `/api/gps/...` is prefixed with
`VITE_API_ORIGIN` (set automatically by `vite build --mode app`). `CapacitorHttp` sends those requests
through Android's native HTTP stack, and `CapacitorCookies` keeps the `waypoint_session` cookie in the
Android cookie store. No CORS or `SameSite` change is needed on the server.

## Build

Requirements: Node 22, JDK 21, Android SDK (platform 36 + build-tools).

```bash
npm run android:sync     # build the app bundle into dist-app/ and copy it into android/
npm run android:apk      # debug APK at android/app/build/outputs/apk/debug/app-debug.apk
npm run android:open     # open the project in Android Studio
```

## Roadmap

| Phase | Scope | Needs from us |
|---|---|---|
| 1. App shell (in progress) | Capacitor project, bundled customer UI, API + session cookies through native HTTP, app name/icon, back button, external links (call, WhatsApp, Google Maps) | — |
| 2. Native features | Driver location as a foreground service ("Allow all the time"), permission screens; FCM push next to the existing web push | Firebase project + `google-services.json` |
| 3. Google Maps | Native Maps SDK for Android on the live map and vehicle page (map loads are free on mobile); OpenFreeMap stays on the website | Google Cloud API key restricted to the app, billing account on file |
| 4. Release | Upload keystore, versioning, Play Console listing, Data safety form, background-location declaration + demo video, internal testing track | Play Console account, keystore kept safe |

Decisions to confirm before the first Play upload (they cannot change afterwards):
- Application ID: `com.waypoint.fleet` (placeholder).
- Upload keystore owner and where it is backed up.
