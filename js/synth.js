// Sxratch synthesis library — the S1 sound-fidelity engine.
//
// Everything the PAD composer plays comes through here:
//  · adsr()            exponential envelopes with true release tails past note end
//  · unison()          detuned multi-voice oscillator banks with stereo spread
//  · INSTRUMENTS       the designed patches (pads, strings, FM e-piano, drawbar
//                      organ, Karplus-Strong guitars, basses, leads)
//  · drum samples      analog-style drum voices rendered to buffers with pure
//                      JS math (deterministic, cheap to trigger, Node-testable)
//  · makeReverbIR      impulse responses with pre-delay, early reflections and
//                      a progressively damped tail (replaces raw noise bursts)
//  · makeEchoSend      tempo-synced ping-pong delay with filtered feedback
//  · makeChorus        stereo ensemble chorus insert
//  · glueCompressor    gentle 2.5:1 bus glue (replaces default-settings squash)
//  · masterFinalize    pure-JS loudness normalize + look-ahead brickwall limit
//                      applied to the rendered buffer
//
// Pure-math helpers (masterFinalize, reverbIRData, drumSampleData, biquadApply,
// mulberry32) never touch Web Audio, so they run under node:test.

import { createLimiterKernel, LIMITER_CEILING } from "./limiter-kernel.js";

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Deterministic PRNG (mulberry32) — seeded so renders are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One deterministic 0..1 value per (seed, step) — for humanized velocity. */
export function stepRand(seed, step) {
  return mulberry32((seed ^ (step * 0x9E3779B9)) >>> 0)();
}

/* ================================ envelopes ================================ */

/**
 * Exponential-feel ADSR on a GainNode.gain AudioParam.
 * Linear micro-attack (click-free), setTargetAtTime decay to sustain, and a
 * release that starts at the note end and rings PAST it — notes no longer
 * hard-stop on the grid line. Returns the safe source stop time.
 */
export function adsr(gp, at, dur, { a = 0.004, d = 0.12, s = 0.75, r = 0.25, peak = 1 } = {}) {
  const atk = Math.max(0.0015, a);
  gp.setValueAtTime(0.0001, at);
  gp.linearRampToValueAtTime(Math.max(0.0002, peak), at + atk);
  gp.setTargetAtTime(Math.max(0.0001, peak * s), at + atk, Math.max(0.01, d / 3));
  const relAt = Math.max(at + atk + 0.005, at + dur);
  gp.setTargetAtTime(0.0001, relAt, Math.max(0.008, r / 4));
  return relAt + r + 0.1;
}

/* ============================ oscillator voices ============================ */

const clampPan = (p) => Math.max(-1, Math.min(1, p));

/* ---------------------- randomised-phase wave bank ------------------------
 * OscillatorNode always starts at phase 0, and unison() only detunes, so at
 * the instant a 4-voice pad note fires all four saws are perfectly aligned:
 * measured peak 4.47 versus 1.70 for randomised phase — an 8.4 dB crest
 * penalty landing exactly on the attack, where the glue compressor and the
 * limiter grab. Musically the worse half is that every note of every pad has
 * the SAME phasey whoosh at onset, because the beating pattern between
 * detuned voices always starts from the same alignment.
 *
 * The cure is a small bank of band-limited PeriodicWaves that differ only in
 * per-harmonic phase. Magnitudes are identical, so the timbre is identical.
 */
const WAVE_BANK_SIZE = 8;
const HARMONICS = 512;
/** RMS of the native Web Audio wave of each type, at unit amplitude. */
const NATIVE_RMS = { sawtooth: 1 / Math.sqrt(3), square: 1, triangle: 1 / Math.sqrt(3), sine: 1 / Math.sqrt(2) };

/** Ideal magnitude of harmonic n for a wave type (n >= 1). */
function harmonicMag(type, n) {
  switch (type) {
    case "square": return n % 2 ? 1 / n : 0;
    case "triangle": return n % 2 ? 1 / (n * n) : 0;
    case "sine": return n === 1 ? 1 : 0;
    default: return 1 / n; // sawtooth
  }
}

/**
 * Fourier coefficients for one bank entry: ideal magnitudes, pseudo-random
 * phases, scaled so the RMS equals the native wave's. RMS is phase-invariant,
 * so ONE constant per type is exact — which is what keeps every entry the
 * same loudness. (createPeriodicWave normalises to unit PEAK by default,
 * which would boost the low-peak randomised entries; callers must pass
 * disableNormalization.)
 */
export function randomPhaseHarmonics(type, k, nHarm = HARMONICS) {
  const real = new Float32Array(nHarm + 1);
  const imag = new Float32Array(nHarm + 1);
  const rand = mulberry32(((k + 1) * 2654435761) >>> 0);
  let sumSq = 0;
  for (let n = 1; n <= nHarm; n++) {
    const mag = harmonicMag(type, n);
    if (!mag) { rand(); continue; }
    sumSq += mag * mag;
    // k === 0 is the classic zero-phase wave, so a bank always contains the
    // reference shape and A/B comparisons stay honest.
    const phi = k === 0 ? -Math.PI / 2 : rand() * Math.PI * 2;
    real[n] = mag * Math.cos(phi);
    imag[n] = mag * Math.sin(phi);
  }
  const rms = Math.sqrt(sumSq / 2);
  const scale = rms > 1e-9 ? (NATIVE_RMS[type] || NATIVE_RMS.sawtooth) / rms : 1;
  for (let n = 1; n <= nHarm; n++) { real[n] *= scale; imag[n] *= scale; }
  return { real, imag };
}

// Keyed on the AudioContext: an OfflineAudioContext is created per render, so
// a plain Map would grow without bound and rebuild the bank anyway.
const waveBanks = new WeakMap();
function periodicWaveBank(ctx, type) {
  let perCtx = waveBanks.get(ctx);
  if (!perCtx) { perCtx = new Map(); waveBanks.set(ctx, perCtx); }
  let bank = perCtx.get(type);
  if (!bank) {
    bank = [];
    for (let k = 0; k < WAVE_BANK_SIZE; k++) {
      const { real, imag } = randomPhaseHarmonics(type, k);
      bank.push(ctx.createPeriodicWave(real, imag, { disableNormalization: true }));
    }
    perCtx.set(type, bank);
  }
  return bank;
}

/** Give an oscillator a bank wave (falling back to the native type). */
function setWave(ctx, osc, type, phaseNdx) {
  if (phaseNdx == null || !ctx.createPeriodicWave) { osc.type = type; return; }
  try {
    const bank = periodicWaveBank(ctx, type);
    osc.setPeriodicWave(bank[((phaseNdx % WAVE_BANK_SIZE) + WAVE_BANK_SIZE) % WAVE_BANK_SIZE]);
  } catch {
    osc.type = type;
  }
}

/**
 * A detuned unison oscillator bank. Voices alternate across three stereo
 * buses (centre / left / right) so wide patches cost 3 panners, not N.
 * Caller normalizes level by 1/sqrt(voices) via the env peak.
 */
export function unison(ctx, dest, { f, type = "sawtooth", voices = 3, detune = 10, spread = 0.7, pan = 0, phaseNdx = null } = {}) {
  const canPan = !!ctx.createStereoPanner;
  const mkPan = (p) => { const sp = ctx.createStereoPanner(); sp.pan.value = clampPan(p); sp.connect(dest); return sp; };
  // A single centred voice connects straight through: a StereoPanner at pan 0
  // applies the equal-power law to a mono source and would cost it 3 dB.
  const solo = voices === 1 && Math.abs(pan) < 1e-6;
  const wide = voices > 1 && canPan;
  // Only build the centre bus when a voice actually sits there (odd counts).
  const centre = !canPan || solo ? dest : (voices === 1 || voices % 2 === 1 ? mkPan(pan) : null);
  const left = wide ? mkPan(pan - spread) : centre;
  const right = wide ? mkPan(pan + spread) : centre;
  const oscs = [];
  for (let i = 0; i < voices; i++) {
    const o = ctx.createOscillator();
    // Each voice takes a DIFFERENT bank entry, so the stack no longer sums
    // coherently at note-on and each note starts from a different beating
    // alignment.
    setWave(ctx, o, type, phaseNdx == null ? null : phaseNdx + i);
    o.frequency.value = f;
    // Bus by detune position so the stereo image stays balanced for any voice
    // count: k<0 → left, k>0 → right, k==0 → centre (even counts have no
    // centre voice, so they split symmetrically).
    const k = voices > 1 ? i - (voices - 1) / 2 : 0;
    if (voices > 1) o.detune.value = detune * k * (2 / Math.max(1, voices - 1));
    o.connect(k === 0 ? (centre || dest) : (k < 0 ? left : right));
    oscs.push(o);
  }
  return {
    oscs,
    start: (t) => oscs.forEach((o) => o.start(t)),
    stop: (t) => oscs.forEach((o) => { try { o.stop(t); } catch {} }),
  };
}

/** Delayed-onset vibrato on a set of oscillators' detune (depth in cents). */
function vibrato(ctx, oscs, { rate = 5.2, cents = 5, delay = 0.2, at, stop }) {
  const lfo = ctx.createOscillator();
  lfo.frequency.value = rate;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.setTargetAtTime(cents, at + delay, 0.16);
  lfo.connect(g);
  oscs.forEach((o) => g.connect(o.detune));
  lfo.start(at);
  lfo.stop(stop);
  return lfo;
}

function bq(ctx, type, f, Q = 0.7, gainDb = 0) {
  const n = ctx.createBiquadFilter();
  n.type = type;
  n.frequency.value = f;
  n.Q.value = Q;
  if (gainDb) n.gain.value = gainDb;
  return n;
}

/**
 * A seeded white-noise bed. The render used to fill this with Math.random(),
 * which quietly broke the reproducibility guarantee the rest of the engine
 * works hard for: a memoised render and a fresh one were audibly different
 * takes, and a section previewed alone did not match the same section inside
 * the exported WAV.
 */
export function noiseData(sr, seconds = 1, seed = 0x5eed) {
  const n = Math.max(1, Math.ceil(sr * seconds));
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1;
  return out;
}

/**
 * Where a transient reads from in the noise bed. Derived from note IDENTITY,
 * never from absolute render time — the old `(at * 7.13) % dur` made the same
 * note sound different depending on where in the song it happened to sit.
 * Golden-ratio increments so consecutive steps land far apart in the buffer.
 */
export function noiseSeek(ndx = 0, step = 0, dur = 1) {
  const u = ((ndx * 0.61803399) + (step * 0.38196601)) % 1;
  return u * Math.max(0.05, dur - 0.1);
}

/** Short filtered-noise burst (pick / key-click / breath chiff transients). */
function noiseBurst(ctx, dest, noise, { at, len = 0.004, peak = 0.1, hp = 0, lp = 0, decay = 0.0015, ndx = 0, step = 0 }) {
  if (!noise) return;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  let node = src;
  if (hp) { const h = bq(ctx, "highpass", hp, 0.7); node.connect(h); node = h; }
  if (lp) { const l = bq(ctx, "lowpass", lp, 0.7); node.connect(l); node = l; }
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, at);
  g.gain.setTargetAtTime(0.0001, at + 0.001, decay);
  node.connect(g).connect(dest);
  src.start(at, noiseSeek(ndx, step, noise.duration));
  src.stop(at + len + decay * 5);
}

