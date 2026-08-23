// Standard MIDI File (SMF) reader for PAD Studio.
//
// This deliberately has no Web MIDI or Web Audio dependencies, so it is safe
// to use both in the browser import flow and in Node-based tests.  It accepts
// the binary contents of a .mid/.midi file and returns absolute-tick note data
// together with a global tempo map and musical metadata.

const MAX_VLQ_BYTES = 4;

/** A useful, user-facing parse error with the byte location when available. */
export class MidiParseError extends Error {
  constructor(message, { code = "MIDI_PARSE_ERROR", offset = null } = {}) {
    super(offset == null ? message : `${message} (at byte ${offset})`);
    this.name = "MidiParseError";
    this.code = code;
    this.offset = offset;
  }
}

function fail(message, code, offset) {
  throw new MidiParseError(message, { code, offset });
}

function asBytes(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  fail("Expected an ArrayBuffer or Uint8Array containing a MIDI file", "MIDI_INPUT");
}

function ascii(bytes, start, length) {
  let text = "";
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[start + i]);
  return text;
}

function decodeText(bytes) {
  // MIDI text is traditionally Latin-1/ASCII. TextDecoder gives UTF-8 MIDI
  // files a nicer result while this fallback keeps older browsers working.
  if (typeof TextDecoder !== "undefined") {
    try { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); } catch { /* fall through */ }
  }
  return ascii(bytes, 0, bytes.length);
}

function readU16(bytes, cursor, end) {
  if (cursor + 2 > end) fail("Unexpected end of MIDI data", "MIDI_TRUNCATED", cursor);
  return (bytes[cursor] << 8) | bytes[cursor + 1];
}

function readU32(bytes, cursor, end) {
  if (cursor + 4 > end) fail("Unexpected end of MIDI data", "MIDI_TRUNCATED", cursor);
  return ((bytes[cursor] * 0x1000000) + (bytes[cursor + 1] << 16) + (bytes[cursor + 2] << 8) + bytes[cursor + 3]);
}

function readVlq(bytes, state, end) {
  let value = 0;
  for (let count = 0; count < MAX_VLQ_BYTES; count += 1) {
    if (state.pos >= end) fail("Unexpected end of MIDI variable-length value", "MIDI_TRUNCATED", state.pos);
    const byte = bytes[state.pos++];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return value;
  }
  fail("MIDI variable-length value is longer than four bytes", "MIDI_VLQ", state.pos - MAX_VLQ_BYTES);
}

function dataLengthForStatus(status) {
  switch (status & 0xf0) {
    case 0xc0:
    case 0xd0:
      return 1;
    case 0x80:
    case 0x90:
    case 0xa0:
    case 0xb0:
    case 0xe0:
      return 2;
    default:
      return null;
  }
}

function tempoBpm(microsPerQuarter) {
  return 60000000 / microsPerQuarter;
}

function sortByTickThenOrder(a, b) {
  return a.tick - b.tick || a.order - b.order;
}

function normalizeTempoEvents(events, defaultMicrosPerQuarter, ticksPerQuarter) {
  const ordered = [{ tick: 0, microsPerQuarter: defaultMicrosPerQuarter, order: -1 }, ...events]
    .sort(sortByTickThenOrder);
  const unique = [];
  for (const event of ordered) {
    if (unique.length && unique[unique.length - 1].tick === event.tick) unique[unique.length - 1] = event;
    else unique.push(event);
  }

  let seconds = 0;
  for (let i = 0; i < unique.length; i += 1) {
    const current = unique[i];
    if (i) {
      const previous = unique[i - 1];
      seconds += ((current.tick - previous.tick) * previous.microsPerQuarter) / (ticksPerQuarter * 1000000);
    }
    current.seconds = seconds;
    current.bpm = tempoBpm(current.microsPerQuarter);
    delete current.order;
  }
  return unique;
}

