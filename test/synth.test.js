// Unit tests for the pure-DSP half of js/synth.js (no Web Audio required).
// Run with: npm test   (uses Node's built-in test runner, no dependencies)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mulberry32, stepRand, mtof, driveCurve, biquadApply,
  drumSampleData, DRUM_KIT_IDS, reverbIRData, masterFinalize,
  resolvePatch, factoryValue, FACTORY_PATCHES, ENGINE_SCHEMA, WAVES, FILTER_TYPES,
} from "../js/synth.js";

const SR = 44100;

const finiteAll = (x) => { for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false; return true; };
const peakOf = (x) => { let m = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; } return m; };
const rmsOf = (x) => { let a = 0; for (let i = 0; i < x.length; i++) a += x[i] * x[i]; return Math.sqrt(a / x.length); };

test("mulberry32/stepRand: deterministic, in [0,1), step-independent", () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
  assert.equal(stepRand(7, 3), stepRand(7, 3));   // stable
  assert.notEqual(stepRand(7, 3), stepRand(7, 4)); // varies by step
});

test("mtof: A4 = 440, octaves double", () => {
  assert.ok(Math.abs(mtof(69) - 440) < 1e-9);
  assert.ok(Math.abs(mtof(81) - 880) < 1e-9);
});

test("driveCurve: odd-symmetric, normalized to full scale, cached", () => {
  const c = driveCurve(2.2);
  assert.equal(c, driveCurve(2.2)); // cache hit
  assert.ok(Math.abs(c[c.length - 1] - 1) < 1e-6);        // +1 → +1
  assert.ok(Math.abs(c[0] + 1) < 1e-6);                   // −1 → −1
  const mid = c[Math.floor(c.length / 2)];
  assert.ok(Math.abs(mid) < 0.01);                        // ~0 at 0
});

test("biquadApply lowpass: passes DC-ish lows, kills highs", () => {
  const n = SR;
  const low = new Float32Array(n), high = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    low[i] = Math.sin((2 * Math.PI * 100 * i) / SR);
    high[i] = Math.sin((2 * Math.PI * 12000 * i) / SR);
  }
  biquadApply(low, SR, "lowpass", 1000, 0.707);
  biquadApply(high, SR, "lowpass", 1000, 0.707);
  assert.ok(rmsOf(low.subarray(SR / 2)) > 0.6);   // ~unity in the passband
  assert.ok(rmsOf(high.subarray(SR / 2)) < 0.02); // >30 dB down well above cutoff
});

test("biquadApply highpass: mirror behaviour", () => {
  const n = SR;
  const low = new Float32Array(n), high = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    low[i] = Math.sin((2 * Math.PI * 60 * i) / SR);
    high[i] = Math.sin((2 * Math.PI * 8000 * i) / SR);
  }
  biquadApply(low, SR, "highpass", 2000, 0.707);
  biquadApply(high, SR, "highpass", 2000, 0.707);
  assert.ok(rmsOf(low.subarray(SR / 2)) < 0.02);
  assert.ok(rmsOf(high.subarray(SR / 2)) > 0.6);
});

test("drumSampleData: every kit/key renders finite, bounded, non-silent audio", () => {
  const kits = DRUM_KIT_IDS;
  const keys = ["kick", "snare", "hat", "open", "crash", "tomH", "tomM", "tomL"];
  for (const kit of kits) for (const key of keys) {
    const d = drumSampleData(SR, kit, key);
    assert.ok(d.length > SR * 0.02, `${kit}/${key} too short`);
    assert.ok(finiteAll(d), `${kit}/${key} has NaN/Inf`);
    const p = peakOf(d);
    assert.ok(p > 0.1 && p <= 1.0001, `${kit}/${key} peak ${p} out of range`);
    assert.ok(Math.abs(d[0]) < 0.05, `${kit}/${key} clicks at sample 0`);
  }
});

test("drumSampleData: deterministic across calls", () => {
  const a = drumSampleData(SR, "808", "snare");
  const b = drumSampleData(SR, "808", "snare");
  assert.deepEqual(Array.from(a.subarray(0, 500)), Array.from(b.subarray(0, 500)));
});