/* ========================== Karplus-Strong strings ========================= */

/**
 * The pluck kernel — pure, so its PITCH can be measured under node:test.
 *
 * The loop length used to be `Math.round(sr / f)`, which quantises the pitch
 * to sr/N. Measured cent error at 44.1 kHz: −4.5 at MIDI 60, +5.8 at 72,
 * +23.3 at 88, −29.3 at 92 — and a DIFFERENT set of errors at 48 kHz. The
 * guitars and the upright were the only instruments in the app not tuned
 * exactly from mtof, so a guitar chord over a pad beat audibly, and because
 * the error is non-monotonic it read as bad intonation rather than a
 * consistent transpose.
 *
 * The fix is a first-order allpass interpolator on the loop, giving a
 * fractional delay. It is phase-only, so the existing 0.5*(cur+nxt) average
 * stays as the damping term and the decay character is unchanged.
 */
export function ksData(sr, f, dur, { decay = 0.996, brightness = 0.6, pickPos = 0.18, seed = 1234 } = {}) {
  const Ntot = Math.max(2, sr / f);
  // The loop delay is NOT just the ring length. The damping term averages the
  // current cell with the NEXT one — `0.5*(x[n] + x[n+1])`, a forward average
  // — so it ADVANCES the loop by half a sample rather than delaying it. Total
  // loop delay is therefore N - 0.5 + delta, and the fractional part has to
  // absorb that half sample as well as the rounding. Getting this wrong is
  // what made the old integer version run sharp, increasingly so up the neck.
  let N = Math.floor(Ntot);
  let delta = Ntot - N + 0.5;   // always in [0.5, 1.5) — safely off the pole
  N = Math.max(2, N);
  const a = (1 - delta) / (1 + delta);

  const total = Math.ceil(dur * sr);
  const out = new Float32Array(total);
  const rand = mulberry32(seed);
  const burst = new Float32Array(N);
  let lp = 0;
  const bcoef = 0.18 + 0.78 * Math.max(0, Math.min(1, brightness));
  for (let i = 0; i < N; i++) { lp += bcoef * ((rand() * 2 - 1) - lp); burst[i] = lp; }
  const pd = Math.max(1, Math.round(N * pickPos));
  const ring = new Float32Array(N);
  for (let i = 0; i < N; i++) ring[i] = burst[i] - 0.7 * burst[(i - pd + N) % N];

  // ONE pair of allpass state variables for the whole loop — they must carry
  // across the ring wrap. Per-cell state produces a plausible pluck that is
  // still detuned, which is why the cent assertion exists.
  let x1 = 0, y1 = 0;
  let idx = 0;
  for (let i = 0; i < total; i++) {
    const cur = ring[idx], nxt = ring[(idx + 1) % N];
    out[i] = cur;
    const damped = 0.5 * (cur + nxt) * decay;
    const y = a * damped + x1 - a * y1;
    x1 = damped; y1 = y;
    ring[idx] = y;
    idx = (idx + 1) % N;
  }
  return out;
}

/**
 * Karplus-Strong pluck with a brightness-shaped excitation burst and a
 * pick-position comb — richer and less "zingy" than raw white-noise KS.
 * Thin AudioBuffer wrapper around ksData().
 */
export function ksBuffer(ctx, f, dur, opts = {}) {
  const sr = ctx.sampleRate;
  const data = ksData(sr, f, dur, opts);
  const buf = ctx.createBuffer(1, data.length, sr);
  buf.getChannelData(0).set(data);
  return buf;
}

/**
 * Play a KS pluck through a guitar-ish body (low-shelf warmth + top-plate
 * peak), with a pick transient and a gated release so it never clicks off.
 */
function playKS(ctx, dest, f, at, dur, { decay = 0.996, brightness = 0.6, gain = 0.5, tone = 3800, body = true, pan = 0, noise = null, pick = 0.1, seed = 1, ndx = 0, step = 0 } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = ksBuffer(ctx, f, dur + 0.05, { decay, brightness, seed: (seed * 7919 + Math.round(f)) >>> 0 });
  let node = src;
  if (body) {
    const warm = bq(ctx, "lowshelf", 120, 0.7, 2.5);
    const plate = bq(ctx, "peaking", 210, 1.1, 3);
    node.connect(warm); warm.connect(plate); node = plate;
  }
  const damp = bq(ctx, "lowpass", tone, 0.6);
  node.connect(damp);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.setTargetAtTime(0.0001, at + Math.max(0.02, dur - 0.03), 0.035); // gate, not click
  damp.connect(g);
  let outNode = g;
  if (pan && ctx.createStereoPanner) {
    const sp = ctx.createStereoPanner();
    sp.pan.value = clampPan(pan);
    g.connect(sp);
    outNode = sp;
  }
  outNode.connect(dest);
  // Through outNode, not dest: the pick used to bypass the panner, so on a
  // spread guitar chord the string was panned but its attack sat dead centre
  // — the ear reads that as an artificial overlaid layer, not as one note.
  if (pick && noise) noiseBurst(ctx, pan && ctx.createStereoPanner ? outNode : dest, noise, { at, peak: pick * gain, hp: 2500, decay: 0.0012, ndx, step });
  src.start(at);
  src.stop(at + dur + 0.15);
}

/* ============================ instrument patches =========================== */
// Patches are DATA, not code. Each factory sound is an engine id plus a set of
// numeric parameters, and the PAD synth editor edits exactly those parameters.
// Songs persist only the values a user actually changed (sparse overrides), so
// untouched sounds keep tracking the factory design and songs saved before the
// editor existed (no overrides at all) render exactly as they always did.
//
// Engines: subtractive (osc/filter/env), fm (2-op), organ (drawbars), pluck
// (Karplus-Strong). Between them they cover all 14 factory sounds.

const vnorm = (voices) => 1 / Math.sqrt(voices);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const WAVES = ["sine", "triangle", "sawtooth", "square"];
export const FILTER_TYPES = ["lowpass", "highpass", "bandpass"];

/** One editable parameter. `unit` drives both display formatting and the control type. */
const P = (key, label, min, max, step, unit) => ({ key, label, min, max, step, unit });

const AMP_PARAMS = [
  P("attack", "Attack", 0.001, 2, 0.001, "s"),
  P("decay", "Decay", 0.01, 3, 0.01, "s"),
  P("sustain", "Sustain", 0, 1, 0.01, "pct"),
  P("release", "Release", 0.02, 3, 0.01, "s"),
  P("level", "Level", 0.005, 0.6, 0.005, "amp"),
];

const FILTER_PARAMS = [
  P("type", "Type", 0, 2, 1, "filtertype"),
  P("cutoff", "Cutoff", 60, 16000, 10, "hz"),
  P("keyTrack", "Key follow", 0, 1.5, 0.01, "x"),
  P("q", "Resonance", 0.1, 14, 0.1, "x"),
  P("envAmount", "Env amount", -6000, 6000, 25, "hz"),
  P("envTime", "Env time", 0.01, 1.5, 0.01, "s"),
  P("velToCutoff", "Vel → cutoff", 0, 6000, 25, "hz"),
  P("envVel", "Vel → env", 0, 1, 0.01, "pct"),
  P("lfoRate", "LFO rate", 0, 8, 0.01, "hz"),
  P("lfoDepth", "LFO depth", 0, 3000, 10, "hz"),
];

export const ENGINE_SCHEMA = {
  subtractive: [
    { key: "osc", label: "Oscillators", params: [
      P("wave1", "Wave 1", 0, 3, 1, "wave"),
      P("level1", "Level 1", 0, 1, 0.01, "pct"),
      P("wave2", "Wave 2", 0, 3, 1, "wave"),
      P("level2", "Level 2", 0, 1, 0.01, "pct"),
      P("detune2", "Osc 2 detune", -1200, 1200, 1, "ct"),
      P("sub", "Sub oscillator", 0, 1, 0.01, "pct"),
      P("noise", "Noise", 0, 0.3, 0.002, "pct"),
      P("drive", "Drive", 1, 4, 0.05, "x"),
    ] },
    { key: "unison", label: "Unison", params: [
      P("voices", "Voices", 1, 7, 1, "int"),
      P("detune", "Detune", 0, 40, 0.5, "ct"),
      P("spread", "Stereo spread", 0, 1, 0.01, "pct"),
    ] },
    { key: "filter", label: "Filter", params: FILTER_PARAMS },
    { key: "amp", label: "Amplitude envelope", params: AMP_PARAMS },
    { key: "vib", label: "Vibrato", params: [
      P("vibRate", "Rate", 0, 10, 0.1, "hz"),
      P("vibCents", "Depth", 0, 40, 0.5, "ct"),
      P("vibDelay", "Onset delay", 0, 1.5, 0.01, "s"),
    ] },
    { key: "transient", label: "Attack transient", params: [
      P("trLevel", "Level", 0, 0.3, 0.005, "pct"),
      P("trHp", "High-pass", 100, 8000, 50, "hz"),
      P("trDecay", "Decay", 0.0005, 0.05, 0.0005, "s"),
    ] },
    { key: "out", label: "Output", params: [P("chorus", "Chorus", 0, 1, 0.01, "pct")] },
  ],
  fm: [
    { key: "fm", label: "FM operator", params: [
      P("ratio", "Mod ratio", 0.25, 20, 0.0001, "x"),
      P("index", "Mod index", 0, 20, 0.1, "x"),
      P("indexDecay", "Index decay", 0.005, 2, 0.005, "s"),
      P("indexVel", "Vel → index", 0.2, 3, 0.05, "x"),
    ] },
    { key: "ot", label: "Overtone", params: [
      P("otRatio", "Ratio", 0.5, 12, 0.0001, "x"),
      P("otLevel", "Level", 0, 0.5, 0.005, "pct"),
      P("otDecay", "Decay", 0.01, 2, 0.01, "s"),
    ] },
    { key: "amp", label: "Amplitude envelope", params: [...AMP_PARAMS, P("velCurve", "Vel curve", 0.4, 2.5, 0.05, "x")] },
    { key: "out", label: "Output", params: [
      P("panSpread", "Pan spread", 0, 0.6, 0.01, "pct"),
      P("chorus", "Chorus", 0, 1, 0.01, "pct"),
    ] },
  ],
  organ: [
    { key: "drawbars", label: "Drawbars", params: [
      P("d1", "16′", 0, 1, 0.01, "pct"), P("d2", "5⅓′", 0, 1, 0.01, "pct"), P("d3", "8′", 0, 1, 0.01, "pct"),
      P("d4", "4′", 0, 1, 0.01, "pct"), P("d5", "2⅔′", 0, 1, 0.01, "pct"), P("d6", "2′", 0, 1, 0.01, "pct"),
      P("d7", "1⅗′", 0, 1, 0.01, "pct"), P("d8", "1⅓′", 0, 1, 0.01, "pct"), P("d9", "1′", 0, 1, 0.01, "pct"),
    ] },
    { key: "perc", label: "Percussion & click", params: [
      P("percLevel", "Percussion", 0, 0.3, 0.005, "pct"),
      P("percRatio", "Perc harmonic", 1, 8, 1, "x"),
      P("percDecay", "Perc decay", 0.01, 1, 0.01, "s"),
      P("clickLevel", "Key click", 0, 0.2, 0.005, "pct"),
      P("vibRate", "Vibrato rate", 0, 10, 0.1, "hz"),
      P("vibCents", "Vibrato depth", 0, 30, 0.5, "ct"),
    ] },
    { key: "amp", label: "Amplitude envelope", params: AMP_PARAMS },
    { key: "out", label: "Output", params: [P("chorus", "Chorus", 0, 1, 0.01, "pct")] },
  ],
  pluck: [
    { key: "string", label: "String", params: [
      P("ring", "Sustain", 0.97, 0.9995, 0.0005, "x"),
      P("brightness", "Brightness", 0, 1, 0.01, "pct"),
      P("brightVel", "Vel → brightness", 0, 1, 0.01, "pct"),
      P("tone", "Damping", 400, 8000, 50, "hz"),
      P("toneVel", "Vel → damping", 0, 4000, 50, "hz"),
      P("pick", "Pick attack", 0, 0.4, 0.01, "pct"),
      P("thump", "Body thump", 0, 0.3, 0.005, "pct"),
    ] },
    { key: "artic", label: "Articulation", params: [
      P("strum", "Strum spread", 0, 0.08, 0.002, "s"),
      P("panSpread", "Pan spread", 0, 0.6, 0.01, "pct"),
      P("durAdd", "Ring past note", 0, 2, 0.05, "s"),
      P("durMax", "Max length", 0.5, 5, 0.1, "s"),
    ] },
    { key: "out", label: "Output", params: [
      P("level", "Level", 0.02, 1.2, 0.01, "amp"),
      P("chorus", "Chorus", 0, 1, 0.01, "pct"),
    ] },
  ],
};

