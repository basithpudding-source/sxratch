// S4 engine tests — the primitives that were measurably wrong.
//
// Each test states the defect it locks out, with the number measured on the
// pre-fix code, so a regression is recognisable rather than just red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { noiseData, noiseSeek, ksData, randomPhaseHarmonics, mtof } from "../js/synth.js";

const SR = 44100;
const rmsOf = (x) => { let a = 0; for (let i = 0; i < x.length; i++) a += x[i] * x[i]; return Math.sqrt(a / x.length); };
const peakOf = (x) => { let m = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; } return m; };

/* ------------------------------ noise bed ------------------------------- */

test("noiseData: deterministic, correctly scaled white noise", () => {
  const a = noiseData(SR, 0.2, 7);
  const b = noiseData(SR, 0.2, 7);
  assert.deepEqual(Array.from(a.slice(0, 500)), Array.from(b.slice(0, 500)));
  // Uniform on [-1,1] has RMS 1/sqrt(3); this catches a mis-scaled generator,
  // which a determinism-only test would sail past.
  assert.ok(Math.abs(rmsOf(a) - 1 / Math.sqrt(3)) < 0.02 * (1 / Math.sqrt(3)), `rms ${rmsOf(a)}`);
  assert.ok(peakOf(a) <= 1);
});

test("noiseData: different seeds are uncorrelated", () => {
  const a = noiseData(SR, 0.2, 1), b = noiseData(SR, 0.2, 2);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  const r = dot / (a.length * rmsOf(a) * rmsOf(b));
  assert.ok(Math.abs(r) < 0.05, `cross-correlation ${r}`);
});

test("noiseSeek: in range, identical for the same note, spread across steps", () => {
  const dur = 1;
  for (let ndx = 0; ndx < 40; ndx++) {
    for (let step = 0; step < 64; step++) {
      const v = noiseSeek(ndx, step, dur);
      assert.ok(v >= 0 && v < dur - 0.1 + 1e-9, `seek ${v} out of range`);
      assert.equal(v, noiseSeek(ndx, step, dur));
    }
  }
  // Consecutive steps must not read nearly the same slice, or a 16th-note hat
  // line reuses one fragment of noise and machine-guns.
  for (let step = 0; step < 16; step++) {
    const d = Math.abs(noiseSeek(0, step, 1) - noiseSeek(0, step + 1, 1));
    assert.ok(d > 0.05, `steps ${step}/${step + 1} only ${d}s apart`);
  }
});

/* --------------------------- Karplus-Strong ----------------------------- */

/**
 * f0 by autocorrelation with parabolic peak interpolation.
 *
 * Takes the FIRST lag that reaches 88% of the global maximum, not the global
 * maximum itself: a harmonically rich decaying pluck correlates just as well
 * at twice its period, and the naive "argmax" reports an octave low (measured
 * −1198 cents at MIDI 40 while the synthesis was correct).
 */
function estimateF0(x, sr, from, win) {
  const seg = x.subarray(from, from + win);
  // Up to 3 kHz: MIDI 96 is 2093 Hz, i.e. a 21-sample period, and a 1400 Hz
  // ceiling would put the true lag outside the search window entirely.
  const minLag = Math.floor(sr / 3000), maxLag = Math.floor(sr / 30);
  const at = (lag) => {
    let s = 0;
    for (let i = 0; i + lag < seg.length; i++) s += seg[i] * seg[i + lag];
    return s / (seg.length - lag);
  };
  const corr = new Float64Array(maxLag + 2);
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    corr[lag] = at(lag);
    if (lag <= maxLag && corr[lag] > best) best = corr[lag];
  }
  let bestLag = minLag;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (corr[lag] >= 0.88 * best && corr[lag] > corr[lag - 1] && corr[lag] >= corr[lag + 1]) { bestLag = lag; break; }
  }
  const y0 = corr[bestLag - 1], y1 = corr[bestLag], y2 = corr[bestLag + 1];
  const denom = y0 - 2 * y1 + y2;
  const shift = Math.abs(denom) > 1e-12 ? (0.5 * (y0 - y2)) / denom : 0;
  return sr / (bestLag + shift);
}

