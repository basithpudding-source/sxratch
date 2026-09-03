// Pure DAW model helpers. Keeping timeline math out of the DOM module makes
// destructive edits deterministic and gives the editor a compact test seam.

export const SNAP_OPTIONS = Object.freeze([
  Object.freeze({ label: "Off", beats: 0 }),
  Object.freeze({ label: "1/4", beats: 1 }),
  Object.freeze({ label: "1/8", beats: 0.5 }),
  Object.freeze({ label: "1/8T", beats: 1 / 3 }),
  Object.freeze({ label: "1/16", beats: 0.25 }),
  Object.freeze({ label: "1/16T", beats: 1 / 6 }),
  Object.freeze({ label: "1/32", beats: 0.125 }),
]);

export const DEFAULT_SNAP = 0.25;
export const MIN_SNAP = 0.125;
export const FINEST_SNAP = 1 / 24;   // quantum floor — must sit below 1/16T

export function clampFinite(value, min, max, fallback) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, safe));
}

export function nearestSnap(value, fallback = DEFAULT_SNAP) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return SNAP_OPTIONS.reduce((best, option) =>
    Math.abs(option.beats - n) < Math.abs(best - n) ? option.beats : best, fallback);
}

export function quantizeBeat(value, step = DEFAULT_SNAP, mode = "round") {
  const beat = Math.max(0, Number(value) || 0);
  const raw = Number(step);
  if (raw === 0) return beat;                       // snap "Off" — no grid
  const quantum = Math.max(FINEST_SNAP, raw > 0 ? raw : DEFAULT_SNAP);
  const op = mode === "floor" ? Math.floor : mode === "ceil" ? Math.ceil : Math.round;
  return op((beat + Number.EPSILON) / quantum) * quantum;
}

export function formatMusicalPosition(beat, beatsPerBar, step = DEFAULT_SNAP) {
  const bpb = Math.max(MIN_SNAP, Number(beatsPerBar) || 4);
  const safeBeat = Math.max(0, Number(beat) || 0);
  const bar = Math.floor(safeBeat / bpb) + 1;
  const inBar = safeBeat % bpb;
  const quarter = Math.floor(inBar) + 1;
  const quantum = Math.max(MIN_SNAP, Number(step) || DEFAULT_SNAP);
  if (quantum >= 1) return `${bar}.${quarter}`;
  const subdivision = Math.floor(((inBar % 1) + 1e-7) / quantum) + 1;
  return `${bar}.${quarter}.${subdivision}`;
}

const TAKE_REGION_FIELDS = Object.freeze([
  "takeGroup", "takeNo", "takeActive", "recordedTake",
]);

function detachTakeMetadata(region) {
  for (const key of TAKE_REGION_FIELDS) delete region[key];
  return region;
}

export function duplicateRegion(region, id, start) {
  // A normal duplicate is a new arrangement region, not another fragment of
  // the recording take. Reusing take identity can make copies silently
  // inactive or cause multiple copies to activate together.
  const copy = detachTakeMetadata(structuredClone(region));
  copy.id = id;
  copy.start = Math.max(0, Number(start) || 0);
  copy.name = `${region.name || "Region"} copy`;
  return copy;
}

export function wrapBeat(value, start, end) {
  const a = Number(start);
  const b = Number(end);
  const beat = Number(value);
  if (!Number.isFinite(beat) || !Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
    return Number.isFinite(beat) ? beat : 0;
  }
  if (beat < b) return beat;
  const span = b - a;
  return a + ((((beat - a) % span) + span) % span);
}

/**
 * Map monotonic recording time into region-local beats. When a take starts
 * inside an active loop, successive passes overdub the same loop region.
 */
export function recordedBeat(elapsed, startBeat, loop = null) {
  const passed = Math.max(0, Number(elapsed) || 0);
  if (!loop || !(loop.b > loop.a) || startBeat < loop.a || startBeat >= loop.b) return passed;
  return wrapBeat(startBeat + passed, loop.a, loop.b) - loop.a;
}

/**
 * Resolve a monotonic recording offset to a loop pass and loop-local beat.
 * Passes are zero-based internally; the UI presents them as Take 1, Take 2…
 */