// Keys the editor may override, per engine (anything else stays factory-fixed).
const SCHEMA_KEYS = Object.fromEntries(
  Object.entries(ENGINE_SCHEMA).map(([eng, secs]) => [eng, new Set(secs.flatMap((s) => s.params.map((p) => p.key)))])
);
const SUB = (params) => ({ engine: "subtractive", params });
const FM = (params) => ({ engine: "fm", params });
const ORG = (params) => ({ engine: "organ", params });
const PLK = (params) => ({ engine: "pluck", params });

export const FACTORY_PATCHES = {
  chord: {
    pad: SUB({
      wave1: 2, level1: 1, wave2: 0, level2: 0, detune2: 0, sub: 0.5, noise: 0, noiseTone: 1900, drive: 1,
      voices: 4, detune: 11, spread: 0.65,
      type: 0, cutoff: 620, keyTrack: 0.5, q: 0.9, envAmount: -1500, envTime: 0.3, velToCutoff: 1500, envVel: 1,
      lfoRate: 0.13, lfoDepth: 170,
      attack: 0.05, attackKey: 0, decay: 0.4, sustain: 0.8, release: 0.55, level: 0.1,
      vibRate: 0, vibCents: 0, vibDelay: 0.2,
      trLevel: 0, trHp: 1000, trLp: 6000, trDecay: 0.0015,
      chorus: 0.4,
    }),
    strings: SUB({
      wave1: 2, level1: 1, wave2: 0, level2: 0, detune2: 0, sub: 0, noise: 0, noiseTone: 1900, drive: 1,
      voices: 5, detune: 16, spread: 0.85,
      type: 0, cutoff: 2900, keyTrack: 0.6, q: 0.6, envAmount: -700, envTime: 0.25, velToCutoff: 700, envVel: 1,
      lfoRate: 0, lfoDepth: 0,
      attack: 0.11, attackKey: 0.3, decay: 0.3, sustain: 0.85, release: 0.6, level: 0.085,
      vibRate: 5.1, vibCents: 5, vibDelay: 0.25,
      trLevel: 0, trHp: 1000, trLp: 6000, trDecay: 0.0015,
      chorus: 0.5,
    }),
    epiano: FM({
      ratio: 14, index: 6.5, indexDecay: 0.045, indexVel: 1.4,
      otRatio: 2, otLevel: 0.11, otDecay: 0.4,
      attack: 0.0025, decay: 1.6, decayAdd: 0.4, sustain: 0.22, release: 0.35, level: 0.17, velCurve: 1.2,
      panSpread: 0.13, chorus: 0.3,
    }),
    organ: ORG({
      d1: 0.65, d2: 0.28, d3: 0.9, d4: 0.45, d5: 0.2, d6: 0.14, d7: 0, d8: 0, d9: 0.16,
      percLevel: 0.06, percRatio: 3, percDecay: 0.09, clickLevel: 0.05, vibRate: 6.9, vibCents: 4,
      attack: 0.004, decay: 0.04, sustain: 1, release: 0.085, level: 0.16,
      chorus: 0.35,
    }),
    guitar: PLK({
      ring: 0.9962, brightness: 0.35, brightVel: 0.45, tone: 3400, toneVel: 1600, pick: 0.12, thump: 0,
      strum: 0.016, panSpread: 0.22, durAdd: 0.7, durMax: 2.8,
      level: 0.5, body: 1, seed: 1, chorus: 0,
    }),
    grand_piano: SUB({
      wave1: 1, level1: 0.8, wave2: 0, level2: 0.2, detune2: 7, sub: 0, noise: 0.005, noiseTone: 2200, drive: 1,
      voices: 3, detune: 5, spread: 0.4,
      type: 0, cutoff: 4500, keyTrack: 0.7, q: 0.7, envAmount: -2200, envTime: 0.15, velToCutoff: 2500, envVel: 0.8,
      lfoRate: 0, lfoDepth: 0,
      attack: 0.003, attackKey: 0.1, decay: 1.2, sustain: 0.4, release: 0.45, level: 0.18,
      vibRate: 0, vibCents: 0, vibDelay: 0,
      trLevel: 0.08, trHp: 1500, trLp: 5000, trDecay: 0.003,
      chorus: 0.15,
    }),
    clavinet: FM({
      ratio: 5, index: 9, indexDecay: 0.03, indexVel: 1.6,
      otRatio: 3, otLevel: 0.2, otDecay: 0.1,
      attack: 0.001, decay: 0.8, decayAdd: 0.1, sustain: 0.15, release: 0.1, level: 0.2, velCurve: 1.3,
      panSpread: 0.1, chorus: 0.1,
    }),
    brass_section: SUB({
      wave1: 2, level1: 1, wave2: 2, level2: 0.6, detune2: 12, sub: 0.3, noise: 0, noiseTone: 1900, drive: 1.2,
      voices: 4, detune: 14, spread: 0.7,
      type: 0, cutoff: 1800, keyTrack: 0.8, q: 1.2, envAmount: 3200, envTime: 0.12, velToCutoff: 1800, envVel: 0.6,
      lfoRate: 0, lfoDepth: 0,
      attack: 0.04, attackKey: 0, decay: 0.25, sustain: 0.75, release: 0.3, level: 0.14,
      vibRate: 4.8, vibCents: 3, vibDelay: 0.2,
      trLevel: 0.04, trHp: 800, trLp: 4000, trDecay: 0.005,
      chorus: 0.25,
    }),
    supersaw_pad: SUB({
      wave1: 2, level1: 1, wave2: 2, level2: 0.8, detune2: -15, sub: 0.4, noise: 0, noiseTone: 1900, drive: 1.1,
      voices: 7, detune: 24, spread: 0.95,
      type: 0, cutoff: 1200, keyTrack: 0.5, q: 0.8, envAmount: 1800, envTime: 0.4, velToCutoff: 1200, envVel: 0.5,
      lfoRate: 0.2, lfoDepth: 250,
      attack: 0.15, attackKey: 0, decay: 0.6, sustain: 0.9, release: 0.7, level: 0.08,
      vibRate: 0, vibCents: 0, vibDelay: 0,
      trLevel: 0, trHp: 1000, trLp: 6000, trDecay: 0.0015,
      chorus: 0.6,
    }),
    glass_keys: FM({
      ratio: 4.5, index: 4.8, indexDecay: 0.4, indexVel: 1.1,
      otRatio: 7, otLevel: 0.25, otDecay: 0.6,
      attack: 0.002, decay: 2.5, decayAdd: 0.5, sustain: 0.2, release: 0.8, level: 0.15, velCurve: 1,
      panSpread: 0.3, chorus: 0.4,
    }),
  },
  bass: {
    electric: SUB({
      wave1: 1, level1: 1, wave2: 2, level2: 0.24, detune2: 0, sub: 0, noise: 0, noiseTone: 1900, drive: 2.2,
      voices: 1, detune: 0, spread: 0,
      type: 0, cutoff: 330, keyTrack: 0, q: 1.1, envAmount: 1070, envTime: 0.09, velToCutoff: 0, envVel: 0.85,
      lfoRate: 0, lfoDepth: 0,
      attack: 0.004, attackKey: 0, decay: 0.18, sustain: 0.62, release: 0.14, level: 0.34,
      vibRate: 0, vibCents: 0, vibDelay: 0.2,
      trLevel: 0.06, trHp: 700, trLp: 3000, trDecay: 0.002,
      chorus: 0,
    }),
    synth: SUB({
      wave1: 2, level1: 1, wave2: 3, level2: 0.35, detune2: -1200, sub: 0, noise: 0, noiseTone: 1900, drive: 1.6,
      voices: 1, detune: 0, spread: 0,
      type: 0, cutoff: 255, keyTrack: 0, q: 5, envAmount: 2045, envTime: 0.13, velToCutoff: 0, envVel: 0.78,
      lfoRate: 0, lfoDepth: 0,
      attack: 0.003, attackKey: 0, decay: 0.2, sustain: 0.5, release: 0.12, level: 0.32,
      vibRate: 0, vibCents: 0, vibDelay: 0.2,
      trLevel: 0, trHp: 700, trLp: 3000, trDecay: 0.002,
      chorus: 0,
    }),
    upright: PLK({
      ring: 0.9915, brightness: 0.22, brightVel: 0.2, tone: 720, toneVel: 0, pick: 0.05, thump: 0.12,
      strum: 0, panSpread: 0, durAdd: 0, durMax: 3.5,
      level: 0.62, body: 1, seed: 3, chorus: 0,
    }),
    sub: SUB({
      wave1: 0, level1: 1, wave2: 0, level2: 0, detune2: 0, sub: 0, noise: 0, noiseTone: 1900, drive: 1.35,
      voices: 1, detune: 0, spread: 0,
      type: 0, cutoff: 8000, keyTrack: 0, q: 0.7, envAmount: 0, envTime: 0.1, velToCutoff: 0, envVel: 0,
      lfoRate: 0, lfoDepth: 0,
      attack: 0.006, attackKey: 0, decay: 0.12, sustain: 0.85, release: 0.16, level: 0.34,
      vibRate: 0, vibCents: 0, vibDelay: 0.2,
      trLevel: 0.03, trHp: 900, trLp: 2400, trDecay: 0.0015,
      chorus: 0,
    }),
    acid_tb: SUB({
      wave1: 2, level1: 1, wave2: 3, level2: 0.3, detune2: 0, sub: 0.4, noise: 0, noiseTone: 1900, drive: 2.8,
      voices: 1, detune: 0, spread: 0,
      type: 0, cutoff: 180, keyTrack: 0.4, q: 9.5, envAmount: 4200, envTime: 0.08, velToCutoff: 1200, envVel: 0.9,
      lfoRate: 0, lfoDepth: 0,
      attack: 0.002, attackKey: 0, decay: 0.15, sustain: 0.4, release: 0.1, level: 0.3,
      vibRate: 0, vibCents: 0, vibDelay: 0,
      trLevel: 0.05, trHp: 600, trLp: 2800, trDecay: 0.002,
      chorus: 0.1,
    }),
    slap_bass: FM({
      ratio: 2, index: 8.5, indexDecay: 0.04, indexVel: 1.8,
      otRatio: 5, otLevel: 0.3, otDecay: 0.08,
      attack: 0.001, decay: 0.4, decayAdd: 0.1, sustain: 0.3, release: 0.12, level: 0.28, velCurve: 1.4,
      panSpread: 0, chorus: 0.15,
    }),
    wobble_bass: SUB({
      wave1: 2, level1: 1, wave2: 3, level2: 0.5, detune2: 0, sub: 0.6, noise: 0, noiseTone: 1900, drive: 2.4,
      voices: 1, detune: 0, spread: 0,
      type: 0, cutoff: 400, keyTrack: 0, q: 6.5, envAmount: 0, envTime: 0.1, velToCutoff: 0, envVel: 0,
      lfoRate: 4, lfoDepth: 1800,
      attack: 0.005, attackKey: 0, decay: 0.3, sustain: 0.7, release: 0.15, level: 0.3,
      vibRate: 0, vibCents: 0, vibDelay: 0,
      trLevel: 0.04, trHp: 500, trLp: 2000, trDecay: 0.003,
      chorus: 0,
    }),
    fm_lately: FM({
      ratio: 1, index: 7.2, indexDecay: 0.07, indexVel: 1.3,
      otRatio: 3, otLevel: 0.15, otDecay: 0.15,
      attack: 0.002, decay: 0.6, decayAdd: 0.1, sustain: 0.45, release: 0.15, level: 0.26, velCurve: 1.2,
      panSpread: 0, chorus: 0.1,
    }),
  },
  lead: {
    synth: SUB({
      wave1: 2, level1: 1, wave2: 0, level2: 0, detune2: 0, sub: 0, noise: 0, noiseTone: 1900, drive: 1,
      voices: 3, detune: 9, spread: 0.5,
      type: 0, cutoff: 2300, keyTrack: 0.8, q: 1.4, envAmount: -2800, envTime: 0.06, velToCutoff: 1600, envVel: 0.57,
      lfoRate: 0, lfoDepth: 0,
      attack: 0.006, attackKey: 0, decay: 0.15, sustain: 0.72, release: 0.18, level: 0.15,
      vibRate: 5.4, vibCents: 7, vibDelay: 0.18,
      trLevel: 0, trHp: 1000, trLp: 6000, trDecay: 0.0015,
      chorus: 0.22,
    }),
    square: SUB({
      wave1: 3, level1: 1, wave2: 0, level2: 0, detune2: 0, sub: 0, noise: 0, noiseTone: 1900, drive: 1,
      voices: 2, detune: 7, spread: 0.4,
      type: 0, cutoff: 3600, keyTrack: 0, q: 0.8, envAmount: 0, envTime: 0.1, velToCutoff: 0, envVel: 0,
      lfoRate: 0, lfoDepth: 0,
      attack: 0.004, attackKey: 0, decay: 0.1, sustain: 0.8, release: 0.12, level: 0.13,
      vibRate: 5.8, vibCents: 4, vibDelay: 0.22,
      trLevel: 0, trHp: 1000, trLp: 6000, trDecay: 0.0015,
      chorus: 0,
    }),
    flute: SUB({
      wave1: 0, level1: 1, wave2: 1, level2: 0.3, detune2: 0, sub: 0, noise: 0.028, noiseTone: 1900, drive: 1,
      voices: 1, detune: 0, spread: 0,
      type: 0, cutoff: 8000, keyTrack: 0, q: 0.7, envAmount: 0, envTime: 0.1, velToCutoff: 0, envVel: 0,
      lfoRate: 0, lfoDepth: 0,
      attack: 0.055, attackKey: 0, decay: 0.1, sustain: 0.88, release: 0.2, level: 0.13,
      vibRate: 5.3, vibCents: 8, vibDelay: 0.3,
      trLevel: 0.05, trHp: 2800, trLp: 0, trDecay: 0.012,
      chorus: 0,
    }),
    bell: FM({
      ratio: 3.5307, index: 3.4, indexDecay: 0.35, indexVel: 1,
      otRatio: 2.76, otLevel: 0.05, otDecay: 0.5,
      attack: 0.002, decay: 2.2, decayAdd: 0.8, sustain: 0.12, release: 1.1, level: 0.15, velCurve: 1,
      panSpread: 0, chorus: 0.2,
    }),
    guitar: PLK({
      ring: 0.9935, brightness: 0.45, brightVel: 0.4, tone: 4200, toneVel: 0, pick: 0.14, thump: 0,
      strum: 0, panSpread: 0, durAdd: 0.4, durMax: 3.6,
      level: 0.42, body: 1, seed: 5, chorus: 0,
    }),
    supersaw_lead: SUB({
      wave1: 2, level1: 1, wave2: 2, level2: 0.8, detune2: 12, sub: 0.2, noise: 0, noiseTone: 1900, drive: 1.2,
      voices: 7, detune: 22, spread: 0.8,
      type: 0, cutoff: 5200, keyTrack: 0.7, q: 1.2, envAmount: 2400, envTime: 0.1, velToCutoff: 1800, envVel: 0.6,
      lfoRate: 0, lfoDepth: 0,
      attack: 0.008, attackKey: 0, decay: 0.3, sustain: 0.8, release: 0.25, level: 0.11,
      vibRate: 5.5, vibCents: 6, vibDelay: 0.2,
      trLevel: 0, trHp: 1000, trLp: 6000, trDecay: 0.0015,
      chorus: 0.35,
    }),
    soft_lead: SUB({
      wave1: 1, level1: 1, wave2: 0, level2: 0.4, detune2: 0, sub: 0.2, noise: 0, noiseTone: 1900, drive: 1,
      voices: 2, detune: 6, spread: 0.3,
      type: 0, cutoff: 1600, keyTrack: 0.9, q: 0.8, envAmount: 800, envTime: 0.15, velToCutoff: 1200, envVel: 0.5,
      lfoRate: 0, lfoDepth: 0,
      attack: 0.02, attackKey: 0, decay: 0.2, sustain: 0.85, release: 0.3, level: 0.16,
      vibRate: 4.8, vibCents: 9, vibDelay: 0.15,
      trLevel: 0, trHp: 1000, trLp: 6000, trDecay: 0.0015,
      chorus: 0.2,
    }),
    brass_lead: SUB({
      wave1: 2, level1: 1, wave2: 3, level2: 0.4, detune2: 7, sub: 0.3, noise: 0, noiseTone: 1900, drive: 1.3,
      voices: 3, detune: 10, spread: 0.5,
      type: 0, cutoff: 2400, keyTrack: 0.8, q: 2.2, envAmount: 3800, envTime: 0.08, velToCutoff: 1500, envVel: 0.7,
      lfoRate: 0, lfoDepth: 0,
      attack: 0.015, attackKey: 0, decay: 0.2, sustain: 0.75, release: 0.2, level: 0.14,
      vibRate: 5.2, vibCents: 5, vibDelay: 0.2,
      trLevel: 0.04, trHp: 1200, trLp: 5000, trDecay: 0.003,
      chorus: 0.15,
    }),
    whistle: SUB({
      wave1: 0, level1: 1, wave2: 0, level2: 0, detune2: 0, sub: 0, noise: 0.015, noiseTone: 3000, drive: 1,
      voices: 1, detune: 0, spread: 0,
      type: 0, cutoff: 7000, keyTrack: 1, q: 0.6, envAmount: 0, envTime: 0.1, velToCutoff: 0, envVel: 0,
      lfoRate: 0, lfoDepth: 0,
      attack: 0.025, attackKey: 0, decay: 0.1, sustain: 0.9, release: 0.15, level: 0.18,
      vibRate: 5.8, vibCents: 12, vibDelay: 0.1,
      trLevel: 0, trHp: 1000, trLp: 6000, trDecay: 0.0015,
      chorus: 0.1,
    }),
  },
  chorus: {
    choir_vox: SUB({
      wave1: 1, level1: 1, wave2: 2, level2: 0.5, detune2: 9, sub: 0.3, noise: 0.015, noiseTone: 2400, drive: 1,
      voices: 5, detune: 18, spread: 0.8,
      type: 0, cutoff: 1400, keyTrack: 0.6, q: 1.8, envAmount: 1200, envTime: 0.3, velToCutoff: 1000, envVel: 0.5,
      lfoRate: 0.15, lfoDepth: 180,
      attack: 0.12, attackKey: 0, decay: 0.4, sustain: 0.85, release: 0.6, level: 0.1,
      vibRate: 5.0, vibCents: 7, vibDelay: 0.25,
      trLevel: 0, trHp: 1000, trLp: 6000, trDecay: 0.0015,
      chorus: 0.55,
    }),
    warm_chorus: SUB({
      wave1: 3, level1: 1, wave2: 0, level2: 0, detune2: 0, sub: 0.5, noise: 0, noiseTone: 1900, drive: 1,
      voices: 4, detune: 14, spread: 0.75,
      type: 0, cutoff: 900, keyTrack: 0.5, q: 0.7, envAmount: 900, envTime: 0.3, velToCutoff: 800, envVel: 0.4,
      lfoRate: 0.2, lfoDepth: 200,
      attack: 0.08, attackKey: 0, decay: 0.5, sustain: 0.85, release: 0.5, level: 0.11,
      vibRate: 0, vibCents: 0, vibDelay: 0,
      trLevel: 0, trHp: 1000, trLp: 6000, trDecay: 0.0015,
      chorus: 0.65,
    }),
    ambient_space: SUB({
      wave1: 0, level1: 1, wave2: 1, level2: 0.7, detune2: 15, sub: 0.4, noise: 0.01, noiseTone: 1500, drive: 1,
      voices: 4, detune: 20, spread: 0.9,
      type: 0, cutoff: 800, keyTrack: 0.4, q: 0.8, envAmount: 1500, envTime: 0.8, velToCutoff: 600, envVel: 0.3,
      lfoRate: 0.1, lfoDepth: 300,
      attack: 0.3, attackKey: 0, decay: 0.8, sustain: 0.9, release: 1.2, level: 0.09,
      vibRate: 4.2, vibCents: 5, vibDelay: 0.4,
      trLevel: 0, trHp: 1000, trLp: 6000, trDecay: 0.0015,
      chorus: 0.7,
    }),
    celestial: FM({
      ratio: 5.5, index: 4.2, indexDecay: 0.5, indexVel: 1,
      otRatio: 8, otLevel: 0.3, otDecay: 0.8,
      attack: 0.05, decay: 2.0, decayAdd: 0.5, sustain: 0.4, release: 1.0, level: 0.14, velCurve: 1,
      panSpread: 0.4, chorus: 0.5,
    }),
    lush_strings: SUB({
      wave1: 2, level1: 1, wave2: 2, level2: 0.7, detune2: -10, sub: 0.2, noise: 0, noiseTone: 1900, drive: 1,
      voices: 6, detune: 18, spread: 0.85,
      type: 0, cutoff: 2200, keyTrack: 0.7, q: 0.6, envAmount: 1000, envTime: 0.4, velToCutoff: 1000, envVel: 0.5,
      lfoRate: 0.18, lfoDepth: 150,
      attack: 0.14, attackKey: 0.2, decay: 0.5, sustain: 0.85, release: 0.75, level: 0.085,
      vibRate: 5.2, vibCents: 8, vibDelay: 0.3,
      trLevel: 0, trHp: 1000, trLp: 6000, trDecay: 0.0015,
      chorus: 0.5,
    }),
  },
};

