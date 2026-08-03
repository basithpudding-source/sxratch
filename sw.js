// Sxratch service worker — installable PWA + offline app shell.
//
// Strategy: network-first for same-origin GETs. When online you always get the
// freshest file (so active development never serves stale JS), and the response
// is cached so the app still boots fully offline. Cross-origin requests (e.g.
// user-supplied direct audio URLs) are left untouched.

// Note: samples/FluidR3_GM/*.js are NOT pre-cached (≈32 MB) — the fetch
// handler below caches them on demand the first time the Sampled·GM engine
// loads one, after which that instrument works offline. They live in their
// own UNVERSIONED cache: the files are immutable, so a shell version bump
// must not throw away megabytes of downloaded instruments.
const CACHE = "sxratch-v30"; // bump when the shell changes so clients refresh
const SAMPLE_CACHE = "sxratch-samples-v1";
const SHELL = [
  "/",
  "/index.html",
  "/css/styles.css",
  "/css/tokens.css",
  "/css/studio.css",
  "/css/daw.css",
  "/css/decks.css",
  "/js/app.js",
  "/js/audio-engine.js",
  "/js/scratch-processor.js",
  "/js/scratch-kernel.js",
  "/js/limiter-processor.js",
  "/js/limiter-kernel.js",
  "/js/waveform.js",
  "/js/waveform-worker.js",
  "/js/waveform-draw.js",
  "/js/ui.js",
  "/js/input.js",
  "/js/practice.js",
  "/js/daw.js",
  "/js/daw-guidance.js",
  "/js/daw-engine.js",
  "/js/daw-model.js",
  "/js/synth.js",
  "/js/theme.js",
  "/js/pad-geometry.js",
  "/js/pad-grooves.js",
  "/js/recorder.js",
  "/js/wav.js",
  "/js/store.js",
  "/js/taptempo.js",
  "/js/metronome.js",
  "/js/idb-store.js",
  "/js/instruments.js",
  "/js/theory.js",
  "/js/midi.js",
  "/js/haptics.js",
  "/js/presets.js",
  "/js/bpm.js",
  "/js/midiexport.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (e) => {
  // Cache each shell entry independently and tolerate misses: the production
  // build inlines the js/ modules into app.js, so the per-module URLs 404 there
  // — skip them rather than failing the whole install.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SAMPLE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't touch cross-origin audio
  const bucket = url.pathname.includes("/samples/") ? SAMPLE_CACHE : CACHE;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          // put() can reject (storage quota — sample files are MBs); a failed
          // cache write must never surface as a failed request.
          caches.open(bucket).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => {
        if (hit) return hit;
        // App-shell fallback is for NAVIGATIONS only. Handing index.html to a
        // code path that asked for a script/sample (e.g. the soundfont loader
        // offline) would feed HTML to a JS parser instead of failing cleanly.
        if (req.mode === "navigate") return caches.match("/index.html");
        return Response.error();
      }))
  );
});