test("drumSampleData: open hat rings longer than closed", () => {
  const closed = drumSampleData(SR, "acoustic", "hat");
  const open = drumSampleData(SR, "acoustic", "open");
  assert.ok(open.length > closed.length * 2);
});

test("reverbIRData: pre-delay silence, finite, decays to ~nothing", () => {
  const [l, r] = reverbIRData(SR, { seconds: 1.2, predelay: 0.02 });
  assert.equal(l.length, r.length);
  assert.ok(finiteAll(l) && finiteAll(r));
  // pre-delay region is silent (before the first early reflection)
  const preEnd = Math.floor(0.02 * SR) + Math.floor(0.010 * SR);
  for (let i = 0; i < Math.floor(0.02 * SR) - 1; i++) assert.equal(l[i], 0);
  assert.ok(preEnd < l.length);
  // tail dies: last 5% is at least 20 dB below the loudest 5%
  const head = rmsOf(l.subarray(Math.floor(0.02 * SR), Math.floor(l.length * 0.15)));
  const tail = rmsOf(l.subarray(Math.floor(l.length * 0.95)));
  assert.ok(tail < head * 0.1, `tail ${tail} vs head ${head}`);
});

test("masterFinalize: normalizes a quiet mix up toward the target", () => {
  const n = SR * 2;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // ~0.057 RMS — reachable within maxBoost so we test hitting the target, not the clamp.
    L[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.08;
    R[i] = L[i];
  }
  const { gain } = masterFinalize([L, R], SR, { targetRms: 0.14 });
  assert.ok(gain > 2 && gain <= 3, `expected boost within clamp, got ${gain}`);
  assert.ok(rmsOf(L) > 0.12, `did not reach target: ${rmsOf(L)}`);
  assert.ok(finiteAll(L) && finiteAll(R));
});

test("masterFinalize: sparse content is NOT slammed (gated loudness + modest maxBoost)", () => {
  // 8 s with one short soft stab per bar (~2 Hz): mostly silence between hits.
  const n = SR * 8;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let bar = 0; bar < 16; bar++) {
    const start = Math.floor(bar * 0.5 * SR);
    for (let i = 0; i < SR * 0.12; i++) {
      const v = Math.sin((2 * Math.PI * 330 * i) / SR) * 0.12 * Math.exp(-i / (SR * 0.05));
      L[start + i] = v; R[start + i] = v;
    }
  }
  const { gain } = masterFinalize([L, R], SR, { targetRms: 0.14 });
  assert.ok(gain <= 3.0001, `sparse render over-boosted: ${gain}`);
  assert.ok(peakOf(L) <= 0.9651, "ceiling respected");
});