/**
 * Merge a factory patch with a song's sparse overrides and clamp every value
 * to its schema range. Unknown keys, non-numbers and NaN are ignored, so a
 * corrupted or hand-edited song JSON can never produce a broken voice.
 */
export function resolvePatch(family, sound, overrides) {
  const fam = FACTORY_PATCHES[family] || FACTORY_PATCHES.chord;
  const fac = fam[sound] || fam[Object.keys(fam)[0]];
  const params = { ...fac.params };
  const allowed = SCHEMA_KEYS[fac.engine];
  if (overrides && allowed) {
    for (const k of Object.keys(overrides)) {
      const v = overrides[k];
      if (allowed.has(k) && typeof v === "number" && Number.isFinite(v)) params[k] = v;
    }
  }
  for (const sec of ENGINE_SCHEMA[fac.engine] || []) {
    for (const pr of sec.params) {
      const v = params[pr.key];
      params[pr.key] = pr.unit === "wave" || pr.unit === "filtertype" || pr.unit === "int"
        ? clamp(Math.round(v), pr.min, pr.max)
        : clamp(v, pr.min, pr.max);
    }
  }
  return { engine: fac.engine, params };
}

/** The default (unedited) value of one parameter — used by the editor's reset. */
export function factoryValue(family, sound, key) {
  const fam = FACTORY_PATCHES[family] || {};
  const fac = fam[sound];
  return fac ? fac.params[key] : undefined;
}

