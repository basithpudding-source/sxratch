import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTOMATION_SPECS,
  audioRegionSlice,
  automationCurve,
  automationValueAt,
  buildRegionClipboard,
  clampFinite,
  clampedFade,
  duplicateRegion,
  formatMusicalPosition,
  loopRecordingPosition,
  materializeRegionClipboard,
  nearestSnap,
  partitionLoopRecording,
  normalizeAutomationPoints,
  quantizeBeat,
  recordedBeat,
  resizeSelectedNotes,
  shiftSelectedNotes,
  splitLoopedNote,
  splitRegionContent,
  trimRegionStartContent,
  wrapBeat,
  quantizeRegionNotes,
  transposeRegionNotes,
  upsertAutomationPoint,
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
  const audio = {
    len: 8,
    clipId: "clip",
    offset: 1.25,
    gain: 0.7,
    fadeIn: 6,
    fadeOut: 7,
    sourceBpm: 96,
    tempoMode: "repitch",
    takeGroup: "vox-1",
    takeNo: 2,
    takeActive: false,
    recordedTake: true,
    volatile: true,
  };
  const splitAudio = splitRegionContent("audio", audio, 3, 0.5);
  assert.equal(splitAudio.right.offset, 2.75);
  assert.equal(splitAudio.right.clipId, "clip");
  assert.equal(splitAudio.right.gain, 0.7);
  assert.equal(splitAudio.left.sourceBpm, 96);
  assert.equal(splitAudio.right.sourceBpm, 96);
  assert.equal(splitAudio.left.tempoMode, "repitch");
  assert.equal(splitAudio.right.tempoMode, "repitch");
  assert.equal(splitAudio.left.takeGroup, "vox-1");
  assert.equal(splitAudio.right.takeGroup, "vox-1");
  assert.equal(splitAudio.right.takeNo, 2);
  assert.equal(splitAudio.right.takeActive, false);
  assert.equal(splitAudio.right.recordedTake, true);
  assert.equal(splitAudio.right.volatile, true);
  assert.equal(splitAudio.left.fadeIn, 3);
  assert.equal(splitAudio.right.fadeOut, 5);

  const drums = { len: 4, hits: [{ b: 1, k: "kick" }, { b: 3, k: "snare" }] };
  const splitDrums = splitRegionContent("drums", drums, 2, 0.5);
  assert.deepEqual(splitDrums.left.hits, [{ b: 1, k: "kick" }]);
  assert.deepEqual(splitDrums.right.hits, [{ b: 1, k: "snare" }]);
});

test("splitRegionContent retains take and recording metadata for MIDI and drums", () => {
  for (const [kind, content] of [
    ["midi", { notes: [{ b: 0.5, d: 2, m: 60 }] }],
    ["drums", { hits: [{ b: 3, k: "snare" }] }],
  ]) {
    const region = {
      len: 4,
      ...content,
      takeGroup: `${kind}-takes`,
      takeNo: 3,
      takeActive: false,
      recordedTake: true,
      volatile: false,
    };
    const { left, right } = splitRegionContent(kind, region, 2, 0.5);
    const expected = {
      takeGroup: `${kind}-takes`,
      takeNo: 3,
      takeActive: false,
      recordedTake: true,
      volatile: false,
    };
    for (const half of [left, right]) {
      for (const [key, value] of Object.entries(expected)) assert.equal(half[key], value);
    }
  }
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
  assert.deepEqual(
    trimRegionStartContent(
      "audio",
      { offset: 1, sourceBpm: 90, tempoMode: "repitch" },
      2,
      60 / 90,
    ),
    { offset: 1 + 120 / 90, sourceBpm: 90, tempoMode: "repitch" },
  );
});

