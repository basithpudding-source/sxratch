// Pure, dependency-free helpers shared across modules — and the unit-test surface.
// Everything here is a pure function (no DOM, no Web Audio), so it runs under
// `node --test` and is safe to import from any thread.

/** MIDI note number -> frequency in Hz (A4 = 69 = 440 Hz). */
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

const SEMITONE = { C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };

/** Note name with flats (e.g. "Bb3", "C4") -> MIDI number, with C4 = 60. null if unparseable. */
export function noteNameToMidi(name) {
  const m = /^([A-G]b?)(-?\d)$/.exec(name);
  if (!m) return null;
  return SEMITONE[m[1]] + (parseInt(m[2], 10) + 1) * 12;
}

/** Nearest value to `x` in a sorted numeric array. */
export function nearest(sorted, x) {
  let best = sorted[0], bd = Infinity;
  for (const v of sorted) { const d = Math.abs(v - x); if (d < bd) { bd = d; best = v; } }
  return best;
}

/**
 * Crossfade gains for the A and B decks. x: 0 (full A) .. 1 (full B).
 * curve: "power" (equal-power, default) | "linear" | "cut". Returns [gainA, gainB].
 */
export function crossfadeGains(x, curve = "power", hamster = false) {
  const v = hamster ? 1 - x : x;
  if (curve === "linear") return [1 - v, v];
  if (curve === "cut") {
    // instant cut-off within 8% of fader travel
    const a = v > 0.92 ? 0 : v < 0.5 ? 1 : Math.max(0, Math.min(1, (0.92 - v) / 0.08));
    const b = v < 0.08 ? 0 : v > 0.5 ? 1 : Math.max(0, Math.min(1, (v - 0.08) / 0.08));
    return [a, b];
  }
  return [Math.cos(v * 0.5 * Math.PI), Math.cos((1 - v) * 0.5 * Math.PI)];
}

/**
 * 4-point Catmull-Rom cubic interpolation; t in [0,1) between p1 and p2.
 * (The scratch worklet inlines this same formula on the audio thread for speed;
 * this is the tested reference implementation.)
 */
export function catmullRom(p0, p1, p2, p3, t) {
  const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
  const d = -0.5 * p0 + 0.5 * p2;
  return ((a * t + b) * t + d) * t + p1;
}

/** Clamp a float sample to [-1,1] and convert to a signed 16-bit int (WAV PCM). */
export function floatToInt16(v) {
  v = Math.max(-1, Math.min(1, v));
  return v < 0 ? v * 0x8000 : v * 0x7fff;
}