function renderSubtractive(ctx, dest, midi, at, dur, vel, p, o = {}) {
  const f = mtof(midi);
  const voices = Math.max(1, Math.round(p.voices));

  const settled = clamp(p.cutoff + p.keyTrack * f + p.velToCutoff * vel, 30, 20000);
  const start = clamp(settled + p.envAmount * (1 - p.envVel + p.envVel * vel), 30, 20000);
  const filt = bq(ctx, FILTER_TYPES[p.type] || "lowpass", start, Math.max(0.05, p.q));
  if (Math.abs(settled - start) > 1) filt.frequency.setTargetAtTime(settled, at + 0.02, Math.max(0.01, p.envTime));

  const atk = p.attackKey > 0
    ? clamp(p.attack * Math.pow(220 / f, p.attackKey), p.attack * 0.55, p.attack * 1.55)
    : p.attack;
  const env = ctx.createGain();
  const stop = adsr(env.gain, at, dur, {
    a: atk, d: p.decay, s: p.sustain, r: p.release,
    peak: Math.max(0.0005, p.level * vel * vnorm(voices)),
  });

  let node = filt;
  if (p.drive > 1.01) { const ws = ctx.createWaveShaper(); ws.curve = driveCurve(p.drive); node.connect(ws); node = ws; }
  node.connect(env).connect(dest);

  const ndx = o.ndx || 0, step = o.step || 0;
  const phaseNdx = (step * 7 + ndx * 3 + midi) | 0;

  const oscs = [];
  if (p.level1 > 0.001) {
    const g1 = ctx.createGain(); g1.gain.value = p.level1; g1.connect(filt);
    const u = unison(ctx, g1, { f, type: WAVES[p.wave1], voices, detune: p.detune, spread: p.spread, phaseNdx });
    u.start(at); u.stop(stop);
    oscs.push(...u.oscs);
  }
  if (p.level2 > 0.001) {
    const o2 = ctx.createOscillator();
    setWave(ctx, o2, WAVES[p.wave2], phaseNdx + 5);
    o2.frequency.value = f; o2.detune.value = p.detune2;
    const g2 = ctx.createGain(); g2.gain.value = p.level2;
    o2.connect(g2).connect(filt);
    o2.start(at); o2.stop(stop);
    oscs.push(o2);
  }
  if (p.sub > 0.001) {
    const sb = ctx.createOscillator(); setWave(ctx, sb, "sine", phaseNdx + 3); sb.frequency.value = f / 2;
    const sg = ctx.createGain(); sg.gain.value = p.sub;
    sb.connect(sg).connect(filt);
    sb.start(at); sb.stop(stop);
  }
  if (p.noise > 0.0005 && o.noise) {
    const ns = ctx.createBufferSource(); ns.buffer = o.noise; ns.loop = true;
    const bp = bq(ctx, "bandpass", clamp(p.noiseTone || 1900, 100, 12000), 0.8);
    const ng = ctx.createGain();
    adsr(ng.gain, at, dur, { a: atk, d: p.decay, s: p.sustain, r: Math.min(p.release, 0.4), peak: p.noise * vel });
    ns.connect(bp).connect(ng).connect(dest);
    ns.start(at, noiseSeek(ndx, step, Math.min(0.6, o.noise.duration)));
    ns.stop(stop);
  }
  if (p.vibCents > 0.1 && p.vibRate > 0.01 && oscs.length) {
    vibrato(ctx, oscs, { rate: p.vibRate, cents: p.vibCents, delay: p.vibDelay, at, stop });
  }
  if (p.lfoDepth > 0.5 && p.lfoRate > 0.001) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = p.lfoRate + (midi % 5) * 0.011;
    const lg = ctx.createGain(); lg.gain.value = p.lfoDepth;
    lfo.connect(lg).connect(filt.frequency);
    lfo.start(at); lfo.stop(stop);
  }
  if (p.trLevel > 0.0005) {
    noiseBurst(ctx, dest, o.noise, { at, peak: p.trLevel * vel, hp: p.trHp, lp: p.trLp || 0, decay: p.trDecay, ndx, step });
  }
  return { env, stop, ctx };
}

function renderFM(ctx, dest, midi, at, dur, vel, p, o = {}) {
  const f = mtof(midi);
  const car = ctx.createOscillator(); car.type = "sine"; car.frequency.value = f;
  const mod = ctx.createOscillator(); mod.type = "sine"; mod.frequency.value = f * p.ratio;
  const mg = ctx.createGain();
  mg.gain.setValueAtTime(f * p.index * Math.pow(vel, p.indexVel), at);
  mg.gain.setTargetAtTime(0.0001, at + 0.001, Math.max(0.005, p.indexDecay));
  mod.connect(mg).connect(car.frequency);

  const env = ctx.createGain();
  const stop = adsr(env.gain, at, dur, {
    a: p.attack, d: Math.min(p.decay, dur + (p.decayAdd || 0)), s: p.sustain, r: p.release,
    peak: Math.max(0.0005, p.level * Math.pow(vel, p.velCurve)),
  });
  car.connect(env);

  if (p.otLevel > 0.001) {
    const ov = ctx.createOscillator(); ov.type = "sine"; ov.frequency.value = f * p.otRatio;
    const og = ctx.createGain();
    og.gain.setValueAtTime(p.otLevel * vel, at);
    og.gain.setTargetAtTime(0.0001, at + 0.01, Math.max(0.01, p.otDecay));
    ov.connect(og).connect(env);
    ov.start(at); ov.stop(stop);
  }
  if (p.panSpread > 0.001 && ctx.createStereoPanner) {
    const pan = ctx.createStereoPanner();
    pan.pan.value = clampPan(((o.ndx || 0) % 2 ? -1 : 1) * p.panSpread);
    env.connect(pan).connect(dest);
  } else env.connect(dest);

  car.start(at); car.stop(stop);
  mod.start(at); mod.stop(stop);
  return { env, stop, ctx };
}

const ORGAN_RATIOS = [0.5, 1.5, 1, 2, 3, 4, 5, 6, 8];

function renderOrgan(ctx, dest, midi, at, dur, vel, p, o = {}) {
  const f = mtof(midi);
  const levels = [p.d1, p.d2, p.d3, p.d4, p.d5, p.d6, p.d7, p.d8, p.d9];
  const total = levels.reduce((a, b) => a + b, 0) || 1;
  const env = ctx.createGain();
  const stop = adsr(env.gain, at, dur, {
    a: p.attack, d: p.decay, s: p.sustain, r: p.release, peak: Math.max(0.0005, p.level * vel),
  });
  const oscs = [];
  ORGAN_RATIOS.forEach((r, i) => {
    if (levels[i] <= 0.01) return;
    const osc = ctx.createOscillator(); osc.type = "sine"; osc.frequency.value = f * r;
    const g = ctx.createGain(); g.gain.value = levels[i] / total;
    osc.connect(g).connect(env);
    osc.start(at); osc.stop(stop);
    oscs.push(osc);
  });
  if (p.vibCents > 0.1 && p.vibRate > 0.01 && oscs.length) {
    vibrato(ctx, oscs, { rate: p.vibRate, cents: p.vibCents, delay: 0.03, at, stop });
  }
  env.connect(dest);
  if (p.percLevel > 0.0005) {
    const perc = ctx.createOscillator(); perc.type = "sine"; perc.frequency.value = f * p.percRatio;
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(p.percLevel * vel, at);
    pg.gain.setTargetAtTime(0.0001, at + 0.002, Math.max(0.01, p.percDecay));
    perc.connect(pg).connect(dest);
    perc.start(at); perc.stop(at + 0.5);
  }
  if (p.clickLevel > 0.0005) {
    noiseBurst(ctx, dest, o.noise, { at, peak: p.clickLevel * vel, hp: 1800, decay: 0.0011, ndx: o.ndx || 0, step: o.step || 0 });
  }
  return { env, stop, ctx };
}

function renderPluck(ctx, dest, midi, at, dur, vel, p, o = {}) {
  const f = mtof(midi);
  const ndx = o.ndx || 0;
  playKS(ctx, dest, f, at + ndx * p.strum, Math.min(dur + p.durAdd, p.durMax), {
    decay: p.ring,
    brightness: clamp(p.brightness + p.brightVel * vel, 0, 1),
    gain: p.level * vel,
    tone: p.tone + p.toneVel * vel,
    body: (p.body ?? 1) > 0.5,
    pan: p.panSpread ? (ndx % 2 ? -1 : 1) * p.panSpread : 0,
    noise: o.noise,
    pick: p.pick,
    seed: midi * (p.seed || 1),
    ndx, step: o.step || 0,
  });
  if (p.thump > 0.0005) {
    const th = ctx.createOscillator(); th.type = "sine"; th.frequency.value = Math.max(45, f * 0.5);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(p.thump * vel, at);
    tg.gain.setTargetAtTime(0.0001, at + 0.002, 0.03);
    th.connect(tg).connect(dest);
    th.start(at); th.stop(at + 0.2);
  }
  return { env: null, stop: at + dur, ctx };
}

