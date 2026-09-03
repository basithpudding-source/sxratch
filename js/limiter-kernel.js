// Shared look-ahead brickwall limiter kernel.
//
// ONE implementation used by BOTH the live master limiter worklet
// (js/limiter-processor.js) and the offline mastering pass
// (masterFinalize in js/synth.js) — previously the live worklet chased the
// instantaneous sample with no window-minimum and no ceiling clamp, so live
// output was weaker than the tested offline path. Now they are literally the
// same code.
//
// Algorithm: the gain target for each output sample is the MINIMUM gain
// needed anywhere in the look-ahead window (sliding-window minimum via a
// monotonic deque), so the reduction is fully ramped in BEFORE a transient
// exits the delay line — peaks are attenuated smoothly instead of flat-top
// clipped. A hard clamp at ±ceiling catches the ≤0.3% attack residue.
//
// Pure ES module, no Web Audio APIs: it runs in the AudioWorkletGlobalScope
// (imported by the worklet — inlined by the production bundle), on the main
// thread (synth.js), and under node:test.
//
// NOTE for dev servers: AudioWorklet module imports are spec-standard and work
// in all Chromium browsers; the production build inlines this file, so any
// engine that lags on worklet imports only affects unbundled dev serving.

/** One ceiling for the live AudioWorklet and every offline finalization path. */
export const LIMITER_CEILING = 0.965;

/**
 * @param {number} sampleRate
 * @param {{ lookaheadMs?: number, releaseMs?: number }} [opts]
 */
export function createLimiterKernel(sampleRate, { lookaheadMs = 3, releaseMs = 120 } = {}) {
  const la = Math.max(1, Math.round((sampleRate * lookaheadMs) / 1000));
  const atk = 1 - Math.exp(-6 / la);       // converges to ~0.25% within the window
  const rel = 1 - Math.exp(-1 / ((sampleRate * releaseMs) / 1000));
  const ringSize = la + 2;                 // > window span (la+1) so arriving/leaving indices never alias
  const dval = new Float32Array(ringSize); // desired gain per sample, ring-indexed
  const cap = la + 3;
  const dqIdx = new Int32Array(cap);       // monotonic deque of sample indices
  let qh = 0, qlen = 0;
  let g = 1, dpos = 0, n = 0;              // n = absolute sample counter (window bookkeeping)
  /** @type {Float32Array[]|null} */
  let delays = null;

  return {
    /** Delay introduced by the look-ahead, in samples. */
    lookahead: la,

    /**
     * Limit `frames` samples starting at `offset`. `inChans`/`outChans` are
     * arrays of Float32Array (same array allowed — processing is in-place
     * safe). Streaming: state carries across calls, so feeding one long
     * buffer or many 128-frame blocks yields identical output.
     */
    process(inChans, outChans, offset, frames, ceiling) {
      if (!delays || delays.length !== inChans.length) {
        delays = inChans.map(() => new Float32Array(la));
        dpos = 0;
      }
      const chN = inChans.length;
      const end = offset + frames;
      for (let i = offset; i < end; i++) {
        let peak = 0;
        for (let c = 0; c < chN; c++) { const v = Math.abs(inChans[c][i]); if (v > peak) peak = v; }
        const dNeed = peak > ceiling ? ceiling / peak : 1;
        dval[n % ringSize] = dNeed;
        while (qlen > 0 && dval[dqIdx[(qh + qlen - 1) % cap] % ringSize] >= dNeed) qlen--;
        dqIdx[(qh + qlen) % cap] = n; qlen++;
        if (dqIdx[qh] < n - la) { qh = (qh + 1) % cap; qlen--; }
        const target = dval[dqIdx[qh] % ringSize];
        g += (target - g) * (target < g ? atk : rel);
        for (let c = 0; c < chN; c++) {
          const dl = delays[c];
          const delayed = dl[dpos];
          dl[dpos] = inChans[c][i];
          let v = delayed * g;
          if (v > ceiling) v = ceiling; else if (v < -ceiling) v = -ceiling;
          outChans[c][i] = v;
        }
        if (++dpos >= la) dpos = 0;
        n++;
      }
    },
  };
}
