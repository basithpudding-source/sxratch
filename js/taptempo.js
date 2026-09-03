// Tap tempo — median-interval BPM from the last few taps.
// Pure module (no DOM/audio): powers the deck BPM readout taps and the PAD
// tempo module, and runs under node:test.

/**
 * @param {{ maxTaps?: number, resetMs?: number, min?: number, max?: number }} [opts]
 */
export function createTapTempo({ maxTaps = 8, resetMs = 2000, min = 40, max = 240 } = {}) {
  /** @type {number[]} */
  let taps = [];
  return {
    /**
     * Register a tap. Returns the current BPM estimate (median of the
     * recorded intervals, ≥2 intervals required) or null while warming up /
     * out of range. A gap longer than `resetMs` starts a fresh measurement.
     */
    tap(now) {
      if (taps.length && now - taps[taps.length - 1] > resetMs) taps = [];
      taps.push(now);
      if (taps.length > maxTaps) taps.shift();
      if (taps.length < 3) return null;
      const iv = [];
      for (let i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
      iv.sort((a, b) => a - b);
      const mid = iv.length >> 1;
      const median = iv.length % 2 ? iv[mid] : (iv[mid - 1] + iv[mid]) / 2;
      const bpm = 60000 / median;
      return bpm >= min && bpm <= max ? Math.round(bpm * 10) / 10 : null;
    },
    reset() { taps = []; },
    get count() { return taps.length; },
  };
}