export function loopRecordingPosition(elapsed, startBeat, loop = null) {
  const passed = Math.max(0, Number(elapsed) || 0);
  const a = Number(loop?.a);
  const b = Number(loop?.b);
  const start = Number(startBeat);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !(b > a)
    || !Number.isFinite(start) || start < a || start >= b) {
    return { pass: 0, beat: passed };
  }
  const span = b - a;
  const absolute = (start - a) + passed;
  const pass = Math.floor(absolute / span);
  return { pass, beat: absolute - pass * span };
}

/**
 * Partition a monotonic slice of a loop recording into pass-local segments.
 * `elapsedOffset` allows held notes to be split from their actual start while
 * audio capture uses the default zero offset to find complete loop passes.
 */
export function partitionLoopRecording(startBeat, durationBeats, loop = null, elapsedOffset = 0) {
  const duration = Math.max(0, Number(durationBeats) || 0);
  const offset = Math.max(0, Number(elapsedOffset) || 0);
  if (!(duration > 0)) return [];

  const a = Number(loop?.a);
  const b = Number(loop?.b);
  const start = Number(startBeat);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !(b > a)
    || !Number.isFinite(start) || start < a || start >= b) {
    return [{
      pass: 0,
      elapsedStart: offset,
      localStart: offset,
      duration,
      complete: false,
    }];
  }

  const span = b - a;
  const epsilon = Math.max(1e-9, span * 1e-9);
  const out = [];
  let consumed = 0;
  while (consumed < duration - epsilon) {
    const elapsedStart = offset + consumed;
    const position = loopRecordingPosition(elapsedStart, start, loop);
    const available = Math.max(epsilon, span - position.beat);
    const partDuration = Math.min(duration - consumed, available);
    out.push({
      pass: position.pass,
      elapsedStart,
      localStart: position.beat,
      duration: partDuration,
      complete: position.beat <= epsilon && partDuration >= span - epsilon,
    });
    consumed += partDuration;
  }
  return out;
}

/**
 * Split a held note at the loop seam. A single region cannot represent a note
 * whose local duration crosses its end, so keep a tail and a wrapped head.
 */
export function splitLoopedNote(start, duration, loopLength) {
  const span = Math.max(MIN_SNAP, Number(loopLength) || 0);
  const at = Math.max(0, Math.min(span, Number(start) || 0));
  const total = Math.max(MIN_SNAP, Math.min(span, Number(duration) || MIN_SNAP));
  const tail = Math.min(total, Math.max(0, span - at));
  const out = [];
  if (tail > 0) out.push({ b: at, d: tail });
  const head = total - tail;
  if (head > 0) out.push({ b: 0, d: head });
  return out;
}

/**
 * Resolve the exact source slice for one audio-region entry. `stopBeat` is
 * normally Infinity, but live loop playback supplies the next loop boundary
 * so a previous pass can never continue underneath the restarted pass.
 */
export function audioRegionSlice(region, playBeat, secondsPerBeat, stopBeat = Infinity, clipDuration = Infinity) {
  const regionStart = Math.max(0, Number(region?.start) || 0);
  const regionLength = Math.max(0, Number(region?.len) || 0);
  const startBeat = Math.max(regionStart, Number(playBeat) || 0);
  const endBeat = Math.min(regionStart + regionLength, Number(stopBeat));
  const spb = Math.max(Number.EPSILON, Number(secondsPerBeat) || 0);
  const baseOffset = Math.max(0, Number(region?.offset) || 0);
  const offsetSec = baseOffset + (startBeat - regionStart) * spb;
  const available = Math.max(0, Number(clipDuration) - offsetSec);
  const durationSec = Math.min(Math.max(0, (endBeat - startBeat) * spb), available);
  if (!(durationSec > 0) || !Number.isFinite(offsetSec)) return null;
  // The UI's clampedFade only guarantees fadeIn + fadeOut <= region LENGTH.
  // A slice truncated by a loop boundary or by the clip running out can be
  // shorter than that sum, which would place fadeOutStart before the fade-in
  // ends (held silence, then a pop). Scale both fades into the audible slice.
  let fadeInSec = Math.max(0, Number(region?.fadeIn || 0) * spb);
  let fadeOutSec = Math.max(0, Number(region?.fadeOut || 0) * spb);
  const totalFade = fadeInSec + fadeOutSec;
  if (totalFade > durationSec && totalFade > 0) {
    const k = durationSec / totalFade;
    fadeInSec *= k;
    fadeOutSec *= k;
  }
  return { offsetSec, durationSec, fadeInSec, fadeOutSec };
}