function secondsAtTick(tick, timing) {
  if (timing.kind === "smpte") return tick / timing.ticksPerSecond;
  const map = timing.tempoMap;
  let entry = map[0];
  // MIDI files normally have a short tempo map, and this branch-free-enough
  // backwards scan avoids allocating helpers for every imported note.
  for (let i = map.length - 1; i >= 0; i -= 1) {
    if (map[i].tick <= tick) { entry = map[i]; break; }
  }
  return entry.seconds + ((tick - entry.tick) * entry.microsPerQuarter) / (timing.ticksPerQuarter * 1000000);
}

function parseDivision(division) {
  if (!(division & 0x8000)) {
    if (!division) fail("MIDI ticks-per-quarter must be greater than zero", "MIDI_DIVISION");
    return { kind: "ppqn", ticksPerQuarter: division };
  }
  const signedFps = (division >> 8) & 0xff;
  const framesPerSecondCode = signedFps - 256;
  const ticksPerFrame = division & 0xff;
  if (!ticksPerFrame || ![-24, -25, -29, -30].includes(framesPerSecondCode)) {
    fail("Unsupported SMPTE MIDI time division", "MIDI_DIVISION");
  }
  // -29 means 29.97 drop-frame timecode in Standard MIDI Files.
  const framesPerSecond = framesPerSecondCode === -29 ? 29.97 : Math.abs(framesPerSecondCode);
  return {
    kind: "smpte",
    framesPerSecond,
    ticksPerFrame,
    ticksPerSecond: framesPerSecond * ticksPerFrame,
  };
}

function channelSummary(channelState) {
  return [...channelState.entries()]
    .sort(([a], [b]) => a - b)
    .map(([channel, data]) => ({
      channel,
      program: data.program,
      programChanges: data.programChanges.slice(),
      controllers: data.controllers.slice(),
    }));
}

function closeOpenNotes(openNotes, notes, endTick, warnings, trackIndex) {
  for (const [key, stack] of openNotes.entries()) {
    for (const open of stack) {
      notes.push({
        tick: open.tick,
        endTick,
        durationTicks: Math.max(0, endTick - open.tick),
        note: open.note,
        velocity: open.velocity,
        velocityRaw: open.velocityRaw,
        channel: open.channel,
        incomplete: true,
      });
      warnings.push({
        code: "MIDI_UNCLOSED_NOTE",
        track: trackIndex,
        tick: open.tick,
        message: `Closed an unterminated MIDI note at the end of track ${trackIndex + 1}`,
      });
    }
    openNotes.delete(key);
  }
}

