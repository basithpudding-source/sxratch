// Sxratch service worker — installable PWA + offline app shell.
//
// Strategy: network-first for same-origin GETs. When online you always get the
// freshest file (so active development never serves stale JS), and the response
// is cached so the app still boots fully offline. Cross-origin requests (e.g.
// user-supplied direct audio URLs) are left untouched.

const CACHE = "sxratch-v3";
const SHELL = [
  "/",
  "/index.html",
  "/css/styles.css",
  "/css/studio.css",
  "/js/app.js",
  "/js/audio-engine.js",
  "/js/scratch-processor.js",
  "/js/limiter-processor.js",
  "/js/waveform.js",
  "/js/waveform-worker.js",
  "/js/waveform-draw.js",
  "/js/ui.js",
  "/js/input.js",
  "/js/practice.js",
  "/js/songbuilder.js",
  "/js/instruments.js",
  "/js/theory.js",
  "/js/midi.js",
  "/js/haptics.js",
  "/js/presets.js",
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return; // don't touch cross-origin audio
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("/index.html")))
  );
});
