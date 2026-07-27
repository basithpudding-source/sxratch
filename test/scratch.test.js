// Unit tests for the scratch-read kernel (js/scratch-kernel.js) — the exact
// interpolation + loop-seam code the scratch worklet runs on the audio thread.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readClamped, createSeamState, seamStart, seamTick } from "../js/scratch-kernel.js";
import { catmullRom } from "../js/theory.js";

const SR = 48000;

function sineData(n, freq = 220, amp = 0.5) {
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amp;
  return d;
}

/**
 * Simulate the worklet's per-frame loop (mono) exactly as scratch-processor.js
 * runs it: clamped read, seam mix, seam tick, advance, wrap + seamStart.
 */
function renderLoop(data, { loopStart, loopEnd, rate, frames, startPh, fadeLen = 240 }) {
  const last = data.length - 1;
  const seam = createSeamState(fadeLen);
  const out = new Float32Array(frames);
  let ph = startPh;
  for (let i = 0; i < frames; i++) {
    let v = readClamped(data, ph, last);
    if (seam.active) v = v * seam.wMain + readClamped(data, seam.ph, last) * seam.wGhost;
    out[i] = v;
    if (seam.active) seamTick(seam, rate, last);
    ph += rate;
    const loopLen = loopEnd - loopStart;
    if (ph >= loopEnd) { seamStart(seam, ph, loopLen); ph -= loopLen; }
    else if (ph < loopStart) { seamStart(seam, ph, loopLen); ph += loopLen; }
  }
  return out;
}

const maxDelta = (x, from = 1, to = x.length) => {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) { const d = Math.abs(x[i] - x[i - 1]); if (d > m) m = d; }
  return m;
};

test("readClamped matches the tested catmullRom reference on interior samples", () => {
  const data = sineData(1000);
  for (const ph of [10.25, 500.5, 700.99, 998.01]) {
    const idx = ph | 0, frac = ph - idx;
    const ref = catmullRom(data[idx - 1], data[idx], data[idx + 1], data[Math.min(999, idx + 2)], frac);
    assert.ok(Math.abs(readClamped(data, ph, 999) - ref) < 1e-12, `mismatch at ph=${ph}`);
  }
});

test("loop seam: forward wrap has no click (discontinuity ≈ mid-loop level)", () => {
  const data = sineData(SR);
  // A loop length whose seam phase-mismatch is near worst case for 220 Hz.
  const opts = { loopStart: 10000, loopEnd: 14400.5, rate: 1, frames: SR / 2, startPh: 10000 };
  const out = renderLoop(data, opts);
  const natural = (2 * Math.PI * 220 / SR) * 0.5; // max per-sample slope of the sine
  const worst = maxDelta(out);
  assert.ok(worst < natural * 3, `seam click: max delta ${worst} vs natural ${natural}`);
});

test("loop seam without the fix WOULD click (sanity: the test can detect one)", () => {
  const data = sineData(SR);
  // Re-run with the seam disabled (fadeLen so large that seamStart always skips).
  const out = renderLoop(data, { loopStart: 10000, loopEnd: 14400.5, rate: 1, frames: SR / 2, startPh: 10000, fadeLen: 1e9 });
  const natural = (2 * Math.PI * 220 / SR) * 0.5;
  const worst = maxDelta(out);
  assert.ok(worst > natural * 4, `expected an audible seam without the fade, got ${worst}`);
});

test("loop seam: reverse playback wrap is also click-free", () => {
  const data = sineData(SR);
  const out = renderLoop(data, { loopStart: 10000, loopEnd: 14400.5, rate: -1, frames: SR / 2, startPh: 14000 });
  const natural = (2 * Math.PI * 220 / SR) * 0.5;
  assert.ok(maxDelta(out) < natural * 3, `reverse seam click: ${maxDelta(out)}`);
});

test("loop seam: non-integer rates stay click-free", () => {
  const data = sineData(SR);
  for (const rate of [0.92, 1.08, 1.5]) {
    const out = renderLoop(data, { loopStart: 20000, loopEnd: 26000.25, rate, frames: SR / 2, startPh: 20000 });
    const natural = (2 * Math.PI * 220 / SR) * 0.5 * rate;
    assert.ok(maxDelta(out) < natural * 3.5, `rate ${rate}: ${maxDelta(out)}`);
  }
});

test("tiny loops skip the crossfade (no ghost stacking) but stay bounded", () => {
  const data = sineData(SR);
  const out = renderLoop(data, { loopStart: 10000, loopEnd: 10100, rate: 1, frames: 4000, startPh: 10000 });
  let peak = 0;
  for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
  assert.ok(peak <= 0.51, `tiny loop over-amplitude: ${peak}`); // never exceeds source amplitude
});

test("seam weights are equal-power and settle to main-only", () => {
  const st = createSeamState(100);
  seamStart(st, 5000, 10000);
  let seen = 0;
  while (st.active) {
    const p = st.wMain * st.wMain + st.wGhost * st.wGhost;
    assert.ok(Math.abs(p - 1) < 1e-9, `not equal-power: ${p}`);
    seamTick(st, 1, 1e6);
    seen++;
    assert.ok(seen < 200, "fade never ends");
  }
  assert.equal(st.wMain, 1);
  assert.equal(st.wGhost, 0);
});