/**
 * Split region-local content at `cut` beats. Notes crossing the split become
 * two tied note segments rather than disappearing from the right-hand side.
 */
export function splitRegionContent(kind, region, cut, secondsPerBeat) {
  const at = Math.max(MIN_SNAP, Math.min(region.len - MIN_SNAP, Number(cut) || 0));
  const left = { len: at };
  const right = { len: region.len - at };

  // These fields describe the recording/take, not the region geometry. Every
  // split kind must retain them so inactive MIDI and drum takes stay inactive.
  for (const key of ["takeGroup", "takeNo", "takeActive", "recordedTake", "volatile"]) {
    if (!Object.prototype.hasOwnProperty.call(region, key)) continue;
    left[key] = region[key];
    right[key] = region[key];
  }

  if (kind === "audio") {
    left.clipId = region.clipId;
    left.offset = region.offset || 0;
    left.gain = region.gain ?? 1;
    left.fadeIn = clampedFade(left.len, 0, region.fadeIn);
    left.fadeOut = 0;
    right.clipId = region.clipId;
    right.offset = (region.offset || 0) + at * secondsPerBeat;
    right.gain = region.gain ?? 1;
    right.fadeIn = 0;
    right.fadeOut = clampedFade(right.len, 0, region.fadeOut);
    for (const key of ["sourceBpm", "tempoMode"]) {
      if (!Object.prototype.hasOwnProperty.call(region, key)) continue;
      left[key] = region[key];
      right[key] = region[key];
    }
    return { left, right };
  }

  if (kind === "drums") {
    left.hits = (region.hits || []).filter((hit) => hit.b < at).map((hit) => ({ ...hit }));
    right.hits = (region.hits || []).filter((hit) => hit.b >= at)
      .map((hit) => ({ ...hit, b: hit.b - at }));
    return { left, right };
  }

  left.notes = [];
  right.notes = [];
  for (const note of region.notes || []) {
    const start = note.b;
    const end = note.b + note.d;
    if (start < at) {
      const duration = Math.min(end, at) - start;
      if (duration > 0) left.notes.push({ ...note, d: duration });
    }
    if (end > at) {
      const rightStart = Math.max(start, at);
      const duration = end - rightStart;
      if (duration > 0) right.notes.push({ ...note, b: rightStart - at, d: duration });
    }
  }
  return { left, right };
}

/**
 * Return content updates after moving a region's left edge by `delta` beats.
 * Positive delta crops; negative delta extends and shifts existing content.
 */
export function trimRegionStartContent(kind, region, delta, secondsPerBeat) {
  if (kind === "audio") {
    const out = { offset: Math.max(0, (region.offset || 0) + delta * secondsPerBeat) };
    for (const key of ["sourceBpm", "tempoMode"]) {
      if (Object.prototype.hasOwnProperty.call(region, key)) out[key] = region[key];
    }
    return out;
  }
  if (kind === "drums") {
    return {
      hits: (region.hits || [])
        .filter((hit) => delta <= 0 || hit.b >= delta)
        .map((hit) => ({ ...hit, b: Math.max(0, hit.b - delta) })),
    };
  }
  const notes = [];
  for (const note of region.notes || []) {
    const end = note.b + note.d;
    if (delta > 0 && end <= delta) continue;
    const start = Math.max(0, note.b - delta);
    const shiftedEnd = end - delta;
    const duration = shiftedEnd - start;
    if (duration > 0) notes.push({ ...note, b: start, d: duration });
  }
  return { notes };
}

export function quantizeRegionNotes(kind, region, step = DEFAULT_SNAP, filterFn = null) {
  if (kind === "drums") {
    return {
      hits: (region.hits || []).map((h) => {
        if (filterFn && !filterFn(h)) return h;
        return {
          ...h,
          b: quantizeBeat(h.b, step),
        };
      }),
    };
  }
  if (kind === "midi") {
    return {
      notes: (region.notes || []).map((n) => {
        if (filterFn && !filterFn(n)) return n;
        return {
          ...n,
          b: quantizeBeat(n.b, step),
          d: Math.max(step, quantizeBeat(n.d, step)),
        };
      }),
    };
  }
  return {};
}