const measureCents = (sr, midi) => {
  const f = mtof(midi);
  const x = ksData(sr, f, 0.6, { decay: 0.998, brightness: 0.6, seed: 99 });
  const from = Math.floor(sr * 0.1);
  const win = Math.min(4096, x.length - from - 1);
  return 1200 * Math.log2(estimateF0(x, sr, from, win) / f);
};

test("ksData: plucks are in tune across the playable range, at 44.1 AND 48 kHz", () => {
  // Pre-fix (integer delay line, half-sample averaging error unaccounted for)
  // the error grew with pitch and DIFFERED per sample rate, so the same song
  // was differently out of tune on a 48 kHz device: +5c at MIDI 60, +26c at
  // 88, and worse above. Measured now: within 0.2c everywhere below MIDI 92.
  for (const sr of [44100, 48000]) {
    for (let midi = 28; midi <= 92; midi += 2) {
      const cents = measureCents(sr, midi);
      assert.ok(Math.abs(cents) < 1.5, `sr=${sr} midi=${midi} off by ${cents.toFixed(2)} cents`);
    }
  }
});

test("ksData: the very top of the range stays usable", () => {
  // At MIDI 96 the loop is only ~21 samples; the estimator is near its own
  // resolution limit there too, so the bound is looser and deliberately so.
  // These pitches are above the guitar/upright patches' actual range.
  for (const sr of [44100, 48000]) {
    assert.ok(Math.abs(measureCents(sr, 96)) < 6, `sr=${sr} midi=96`);
  }
});

test("ksData: tuning no longer depends on the device sample rate", () => {
  // The defect this locks out: a song that is in tune on a 44.1 kHz phone and
  // out of tune on a 48 kHz laptop.
  for (let midi = 40; midi <= 88; midi += 4) {
    const d = Math.abs(measureCents(44100, midi) - measureCents(48000, midi));
    assert.ok(d < 1, `midi=${midi} differs by ${d.toFixed(2)} cents between sample rates`);
  }
});

test("ksData: the allpass did not change the decay character", () => {
  const sr = SR, f = mtof(60);
  const x = ksData(sr, f, 1.0, { decay: 0.996, brightness: 0.6, seed: 5 });
  const win = 2048;
  const early = rmsOf(x.subarray(Math.floor(sr * 0.05), Math.floor(sr * 0.05) + win));
  const late = rmsOf(x.subarray(Math.floor(sr * 0.5), Math.floor(sr * 0.5) + win));
  const ratio = late / early;
  // A ~0.996 loop over 0.45 s at ~262 Hz decays a long way but must still ring.
  assert.ok(ratio > 0.001 && ratio < 0.9, `decay ratio ${ratio}`);
});

test("ksData: deterministic and finite", () => {
  const a = ksData(SR, mtof(64), 0.3, { seed: 11 });
  const b = ksData(SR, mtof(64), 0.3, { seed: 11 });
  assert.deepEqual(Array.from(a.slice(0, 400)), Array.from(b.slice(0, 400)));
  for (let i = 0; i < a.length; i++) assert.ok(Number.isFinite(a[i]), `NaN at ${i}`);
  assert.ok(peakOf(a) < 4, "loop must not blow up");
});

/* ------------------------- random-phase wave bank ------------------------ */

/** Reconstruct one cycle from Fourier coefficients. */
function idft({ real, imag }, n = 2048) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    let v = 0;
    for (let k = 1; k < real.length; k++) {
      if (real[k] === 0 && imag[k] === 0) continue;
      v += real[k] * Math.cos(k * th) + imag[k] * Math.sin(k * th);
    }
    out[i] = v;
  }
  return out;
}