const ENGINE_RENDER = { subtractive: renderSubtractive, fm: renderFM, organ: renderOrgan, pluck: renderPluck };

export function playInstrument(family, sound, ctx, dest, midi, at, dur, vel = 1, o = {}) {
  const patch = o.patch && o.patch.params ? o.patch : resolvePatch(family, sound);
  const render = ENGINE_RENDER[patch.engine] || renderSubtractive;
  const handle = render(ctx, dest, midi, at, Math.max(0.03, dur), clamp(vel, 0.05, 1.25), patch.params, o);
  return { ...(handle || {}), patch };
}

/* ============================== wave shaping =============================== */

const driveCurves = new Map();
/** Cached tanh drive curve, normalized so full-scale stays full-scale. */
export function driveCurve(amount = 2) {
  const key = Math.round(amount * 100);
  let c = driveCurves.get(key);
  if (!c) {
    const n = 2048;
    c = new Float32Array(n);
    const norm = Math.tanh(amount);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * amount) / norm;
    }
    driveCurves.set(key, c);
  }
  return c;
}

/* ============================= drum synthesis ============================== */
/* Drum hits are synthesized ONCE per (kit, key, sample-rate) into an
 * AudioBuffer with pure JS math — deterministic, testable, and each hit is a
 * single BufferSource + gain instead of a pile of oscillator/filter nodes.  */

/** In-place RBJ biquad (lowpass | highpass | bandpass) over a Float32Array. */
export function biquadApply(x, sr, type, f0, Q = 0.707) {
  const w = 2 * Math.PI * Math.min(f0, sr * 0.49) / sr;
  const cw = Math.cos(w), sw = Math.sin(w), alpha = sw / (2 * Q);
  let b0, b1, b2;
  if (type === "lowpass") { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
  else if (type === "highpass") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
  else { b0 = alpha; b1 = 0; b2 = -alpha; } // bandpass
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  const c0 = b0 / a0, c1 = b1 / a0, c2 = b2 / a0, d1 = a1 / a0, d2 = a2 / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = c0 * x[i] + c1 * x1 + c2 * x2 - d1 * y1 - d2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

function normalizeTo(x, peak) {
  let m = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
  if (m > 1e-9) { const g = peak / m; for (let i = 0; i < x.length; i++) x[i] *= g; }
  return x;
}

/** Per-piece body loudness targets, in dBFS RMS over the first 200 ms. */
const DRUM_RMS_TARGET = { kick: -7, snare: -13, hat: -25, open: -23, crash: -20, tom: -11 };

/**
 * Match a drum hit by LOUDNESS, with peak as a ceiling rather than the target.
 *
 * Peak normalisation sounds like it equalises level but does not: crest factor
 * varies enormously between voices and kits, so a near-square bitcrushed lofi
 * kick and a tiny bossa cross-stick at the same peak are nowhere near the same
 * loudness. Measured spread across kits at equal peak: 8 dB on the kick, 11 dB
 * on the snare — so changing kit silently rebalanced the whole arrangement,
 * and (because each round-robin take is a different noise realisation) even
 * two takes of the same hat differed by up to 33%.
 *
 * Body first, transient second: scale to hit the RMS target, then pull back
 * only if the peak would exceed the ceiling.
 */
function normalizeLoudness(x, sr, key, peakCeiling) {
  const win = Math.min(x.length, Math.floor(sr * 0.2));
  let sum = 0;
  for (let i = 0; i < win; i++) sum += x[i] * x[i];
  const rms = Math.sqrt(sum / Math.max(1, win));
  if (rms < 1e-9) return x;
  const target = Math.pow(10, (DRUM_RMS_TARGET[key] ?? -12) / 20);
  let g = target / rms;
  // The ceiling is a clipping guard, not a design value. A high-crest hit
  // (a bitcrushed lofi hat, a hard-driven 808 snare) cannot reach its body
  // target under the patch's own decorative peak, and pulling it back is what
  // left two takes of the same hat 33% apart. 0.9 is still safely inside the
  // drum bus, which is limited downstream.
  const ceil = Math.max(peakCeiling, 0.9);
  let m = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]) * g; if (a > m) m = a; }
  if (m > ceil) g *= ceil / m;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

function applyDrive(x, amount) {
  const norm = Math.tanh(amount);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * amount) / norm;
}

function bitcrush(x, bits) {
  const L = Math.pow(2, bits - 1);
  for (let i = 0; i < x.length; i++) x[i] = Math.round(x[i] * L) / L;
}

function fadeIn(x, sr, ms = 1.2) {
  const n = Math.min(x.length, Math.max(2, Math.round(sr * ms / 1000)));
  for (let i = 0; i < n; i++) x[i] *= i / n;
}

function synthKick(sr, p, rand, key = 'kick') {
  const n = Math.ceil((p.dec * 2.2 + 0.1) * sr);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = p.f1 + (p.f0 - p.f1) * Math.exp(-t / p.pt);
    phase += (2 * Math.PI * f) / sr;
    out[i] = Math.sin(phase) * Math.exp(-t / p.dec);
  }
  if (p.click) { // beater / click transient
    const cn = Math.floor(0.005 * sr);
    for (let i = 0; i < cn && i < n; i++) out[i] += (rand() * 2 - 1) * Math.exp(-i / (0.0011 * sr)) * p.click;
  }
  if (p.drive) applyDrive(out, p.drive);
  if (p.lp) biquadApply(out, sr, "lowpass", p.lp, 0.7);
  if (p.bits) bitcrush(out, p.bits);
  fadeIn(out, sr);
  return normalizeLoudness(out, sr, key, p.peak);
}

function synthSnare(sr, p, rand, key = 'snare') {
  const n = Math.ceil((Math.max((p.ndec || 0.12) * 3, 0.25) + 0.06) * sr);
  const out = new Float32Array(n);
  if (p.rim) { // bossa cross-stick: woody ping + a whisper of wires
    let ph1 = 0, ph2 = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      ph1 += (2 * Math.PI * 1750) / sr; ph2 += (2 * Math.PI * 420) / sr;
      out[i] = Math.sin(ph1) * Math.exp(-t / 0.009) * 0.8 + Math.sin(ph2) * Math.exp(-t / 0.05) * 0.55;
    }
    const wires = new Float32Array(n);
    for (let i = 0; i < n; i++) wires[i] = (rand() * 2 - 1) * Math.exp(-(i / sr) / 0.025);
    biquadApply(wires, sr, "highpass", 2600, 0.8);
    for (let i = 0; i < n; i++) out[i] += wires[i] * 0.4;
    fadeIn(out, sr, 0.6);
    return normalizeLoudness(out, sr, key, p.peak);
  }
  // shell: two detuned partials with a fast pitch settle
  let ph1 = 0, ph2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const bend = 1 + 0.06 * Math.exp(-t / 0.03);
    ph1 += (2 * Math.PI * p.tone * bend) / sr;
    ph2 += (2 * Math.PI * p.tone * 1.78 * bend) / sr;
    out[i] = (Math.sin(ph1) * 0.6 + Math.sin(ph2) * 0.35) * Math.exp(-t / 0.055) * p.toneAmt;
  }
  // wires: snappy dual-stage noise
  const noiz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    noiz[i] = (rand() * 2 - 1) * (Math.exp(-t / 0.012) * 0.7 + Math.exp(-t / p.ndec) * 0.55);
  }
  biquadApply(noiz, sr, "bandpass", 1800, 0.6);
  biquadApply(noiz, sr, "highpass", p.hp, 0.75);
  for (let i = 0; i < n; i++) out[i] += noiz[i] * p.noiseAmt * 2.2;
  applyDrive(out, 1.35);
  if (p.lp) biquadApply(out, sr, "lowpass", p.lp, 0.7);
  if (p.bits) bitcrush(out, p.bits);
  fadeIn(out, sr, 0.6);
  return normalizeLoudness(out, sr, key, p.peak);
}

/**
 * One band-limited square sample from a phase accumulator.
 *
 * The metallic hat/cymbal clusters used to be ideal squares
 * (`phase < 0.5 ? 1 : -1`), whose infinite harmonics fold back hard at the
 * ratios used. The dense inharmonic result happens to sound metallic, which
 * is presumably why it survived, but it made the kit SAMPLE-RATE DEPENDENT:
 * the 808 crash's spectral centroid measured 13.1 kHz at 44.1 kHz, 14.0 kHz
 * at 48 kHz (+7.5%) and 26.1 kHz at 96 kHz (+99.9%). Most desktops run the
 * AudioContext at 48 kHz while the tests and many phones run 44.1 kHz — so
 * the drums a developer verified were not the drums a user heard.
 *
 * polyBLEP subtracts the band-limited step residual around each edge, which
 * removes the fold-back while leaving the ratios (and therefore the
 * character) alone.
 */
/**
 * A fixed upper band edge, independent of the device sample rate.
 *
 * polyBLEP fixes the *aliasing* half of the sample-rate dependence, but the
 * hats and crash also mix in raw white noise, whose bandwidth is whatever
 * Nyquist happens to be — so at 88.2 kHz the cymbals gained a whole extra
 * octave of hiss and their spectral centroid moved 42%. Capping at 19 kHz
 * (just under Nyquist at 44.1 kHz, so the common case is barely touched)
 * makes the kit sound the same on every device, and drops ultrasonic energy
 * that only ever ate headroom.
 */
function airCeiling(x, sr) {
  const fc = Math.min(19000, sr * 0.45);
  if (fc < sr * 0.5) biquadApply(x, sr, "lowpass", fc, 0.7);
}

/**
 * White noise has flat spectral DENSITY, so at a higher sample rate the same
 * per-sample amplitude spreads the same power over a wider band and therefore
 * puts LESS of it in the audible range. Left alone, the noise/partial balance
 * of the cymbals — and hence their timbre — drifts with the device's sample
 * rate. Scaling by sqrt(sr / 44100) holds the in-band density constant.
 */
const noiseGainFor = (sr) => Math.sqrt(sr / 44100);

function blepSquare(phase, inc) {
  let v = phase < 0.5 ? 1 : -1;
  const poly = (t) => t - t * t / 2 - 0.5;
  // rising edge at phase 0
  if (phase < inc) v -= 2 * poly(phase / inc);
  else if (phase > 1 - inc) v -= 2 * (-poly((phase - 1) / inc));
  // falling edge at phase 0.5
  const d = phase - 0.5;
  if (d >= 0 && d < inc) v += 2 * poly(d / inc);
  else if (d < 0 && d > -inc) v += 2 * (-poly(d / inc));
  return v;
}

const HAT_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21]; // classic 808 metallic cluster

