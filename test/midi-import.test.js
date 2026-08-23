import test from "node:test";
import assert from "node:assert/strict";

import { encodeMidi, vlq } from "../js/midiexport.js";
import { MidiParseError, midiImportGroups, parseMidiFile } from "../js/midi-import.js";

const bytes = (...values) => new Uint8Array(values.flatMap((value) => typeof value === "number" ? [value] : Array.from(value)));
const u16 = (value) => [(value >>> 8) & 255, value & 255];
const u32 = (value) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const ascii = (value) => [...value].map((char) => char.charCodeAt(0));

function smfTracks(tracks, { format = 0, division = 480 } = {}) {
  return bytes(
    ascii("MThd"), u32(6), u16(format), u16(tracks.length), u16(division),
    ...tracks.flatMap((track) => [ascii("MTrk"), u32(track.length), track]),
  );
}

const smf = (track, options) => smfTracks([track], options);

test("parseMidiFile returns tempo-aware PAD note data from a format-1 export", () => {
  const file = encodeMidi({
    ticksPerQuarter: 480,
    tempos: [{ tick: 0, bpm: 120 }, { tick: 480, bpm: 60 }],
    timeSigs: [{ tick: 0, num: 4, den: 4 }],
    markers: [{ tick: 480, name: "Chorus" }],
    tracks: [{ name: "Keys", channel: 0, notes: [{ tick: 240, dur: 480, note: 60, vel: 96 }] }],
  });

  const parsed = parseMidiFile(file.buffer);
  assert.equal(parsed.format, 1);
  assert.equal(parsed.ticksPerQuarter, 480);
  assert.equal(parsed.durationTicks, 720);
  assert.equal(parsed.tempoMap.length, 2);
  assert.equal(parsed.tempoMap[1].bpm, 60);
  assert.deepEqual(parsed.timeSignatures[0], {
    tick: 0,
    numerator: 4,
    denominator: 4,
    clocksPerClick: 24,
    thirtySecondsPerQuarter: 8,
    track: 0,
  });
  assert.deepEqual(parsed.markers[0], { tick: 480, name: "Chorus", track: 0 });

  const note = parsed.tracks[1].notes[0];
  assert.equal(parsed.tracks[1].name, "Keys");
  assert.equal(note.tick, 240);
  assert.equal(note.durationTicks, 480);
  assert.equal(note.startBeats, 0.5);
  assert.equal(note.durationBeats, 1);
  assert.equal(note.startSeconds, 0.25);
  assert.equal(note.endSeconds, 1);
  assert.equal(note.durationSeconds, 0.75);

  const groups = midiImportGroups(parsed);
  assert.deepEqual(groups[0].notes[0], {
    b: 0.5,
    d: 1,
    m: 60,
    v: 96 / 127,
    tick: 240,
    durationTicks: 480,
    startSeconds: 0.25,
    durationSeconds: 0.75,
  });
});

test("parseMidiFile supports running status, MIDI note-on velocity zero and programs", () => {
  const track = bytes(
    vlq(0), 0xff, 0x03, 0x05, ...ascii("Piano"),
    vlq(0), 0xc0, 0x05,
    vlq(0), 0x90, 60, 100,
    vlq(0), 0xff, 0x01, 0x01, 0x78, // Meta text must not break running status.
    vlq(480), 60, 0, // Running status: note-on with velocity zero is note-off.
    vlq(0), 0xff, 0x2f, 0,
  );
  const parsed = parseMidiFile(smf(track));
  assert.equal(parsed.tracks[0].name, "Piano");
  assert.deepEqual(parsed.tracks[0].channels, [{
    channel: 0,
    program: 5,
    programChanges: [{ tick: 0, program: 5 }],
    controllers: [],
  }]);
  assert.deepEqual(parsed.tracks[0].notes[0], {
    tick: 0,
    endTick: 480,
    durationTicks: 480,
    note: 60,
    velocity: 100 / 127,
    velocityRaw: 100,
    channel: 0,
    startSeconds: 0,
    endSeconds: 0.5,
    durationSeconds: 0.5,
    startBeats: 0,
    durationBeats: 1,
  });
});

test("parseMidiFile gives clear errors and deterministic recoverable warnings", () => {
  assert.throws(
    () => parseMidiFile(bytes(...ascii("not-a-midi"))),
    (error) => error instanceof MidiParseError && error.code === "MIDI_HEADER",
  );

  const orphanTrack = bytes(
    vlq(0), 0x80, 64, 0,
    vlq(0), 0x90, 67, 100,
    vlq(120), 0xff, 0x2f, 0,
  );
  const parsed = parseMidiFile(smf(orphanTrack));
  assert.equal(parsed.warnings.length, 2);
  assert.equal(parsed.warnings[0].code, "MIDI_ORPHAN_NOTE_OFF");
  assert.equal(parsed.warnings[1].code, "MIDI_UNCLOSED_NOTE");
  assert.equal(parsed.tracks[0].notes[0].incomplete, true);
  assert.equal(parsed.tracks[0].notes[0].durationTicks, 120);
});

test("parseMidiFile turns SMPTE division into stable seconds without pretending it has beats", () => {
  // -25 fps, 40 ticks per frame = 1,000 ticks/second.
  const division = ((256 - 25) << 8) | 40;
  const track = bytes(
    vlq(100), 0x90, 60, 127,
    vlq(250), 0x80, 60, 0,
    vlq(0), 0xff, 0x2f, 0,
  );
  const parsed = parseMidiFile(smf(track, { division }));
  const note = parsed.tracks[0].notes[0];
  assert.equal(parsed.timing.kind, "smpte");
  assert.equal(parsed.ticksPerQuarter, null);
  assert.equal(note.startSeconds, 0.1);
  assert.ok(Math.abs(note.durationSeconds - 0.25) < 1e-12);
  assert.equal("startBeats" in note, false);
  assert.equal(midiImportGroups(parsed)[0].notes[0].b, 100);
});

test("format-2 MIDI tracks retain separate timing contexts", () => {
  const first = bytes(
    vlq(0), 0xff, 0x51, 3, 0x07, 0xa1, 0x20, // 120 BPM
    vlq(0), 0x90, 60, 100,
    vlq(480), 0x80, 60, 0,
    vlq(0), 0xff, 0x2f, 0,
  );
  const second = bytes(
    vlq(0), 0xff, 0x51, 3, 0x0f, 0x42, 0x40, // 60 BPM
    vlq(0), 0x90, 64, 100,
    vlq(480), 0x80, 64, 0,
    vlq(0), 0xff, 0x2f, 0,
  );
  const parsed = parseMidiFile(smfTracks([first, second], { format: 2 }));
  assert.equal(parsed.timing.independentTracks, true);
  assert.deepEqual(parsed.tempoMap, []);
  assert.equal(parsed.tracks[0].notes[0].durationSeconds, 0.5);
  assert.equal(parsed.tracks[1].notes[0].durationSeconds, 1);
  assert.equal(parsed.durationSeconds, 1);
});