test("randomPhaseHarmonics: identical magnitude spectrum for every bank entry", () => {
  const ref = randomPhaseHarmonics("sawtooth", 0, 64);
  for (let k = 1; k < 8; k++) {
    const w = randomPhaseHarmonics("sawtooth", k, 64);
    for (let n = 1; n <= 64; n++) {
      const m0 = Math.hypot(ref.real[n], ref.imag[n]);
      const mk = Math.hypot(w.real[n], w.imag[n]);
      assert.ok(Math.abs(mk - m0) <= 0.01 * m0 + 1e-9, `harmonic ${n}, k=${k}: ${mk} vs ${m0}`);
    }
  }
});

test("randomPhaseHarmonics: every entry is the same loudness (the normalisation trap)", () => {
  // createPeriodicWave normalises to unit PEAK by default; a randomised-phase
  // wave has a lower peak, so it would be BOOSTED and the pad's level would
  // jump per note. Coefficients are pre-scaled by RMS instead.
  const target = 1 / Math.sqrt(3); // native sawtooth RMS
  for (let k = 0; k < 8; k++) {
    const r = rmsOf(idft(randomPhaseHarmonics("sawtooth", k, 128), 1024));
    assert.ok(Math.abs(r - target) < 0.005 * target + 0.002, `k=${k} rms ${r} vs ${target}`);
  }
});

test("randomPhaseHarmonics: phases genuinely differ, and stacks stop summing coherently", () => {
  const waves = [];
  for (let k = 0; k < 8; k++) waves.push(idft(randomPhaseHarmonics("sawtooth", k, 128), 1024));
  const crests = waves.map((w) => peakOf(w) / rmsOf(w));
  const spread = (Math.max(...crests) - Math.min(...crests)) / Math.min(...crests);
  assert.ok(spread > 0.2, `crest factors barely differ (${spread})`);

  const sum = (idxs) => {
    const out = new Float32Array(1024);
    for (const i of idxs) for (let j = 0; j < 1024; j++) out[j] += waves[i][j];
    return out;
  };
  const same = peakOf(sum([0, 0, 0, 0]));
  const diff = peakOf(sum([0, 1, 2, 3]));
  assert.ok(diff < 0.7 * same, `4-voice stack peak ${diff} vs coherent ${same}`);
});

test("randomPhaseHarmonics: square and triangle keep their harmonic structure", () => {
  const sq = randomPhaseHarmonics("square", 3, 32);
  for (let n = 2; n <= 32; n += 2) {
    assert.equal(Math.hypot(sq.real[n], sq.imag[n]), 0, `square has even harmonic ${n}`);
  }
  const tri = randomPhaseHarmonics("triangle", 3, 32);
  const m1 = Math.hypot(tri.real[1], tri.imag[1]);
  const m3 = Math.hypot(tri.real[3], tri.imag[3]);
  assert.ok(m3 > 0 && m3 < m1 / 5, "triangle rolls off as 1/n^2");
});

test("randomPhaseHarmonics: deterministic", () => {
  const a = randomPhaseHarmonics("sawtooth", 5, 32);
  const b = randomPhaseHarmonics("sawtooth", 5, 32);
  assert.deepEqual(Array.from(a.real), Array.from(b.real));
  assert.deepEqual(Array.from(a.imag), Array.from(b.imag));
});

/* ------------------- drum round-robin + band-limiting -------------------- */

import { drumSampleData, DRUM_VARIANTS, chokeSchedule } from "../js/synth.js";

const KITS = ["acoustic", "808", "electronic", "lofi", "bossa"];

/**
 * Spectral centroid over the AUDIBLE band, via a naive DFT.
 *
 * Measured to 20 kHz rather than Nyquist deliberately: what matters is that
 * the drum sounds the same on a 44.1 kHz phone and a 48 kHz laptop, and
 * ultrasonic residue above 20 kHz is inaudible on both. Measuring to Nyquist
 * would compare a 22 kHz-wide spectrum against a 44 kHz-wide one and report a
 * difference nobody can hear.
 */