test("duplicateRegion deep-clones content and moves the copy", () => {
  const source = {
    id: 4,
    name: "Verse",
    start: 0,
    len: 4,
    takeGroup: "take-1",
    takeNo: 2,
    takeActive: false,
    recordedTake: true,
    volatile: true,
    notes: [{ b: 0, d: 1, m: 60 }],
  };
  const copy = duplicateRegion(source, 9, 4);
  assert.equal(copy.id, 9);
  assert.equal(copy.start, 4);
  assert.equal(copy.name, "Verse copy");
  for (const key of ["takeGroup", "takeNo", "takeActive", "recordedTake"]) {
    assert.equal(copy[key], undefined);
  }
  assert.equal(copy.volatile, true);
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

test("loop recording partitions multiple passes and identifies complete audio slices", () => {
  const loop = { a: 4, b: 8 };
  assert.deepEqual(loopRecordingPosition(5, 4, loop), { pass: 1, beat: 1 });
  assert.deepEqual(partitionLoopRecording(4, 10, loop), [
    { pass: 0, elapsedStart: 0, localStart: 0, duration: 4, complete: true },
    { pass: 1, elapsedStart: 4, localStart: 0, duration: 4, complete: true },
    { pass: 2, elapsedStart: 8, localStart: 0, duration: 2, complete: false },
  ]);
});

test("loop recording preserves partial pass positions and splits held-note spans by pass", () => {
  const loop = { a: 4, b: 8 };
  assert.deepEqual(partitionLoopRecording(6, 6, loop), [
    { pass: 0, elapsedStart: 0, localStart: 2, duration: 2, complete: false },
    { pass: 1, elapsedStart: 2, localStart: 0, duration: 4, complete: true },
  ]);
  assert.deepEqual(partitionLoopRecording(4, 3, loop, 2.5), [
    { pass: 0, elapsedStart: 2.5, localStart: 2.5, duration: 1.5, complete: false },
    { pass: 1, elapsedStart: 4, localStart: 0, duration: 1.5, complete: false },
  ]);
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

test("quantizeBeat: snap Off passes beats through; triplet grids are not clamped away", () => {
  assert.equal(quantizeBeat(1.137, 0), 1.137);
  assert.equal(quantizeBeat(-2, 0), 0);
  assert.ok(Math.abs(quantizeBeat(0.35, 1 / 3) - 1 / 3) < 1e-9);
  assert.ok(Math.abs(quantizeBeat(0.5, 1 / 6) - 0.5) < 1e-9);
  assert.ok(Math.abs(quantizeBeat(0.2, 1 / 6) - 1 / 6) < 1e-9);
  assert.equal(nearestSnap(0), 0);
  assert.equal(nearestSnap(1 / 3), 1 / 3);
});

test("shiftSelectedNotes moves the group as one and clamps at region borders", () => {
  const notes = [
    { b: 0, d: 1, m: 60, v: 1 },
    { b: 2, d: 1, m: 64, v: 1 },
    { b: 3, d: 1, m: 72, v: 1 },
  ];
  const sel = (n) => n.m !== 72;
  // Asking to move left by 1 clamps to 0 because the first note is at b=0.
  const left = shiftSelectedNotes(notes, sel, -1, 0, 8);
  assert.equal(left[0].b, 0);
  assert.equal(left[1].b, 2);
  // Pitch clamp: +60 would push m=64 past 127 → whole group limited to +63.
  const up = shiftSelectedNotes(notes, sel, 0, 60, 8);
  assert.equal(up[1].m, 124);
  assert.equal(up[0].m, 120);
  assert.equal(up[2].m, 72);        // unselected untouched
  // Durations shrink when a moved note would overhang the region end.
  const right = shiftSelectedNotes(notes, sel, 5.5, 0, 8);
  assert.equal(right[1].b, 7.5);
  assert.equal(right[1].d, 0.5);
});

test("resizeSelectedNotes clamps duration to region end and MIN_SNAP", () => {
  const notes = [{ b: 6, d: 1, m: 60 }, { b: 0, d: 1, m: 62 }];
  const out = resizeSelectedNotes(notes, (n) => n.m === 60, 4, 8);
  assert.equal(out[0].d, 2);        // 6 + 2 = region end
  assert.equal(out[1].d, 1);
  const tiny = resizeSelectedNotes(notes, () => true, -5, 8);
  assert.equal(tiny[0].d, 0.125);
});

test("region clipboard round-trips relative layout onto a new beat", () => {
  const clip = buildRegionClipboard([
    {
      trackId: 1,
      kind: "midi",
      region: {
        id: 9,
        start: 4,
        len: 2,
        takeGroup: "take-2",
        takeNo: 1,
        takeActive: false,
        recordedTake: true,
        volatile: true,
        notes: [{ b: 0, d: 1, m: 60 }],
      },
    },
    { trackId: 2, kind: "drums", region: { id: 10, start: 6, len: 4, hits: [{ b: 1, k: "kick" }] } },
  ]);
  const out = materializeRegionClipboard(clip, 16);
  assert.equal(out.length, 2);
  assert.equal(out[0].spec.start, 16);
  assert.equal(out[1].spec.start, 18);
  assert.equal(out[0].spec.id, undefined);
  assert.equal(out[0].trackId, 1);
  for (const key of ["takeGroup", "takeNo", "takeActive", "recordedTake"]) {
    assert.equal(out[0].spec[key], undefined);
  }
  assert.equal(out[0].spec.volatile, true);
  assert.deepEqual(out[0].spec.notes, [{ b: 0, d: 1, m: 60 }]);
  // mutating the paste result must not touch the clipboard
  out[0].spec.notes[0].m = 72;
  assert.equal(clip.items[0].spec.notes[0].m, 60);
});

test("clampedFade keeps fadeIn + fadeOut inside the region", () => {
  assert.equal(clampedFade(8, 0, 3), 3);
  assert.equal(clampedFade(8, 6, 3), 2);
  assert.equal(clampedFade(8, 9, 3), 0);
  assert.equal(clampedFade(8, 0, -2), 0);
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

test("automation points normalize, clamp, sort and keep the last duplicate", () => {
  const input = [
    { b: 4, v: 2 },
    { b: -2, v: -1 },
    { b: 4, v: 0.7 },
    { b: "bad", v: 0.2 },
    null,
  ];
  assert.deepEqual(normalizeAutomationPoints(input, AUTOMATION_SPECS.gain), [
    { b: 0, v: 0 },
    { b: 4, v: 0.7 },
  ]);
  assert.equal(input[0].v, 2, "normalization must not mutate source points");
});

test("automationValueAt holds endpoints and interpolates linearly", () => {
  const lane = [{ b: 2, v: 0.2 }, { b: 6, v: 1 }];
  assert.equal(automationValueAt([], 4, 0.75), 0.75);
  assert.equal(automationValueAt(lane, 0, 0.75), 0.2);
  assert.equal(automationValueAt(lane, 2, 0.75), 0.2);
  assert.ok(Math.abs(automationValueAt(lane, 4, 0.75) - 0.6) < 1e-9);
  assert.equal(automationValueAt(lane, 9, 0.75), 1);
});

test("automation curves join exactly at adjacent scheduler windows", () => {
  const lane = [{ b: 0, v: -1 }, { b: 8, v: 1 }];
  const left = automationCurve(lane, 0, 4, 17, 0);
  const right = automationCurve(lane, 4, 8, 17, 0);
  assert.equal(left[left.length - 1], right[0]);
  assert.equal(left[0], -1);
  assert.equal(right[right.length - 1], 1);
});

test("upsertAutomationPoint replaces a beat and respects parameter range", () => {
  const lane = upsertAutomationPoint(
    [{ b: 0, v: 0.2 }, { b: 4, v: 0.5 }],
    4,
    2,
    AUTOMATION_SPECS.reverb,
  );
  assert.deepEqual(lane, [{ b: 0, v: 0.2 }, { b: 4, v: 1 }]);
});

test("automation normalization preserves stable point ids", () => {
  const lane = normalizeAutomationPoints([
    { id: 7, b: 4, v: 0.2 },
    { b: 4, v: 0.8 },
    { id: 9, b: 8, v: 0.5 },
  ], AUTOMATION_SPECS.reverb);
  assert.deepEqual(lane, [
    { id: 7, b: 4, v: 0.8 },
    { id: 9, b: 8, v: 0.5 },
  ]);
});
