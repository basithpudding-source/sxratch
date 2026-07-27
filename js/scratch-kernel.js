// Shared scratch-read kernel — the sample-interpolation and loop-seam logic
// used by the scratch worklet (js/scratch-processor.js), extracted pure so
// node:test can exercise the exact code that ships on the audio thread.
//
// Loop-seam model: the track is contiguous audio everywhere, so reads ALWAYS
// use true track samples (clamped at the track edges) — interpolation context
// beyond a loop boundary is the same audio the pre-wrap trajectory would play.
// The click at a loop wrap comes from the playhead JUMP (phase mismatch
// between loop end and loop start), and is removed by a short equal-power
// crossfade between the post-wrap audio and a "ghost" continuation of the
// pre-wrap playhead. (A circular wrap-aware read was tried and rejected: it
// bends the waveform toward the phase-mismatched far end of the loop before
// the fade starts, which measurably ADDS a discontinuity at non-integer
// rates — see test/scratch.test.js.)

/** 4-point Catmull-Rom read with track-bound clamped neighbors. */
export function readClamped(data, ph, last) {
  const idx = ph | 0;
  const frac = ph - idx;
  const i0 = idx > 0 ? idx - 1 : 0;
  const i2 = idx < last ? idx + 1 : last;
  const i3 = i2 < last ? i2 + 1 : last;
  const p0 = data[i0], p1 = data[idx], p2 = data[i2], p3 = data[i3];
  const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
  const d = -0.5 * p0 + 0.5 * p2;
  return ((a * frac + b) * frac + d) * frac + p1;
}

/* ------------------------------ seam crossfade ---------------------------- */

/** @param {number} fadeLen crossfade length in samples (~5 ms at 48 kHz = 240). */
export function createSeamState(fadeLen = 240) {
  return { fadeLen, active: false, pos: 1, ph: 0, wMain: 1, wGhost: 0 };
}

/**
 * Call when the playhead wraps at a loop boundary. `prePh` is the playhead
 * BEFORE the wrap correction (i.e. just past the boundary) — the ghost
 * continues along that trajectory while the fade runs. Skipped for loops too
 * short to fade cleanly (the ghost would cross the next seam).
 */
export function seamStart(state, prePh, loopLen) {
  if (loopLen < state.fadeLen * 2) { state.active = false; return; }
  state.ph = prePh;
  state.pos = 0;
  state.active = true;
  state.wMain = 0;
  state.wGhost = 1;
}

/**
 * Advance the seam once per frame (after the channel reads): moves the ghost
 * playhead by the current rate and updates the equal-power weights.
 */
export function seamTick(state, rate, last) {
  if (!state.active) return;
  state.ph += rate;
  if (state.ph < 0) state.ph = 0; else if (state.ph > last) state.ph = last;
  state.pos += 1 / state.fadeLen;
  if (state.pos >= 1) { state.active = false; state.wMain = 1; state.wGhost = 0; return; }
  const th = state.pos * Math.PI / 2;
  state.wMain = Math.sin(th);
  state.wGhost = Math.cos(th);
}