function parseTrack(bytes, start, end, trackIndex, shared) {
  const state = { pos: start };
  let tick = 0;
  let runningStatus = null;
  let endOfTrack = false;
  let sequence = 0;
  let name = "";
  let instrumentName = "";
  const notes = [];
  const openNotes = new Map();
  const channelState = new Map();
  const meta = { tempos: [], markers: [], cuePoints: [], keySignatures: [] };

  const channelData = (channel) => {
    let data = channelState.get(channel);
    if (!data) {
      data = { program: null, programChanges: [], controllers: [] };
      channelState.set(channel, data);
    }
    return data;
  };
  const closeNote = (channel, note) => {
    const key = `${channel}:${note}`;
    const stack = openNotes.get(key);
    if (!stack?.length) {
      shared.warnings.push({
        code: "MIDI_ORPHAN_NOTE_OFF",
        track: trackIndex,
        tick,
        message: `Ignored a MIDI note-off with no matching note-on in track ${trackIndex + 1}`,
      });
      return;
    }
    const open = stack.shift(); // FIFO is the least surprising pairing for overlapping same notes.
    if (!stack.length) openNotes.delete(key);
    notes.push({
      tick: open.tick,
      endTick: tick,
      durationTicks: Math.max(0, tick - open.tick),
      note,
      velocity: open.velocity,
      velocityRaw: open.velocityRaw,
      channel,
    });
  };
  const openNote = (channel, note, velocityRaw) => {
    const key = `${channel}:${note}`;
    if (!openNotes.has(key)) openNotes.set(key, []);
    openNotes.get(key).push({ tick, note, channel, velocityRaw, velocity: velocityRaw / 127 });
  };

  while (state.pos < end && !endOfTrack) {
    tick += readVlq(bytes, state, end);
    if (state.pos >= end) fail("MIDI event is missing a status byte", "MIDI_TRUNCATED", state.pos);

    let status = bytes[state.pos];
    let firstData = null;
    if (status < 0x80) {
      if (runningStatus == null) fail("MIDI running status has no preceding channel status", "MIDI_RUNNING_STATUS", state.pos);
      status = runningStatus;
      firstData = bytes[state.pos++];
    } else {
      state.pos += 1;
      // Keep the most recent channel status across meta and SysEx events.
      // A few real-world sequencers use this legal SMF shorthand, while a
      // channel event always supersedes it below.
      if (status >= 0x80 && status <= 0xef) runningStatus = status;
    }

    if (status === 0xff) {
      if (state.pos >= end) fail("MIDI meta event is missing its type", "MIDI_TRUNCATED", state.pos);
      const type = bytes[state.pos++];
      const length = readVlq(bytes, state, end);
      if (state.pos + length > end) fail("MIDI meta event exceeds its track", "MIDI_TRUNCATED", state.pos);
      const value = bytes.subarray(state.pos, state.pos + length);
      state.pos += length;

      if (type === 0x2f) {
        if (length !== 0) fail("MIDI end-of-track event must have zero length", "MIDI_META_LENGTH", state.pos - length);
        endOfTrack = true;
      } else if (type === 0x51 && length === 3) {
        const microsPerQuarter = (value[0] << 16) | (value[1] << 8) | value[2];
        if (microsPerQuarter > 0) {
          const tempo = { tick, microsPerQuarter, order: shared.order++ };
          meta.tempos.push(tempo);
          shared.tempos.push({ ...tempo });
        }
      } else if (type === 0x58 && length >= 2) {
        const denominatorExponent = value[1];
        if (denominatorExponent <= 30) {
          shared.timeSignatures.push({
            tick,
            numerator: value[0] || 4,
            denominator: 2 ** denominatorExponent,
            clocksPerClick: value[2] ?? 24,
            thirtySecondsPerQuarter: value[3] ?? 8,
            track: trackIndex,
            order: shared.order++,
          });
        }
      } else if (type === 0x03) {
        name = decodeText(value).replace(/\0/g, "").trim();
      } else if (type === 0x04) {
        instrumentName = decodeText(value).replace(/\0/g, "").trim();
      } else if (type === 0x06) {
        const marker = { tick, name: decodeText(value).replace(/\0/g, "").trim() || "Marker", track: trackIndex, order: shared.order++ };
        meta.markers.push(marker);
        shared.markers.push(marker);
      } else if (type === 0x07) {
        meta.cuePoints.push({ tick, name: decodeText(value).replace(/\0/g, "").trim() || "Cue" });
      } else if (type === 0x59 && length >= 2) {
        meta.keySignatures.push({ tick, sharpsFlats: (value[0] << 24) >> 24, minor: value[1] === 1 });
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const length = readVlq(bytes, state, end);
      if (state.pos + length > end) fail("MIDI system-exclusive event exceeds its track", "MIDI_TRUNCATED", state.pos);
      state.pos += length;
      continue;
    }

    const dataLength = dataLengthForStatus(status);
    if (dataLength == null) fail(`Unsupported MIDI system status 0x${status.toString(16)}`, "MIDI_STATUS", state.pos - 1);
    const data = firstData == null ? [] : [firstData];
    while (data.length < dataLength) {
      if (state.pos >= end) fail("MIDI channel event is truncated", "MIDI_TRUNCATED", state.pos);
      const value = bytes[state.pos++];
      if (value >= 0x80) fail("MIDI channel event contains an invalid data byte", "MIDI_DATA", state.pos - 1);
      data.push(value);
    }
    if (data.some((value) => value >= 0x80)) fail("MIDI channel event contains an invalid data byte", "MIDI_DATA", state.pos - data.length);

    const family = status & 0xf0;
    const channel = status & 0x0f;
    const channelInfo = channelData(channel);
    if (family === 0x80) closeNote(channel, data[0]);
    else if (family === 0x90) {
      if (data[1] === 0) closeNote(channel, data[0]);
      else openNote(channel, data[0], data[1]);
    } else if (family === 0xb0) {
      channelInfo.controllers.push({ tick, controller: data[0], value: data[1] });
    } else if (family === 0xc0) {
      channelInfo.program = data[0];
      channelInfo.programChanges.push({ tick, program: data[0] });
    }
    sequence += 1;
  }

  if (!endOfTrack && state.pos !== end) fail("MIDI track did not end cleanly", "MIDI_TRACK");
  // Bytes after an End-of-Track event are legal padding in the wild; ignore it.
  closeOpenNotes(openNotes, notes, tick, shared.warnings, trackIndex);
  notes.sort((a, b) => a.tick - b.tick || a.note - b.note || a.channel - b.channel);
  return {
    index: trackIndex,
    name,
    instrumentName,
    endTick: tick,
    notes,
    tempoEvents: meta.tempos.map(({ order, ...tempo }) => tempo),
    channels: channelSummary(channelState),
    markers: meta.markers,
    cuePoints: meta.cuePoints,
    keySignatures: meta.keySignatures,
    eventCount: sequence,
  };
}

function annotateNoteTiming(track, timing) {
  for (const note of track.notes) {
    note.startSeconds = secondsAtTick(note.tick, timing);
    note.endSeconds = secondsAtTick(note.endTick, timing);
    note.durationSeconds = Math.max(0, note.endSeconds - note.startSeconds);
    if (timing.kind === "ppqn") {
      note.startBeats = note.tick / timing.ticksPerQuarter;
      note.durationBeats = note.durationTicks / timing.ticksPerQuarter;
    }
  }
}

/**
 * Parse a Standard MIDI File (.mid/.midi) into tempo-aware, absolute-tick data.
 *
 * @param {ArrayBuffer|Uint8Array|ArrayBufferView} source file bytes
 * @param {{ defaultTempoBpm?: number }} options
 * @returns {{
 *   format: number, ticksPerQuarter?: number, timing: object, tracks: object[],
 *   tempoMap: object[], timeSignatures: object[], markers: object[], warnings: object[],
 *   durationTicks: number, durationSeconds: number
 * }}
 */
export function parseMidiFile(source, { defaultTempoBpm = 120 } = {}) {
  const bytes = asBytes(source);
  if (bytes.length < 14) fail("File is too small to be a Standard MIDI File", "MIDI_HEADER", 0);
  if (ascii(bytes, 0, 4) !== "MThd") fail("Expected a Standard MIDI File header (MThd)", "MIDI_HEADER", 0);
  const headerLength = readU32(bytes, 4, bytes.length);
  if (headerLength < 6 || 8 + headerLength > bytes.length) fail("MIDI header has an invalid length", "MIDI_HEADER", 4);

  const format = readU16(bytes, 8, bytes.length);
  const declaredTrackCount = readU16(bytes, 10, bytes.length);
  const division = readU16(bytes, 12, bytes.length);
  if (![0, 1, 2].includes(format)) fail(`Unsupported MIDI file format ${format}`, "MIDI_FORMAT", 8);
  if (!declaredTrackCount) fail("MIDI file declares no tracks", "MIDI_HEADER", 10);
  if (format === 0 && declaredTrackCount !== 1) fail("Format-0 MIDI files must declare exactly one track", "MIDI_HEADER", 10);

  const defaultMicrosPerQuarter = Math.max(1, Math.round(60000000 / Math.max(1, Number(defaultTempoBpm) || 120)));
  const timing = parseDivision(division);
  const shared = { tempos: [], timeSignatures: [], markers: [], warnings: [], order: 0 };
  const tracks = [];
  let cursor = 8 + headerLength;

  while (cursor < bytes.length && tracks.length < declaredTrackCount) {
    if (cursor + 8 > bytes.length) fail("MIDI chunk header is truncated", "MIDI_TRUNCATED", cursor);
    const chunkId = ascii(bytes, cursor, 4);
    const length = readU32(bytes, cursor + 4, bytes.length);
    const bodyStart = cursor + 8;
    const bodyEnd = bodyStart + length;
    if (bodyEnd > bytes.length) fail(`MIDI ${chunkId} chunk exceeds file length`, "MIDI_TRUNCATED", cursor + 4);
    cursor = bodyEnd;
    if (chunkId !== "MTrk") continue; // Ignore legal/unknown non-track chunks.
    tracks.push(parseTrack(bytes, bodyStart, bodyEnd, tracks.length, shared));
  }
  if (tracks.length !== declaredTrackCount) fail("MIDI file ended before all declared tracks were found", "MIDI_TRACK_COUNT", cursor);

  const durationTicks = tracks.reduce((max, track) => Math.max(max, track.endTick), 0);
  if (timing.kind === "ppqn" && format !== 2) {
    timing.tempoMap = normalizeTempoEvents(shared.tempos, defaultMicrosPerQuarter, timing.ticksPerQuarter);
    for (const track of tracks) annotateNoteTiming(track, timing);
  } else if (timing.kind === "ppqn") {
    // Format 2 holds independent sequences, so a single global tempo map
    // would be misleading. Give every source track its own timing context.
    timing.tempoMap = [];
    timing.independentTracks = true;
    for (const track of tracks) {
      track.timing = {
        kind: "ppqn",
        ticksPerQuarter: timing.ticksPerQuarter,
        tempoMap: normalizeTempoEvents(track.tempoEvents, defaultMicrosPerQuarter, timing.ticksPerQuarter),
      };
      annotateNoteTiming(track, track.timing);
    }
  } else {
    timing.tempoMap = [];
    for (const track of tracks) annotateNoteTiming(track, timing);
  }

  const timeSignatures = shared.timeSignatures
    .sort(sortByTickThenOrder)
    .map(({ order, ...signature }) => signature);
  const markers = shared.markers
    .sort(sortByTickThenOrder)
    .map(({ order, ...marker }) => marker);
  const durationSeconds = format === 2 && timing.kind === "ppqn"
    ? tracks.reduce((max, track) => Math.max(max, secondsAtTick(track.endTick, track.timing)), 0)
    : secondsAtTick(durationTicks, timing);

  return {
    format,
    declaredTrackCount,
    division,
    ticksPerQuarter: timing.kind === "ppqn" ? timing.ticksPerQuarter : null,
    timing,
    tracks,
    tempoMap: timing.tempoMap,
    timeSignatures,
    markers,
    warnings: shared.warnings,
    durationTicks,
    durationSeconds,
  };
}

/**
 * Flatten parsed tracks into PAD-friendly musical notes without mutating them.
 * Each returned item remains a source-track/channel group, making the calling
 * UI free to combine channels or create one PAD track per instrument.
 */
export function midiImportGroups(parsed) {
  if (!parsed || !Array.isArray(parsed.tracks)) {
    throw new TypeError("midiImportGroups expects the result of parseMidiFile()");
  }
  return parsed.tracks.flatMap((track) => {
    const byChannel = new Map();
    for (const note of track.notes) {
      if (!byChannel.has(note.channel)) byChannel.set(note.channel, []);
      byChannel.get(note.channel).push({
        b: note.startBeats ?? note.tick,
        d: note.durationBeats ?? note.durationTicks,
        m: note.note,
        v: note.velocity,
        tick: note.tick,
        durationTicks: note.durationTicks,
        startSeconds: note.startSeconds,
        durationSeconds: note.durationSeconds,
      });
    }
    return [...byChannel.entries()].map(([channel, notes]) => {
      const channelInfo = track.channels.find((item) => item.channel === channel);
      const readableName = track.name || track.instrumentName || (channel === 9 ? "Drums" : `MIDI ${channel + 1}`);
      return {
        sourceTrackIndex: track.index,
        name: readableName,
        instrumentName: track.instrumentName,
        channel,
        program: channelInfo?.program ?? null,
        notes,
      };
    });
  });
}