function centroid(x, sr, bins = 200, fmax = 20000) {
  const n = Math.min(x.length, 8192);
  let num = 0, den = 0;
  for (let b = 1; b <= bins; b++) {
    const f = (b / bins) * Math.min(fmax, sr / 2);
    const w = (2 * Math.PI * f) / sr;
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { re += x[i] * Math.cos(w * i); im -= x[i] * Math.sin(w * i); }
    const mag = Math.hypot(re, im) / n;
    num += f * mag; den += mag;
  }
  return den > 0 ? num / den : 0;
}

/** Fraction of total energy in low (<200 Hz), mid (200 Hz-2 kHz) and high (>2 kHz) bands. */
function bands(x, sr) {
  const n = Math.min(x.length, 8192);
  const at = (f) => {
    const w = (2 * Math.PI * f) / sr;
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { re += x[i] * Math.cos(w * i); im -= x[i] * Math.sin(w * i); }
    return Math.hypot(re, im) / n;
  };
  // LOG-spaced probes: a kick lives between 40 and 120 Hz, and linear bins
  // over 0-16 kHz put a single probe below 200 Hz — so a 2% pitch change
  // between takes moved the sweep across that one bin and looked like a 5x
  // change in bass content when the waveforms were in fact near-identical.
  let low = 0, mid = 0, high = 0;
  const lo = 30, hi = Math.min(16000, sr / 2), steps = 160;
  for (let b = 0; b < steps; b++) {
    const f = lo * Math.pow(hi / lo, b / (steps - 1));
    const m = at(f);
    if (f < 200) low += m; else if (f < 2000) mid += m; else high += m;
  }
  const t = low + mid + high || 1;
  return { low: low / t, mid: mid / t, high: high / t };
}

test("drumSampleData: round-robin variants are different takes, not different drums", () => {
  for (const kit of KITS) {
    for (const key of ["kick", "snare", "hat"]) {
      const v0 = drumSampleData(SR, kit, key, 0);
      const b0 = bands(v0, SR);
      for (let v = 1; v < (DRUM_VARIANTS[key] || 1); v++) {
        const vn = drumSampleData(SR, kit, key, v);
        // Different…
        let maxDiff = 0;
        const n = Math.min(v0.length, vn.length);
        for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(v0[i] - vn[i]));
        assert.ok(maxDiff > 0.05, `${kit}/${key} variant ${v} is identical to variant 0`);

        // …but the same instrument. Loudness matching (not peak normalising)
        // is what makes this hold: pre-fix, two takes of the same lofi hat
        // differed by 33%.
        const r0 = rmsOf(v0.subarray(0, Math.floor(SR * 0.2)));
        const rn = rmsOf(vn.subarray(0, Math.floor(SR * 0.2)));
        assert.ok(Math.abs(rn - r0) <= 0.15 * r0, `${kit}/${key} v${v} loudness drift ${rn} vs ${r0}`);

        // Tonal balance by band energy rather than spectral centroid: a kick's
        // centroid is set almost entirely by a few milliseconds of beater
        // click, so it swings wildly for changes nobody would call a different
        // drum. Peak is deliberately NOT asserted — crest factor is free to
        // vary take to take, which is what real drums do.
        const bn = bands(vn, SR);
        for (const k of ["low", "mid", "high"]) {
          assert.ok(Math.abs(bn[k] - b0[k]) < 0.08, `${kit}/${key} v${v} ${k}-band share ${bn[k].toFixed(3)} vs ${b0[k].toFixed(3)}`);
        }
      }
    }
  }
});

test("drumSampleData: every variant is deterministic", () => {
  for (let v = 0; v < 4; v++) {
    const a = drumSampleData(SR, "808", "kick", v);
    const b = drumSampleData(SR, "808", "kick", v);
    assert.deepEqual(Array.from(a.slice(0, 600)), Array.from(b.slice(0, 600)));
  }
});

