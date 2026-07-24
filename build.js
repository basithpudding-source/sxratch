// Sxratch production build.
//
// Dev needs NO build — `npm start` serves the ES modules in js/ directly. This
// script produces an optimized, minified copy in dist/ for deployment:
//
//   - js/app.js + all its imports  -> dist/js/app.js   (one bundled, minified module)
//   - js/scratch-processor.js       -> dist/js/scratch-processor.js  (the AudioWorklet
//        is loaded by URL via addModule(), NOT imported, so it is built separately and
//        kept at the same path so the runtime reference still resolves)
//   - css/*.css                     -> dist/css/*.css   (minified)
//   - index.html, manifest, sw.js, icon.svg  -> copied as-is
//
// Serve the result with:  npm run start:dist  (server.js --dist)

import esbuild from "esbuild";
import { rm, mkdir, cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const common = { bundle: true, minify: true, format: "esm", target: "es2020", logLevel: "info" };

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "js"), { recursive: true });

// Main app: inline every import into one minified module.
await esbuild.build({
  ...common,
  entryPoints: [join(root, "js/app.js")],
  outfile: join(dist, "js/app.js"),
  sourcemap: true,
});

// AudioWorklets: separate entries, same output paths (run in AudioWorkletGlobalScope).
for (const w of ["scratch-processor", "limiter-processor"]) {
  await esbuild.build({
    ...common,
    entryPoints: [join(root, `js/${w}.js`)],
    outfile: join(dist, `js/${w}.js`),
  });
}

// Waveform render worker: separate bundled entry, referenced by URL ("/js/...").
await esbuild.build({
  ...common,
  entryPoints: [join(root, "js/waveform-worker.js")],
  outfile: join(dist, "js/waveform-worker.js"),
});

// Stylesheets.
await esbuild.build({
  entryPoints: [join(root, "css/styles.css"), join(root, "css/studio.css"), join(root, "css/decks.css")],
  minify: true,
  outdir: join(dist, "css"),
  logLevel: "info",
});

// Static assets that ship unchanged (file or directory). samples/ is the
// self-hosted FluidR3_GM instrument set (npm run samples) — optional: skipped
// with a note if it hasn't been fetched, and the app falls back to the CDN.
for (const f of ["index.html", "manifest.webmanifest", "sw.js", "icon.svg", "icon-192.png", "icon-512.png", ".well-known"]) {
  await cp(join(root, f), join(dist, f), { recursive: true });
}
try {
  await cp(join(root, "samples"), join(dist, "samples"), { recursive: true });
} catch {
  console.warn("  (no samples/ directory — run `npm run samples` to self-host the GM instruments)");
}

console.log("\n  Built → dist/   (serve with: npm run start:dist)\n");
