// Pure DAW model helpers. Keeping timeline math out of the DOM module makes
// destructive edits deterministic and gives the editor a compact test seam.

export const SNAP_OPTIONS = Object.freeze([
  Object.freeze({ label: "1/4", beats: 1 }),
  Object.freeze({ label: "1/8", beats: 0.5 }),
  Object.freeze({ label: "1/16", beats: 0.25 }),
  Object.freeze({ label: "1/32", beats: 0.125 }),
]);

export const DEFAULT_SNAP = 0.25;
export const MIN_SNAP = 0.125;

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
  const quantum = Math.max(MIN_SNAP, Number(step) || DEFAULT_SNAP);
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

export function duplicateRegion(region, id, start) {
  const copy = structuredClone(region);
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
  const fadeInSec = Math.max(0, Number(region?.fadeIn || 0) * spb);
  const fadeOutSec = Math.max(0, Number(region?.fadeOut || 0) * spb);
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

  if (kind === "audio") {
    left.clipId = region.clipId;
    left.offset = region.offset || 0;
    left.gain = region.gain ?? 1;
    left.fadeIn = region.fadeIn || 0;
    left.fadeOut = 0;
    right.clipId = region.clipId;
    right.offset = (region.offset || 0) + at * secondsPerBeat;
    right.gain = region.gain ?? 1;
    right.fadeIn = 0;
    right.fadeOut = region.fadeOut || 0;
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
    return { offset: Math.max(0, (region.offset || 0) + delta * secondsPerBeat) };
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

export function quantizeRegionNotes(kind, region, step = DEFAULT_SNAP) {
  if (kind === "drums") {
    return {
      hits: (region.hits || []).map((h) => ({
        ...h,
        b: quantizeBeat(h.b, step),
      })),
    };
  }
  if (kind === "midi") {
    return {
      notes: (region.notes || []).map((n) => ({
        ...n,
        b: quantizeBeat(n.b, step),
        d: Math.max(step, quantizeBeat(n.d, step)),
      })),
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