test("drum timbre no longer depends on the device sample rate", () => {
  // Pre-fix, with naive squares: 808 closed hat centroid +2.7% at 48 kHz and
  // +30.1% at 96 kHz; crash +7.5% and +99.9%. The drums a developer tested at
  // 44.1 kHz were not the drums a user heard at 48 kHz.
  for (const kit of KITS) {
    for (const key of ["hat", "open", "crash"]) {
      const base = centroid(drumSampleData(44100, kit, key), 44100);
      for (const sr of [48000, 88200]) {
        const c = centroid(drumSampleData(sr, kit, key), sr);
        const drift = Math.abs(c - base) / base;
        // 48 kHz is the case that actually matters — most desktops run the
        // AudioContext there while the tests and many phones run 44.1 kHz.
        // 88.2 kHz is rare and the lofi crash's baseline centroid is only
        // ~7 kHz, so small absolute moves read as large percentages there.
        const bound = sr === 48000 ? 0.06 : 0.13;
        assert.ok(drift < bound, `${kit}/${key} centroid drifts ${(drift * 100).toFixed(1)}% at ${sr}`);
      }
    }
  }
});

test("chokeSchedule: an open hat is cut by the next closed hat, and only then", () => {
  assert.deepEqual(chokeSchedule([0, 1, 2], [0.5, 1.5]), [0.5, 1.5, null]);
  assert.deepEqual(chokeSchedule([1], []), [null]);
  assert.deepEqual(chokeSchedule([], [1, 2]), []);
  // A closed hat at the same instant must not choke it (they are one hit).
  assert.deepEqual(chokeSchedule([1], [1, 2]), [2]);
  // Order of the closed list must not matter.
  assert.deepEqual(chokeSchedule([0], [2, 0.5, 1]), [0.5]);
});

test("drum kits are loudness-matched, so changing kit does not rebalance the mix", () => {
  // Pre-fix, at equal PEAK: kick spanned 8 dB across kits and snare 11 dB, and
  // the kick-to-snare gap was 7.0 dB on acoustic but 12.9 dB on 808 — i.e.
  // switching kit silently remixed the arrangement. Bossa is excluded from the
  // snare comparison because its "snare" is a cross-stick, a genuinely quieter
  // instrument rather than a mismatch.
  const body = (kit, key) => 20 * Math.log10(rmsOf(drumSampleData(SR, kit, key).subarray(0, Math.floor(SR * 0.2))));
  for (const key of ["kick", "hat", "crash"]) {
    const vals = KITS.map((k) => body(k, key));
    const spread = Math.max(...vals) - Math.min(...vals);
    assert.ok(spread < 1.5, `${key} spans ${spread.toFixed(1)} dB across kits`);
  }
  const snares = KITS.filter((k) => k !== "bossa").map((k) => body(k, "snare"));
  assert.ok(Math.max(...snares) - Math.min(...snares) < 1.5, "snare spread across kits");

  for (const kit of KITS.filter((k) => k !== "bossa")) {
    const gap = body(kit, "kick") - body(kit, "snare");
    assert.ok(gap > 4 && gap < 9, `${kit} kick-snare gap ${gap.toFixed(1)} dB`);
  }
});

test("no drum hit exceeds the clipping guard", () => {
  for (const kit of KITS) {
    for (const key of ["kick", "snare", "hat", "open", "crash", "tomH", "tomM", "tomL"]) {
      for (let v = 0; v < (DRUM_VARIANTS[key] || 1); v++) {
        const p = peakOf(drumSampleData(SR, kit, key, v));
        assert.ok(p <= 0.901, `${kit}/${key} v${v} peaks at ${p.toFixed(3)}`);
        assert.ok(p > 0.05, `${kit}/${key} v${v} is silent`);
      }
    }
  }
});
