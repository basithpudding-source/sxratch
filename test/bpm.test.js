// Unit tests for BPM detection (js/bpm.js) — the pure-array path the
// AudioBuffer wrapper delegates to. Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBPMFromChannels } from "../js/bpm.js";

const SR = 44100;

/** A synthetic drum-machine track: kick-like decaying bursts on every beat. */
function clickTrack(bpm, seconds = 45) {
  const n = Math.floor(SR * seconds);
  const x = new Float32Array(n);
  const beat = (60 / bpm) * SR;
  for (let b = 0; ; b++) {
    const at = Math.round(b * beat);
    if (at >= n) break;
    for (let i = 0; i < 2000 && at + i < n; i++) {
      x[at + i] += Math.sin((2 * Math.PI * 100 * i) / SR) * Math.exp(-i / 900) * 0.8;
    }
  }
  // quiet noise bed so the envelope isn't literally zero between hits
  let seed = 42;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    x[i] += ((seed / 4294967296) - 0.5) * 0.02;
  }
  return x;
}

test("detects synthetic click tracks within ±0.5 BPM", () => {
  for (const bpm of [90, 128, 174]) {
    const x = clickTrack(bpm);
    const got = detectBPMFromChannels(x, x, SR, x.length);
    assert.ok(got != null, `no detection at ${bpm} BPM`);
    // 174 folds into the preferred 84–168 window as 87 — accept the octave.
    const err = Math.min(Math.abs(got - bpm), Math.abs(got - bpm / 2), Math.abs(got - bpm * 2));
    assert.ok(err <= 0.5, `bpm ${bpm}: got ${got}`);
  }
});

test("returns null for silence", () => {
  const x = new Float32Array(SR * 30);
  assert.equal(detectBPMFromChannels(x, x, SR, x.length), null);
});

test("returns null for white noise", () => {
  const n = SR * 30;
  const x = new Float32Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    x[i] = (seed / 4294967296) * 2 - 1;
  }
  assert.equal(detectBPMFromChannels(x, x, SR, x.length), null);
});

test("returns null for a pure-tone drone (transient gate)", () => {
  const n = SR * 30;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5;
  assert.equal(detectBPMFromChannels(x, x, SR, x.length), null);
});

test("returns null for too-short audio", () => {
  const x = clickTrack(120, 3); // < 8 s analysis window
  assert.equal(detectBPMFromChannels(x, x, SR, x.length), null);
});

test("detectBeatGridFromChannels reports tempo and downbeat offset", () => {
  const bpm = 120;
  const leadSilenceSec = 0.4;
  const n = Math.floor(SR * 40);
  const x = new Float32Array(n);
  const beat = (60 / bpm) * SR;
  const startSample = Math.round(leadSilenceSec * SR);
  for (let b = 0; ; b++) {
    const at = startSample + Math.round(b * beat);
    if (at >= n) break;
    for (let i = 0; i < 2000 && at + i < n; i++) {
      x[at + i] += Math.sin((2 * Math.PI * 100 * i) / SR) * Math.exp(-i / 900) * 0.8;
    }
  }
  const grid = detectBPMFromChannels(x, x, SR, x.length, { detailed: true });
  assert.ok(grid && typeof grid === "object", "grid should be an object");
  assert.ok(Math.abs(grid.bpm - bpm) <= 0.5, `expected ${bpm} bpm, got ${grid.bpm}`);
  // hop is 256 samples (approx 5.8 ms at 44.1 kHz); offset should be within ~20 ms of 0.4 s
  assert.ok(Math.abs(grid.offset - leadSilenceSec) < 0.05, `expected offset near 0.4s, got ${grid.offset}`);
});