test("masterFinalize: spikes are limited to the ceiling", () => {
  const n = SR;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = R[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.2;
  for (let i = 10000; i < 10010; i++) { L[i] = 4; R[i] = -4; } // brutal transient
  masterFinalize([L, R], SR, { ceiling: 0.965 });
  assert.ok(peakOf(L) <= 0.9651 && peakOf(R) <= 0.9651);
  assert.ok(finiteAll(L) && finiteAll(R));
});

test("masterFinalize: look-ahead ramps in — a transient is limited, not hard-clipped flat", () => {
  // A single loud kick-like transient over a quiet bed. A correct look-ahead
  // limiter reduces gain BEFORE the peak exits the delay, so the peak sits at
  // ~ceiling for only a handful of samples rather than a long flat-top plateau.
  const n = SR;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = R[i] = Math.sin((2 * Math.PI * 200 * i) / SR) * 0.05;
  for (let i = 20000; i < 20120; i++) { // ~2.7 ms transient at 1.4
    const e = Math.exp(-(i - 20000) / 400);
    L[i] = R[i] = 1.4 * e;
  }
  masterFinalize([L, R], SR, { ceiling: 0.965, targetRms: 0.14 });
  assert.ok(peakOf(L) <= 0.9651, "ceiling still respected");
  // Count samples pinned within 0.1% of the ceiling — hard clipping would pin many.
  let pinned = 0;
  for (let i = 0; i < n; i++) if (Math.abs(L[i]) >= 0.9645) pinned++;
  assert.ok(pinned < 40, `too many samples flat-topped at ceiling: ${pinned}`);
  assert.ok(finiteAll(L));
});

test("masterFinalize: silence stays silent (no NaN, no boost explosion)", () => {
  const L = new Float32Array(SR), R = new Float32Array(SR);
  const { gain } = masterFinalize([L, R], SR);
  assert.ok(finiteAll(L) && finiteAll(R));
  assert.equal(peakOf(L), 0);
  assert.ok(Number.isFinite(gain));
});

/* ------------------------------ synth patches ----------------------------- */

test("FACTORY_PATCHES: every factory sound defines every parameter its engine needs", () => {
  for (const [family, sounds] of Object.entries(FACTORY_PATCHES)) {
    for (const [id, patch] of Object.entries(sounds)) {
      const schema = ENGINE_SCHEMA[patch.engine];
      assert.ok(schema, `${family}/${id}: unknown engine ${patch.engine}`);
      for (const sec of schema) {
        for (const pr of sec.params) {
          const v = patch.params[pr.key];
          assert.equal(typeof v, "number", `${family}/${id} missing param ${pr.key}`);
          assert.ok(Number.isFinite(v), `${family}/${id}.${pr.key} is not finite`);
          assert.ok(v >= pr.min && v <= pr.max,
            `${family}/${id}.${pr.key} = ${v} outside schema range ${pr.min}..${pr.max}`);
        }
      }
    }
  }
});

test("resolvePatch: no overrides returns the factory values", () => {
  const r = resolvePatch("chord", "pad");
  assert.equal(r.engine, "subtractive");
  assert.equal(r.params.cutoff, FACTORY_PATCHES.chord.pad.params.cutoff);
  assert.equal(r.params.voices, 4);
});

test("resolvePatch: overrides are applied and clamped to the schema range", () => {
  assert.equal(resolvePatch("chord", "pad", { cutoff: 4200 }).params.cutoff, 4200);
  assert.equal(resolvePatch("chord", "pad", { cutoff: 999999 }).params.cutoff, 16000); // schema max
  assert.equal(resolvePatch("chord", "pad", { cutoff: -50 }).params.cutoff, 60);       // schema min
});

test("resolvePatch: junk overrides can never break a voice", () => {
  const r = resolvePatch("chord", "pad", {
    cutoff: NaN, voices: Infinity, q: "loud", nonsenseKey: 5, level: null, engine: "evil",
  });
  for (const v of Object.values(r.params)) {
    assert.ok(typeof v !== "number" || Number.isFinite(v), "produced a non-finite parameter");
  }
  assert.equal(r.params.cutoff, FACTORY_PATCHES.chord.pad.params.cutoff, "NaN override ignored");
  assert.equal(r.params.voices, 4, "Infinity override ignored");
  assert.equal(r.engine, "subtractive", "engine is not overridable");
  assert.ok(!("nonsenseKey" in r.params), "unknown key was not adopted");
});

test("resolvePatch: discrete params round to valid indices", () => {
  const r = resolvePatch("chord", "pad", { wave1: 2.7, type: 1.4, voices: 3.6 });
  assert.equal(r.params.wave1, 3);
  assert.ok(WAVES[r.params.wave1], "wave index maps to a real waveform");
  assert.equal(r.params.type, 1);
  assert.ok(FILTER_TYPES[r.params.type], "filter index maps to a real filter type");
  assert.equal(r.params.voices, 4);
});

test("resolvePatch: unknown family/sound falls back instead of throwing", () => {
  assert.ok(resolvePatch("nope", "nope").params.level > 0);
  assert.ok(resolvePatch("chord", "does-not-exist").params.level > 0);
});

test("resolvePatch: every factory sound resolves to finite params", () => {
  for (const [family, sounds] of Object.entries(FACTORY_PATCHES)) {
    for (const id of Object.keys(sounds)) {
      const r = resolvePatch(family, id);
      for (const [k, v] of Object.entries(r.params)) {
        assert.ok(Number.isFinite(v), `${family}/${id}.${k} resolved to ${v}`);
      }
    }
  }
});

test("factoryValue: reports the untouched default (used by the editor's reset)", () => {
  assert.equal(factoryValue("chord", "pad", "cutoff"), FACTORY_PATCHES.chord.pad.params.cutoff);
  assert.equal(factoryValue("chord", "nope", "cutoff"), undefined);
});