function synthHat(sr, p, open, rand, key = 'hat') {
  const len = open ? 0.55 : 0.11;
  const n = Math.ceil(len * sr);
  const out = new Float32Array(n);
  const ng = noiseGainFor(sr);
  const incs = HAT_RATIOS.map((r) => (p.base * r) / sr);
  const phases = HAT_RATIOS.map((_, i) => (i * 0.37) % 1);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < incs.length; k++) {
      phases[k] += incs[k]; if (phases[k] >= 1) phases[k] -= 1;
      v += blepSquare(phases[k], incs[k]);
    }
    if (p.noiseMix) v = v * (1 - p.noiseMix) + (rand() * 2 - 1) * 6 * p.noiseMix * ng;
    out[i] = v / 6;
  }
  biquadApply(out, sr, "bandpass", p.bp, 1.1);
  biquadApply(out, sr, "highpass", p.hp, 0.8);
  const t1 = open ? 0.11 : 0.02, t2 = open ? 0.3 : 0.05;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] *= Math.exp(-t / t1) * 0.85 + Math.exp(-t / t2) * 0.25;
  }
  if (p.lp) biquadApply(out, sr, "lowpass", p.lp, 0.7);
  if (p.bits) bitcrush(out, p.bits);
  airCeiling(out, sr);   // after the crusher: its quantisation noise is broadband too
  fadeIn(out, sr, 0.5);
  return normalizeLoudness(out, sr, open ? 'open' : 'hat', open ? p.peakOpen : p.peak);
}

const CRASH_RATIOS = [2, 2.89, 3.41, 4.16, 5.43, 6.79, 8.21, 9.7];

function synthCrash(sr, p, rand, key = 'crash') {
  const n = Math.ceil((p.len + 0.2) * sr);
  const out = new Float32Array(n);
  const ng = noiseGainFor(sr);
  const incs = CRASH_RATIOS.map((r) => (p.base * r) / sr);
  const phases = CRASH_RATIOS.map((_, i) => (i * 0.61) % 1);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < incs.length; k++) {
      phases[k] += incs[k]; if (phases[k] >= 1) phases[k] -= 1;
      v += blepSquare(phases[k], incs[k]);
    }
    out[i] = (v / 8) * 0.55 + (rand() * 2 - 1) * 0.45 * ng;
  }
  biquadApply(out, sr, "highpass", p.hp, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] *= Math.exp(-t / (p.len * 0.3)) * 0.5 + Math.exp(-t / p.len) * 0.55;
  }
  if (p.lp) biquadApply(out, sr, "lowpass", p.lp, 0.7);
  airCeiling(out, sr);
  fadeIn(out, sr, 0.6);
  return normalizeLoudness(out, sr, key, p.peak);
}

function synthTom(sr, p, base, rand, key = 'tom') {
  const n = Math.ceil((p.dec * 2.4 + 0.08) * sr);
  const out = new Float32Array(n);
  let phase = 0, ph2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = base + base * 0.35 * Math.exp(-t / 0.08);
    phase += (2 * Math.PI * f) / sr;
    ph2 += (2 * Math.PI * f * 1.5) / sr;
    out[i] = (Math.sin(phase) + Math.sin(ph2) * 0.28) * Math.exp(-t / p.dec);
  }
  const skin = new Float32Array(Math.min(n, Math.ceil(0.02 * sr)));
  for (let i = 0; i < skin.length; i++) skin[i] = (rand() * 2 - 1) * Math.exp(-(i / sr) / 0.006);
  biquadApply(skin, sr, "bandpass", base * 3.2, 1);
  for (let i = 0; i < skin.length; i++) out[i] += skin[i] * 0.4;
  applyDrive(out, 1.25);
  if (p.lp) biquadApply(out, sr, "lowpass", p.lp, 0.7);
  fadeIn(out, sr);
  return normalizeLoudness(out, sr, key, p.peak);
}

const DRUM_PARAMS = {
  acoustic: {
    kick: { f0: 165, f1: 54, pt: 0.035, dec: 0.17, click: 0.5, drive: 1.5, peak: 0.85 },
    snare: { tone: 196, hp: 1000, ndec: 0.14, toneAmt: 0.7, noiseAmt: 1, peak: 0.78 },
    hat: { base: 40, bp: 10000, hp: 7200, noiseMix: 0.3, peak: 0.42, peakOpen: 0.4 },
    crash: { base: 62, hp: 4200, len: 1.5, peak: 0.5 },
    tom: { dec: 0.3, peak: 0.66 },
  },
  "808": {
    kick: { f0: 120, f1: 41, pt: 0.05, dec: 0.55, click: 0.16, drive: 2.4, peak: 0.9 },
    snare: { tone: 180, hp: 1600, ndec: 0.1, toneAmt: 0.5, noiseAmt: 1, peak: 0.74 },
    hat: { base: 40, bp: 10500, hp: 8200, noiseMix: 0, peak: 0.38, peakOpen: 0.36 },
    crash: { base: 58, hp: 5200, len: 1.9, peak: 0.46 },
    tom: { dec: 0.48, peak: 0.68 },
  },
  electronic: {
    kick: { f0: 210, f1: 48, pt: 0.02, dec: 0.15, click: 0.8, drive: 1.9, peak: 0.9 },
    snare: { tone: 220, hp: 1400, ndec: 0.19, toneAmt: 0.62, noiseAmt: 1.05, peak: 0.8 },
    hat: { base: 44, bp: 9800, hp: 7800, noiseMix: 0.15, peak: 0.42, peakOpen: 0.4 },
    crash: { base: 66, hp: 4600, len: 1.35, peak: 0.5 },
    tom: { dec: 0.24, peak: 0.66 },
  },
  bossa: {
    kick: { f0: 110, f1: 48, pt: 0.03, dec: 0.13, click: 0.1, drive: 1.2, peak: 0.6 },
    snare: { rim: true, peak: 0.55 },
    hat: { base: 38, bp: 8200, hp: 5600, noiseMix: 0.45, peak: 0.3, peakOpen: 0.3 },
    crash: { base: 55, hp: 3800, len: 1.05, peak: 0.36 },
    tom: { dec: 0.26, peak: 0.5 },
  },
  lofi: {
    kick: { f0: 130, f1: 44, pt: 0.04, dec: 0.2, click: 0.3, drive: 2.8, lp: 1500, bits: 10, peak: 0.82 },
    snare: { tone: 175, hp: 900, ndec: 0.13, toneAmt: 0.7, noiseAmt: 0.9, lp: 3800, bits: 9, peak: 0.7 },
    hat: { base: 40, bp: 8600, hp: 6100, noiseMix: 0.25, lp: 7600, bits: 9, peak: 0.34, peakOpen: 0.32 },
    crash: { base: 60, hp: 4000, len: 1.2, lp: 6800, peak: 0.4 },
    tom: { dec: 0.26, lp: 3200, peak: 0.58 },
  },
};

const TOM_FREQS = { tomH: 240, tomM: 170, tomL: 115 };

/** How many round-robin variants each piece is worth synthesising. */
export const DRUM_VARIANTS = { kick: 4, snare: 4, hat: 4, open: 2, crash: 1, tomH: 2, tomM: 2, tomL: 2 };

/**
 * Small deterministic perturbations that make variant N a different TAKE of
 * the same drum rather than a different drum: ±2% tuning, ±6% decay, ±8% on
 * the click/noise levels. Tight enough that the kit still sounds like itself.
 */
function varyParams(p, variant, rand) {
  if (!variant) return p;
  const jit = (amt) => 1 + (rand() * 2 - 1) * amt;
  const q = { ...p };
  for (const k of ["f0", "f1", "tone"]) if (typeof q[k] === "number") q[k] *= jit(0.02);
  // `base` is the metallic cluster's root, and the cluster sits under a fixed
  // bandpass — detuning it changes how much of the cluster survives the
  // filter, so a 2% move became an 18% level swing between takes. 1% still
  // decorrelates the partials without moving the level.
  if (typeof q.base === "number") q.base *= jit(0.01);
  for (const k of ["dec", "ndec"]) if (typeof q[k] === "number") q[k] *= jit(0.03);
  for (const k of ["click", "noiseAmt"]) if (typeof q[k] === "number") q[k] *= jit(0.05);
  // NOT noiseMix: it sets the tone/noise balance, and because each hit is
  // peak-normalised afterwards, moving it changes the crest factor and hence
  // the perceived loudness (measured 26% between takes) — a different drum,
  // not a different take.
  return q;
}

/**
 * Pure sample math for one drum hit — Node-testable, deterministic.
 *
 * `variant` selects a round-robin take. Without it every kick in a
 * three-minute song was the same waveform sample-for-sample, which the ear
 * detects far more readily than level uniformity — the loudest remaining
 * "this is a drum machine" cue.
 */
export function drumSampleData(sr, kit, key, variant = 0) {
  const kp = DRUM_PARAMS[kit] || DRUM_PARAMS.acoustic;
  const base = (kit + "|" + key).split("").reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381);
  const seed = variant ? (base ^ (variant * 0x9e3779b9)) >>> 0 : base;
  const rand = mulberry32(seed);
  // The perturbation PRNG is drawn from the same stream, so a variant is
  // reproducible from (kit, key, variant) alone.
  const v = (p) => varyParams(p, variant, rand);
  if (key === "kick") return synthKick(sr, v(kp.kick), rand, "kick");
  if (key === "snare") return synthSnare(sr, v(kp.snare), rand, "snare");
  if (key === "hat") return synthHat(sr, v(kp.hat), false, rand);
  if (key === "open") return synthHat(sr, v(kp.hat), true, rand);
  if (key === "crash") return synthCrash(sr, v(kp.crash), rand, "crash");
  return synthTom(sr, v(kp.tom), TOM_FREQS[key] || 170, rand, "tom");
}

const drumBufferCache = new Map(); // `${sr}|${kit}|${key}|${variant}` -> AudioBuffer

/** Cached AudioBuffer for a drum hit (AudioBuffers are context-independent). */
export function getDrumBuffer(ctx, kit, key, variant = 0) {
  const sr = ctx.sampleRate;
  const n = DRUM_VARIANTS[key] || 1;
  const v = ((variant % n) + n) % n;
  const ck = sr + "|" + kit + "|" + key + "|" + v;
  let buf = drumBufferCache.get(ck);
  if (!buf) {
    // Lazily — a fully exercised kit is ~20 buffers, and most songs touch a
    // handful of pieces.
    const data = drumSampleData(sr, kit, key, v);
    buf = ctx.createBuffer(1, data.length, sr);
    buf.getChannelData(0).set(data);
    drumBufferCache.set(ck, buf);
  }
  return buf;
}

/**
 * Trigger one drum hit: a BufferSource + velocity gain.
 * Returns the gain node so the caller can choke it (see chokeSchedule).
 */
export function playDrumHit(ctx, dest, kit, key, at, vel = 1, variant = 0) {
  const buf = getDrumBuffer(ctx, kit, key, variant);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = Math.max(0.02, vel);
  src.connect(g).connect(dest);
  src.start(at);
  src.stop(at + buf.duration + 0.02);
  return { gain: g, src, until: at + buf.duration };
}

/**
 * A real hi-hat cannot ring open while the pedal is closed. The sequencer
 * fired the two rows independently, so a closed hat landing under a ringing
 * open hat left BOTH sounding — physically impossible and an immediate
 * giveaway. For each open hat this returns the time it should be cut off
 * (the next closed hat), or null if nothing follows it.
 */
