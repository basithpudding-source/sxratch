import test from "node:test";
import assert from "node:assert/strict";

import {
  audioRegionSlice,
  clampFinite,
  duplicateRegion,
  formatMusicalPosition,
  nearestSnap,
  quantizeBeat,
  recordedBeat,
  splitLoopedNote,
  splitRegionContent,
  trimRegionStartContent,
  wrapBeat,
  quantizeRegionNotes,
  transposeRegionNotes,
} from "../js/daw-model.js";

test("quantizeBeat supports musical snap values and never returns negative beats", () => {
  assert.equal(quantizeBeat(1.13, 0.25), 1.25);
  assert.equal(quantizeBeat(1.13, 0.5), 1);
  assert.equal(quantizeBeat(1.13, 0.25, "floor"), 1);
  assert.equal(quantizeBeat(-4, 0.25), 0);
  assert.equal(nearestSnap(0.24), 0.25);
  assert.equal(nearestSnap(0.49), 0.5);
});

test("formatMusicalPosition reports bar, quarter and active subdivision", () => {
  assert.equal(formatMusicalPosition(0, 4, 0.25), "1.1.1");
  assert.equal(formatMusicalPosition(0.75, 4, 0.25), "1.1.4");
  assert.equal(formatMusicalPosition(5.5, 4, 0.5), "2.2.2");
  assert.equal(formatMusicalPosition(3, 3, 1), "2.1");
});

test("splitRegionContent preserves sustained notes across a cut", () => {
  const region = {
    len: 4,
    notes: [
      { b: 0.5, d: 2.5, m: 60, v: 1 },
      { b: 3, d: 0.5, m: 64, v: 0.8 },
    ],
  };
  const { left, right } = splitRegionContent("midi", region, 2, 0.5);
  assert.deepEqual(left.notes, [{ b: 0.5, d: 1.5, m: 60, v: 1 }]);
  assert.deepEqual(right.notes, [
    { b: 0, d: 1, m: 60, v: 1 },
    { b: 1, d: 0.5, m: 64, v: 0.8 },
  ]);
  assert.equal(left.len, 2);
  assert.equal(right.len, 2);
});

test("splitRegionContent advances audio offset and partitions drum hits", () => {
  const audio = { len: 8, clipId: "clip", offset: 1.25, gain: 0.7 };
  const splitAudio = splitRegionContent("audio", audio, 3, 0.5);
  assert.equal(splitAudio.right.offset, 2.75);
  assert.equal(splitAudio.right.clipId, "clip");
  assert.equal(splitAudio.right.gain, 0.7);

  const drums = { len: 4, hits: [{ b: 1, k: "kick" }, { b: 3, k: "snare" }] };
  const splitDrums = splitRegionContent("drums", drums, 2, 0.5);
  assert.deepEqual(splitDrums.left.hits, [{ b: 1, k: "kick" }]);
  assert.deepEqual(splitDrums.right.hits, [{ b: 1, k: "snare" }]);
});

test("trimRegionStartContent crops expired events and trims crossing notes", () => {
  const midi = {
    notes: [
      { b: 0, d: 0.5, m: 60 },
      { b: 0.5, d: 1.5, m: 64 },
      { b: 2.5, d: 0.5, m: 67 },
    ],
  };
  assert.deepEqual(trimRegionStartContent("midi", midi, 1, 0.5).notes, [
    { b: 0, d: 1, m: 64 },
    { b: 1.5, d: 0.5, m: 67 },
  ]);
  assert.deepEqual(
    trimRegionStartContent("drums", { hits: [{ b: 0.5, k: "kick" }, { b: 2, k: "snare" }] }, 1, 0.5).hits,
    [{ b: 1, k: "snare" }],
  );
});

test("duplicateRegion deep-clones content and moves the copy", () => {
  const source = { id: 4, name: "Verse", start: 0, len: 4, notes: [{ b: 0, d: 1, m: 60 }] };
  const copy = duplicateRegion(source, 9, 4);
  assert.equal(copy.id, 9);
  assert.equal(copy.start, 4);
  assert.equal(copy.name, "Verse copy");
  copy.notes[0].m = 72;
  assert.equal(source.notes[0].m, 60);
});

test("clampFinite preserves valid zero values", () => {
  assert.equal(clampFinite(0, 0, 1.4, 0.9), 0);
  assert.equal(clampFinite("0", 0, 4, 1), 0);
  assert.equal(clampFinite(undefined, 0, 1.4, 0.9), 0.9);
  assert.equal(clampFinite(8, 0, 1.4, 0.9), 1.4);
});

test("loop timing keeps the playhead wrapped while recording time remains usable", () => {
  assert.equal(wrapBeat(17, 0, 16), 1);
  assert.equal(wrapBeat(3, 4, 8), 3);
  assert.equal(recordedBeat(2, 7, { a: 4, b: 8 }), 1);
  assert.equal(recordedBeat(18, 4, { a: 4, b: 8 }), 2);
  assert.equal(recordedBeat(2, 2, { a: 4, b: 8 }), 2);
});

test("notes held across a loop seam are split into tail and wrapped head", () => {
  assert.deepEqual(splitLoopedNote(3.5, 1, 4), [
    { b: 3.5, d: 0.5 },
    { b: 0, d: 0.5 },
  ]);
  assert.deepEqual(splitLoopedNote(1, 8, 4), [
    { b: 1, d: 3 },
    { b: 0, d: 1 },
  ]);
});

test("audioRegionSlice stops sources exactly at the next loop boundary and computes fades", () => {
  const region = { start: 0, len: 8, offset: 1, fadeIn: 0.5, fadeOut: 1 };
  assert.deepEqual(audioRegionSlice(region, 0, 0.5, 4, 20), {
    offsetSec: 1,
    durationSec: 2,
    fadeInSec: 0.25,
    fadeOutSec: 0.5,
  });
  assert.deepEqual(audioRegionSlice(region, 2, 0.5, 4, 20), {
    offsetSec: 2,
    durationSec: 1,
    fadeInSec: 0.25,
    fadeOutSec: 0.5,
  });
  assert.equal(audioRegionSlice(region, 8, 0.5, 8, 20), null);
});

test("quantizeRegionNotes aligns MIDI notes and drum hits to step grid", () => {
  const midi = { notes: [{ b: 0.22, d: 0.9, m: 60 }] };
  assert.deepEqual(quantizeRegionNotes("midi", midi, 0.25), {
    notes: [{ b: 0.25, d: 1, m: 60 }],
  });

  const drums = { hits: [{ b: 0.49, k: "kick" }] };
  assert.deepEqual(quantizeRegionNotes("drums", drums, 0.5), {
    hits: [{ b: 0.5, k: "kick" }],
  });
});

test("transposeRegionNotes shifts pitches within valid MIDI range (0..127)", () => {
  const region = { notes: [{ b: 0, d: 1, m: 60 }, { b: 1, d: 1, m: 120 }] };
  assert.deepEqual(transposeRegionNotes(region, 12).notes, [
    { b: 0, d: 1, m: 72 },
    { b: 1, d: 1, m: 127 },
  ]);
  assert.deepEqual(transposeRegionNotes(region, -12).notes, [
    { b: 0, d: 1, m: 48 },
    { b: 1, d: 1, m: 108 },
  ]);
});

