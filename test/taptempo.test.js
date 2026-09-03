// Unit tests for tap tempo (js/taptempo.js). Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTapTempo } from "../js/taptempo.js";

test("steady taps at 120 BPM read 120", () => {
  const t = createTapTempo();
  let bpm = null;
  for (let i = 0; i < 6; i++) bpm = t.tap(i * 500);
  assert.equal(bpm, 120);
});

test("median rejects one flubbed tap", () => {
  const t = createTapTempo();
  const times = [0, 500, 1000, 1650, 2000, 2500, 3000]; // one late tap
  let bpm = null;
  for (const at of times) bpm = t.tap(at);
  assert.ok(Math.abs(bpm - 120) <= 3, `got ${bpm}`);
});

test("needs three taps before reporting", () => {
  const t = createTapTempo();
  assert.equal(t.tap(0), null);
  assert.equal(t.tap(500), null);
  assert.notEqual(t.tap(1000), null);
});

test("a >2 s gap starts a fresh measurement", () => {
  const t = createTapTempo();
  t.tap(0); t.tap(500); t.tap(1000);
  assert.equal(t.tap(5000), null); // fresh sequence, first tap again
  assert.equal(t.count, 1);
});

test("out-of-range tempos return null", () => {
  const t = createTapTempo();
  let bpm;
  for (let i = 0; i < 4; i++) bpm = t.tap(i * 5); // ~12000 BPM mash
  assert.equal(bpm, null);
});

test("only the last maxTaps matter (tempo changes converge)", () => {
  const t = createTapTempo();
  let at = 0, bpm = null;
  for (let i = 0; i < 8; i++) { bpm = t.tap(at); at += 600; }  // 100 BPM
  for (let i = 0; i < 9; i++) { bpm = t.tap(at); at += 400; }  // shift to 150
  assert.equal(bpm, 150);
});