export function transposeRegionNotes(region, semitones) {
  if (!Array.isArray(region?.notes)) return { notes: [] };
  const st = Number(semitones) || 0;
  return {
    notes: region.notes.map((n) => ({
      ...n,
      m: Math.max(0, Math.min(127, n.m + st)),
    })),
  };
}

/**
 * Move a subset of notes by beat/pitch deltas. The whole group clamps as one:
 * the applied delta is reduced so no member leaves [0, regionLen) or 0..127,
 * which keeps relative spacing intact instead of squashing edge notes.
 */
export function shiftSelectedNotes(notes, isSelected, dBeat, dPitch, regionLen) {
  const sel = notes.filter(isSelected);
  if (!sel.length) return notes.map((n) => ({ ...n }));
  const len = Math.max(MIN_SNAP, Number(regionLen) || MIN_SNAP);
  let db = Number(dBeat) || 0;
  let dp = Math.round(Number(dPitch) || 0);
  for (const n of sel) {
    db = Math.max(db, -n.b);
    db = Math.min(db, Math.max(0, len - MIN_SNAP - n.b));
    if (n.m != null) {
      dp = Math.max(dp, -n.m);
      dp = Math.min(dp, 127 - n.m);
    }
  }
  return notes.map((n) => {
    if (!isSelected(n)) return { ...n };
    const b = n.b + db;
    const out = { ...n, b };
    if (n.d != null) out.d = Math.max(MIN_SNAP, Math.min(n.d, len - b));
    if (n.m != null) out.m = n.m + dp;
    return out;
  });
}

/** Resize a subset of notes by a duration delta, clamped to the region. */
export function resizeSelectedNotes(notes, isSelected, dBeat, regionLen) {
  const len = Math.max(MIN_SNAP, Number(regionLen) || MIN_SNAP);
  const db = Number(dBeat) || 0;
  return notes.map((n) => {
    if (!isSelected(n) || n.d == null) return { ...n };
    return { ...n, d: Math.max(MIN_SNAP, Math.min((n.d || MIN_SNAP) + db, len - n.b)) };
  });
}

/**
 * Region clipboard. `build` strips ids and re-bases starts on the earliest
 * selected region; `materialize` re-bases onto the paste beat. Track identity
 * travels by id so paste lands each region back on its own track.
 */
export function buildRegionClipboard(items) {
  const valid = (items || []).filter((it) => it && it.region && it.trackId != null);
  if (!valid.length) return null;
  const anchor = Math.min(...valid.map((it) => it.region.start));
  return {
    items: valid.map((it) => {
      // Clipboard material is intentionally detached from take identity. A
      // paste may land on another track/time and must always be independently
      // audible and selectable.
      const spec = detachTakeMetadata(structuredClone(it.region));
      delete spec.id;
      spec.start = it.region.start - anchor;
      return { trackId: it.trackId, kind: it.kind, spec };
    }),
  };
}

export function materializeRegionClipboard(clip, atBeat) {
  if (!clip || !Array.isArray(clip.items)) return [];
  const base = Math.max(0, Number(atBeat) || 0);
  return clip.items.map((it) => {
    const spec = structuredClone(it.spec);
    spec.start = base + spec.start;
    return { trackId: it.trackId, kind: it.kind, spec };
  });
}

/** Clamp one fade so fadeIn + fadeOut never exceeds the region length. */
export function clampedFade(regionLen, otherFade, want) {
  const len = Math.max(0, Number(regionLen) || 0);
  const other = Math.max(0, Number(otherFade) || 0);
  return Math.max(0, Math.min(Number(want) || 0, Math.max(0, len - other)));
}

/* --------------------------- track automation --------------------------- */

/**
 * Canonical persisted automation ids and value ranges. Beats are always
 * absolute song beats; send values stay normalized here and are scaled only
 * when they reach the audio graph.
 */
export const AUTOMATION_SPECS = Object.freeze({
  gain: Object.freeze({ label: "Volume", min: 0, max: 1.4, fallback: 0.9 }),
  pan: Object.freeze({ label: "Pan", min: -1, max: 1, fallback: 0 }),
  reverb: Object.freeze({ label: "Reverb send", min: 0, max: 1, fallback: 0 }),
  delay: Object.freeze({ label: "Delay send", min: 0, max: 1, fallback: 0 }),
});