export function chokeSchedule(openTimes, closedTimes) {
  const closed = [...closedTimes].sort((a, b) => a - b);
  return openTimes.map((t) => {
    for (const c of closed) if (c > t + 1e-4) return c;
    return null;
  });
}


/**
 * A kick-triggered ducking envelope, as a plain sample array.
 *
 * Nothing in the render interacts dynamically: pads, bass and the sampler all
 * play straight through whatever the kick is doing, which is why the mix reads
 * as a stack of stems rather than a record. Web Audio's DynamicsCompressor has
 * no sidechain input, but this is an OFFLINE render — every kick time is known
 * before a single note is scheduled, so the duck can simply be drawn.
 *
 * Shape: an immediate dip at each kick, then an exponential recovery. Returned
 * as data so its shape is testable without Web Audio; the render feeds it to a
 * GainNode via setValueCurveAtTime.
 *
 * depth 0 returns exactly ones, which is the back-compatibility guarantee —
 * an untouched song renders bit-identically.
 */
export function duckEnvelope(kickTimes, seconds, sr, { depth = 0.3, attack = 0.008, release = 0.13 } = {}) {
  const n = Math.max(1, Math.ceil(seconds * sr));
  const out = new Float32Array(n);
  out.fill(1);
  if (!(depth > 0) || !kickTimes || !kickTimes.length) return out;
  const d = Math.max(0, Math.min(0.95, depth));
  const atk = Math.max(1, Math.round(attack * sr));
  const rel = Math.max(1e-4, release);
  const times = [...kickTimes].sort((a, b) => a - b);
  for (const t of times) {
    const i0 = Math.round(t * sr);
    if (i0 >= n) continue;
    // Dip in over the attack, from wherever the curve currently sits, so
    // kicks close together do not step back up between them.
    const start = i0 < 0 ? 1 : out[Math.max(0, i0)];
    const floor = 1 - d;
    for (let i = 0; i < atk; i++) {
      const k = i0 + i;
      if (k < 0 || k >= n) continue;
      const v = start + (floor - start) * (i / atk);
      if (v < out[k]) out[k] = v;
    }
    // Exponential recovery toward unity.
    const from = Math.max(0, i0 + atk);
    for (let k = from; k < n; k++) {
      const v = 1 - d * Math.exp(-((k - from) / sr) / rel);
      if (v >= 0.9995) { if (out[k] > v) break; }
      if (v < out[k]) out[k] = v; else break;
    }
  }
  return out;
}

/* ================================= FX ===================================== */

/**
 * Reverb impulse data: pre-delay silence, sparse alternating early
 * reflections, then a noise tail whose high end dies faster than its low end
 * (progressive one-pole damping) — the "room" the old white-noise burst lacked.
 */
export function reverbIRData(sr, { seconds = 1.8, decay = 3.0, predelay = 0.018, damp = 0.5, er = 0.6, seed = 20260718 } = {}) {
  const rand = mulberry32(seed);
  const pre = Math.floor(predelay * sr);
  const len = Math.max(pre + 8, Math.floor(sr * (seconds + predelay)));
  const chans = [new Float32Array(len), new Float32Array(len)];
  const taps = [0.011, 0.017, 0.023, 0.031, 0.041, 0.053, 0.067, 0.079];
  taps.forEach((tsec, i) => {
    const idx = pre + Math.floor(tsec * sr);
    if (idx >= len) return;
    const g = er * Math.pow(0.76, i) * (i % 2 ? -0.6 : 0.6);
    chans[i % 2][idx] += g;
    const bleed = idx + Math.floor(0.0013 * sr);
    if (bleed < len) chans[(i + 1) % 2][bleed] += g * 0.5;
  });
  for (let c = 0; c < 2; c++) {
    let lp = 0;
    const tail = len - pre;
    for (let i = pre; i < len; i++) {
      const p = (i - pre) / tail;
      const alpha = Math.max(0.02, 0.55 * (1 - damp * p)); // darker as it decays
      lp += alpha * ((rand() * 2 - 1) - lp);
      chans[c][i] += lp * Math.pow(1 - p, decay) * 0.7;
    }
  }
  return chans;
}

const irCache = new Map();
const IR_CACHE_MAX = 16;
const q = (v, step) => Math.round((v || 0) / step) * step; // quantize for the cache key

/**
 * Cached stereo reverb IR as an AudioBuffer. The reverb amount comes from a
 * continuous 0.01-step slider, so the cache key is quantized (audibly
 * identical IRs collapse to one entry) and LRU-capped — otherwise sweeping a
 * reverb slider across renders would retain ~1 MB per distinct value forever.
 */
export function makeReverbIR(ctx, opts = {}) {
  const sr = ctx.sampleRate;
  const o = {
    seconds: q(opts.seconds ?? 1.8, 0.15),
    decay: q(opts.decay ?? 3.0, 0.2),
    predelay: q(opts.predelay ?? 0.018, 0.005),
    damp: q(opts.damp ?? 0.5, 0.1),
    er: q(opts.er ?? 0.6, 0.1),
    seed: opts.seed ?? 20260718,
  };
  const key = sr + "|" + o.seconds + "|" + o.decay + "|" + o.predelay + "|" + o.damp + "|" + o.er + "|" + o.seed;
  let buf = irCache.get(key);
  if (buf) { irCache.delete(key); irCache.set(key, buf); return buf; } // refresh LRU
  const [l, rt] = reverbIRData(sr, o);
  buf = ctx.createBuffer(2, l.length, sr);
  buf.getChannelData(0).set(l);
  buf.getChannelData(1).set(rt);
  irCache.set(key, buf);
  while (irCache.size > IR_CACHE_MAX) irCache.delete(irCache.keys().next().value);
  return buf;
}

/** Wet-only convolution reverb send. */
export function makeReverbSend(ctx, opts = {}) {
  const input = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.buffer = makeReverbIR(ctx, opts);
  const out = ctx.createGain();
  input.connect(conv);
  conv.connect(out);
  return { in: input, out };
}

/**
 * Wet-only echo send: ping-pong across the stereo field with low/high-pass
 * filtering in the loop so repeats darken like an analog delay.
 */
export function makeEchoSend(ctx, { time = 0.375, fb = 0.35, tone = 2600, hp = 160, pingpong = true } = {}) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const hpF = bq(ctx, "highpass", hp, 0.7);
  input.connect(hpF);
  const clampT = Math.max(0.02, Math.min(2.4, time));
  const fbAmt = Math.min(0.72, Math.max(0, fb));
  if (pingpong && ctx.createStereoPanner) {
    const dL = ctx.createDelay(2.5), dR = ctx.createDelay(2.5);
    dL.delayTime.value = clampT; dR.delayTime.value = clampT;
    const pL = ctx.createStereoPanner(); pL.pan.value = -0.65;
    const pR = ctx.createStereoPanner(); pR.pan.value = 0.65;
    const lp1 = bq(ctx, "lowpass", tone, 0.6), lp2 = bq(ctx, "lowpass", tone, 0.6);
    const g1 = ctx.createGain(), g2 = ctx.createGain();
    g1.gain.value = fbAmt; g2.gain.value = fbAmt;
    hpF.connect(dL);
    dL.connect(pL).connect(out);
    dR.connect(pR).connect(out);
    dL.connect(lp1).connect(g1).connect(dR);
    dR.connect(lp2).connect(g2).connect(dL);
    return { in: input, out, delays: [dL, dR], fbGains: [g1, g2], tone: [lp1, lp2] };
  }
  const d = ctx.createDelay(2.5);
  d.delayTime.value = clampT;
  const lp = bq(ctx, "lowpass", tone, 0.6);
  const g = ctx.createGain(); g.gain.value = fbAmt;
  hpF.connect(d);
  d.connect(out);
  d.connect(lp).connect(g).connect(d);
  return { in: input, out, delays: [d], fbGains: [g], tone: [lp] };
}

/** Stereo ensemble chorus insert (in → out carries dry + modulated wet). */
export function makeChorus(ctx, { mix = 0.4, rate = 0.55, depth = 0.0038, base = 0.017 } = {}) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const dry = ctx.createGain();
  dry.gain.value = 1 - mix * 0.4;
  input.connect(dry).connect(out);
  const wet = ctx.createGain();
  wet.gain.value = mix * 0.75;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = rate;
  [[-0.6, 1], [0.6, -1]].forEach(([pan, sign]) => {
    const d = ctx.createDelay(0.08);
    d.delayTime.value = base;
    const dg = ctx.createGain();
    dg.gain.value = depth * sign;
    lfo.connect(dg).connect(d.delayTime);
    input.connect(d);
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      d.connect(p).connect(wet);
    } else d.connect(wet);
  });
  wet.connect(out);
  lfo.start();
  return { in: input, out, lfo };
}

/* =============================== mastering ================================ */

/** Gentle 2.5:1 bus glue — replaces the default DynamicsCompressor squash. */
export function glueCompressor(ctx) {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = -12;
  c.knee.value = 8;
  c.ratio.value = 2.5;
  c.attack.value = 0.012;
  c.release.value = 0.2;
  return c;
}

/**
 * Post-render mastering on raw channel data (pure JS, in place):
 *  1. loudness-normalize toward targetRms (measured over the loudest half of
 *     50 ms windows so silence and intros don't skew it),
 *  2. look-ahead brickwall limit + hard ceiling clamp via the SHARED kernel
 *     in js/limiter-kernel.js — literally the same code as the live master
 *     limiter worklet, so offline renders and live output limit identically.
 * Returns { gain, rms } for diagnostics.
 */
export function masterFinalize(channels, sr, {
  targetRms = 0.14, ceiling = LIMITER_CEILING, lookaheadMs = 3, releaseMs = 120,
  maxBoost = 3, maxCut = 0.3,
} = {}) {
  if (!channels.length || !channels[0].length) return { gain: 1, rms: 0 };
  const n = channels[0].length;
  // Loudness measure: 50 ms windows, gated at ≈ −50 dBFS so empty bars in a
  // sparse arrangement don't dilute the estimate (and section previews match
  // the same material inside a full-song render), then mean of the loudest
  // half. maxBoost stays modest so near-silent content is lifted, not slammed.
  const win = Math.max(1, Math.floor(sr * 0.05));
  const rmsList = [];
  for (let start = 0; start + win <= n; start += win) {
    let acc = 0;
    for (const ch of channels) for (let i = start; i < start + win; i++) acc += ch[i] * ch[i];
    const w = Math.sqrt(acc / (win * channels.length));
    if (w > 0.003) rmsList.push(w);
  }
  rmsList.sort((a, b) => b - a);
  const top = rmsList.slice(0, Math.max(1, Math.ceil(rmsList.length / 2)));
  const rms = top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0;
  let gain = rms > 1e-6 ? targetRms / rms : 1;
  gain = Math.min(maxBoost, Math.max(maxCut, gain));

  if (gain !== 1) {
    for (const ch of channels) for (let i = 0; i < n; i++) ch[i] *= gain;
  }
  const kernel = createLimiterKernel(sr, { lookaheadMs, releaseMs });
  kernel.process(channels, channels, 0, n, ceiling);
  return { gain, rms };
}
