// Sxratch BPM detection — lightweight onset-envelope autocorrelation.
//
// Good enough to drive the deck BPM readout, SYNC and auto-loops for typical
// rhythmic material (house/hip-hop/rock, 60–200 BPM). Returns null when the
// signal has no confident periodicity (ambient pads, speech, FX one-shots) so
// callers can keep showing "--" instead of guessing.
//
// Cost: one pass over the samples for the RMS envelope (~10–20 ms for a
// 4-minute track) + a tiny autocorrelation. Call it off the load path
// (setTimeout / idle) so the UI never blocks.

/**
 * Estimate the tempo and downbeat offset of a decoded track.
 * @param {AudioBuffer} buffer
 * @returns {{ bpm: number, offset: number }|null}
 */
export function detectBeatGrid(buffer) {
  if (!buffer || !buffer.length) return null;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  return detectBeatGridFromChannels(ch0, ch1, buffer.sampleRate, buffer.length);
}

/**
 * Estimate the tempo of a decoded track.
 * @param {AudioBuffer} buffer
 * @returns {number|null} BPM rounded to 0.1, or null if not confident.
 */
export function detectBPM(buffer) {
  if (!buffer || !buffer.length) return null;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  return detectBPMFromChannels(ch0, ch1, buffer.sampleRate, buffer.length);
}

export function detectBeatGridFromChannels(ch0, ch1, sr, length) {
  return detectBPMFromChannels(ch0, ch1, sr, length, { detailed: true });
}

/**
 * Pure-array tempo estimator (all the logic; node-testable without Web Audio).
 * @param {Float32Array} ch0
 * @param {Float32Array} ch1  pass ch0 again for mono
 * @param {number} sr         sample rate
 * @param {number} length     samples to analyze
 * @param {{ detailed?: boolean }} [opts]
 * @returns {number|{ bpm: number, offset: number }|null}
 */
export function detectBPMFromChannels(ch0, ch1, sr, length, { detailed = false } = {}) {
  if (!ch0 || !length) return null;

  // 1) RMS envelope at ~172 Hz (hop 256 @ 44.1k) — fine enough lag resolution
  //    that quantization error stays well under ±1 BPM after refinement.
  const hop = 256;
  const n = Math.floor(length / hop);
  if (n < 128) return null; // < ~0.75 s of audio
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * hop;
    const end = Math.min(length, o + hop);
    for (let j = o; j < end; j++) {
      const v = (ch0[j] + ch1[j]) * 0.5;
      s += v * v;
    }
    env[i] = Math.sqrt(s / (end - o));
  }

  // 2) Onset strength = half-wave-rectified envelope difference, lightly
  //    smoothed so correlation peaks are wide enough for parabolic refinement.
  const raw = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const d = env[i] - env[i - 1];
    raw[i] = d > 0 ? d : 0;
  }
  const on = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) on[i] = (raw[i - 1] + raw[i] + raw[i + 1]) / 3;

  // 3) Autocorrelate a window (skip the intro, cap at 90 s) over 60–200 BPM.
  //    Score is computed out to 2× the slowest beat lag so the harmonic-support
  //    confidence test below has something to look at.
  const envRate = sr / hop;
  const start = Math.min(Math.floor(n * 0.15), Math.floor(envRate * 30));
  const len = Math.min(n - start, Math.floor(envRate * 90));
  if (len < envRate * 8) return null; // need ≥ 8 s to be meaningful
  const minLag = Math.max(2, Math.floor((envRate * 60) / 200));
  const maxLag = Math.min(Math.floor((len - 2) / 2), Math.ceil((envRate * 60) / 60));
  if (maxLag <= minLag) return null;
  const scanMax = Math.min(len - 2, maxLag * 2);

  let mean = 0;
  for (let i = start; i < start + len; i++) mean += on[i];
  mean /= len;
  let s0 = 0;
  for (let i = start; i < start + len; i++) s0 += (on[i] - mean) * (on[i] - mean);
  s0 /= len;
  if (!(s0 > 0)) return null; // silence / constant signal

  // Transient gate: a drone / pure tone has a near-flat envelope whose tiny
  // periodic ripple (block size vs. waveform period) can still autocorrelate.
  // Real rhythm has attack steps that are a large fraction of the level —
  // require the biggest onset to be ≥ 12% of the average level. (Sustained
  // beating between tones is genuine amplitude modulation and may still read
  // as a tempo; that is physically fair for an envelope-based detector.)
  let envMean = 0, onPeak = 0;
  for (let i = start; i < start + len; i++) {
    envMean += env[i];
    if (on[i] > onPeak) onPeak = on[i];
  }
  envMean /= len;
  if (!(envMean > 1e-6) || onPeak / envMean < 0.12) return null;

  const score = new Float32Array(scanMax + 1);
  let best = 0, bestLag = 0;
  for (let lag = minLag; lag <= scanMax; lag++) {
    let s = 0;
    for (let i = start; i < start + len - lag; i++) s += (on[i] - mean) * (on[i + lag] - mean);
    score[lag] = s / (len - lag);
    if (lag <= maxLag && score[lag] > best) { best = score[lag]; bestLag = lag; }
  }
  if (!bestLag || best <= 0) return null;

  const at = (l) => (l >= minLag && l <= scanMax ? score[Math.round(l)] : -1);
  const bpmOf = (l) => (60 * envRate) / l;

  // Confidence, part 1: normalized correlation at the winning lag. White noise
  // sits near 0; anything rhythmic lands well above 0.1.
  if (best / s0 < 0.1) return null;
  // Confidence, part 2: real tempos repeat — demand harmonic support at half
  // or double the period. A random noise peak has none.
  const support = Math.max(at(bestLag / 2), at(bestLag * 2));
  if (support < best * 0.3) return null;

  // 4) Octave disambiguation — prefer the 84–168 BPM window when the half /
  //    double lag scores nearly as well (classic double/half-time confusion).
  let lag = bestLag;
  const half = Math.round(bestLag / 2), dbl = bestLag * 2;
  if (bpmOf(lag) < 84 && at(half) > best * 0.5) lag = half;
  else if (bpmOf(lag) > 168 && at(dbl) > best * 0.5) lag = dbl;

  // 5) Parabolic peak refinement for sub-lag precision.
  const y0 = at(lag - 1), y1 = at(lag), y2 = at(lag + 1);
  let refined = lag;
  if (y0 > 0 && y2 > 0) {
    const denom = y0 - 2 * y1 + y2;
    if (denom !== 0) {
      const d = (y0 - y2) / (2 * denom);
      if (Math.abs(d) < 1) refined = lag + d;
    }
  }

  const bpm = (60 * envRate) / refined;
  if (!(bpm >= 50 && bpm <= 220)) return null;
  const roundedBpm = Math.round(bpm * 10) / 10;

  if (!detailed) return roundedBpm;

  // 6) Downbeat offset estimation — find which phase phi has the strongest onset sum.
  const beatPeriod = Math.max(1, Math.round(refined));
  let bestPhase = 0;
  let bestPhaseScore = -1;
  for (let phi = 0; phi < beatPeriod; phi++) {
    let sum = 0;
    for (let p = phi; p < n; p += beatPeriod) {
      sum += on[p];
    }
    if (sum > bestPhaseScore) {
      bestPhaseScore = sum;
      bestPhase = phi;
    }
  }
  const offset = Math.round(((bestPhase * hop) / sr) * 1000) / 1000;
  return { bpm: roundedBpm, offset };
}
