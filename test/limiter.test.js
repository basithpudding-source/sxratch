// Unit tests for the shared look-ahead limiter kernel (js/limiter-kernel.js).
// This is the SAME code the live master-limiter worklet and the offline
// masterFinalize pass run — these tests cover what actually ships.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimiterKernel } from "../js/limiter-kernel.js";

const SR = 48000;
const CEIL = 0.965;

const peakOf = (x) => { let m = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; } return m; };
const finiteAll = (x) => { for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false; return true; };

function sine(n, freq, amp) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amp;
  return x;
}

test("kernel: quiet signal passes through at unity (only delayed)", () => {
  const n = SR;
  const L = sine(n, 440, 0.3), R = sine(n, 440, 0.3);
  const k = createLimiterKernel(SR);
  const outL = new Float32Array(n), outR = new Float32Array(n);
  k.process([L, R], [outL, outR], 0, n, CEIL);
  // Compensate the look-ahead delay, then compare mid-buffer
  const la = k.lookahead;
  let maxErr = 0;
  for (let i = la + 100; i < n - 100; i++) {
    const e = Math.abs(outL[i] - L[i - la]);
    if (e > maxErr) maxErr = e;
  }
  assert.ok(maxErr < 1e-6, `quiet signal altered: max err ${maxErr}`);
});

test("kernel: impulse train never exceeds the ceiling", () => {
  const n = SR;
  const L = sine(n, 200, 0.2);
  for (let i = 5000; i < n; i += 4000) { L[i] = 3; L[i + 1] = -3; } // brutal spikes
  const k = createLimiterKernel(SR);
  const out = new Float32Array(n);
  k.process([L], [out], 0, n, CEIL);
  assert.ok(peakOf(out) <= CEIL + 1e-7, `overshoot: ${peakOf(out)}`);
  assert.ok(finiteAll(out));
});

test("kernel: square burst over ceiling is limited, not flat-top clipped", () => {
  const n = SR;
  const L = sine(n, 200, 0.05);
  for (let i = 20000; i < 20000 + 480; i++) L[i] = 1.4 * Math.sin((2 * Math.PI * 900 * i) / SR);
  const k = createLimiterKernel(SR);
  const out = new Float32Array(n);
  k.process([L], [out], 0, n, CEIL);
  assert.ok(peakOf(out) <= CEIL + 1e-7);
  // Hard clipping would pin many consecutive samples at exactly the ceiling.
  let pinned = 0;
  for (let i = 0; i < n; i++) if (Math.abs(out[i]) >= CEIL - 1e-4) pinned++;
  assert.ok(pinned < 40, `flat-topped samples: ${pinned}`);
});

test("kernel: block-size invariance — 128-frame chunks equal one long pass", () => {
  // The property that proves the live worklet (128-frame blocks) and the
  // offline pass (one long buffer) produce identical audio.
  const n = SR;
  const src = sine(n, 330, 0.4);
  for (let i = 9000; i < n; i += 7000) src[i] = 2.2;

  const whole = new Float32Array(src);
  const kA = createLimiterKernel(SR);
  const outWhole = new Float32Array(n);
  kA.process([whole], [outWhole], 0, n, CEIL);

  const chunked = new Float32Array(src);
  const kB = createLimiterKernel(SR);
  const outChunks = new Float32Array(n);
  for (let off = 0; off < n; off += 128) {
    kB.process([chunked], [outChunks], off, Math.min(128, n - off), CEIL);
  }

  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(outWhole[i] - outChunks[i]) < 1e-9, `divergence at ${i}`);
  }
});

test("kernel: in-place processing (same array in and out) is safe", () => {
  const n = SR / 2;
  const a = sine(n, 500, 0.4);
  for (let i = 4000; i < n; i += 5000) a[i] = 2;
  const ref = new Float32Array(a);
  const k1 = createLimiterKernel(SR);
  const refOut = new Float32Array(n);
  k1.process([ref], [refOut], 0, n, CEIL);
  const k2 = createLimiterKernel(SR);
  k2.process([a], [a], 0, n, CEIL); // in place
  for (let i = 0; i < n; i++) assert.ok(Math.abs(a[i] - refOut[i]) < 1e-9, `in-place divergence at ${i}`);
});

test("kernel: gain recovers toward unity after a peak (release)", () => {
  const n = SR; // 1 s
  const L = sine(n, 440, 0.3);
  for (let i = 1000; i < 1100; i++) L[i] = 2.5; // early spike
  const k = createLimiterKernel(SR);
  const out = new Float32Array(n);
  k.process([L], [out], 0, n, CEIL);
  // Well after the spike (~5 release constants), amplitude should be back near 0.3.
  let tailPeak = 0;
  for (let i = n - SR / 10; i < n; i++) { const v = Math.abs(out[i]); if (v > tailPeak) tailPeak = v; }
  assert.ok(tailPeak > 0.29, `did not recover: tail peak ${tailPeak}`);
});

test("kernel: channels are gain-linked (stereo image preserved)", () => {
  const n = SR / 2;
  const L = sine(n, 440, 0.8);
  const R = sine(n, 440, 0.2); // quiet channel
  for (let i = 6000; i < 6100; i++) L[i] = 2; // spike on L only
  const k = createLimiterKernel(SR);
  const outL = new Float32Array(n), outR = new Float32Array(n);
  k.process([L, R], [outL, outR], 0, n, CEIL);
  // The same gain applies to both channels: L/R ratio is preserved through the event.
  const la = k.lookahead;
  const i = 6050 + la;
  const ratioIn = Math.abs(L[6050] / (R[6050] || 1e-9));
  const ratioOut = Math.abs(outL[i] / (outR[i] || 1e-9));
  assert.ok(Math.abs(ratioIn - ratioOut) / ratioIn < 0.05, `image shifted: ${ratioIn} -> ${ratioOut}`);
});
