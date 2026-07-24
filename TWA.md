# Shipping Sxratch to the Play Store (TWA)

Sxratch is a PWA. A **Trusted Web Activity (TWA)** wraps that PWA in a thin
Android app that opens it full-screen (no browser URL bar) and is installable
from Google Play — with essentially zero app code, because the engine is already
Web Audio + AudioWorklet and runs identically in Android Chrome.

> Verify audio latency on real devices first. For a scratching app, audio
> round-trip latency is the whole game; if Android Chrome's Web Audio latency is
> too high on your target hardware, consider a Capacitor shell with a native
> (Oboe/AAudio) audio path instead. Measure before committing to native.

## What's already in this repo

- `manifest.webmanifest` — installable web manifest (name, icons, `display:
  standalone`, theme colors). Already meets PWA installability criteria.
- `sw.js` — network-first service worker with an offline shell cache.
- `build.js` — production build script. It bundles/minifies the main app, keeps
  URL-loaded AudioWorklets/workers at stable paths, and copies manifest/icons/
  `.well-known` assets into `dist/`.
- `twa-manifest.json` — Bubblewrap config. **Replace every `PLACEHOLDER`.**
- `.well-known/assetlinks.json` — Digital Asset Links. The domain must serve this
  so Android verifies the app owns the site and hides the URL bar. **Replace the
  fingerprint.** (`server.js` and the `dist/` build already serve it.)

## Prerequisites

1. Deploy the PWA to **HTTPS** (TWA requires a secure origin; plain-http LAN
   won't register a service worker on a phone). Note your domain. Run
   `npm run build` first if you are deploying the optimized `dist/` output.
2. A **512×512 PNG icon** hosted on that domain. The repo ships `icon-512.png`
   (and `icon-192.png`), generated from `icon.svg` via `npm run icons` (sharp).
   After replacing the placeholder host, `twa-manifest.json` points
   `iconUrl`/`maskableIconUrl` at `https://<your-domain>/icon-512.png`.
3. JDK 17+ and the Android SDK (Bubblewrap can install these for you), **or** skip
   the local toolchain entirely and use https://www.pwabuilder.com (paste your
   URL → Android package).

## Build with Bubblewrap

```bash
npm i -g @bubblewrap/cli

# twa-manifest.json is already set to host sxratchpad.com (set your packageId if desired).
bubblewrap init --manifest "https://sxratchpad.com/manifest.webmanifest"
bubblewrap build          # produces app-release-signed.aab  (+ app-release-signed.apk)
```

`bubblewrap build` creates/uses a signing key. Get its SHA-256 fingerprint:

```bash
keytool -list -v -keystore android.keystore -alias android | grep SHA256
```

(If you use **Play App Signing**, take the fingerprint from the Play Console:
Release → Setup → App signing → "App signing key certificate".)

## Link the app to the domain

1. Put that SHA-256 fingerprint into `.well-known/assetlinks.json`
   (`sha256_cert_fingerprints`) and into `twa-manifest.json` `fingerprints`.
2. Redeploy so `https://sxratchpad.com/.well-known/assetlinks.json` is live.
3. Verify: https://developers.google.com/digital-asset-links/tools/generator
4. Install the APK and confirm the address bar is gone (verification succeeded).

## Publish

Upload `app-release-signed.aab` to the Play Console (Internal testing → Production).

---

Local sanity check of the assetlinks file while developing:

```bash
npm run build && npm run start:dist
curl http://localhost:5173/.well-known/assetlinks.json
```
