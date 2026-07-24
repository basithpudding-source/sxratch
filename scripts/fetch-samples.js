// Download the sampled-instrument assets Sxratch self-hosts.
//
// Fetches the 14 FluidR3_GM programs the Song Builder uses (see GM_PROGRAMS in
// js/instruments.js) from the gleitz/midi-js-soundfonts GitHub mirror into
// samples/FluidR3_GM/, keeping the upstream one-file-per-instrument format so
// the loader works identically against local files and the CDN fallback.
//
// FluidR3 GM (by Frank Wen) and the midi-js-soundfonts renderings are MIT
// licensed — see samples/README.md. Run with:  npm run samples
//
// Idempotent: existing files are skipped; pass --force to re-download.

import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "samples", "FluidR3_GM");
const BASE = "https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM";
const force = process.argv.includes("--force");

// Every program referenced by GM_PROGRAMS in js/instruments.js.
const PROGRAMS = [
  // chords
  "pad_2_warm", "string_ensemble_1", "electric_piano_1", "drawbar_organ", "acoustic_guitar_nylon",
  // bass
  "electric_bass_finger", "synth_bass_1", "acoustic_bass", "synth_bass_2",
  // leads
  "lead_2_sawtooth", "lead_1_square", "flute", "celesta", "acoustic_guitar_steel",
];

await mkdir(outDir, { recursive: true });
let total = 0, fetched = 0, skipped = 0, failed = 0;

for (const program of PROGRAMS) {
  const file = `${program}-mp3.js`;
  const dest = join(outDir, file);
  if (!force) {
    try {
      const s = await stat(dest);
      if (s.size > 10000) { skipped++; total += s.size; console.log(`  · ${file} (kept, ${(s.size / 1048576).toFixed(1)} MB)`); continue; }
    } catch {}
  }
  try {
    const res = await fetch(`${BASE}/${file}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 10000 || !buf.subarray(0, 200).toString().includes("MIDI.Soundfont")) {
      throw new Error("unexpected content");
    }
    await writeFile(dest, buf);
    total += buf.length;
    fetched++;
    console.log(`  ✓ ${file} (${(buf.length / 1048576).toFixed(1)} MB)`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${file}: ${e.message}`);
  }
}

console.log(`\n  ${fetched} fetched, ${skipped} kept, ${failed} failed — ${(total / 1048576).toFixed(1)} MB in samples/FluidR3_GM/`);
if (failed) process.exit(1);
