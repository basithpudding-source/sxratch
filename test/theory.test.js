// Unit tests for the pure engine/music-theory helpers.
// Run with: npm test   (uses Node's built-in test runner, no dependencies)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  midiToFreq, noteNameToMidi, nearest, crossfadeGains, catmullRom, floatToInt16,
} from "../js/theory.js";

test("midiToFreq: A4 = 440 Hz, octaves double", () => {
  assert.equal(midiToFreq(69), 440);
  assert.ok(Math.abs(midiToFreq(81) - 880) < 1e-9); // A5
  assert.ok(Math.abs(midiToFreq(57) - 220) < 1e-9); // A3
});

test("noteNameToMidi: soundfont naming (flats, C4=60)", () => {
  assert.equal(noteNameToMidi("C4"), 60);
  assert.equal(noteNameToMidi("A0"), 21);  // bottom piano key
  assert.equal(noteNameToMidi("C8"), 108);  // top piano key
  assert.equal(noteNameToMidi("Bb3"), 58);
  assert.equal(noteNameToMidi("Db1"), 25);
  assert.equal(noteNameToMidi("nonsense"), null);
});

test("nearest: closest sample in a sorted list", () => {
  assert.equal(nearest([21, 24, 28, 60], 27), 28);
  assert.equal(nearest([21, 24, 28, 60], 60), 60);
  assert.equal(nearest([40], 999), 40);
});

test("crossfadeGains: equal-power is unity-summed in power at center", () => {
  const [a, b] = crossfadeGains(0.5, "power");
  assert.ok(Math.abs(a - b) < 1e-12);
  assert.ok(Math.abs(a * a + b * b - 1) < 1e-9); // equal-power: a² + b² = 1
});

test("crossfadeGains: ends are full-kill", () => {
  assert.deepEqual(crossfadeGains(0, "linear"), [1, 0]);
  assert.deepEqual(crossfadeGains(1, "linear"), [0, 1]);
  const [a0] = crossfadeGains(0, "power"); assert.ok(Math.abs(a0 - 1) < 1e-9);
});

test("crossfadeGains: hamster mode reverses the fader", () => {
  assert.deepEqual(crossfadeGains(0, "linear", true), crossfadeGains(1, "linear", false));
});

test("crossfadeGains: cut curve kills only near the edges", () => {
  assert.deepEqual(crossfadeGains(0.3, "cut"), [1, 1]);  // mid-range: both decks full
  assert.deepEqual(crossfadeGains(0.95, "cut"), [0, 1]); // hard cut to B at the far edge
  assert.deepEqual(crossfadeGains(0.05, "cut"), [1, 0]); // hard cut to A at the near edge
});

test("catmullRom: passes through control points and interpolates monotonically", () => {
  // At t=0 it returns p1, at t→1 it returns p2.
  assert.equal(catmullRom(0, 1, 2, 3, 0), 1);
  assert.ok(Math.abs(catmullRom(0, 1, 2, 3, 1) - 2) < 1e-9);
  const mid = catmullRom(0, 1, 2, 3, 0.5); // smooth line -> ~1.5
  assert.ok(mid > 1 && mid < 2);
});

test("floatToInt16: clamps and scales to 16-bit range", () => {
  assert.equal(floatToInt16(0), 0);
  assert.equal(floatToInt16(1), 0x7fff);
  assert.equal(floatToInt16(-1), -0x8000);
  assert.equal(floatToInt16(2), 0x7fff);   // clamps over-range
  assert.equal(floatToInt16(-9), -0x8000);
});