function automationBounds(minOrSpec, max) {
  if (minOrSpec && typeof minOrSpec === "object") {
    return {
      min: Number.isFinite(+minOrSpec.min) ? +minOrSpec.min : -Infinity,
      max: Number.isFinite(+minOrSpec.max) ? +minOrSpec.max : Infinity,
    };
  }
  return {
    min: Number.isFinite(+minOrSpec) ? +minOrSpec : -Infinity,
    max: Number.isFinite(+max) ? +max : Infinity,
  };
}

/**
 * Return a clean, sorted copy of a breakpoint lane. Invalid points are
 * discarded and duplicate beats collapse to the last supplied value.
 */
export function normalizeAutomationPoints(points, minOrSpec = -Infinity, max = Infinity) {
  const bounds = automationBounds(minOrSpec, max);
  const clean = [];
  for (const point of Array.isArray(points) ? points : []) {
    const beat = Number(point?.b);
    const value = Number(point?.v);
    if (!Number.isFinite(beat) || !Number.isFinite(value)) continue;
    const normalized = {
      b: Math.max(0, beat),
      v: Math.max(bounds.min, Math.min(bounds.max, value)),
    };
    const id = Number(point?.id);
    if (Number.isFinite(id)) normalized.id = id;
    clean.push(normalized);
  }
  clean.sort((a, b) => a.b - b.b);
  const out = [];
  for (const point of clean) {
    const previous = out[out.length - 1];
    if (previous && Math.abs(previous.b - point.b) < 1e-9) {
      if (point.id == null && previous.id != null) point.id = previous.id;
      out[out.length - 1] = point;
    } else out.push(point);
  }
  return out;
}

/**
 * Evaluate a piecewise-linear automation lane. This deliberately tolerates
 * unsorted input without allocating, so malformed imports cannot put NaN into
 * an AudioParam before normalizeSong has a chance to rewrite them.
 */
export function automationValueAt(points, beat, fallback = 0) {
  const at = Math.max(0, Number(beat) || 0);
  let lowerBeat = -Infinity, lowerValue = null;
  let upperBeat = Infinity, upperValue = null;
  for (const point of Array.isArray(points) ? points : []) {
    const pointBeat = Number(point?.b);
    const pointValue = Number(point?.v);
    if (!Number.isFinite(pointBeat) || !Number.isFinite(pointValue)) continue;
    const safeBeat = Math.max(0, pointBeat);
    if (safeBeat <= at && safeBeat >= lowerBeat) {
      lowerBeat = safeBeat;
      lowerValue = pointValue;
    }
    if (safeBeat >= at && safeBeat <= upperBeat) {
      upperBeat = safeBeat;
      upperValue = pointValue;
    }
  }
  if (lowerValue == null && upperValue == null) return Number(fallback) || 0;
  if (lowerValue == null) return upperValue;
  if (upperValue == null || upperBeat === lowerBeat) return lowerValue;
  const t = (at - lowerBeat) / (upperBeat - lowerBeat);
  return lowerValue + (upperValue - lowerValue) * t;
}

/** Fill an existing Float32Array with uniformly sampled automation values. */
export function fillAutomationCurve(out, points, fromBeat, toBeat, fallback = 0, scale = 1) {
  if (!(out instanceof Float32Array) || out.length < 2) {
    throw new TypeError("automation curve output must be a Float32Array of length >= 2");
  }
  const from = Math.max(0, Number(fromBeat) || 0);
  const to = Math.max(from, Number(toBeat) || from);
  const mul = Number.isFinite(+scale) ? +scale : 1;
  const span = to - from;
  for (let i = 0; i < out.length; i++) {
    const beat = from + span * (i / (out.length - 1));
    out[i] = automationValueAt(points, beat, fallback) * mul;
  }
  return out;
}

/** Allocate and return a sampled curve, primarily for tests and UI previews. */
export function automationCurve(points, fromBeat, toBeat, samples = 24, fallback = 0, scale = 1) {
  const count = Math.max(2, Math.min(2048, Math.round(Number(samples) || 24)));
  return fillAutomationCurve(new Float32Array(count), points, fromBeat, toBeat, fallback, scale);
}

/** Insert or replace one breakpoint and return a normalized, sorted lane. */
export function upsertAutomationPoint(points, beat, value, minOrSpec = -Infinity, max = Infinity) {
  const next = Array.isArray(points) ? points.map((point) => ({ ...point })) : [];
  next.push({ b: beat, v: value });
  return normalizeAutomationPoints(next, minOrSpec, max);
}
