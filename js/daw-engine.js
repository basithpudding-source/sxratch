// PAD Studio DAW engine — realtime multitrack playback, recording and bounce.
//
// The old song builder rendered every play offline and then played one buffer.
// A DAW cannot do that: recording an overdub means the other tracks must sound
// LIVE while the input is captured. So this engine schedules the same synth.js
// voices (playInstrument / playDrumHit) into the live AudioContext with a
// classic look-ahead scheduler, and reuses the identical scheduling path with
// an OfflineAudioContext for bounces (WAV export / send-to-deck).
//
// Timebase: BEATS, where one beat is one quarter note. secPerBeat = 60/bpm.
// A region is { start, len } in beats; MIDI notes are { b, d, m, v } (beat
// offset, duration-in-beats, midi, velocity); drum hits are { b, k, v }.
//
// Ownership: the UI (daw.js) owns the song object and mutates it freely; this
// engine keeps only a REFERENCE and re-reads it on every scheduler tick, so
// edits during playback are heard on the next pass without any resync step.

import {
  playInstrument, playDrumHit, resolvePatch, noiseData,
  makeReverbSend, makeEchoSend, glueCompressor, masterFinalize,
} from "./synth.js";
import {
  automationValueAt,
  audioRegionSlice,
  fillAutomationCurve,
  loopRecordingPosition,
  partitionLoopRecording,
  wrapBeat,
} from "./daw-model.js";

export const RENDER_LEAD_SEC = 0.03;  // silence prepended to offline bounces

const LOOKAHEAD_MS = 30;      // scheduler tick
const HORIZON_SEC = 0.18;     // how far ahead events are committed to WebAudio
const STOP_RAMP = 0.04;       // fade applied to a session bus on stop
const AUTOMATION_CURVE_SAMPLES = 24;
const OFFLINE_AUTOMATION_WINDOW_BEATS = 4;
const REVERB_SEND_SCALE = 0.4;
const DELAY_SEND_SCALE = 0.5;

export const DRUM_KEYS = ["crash", "hat", "open", "snare", "tomH", "tomM", "tomL", "kick"];

function automationPoints(track, key) {
  const lane = track?.automation?.[key];
  if (Array.isArray(lane)) return lane;
  if (lane && lane.enabled !== false && Array.isArray(lane.points)) return lane.points;
  return [];
}

/**
 * Schedule one piecewise-linear automation lane over a scheduler window.
 * Exported as a pure AudioParam-shaped seam for node tests.
 */
export function scheduleAutomationParam(
  param,
  points,
  fallback,
  fromBeat,
  toBeat,
  timeAt,
  { scale = 1, curve = null } = {},
) {
  if (!param || !Array.isArray(points) || !points.length || typeof timeAt !== "function") return false;
  const start = Number(timeAt(fromBeat));
  const end = Number(timeAt(toBeat));
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return false;
  const samples = curve instanceof Float32Array && curve.length >= 2
    ? curve
    : new Float32Array(AUTOMATION_CURVE_SAMPLES);
  fillAutomationCurve(samples, points, fromBeat, toBeat, fallback, scale);
  try {
    if (typeof param.setValueCurveAtTime === "function") {
      param.setValueCurveAtTime(samples, start, end - start);
    } else {
      param.setValueAtTime?.(samples[0], start);
      param.linearRampToValueAtTime?.(samples[samples.length - 1], end);
    }
    return true;
  } catch {
    // Usually FP jitter at a window seam: our start lands a hair inside the
    // previous curve's tail. Cancel from our start and retry once; a truly
    // malformed lane still falls through without taking down the scheduler.
    try {
      param.cancelScheduledValues?.(start);
      param.setValueCurveAtTime(samples, start, end - start);
      return true;
    } catch {
      try { param.setValueAtTime?.(samples[0], start); } catch {}
      return false;
    }
  }
}

export function createDawEngine({ getCtx, getOutput, getSong, getClip, onPlayhead, onRecordFail }) {
  let ctx = null;
  let master = null, glue = null, meterTap = null;
  let liveMix = null;
  let clickBus = null;        // metronome/count-in output, post-master
  let noise = null;           // shared noise buffer for the synth voices
  let buses = new Map();      // trackId -> live bus (see buildTrackChain)
  let sessions = new Map();   // trackId -> per-play gain the voices feed
  let audioSrcs = [];         // live BufferSources (for stop cleanup)

  // Transport state.
  let playing = false;
  let timer = null;
  let t0 = 0;                 // ctx.currentTime when play started
  let beat0 = 0;              // playhead beat at t0
  let scheduledTo = 0;        // absolute TIMELINE beat already committed
  let metronomeOn = false;

  // Recording state.
  let rec = null;             // { kind:'audio'|'midi', trackId, startBeat, ... }
  let recPending = null;      // { cancelled, voices } while a count-in runs

  const song = () => getSong();
  const secPerBeat = () => 60 / (song().bpm || 120);
  const beatsToSec = (b) => b * secPerBeat();

  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
  };

  function masterSettings(sg) {
    const m = sg?.master || {};
    const eq = m.eq || {};
    return {
      gain: clamp(m.gain, 0, 1.4, 0.9),
      eq: {
        on: eq.on !== false,
        low: clamp(eq.low, -18, 18, 0),
        mid: clamp(eq.mid, -18, 18, 0),
        high: clamp(eq.high, -18, 18, 0),
      },
    };
  }

  function busSettings(sg) {
    const tracks = sg?.tracks || [];
    const legacyReverb = tracks.find((t) => t.fx?.reverb && t.fx.reverb.on !== false && (+t.fx.reverb.mix || 0) > 0)?.fx.reverb
      || tracks.find((t) => t.fx?.reverb)?.fx.reverb
      || {};
    const legacyDelay = tracks.find((t) => t.fx?.delay && t.fx.delay.on !== false && (+t.fx.delay.mix || 0) > 0)?.fx.delay
      || tracks.find((t) => t.fx?.delay)?.fx.delay
      || {};
    const rv = sg?.buses?.reverb || legacyReverb;
    const del = sg?.buses?.delay || legacyDelay;
    return {
      reverb: {
        on: rv.on !== false,
        size: clamp(rv.size, 0, 1, 0.4),
        damp: clamp(rv.damp, 0, 1, 0.5),
        return: clamp(rv.return, 0, 1.4, 1),
      },
      delay: {
        on: del.on !== false,
        time: clamp(del.time, 0.0625, 4, 0.25),
        feedback: clamp(del.feedback, 0, 0.72, 0.3),
        tone: clamp(del.tone, 400, 12000, 2600),
        return: clamp(del.return, 0, 1.4, 1),
      },
    };
  }

  function trackSendSettings(track) {
    const sends = track?.sends || {};
    const legacyRv = track?.fx?.reverb || {};
    const legacyDel = track?.fx?.delay || {};
    return {
      reverb: clamp(
        sends.reverb,
        0,
        1,
        legacyRv.on === false ? 0 : clamp(legacyRv.mix, 0, 1, 0),
      ),
      delay: clamp(
        sends.delay,
        0,
        1,
        legacyDel.on === false ? 0 : clamp(legacyDel.mix, 0, 1, 0),
      ),
    };
  }

  function offlineTailSeconds(sg) {
    const settings = busSettings(sg);
    const reverbTail = settings.reverb.on
      ? 0.9 + settings.reverb.size * 2.4
      : 0;
    let delayTail = 0;
    if (settings.delay.on) {
      const delayTime = Math.max(
        0.02,
        Math.min(2.4, settings.delay.time * (60 / (sg?.bpm || 120))),
      );
      // Include repeats down to -60 dB. The schema caps feedback below one,
      // so this always converges; 60 s also bounds pathological imports.
      const feedback = settings.delay.feedback;
      const repeats = feedback > 0.001
        ? 1 + Math.ceil(Math.log(0.001) / Math.log(feedback))
        : 1;
      delayTail = delayTime * repeats;
    }
    return Math.max(2, Math.min(60, Math.max(reverbTail, delayTail)));
  }

  function nextOfflineAutomationBoundary(sg, fromBeat, limitBeat) {
    let boundary = limitBeat;
    for (const track of sg?.tracks || []) {
      for (const key of ["gain", "pan", "reverb", "delay"]) {
        for (const point of automationPoints(track, key)) {
          const beat = Number(point?.b);
          if (Number.isFinite(beat) && beat > fromBeat + 1e-8 && beat < boundary - 1e-8) {
            boundary = beat;
          }
        }
      }
    }
    return boundary;
  }

  const reverbSignature = (rv) => `${rv.size.toFixed(4)}:${rv.damp.toFixed(4)}`;

  function attachReverbProcessor(c, bus, settings) {
    const verb = makeReverbSend(c, {
      seconds: 0.8 + settings.size * 2.4,
      decay: 2.2 + (1 - settings.damp) * 1.6,
      predelay: 0.016,
      damp: settings.damp,
    });
    bus.input.connect(verb.in);
    verb.out.connect(bus.returnGain);
    bus.processor = verb;
    bus.signature = reverbSignature(settings);
  }

  function buildMixGraph(c, destination, sg, { meters = true } = {}) {
    const input = c.createGain();
    const low = c.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 120;
    const mid = c.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 0.8;
    const high = c.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 8000;
    const busGlue = glueCompressor(c);
    const fader = c.createGain();
    const meter = meters ? c.createAnalyser() : null;
    if (meter) meter.fftSize = 1024;
    input.connect(low); low.connect(mid); mid.connect(high); high.connect(busGlue); busGlue.connect(fader);
    if (meter) { fader.connect(meter); meter.connect(destination); }
    else fader.connect(destination);

    const settings = busSettings(sg);
    const reverb = {
      input: c.createGain(),
      returnGain: c.createGain(),
      processor: null,
      signature: "",
    };
    reverb.returnGain.connect(input);
    attachReverbProcessor(c, reverb, settings.reverb);

    const echo = makeEchoSend(c, {
      time: settings.delay.time * (60 / (sg?.bpm || 120)),
      fb: settings.delay.feedback,
      tone: settings.delay.tone,
      hp: 160,
      pingpong: true,
    });
    const delay = {
      input: echo.in,
      returnGain: c.createGain(),
      processor: echo,
    };
    echo.out.connect(delay.returnGain);
    delay.returnGain.connect(input);

    const graph = {
      context: c,
      input, low, mid, high, glue: busGlue, fader, meter,
      sends: { reverb, delay },
    };
    applyMasterParams(graph, sg);
    applyBusParams(graph, sg);
    return graph;
  }

  function applyMasterParams(graph, sg) {
    if (!graph) return;
    const settings = masterSettings(sg);
    graph.low.gain.value = settings.eq.on ? settings.eq.low : 0;
    graph.mid.gain.value = settings.eq.on ? settings.eq.mid : 0;
    graph.high.gain.value = settings.eq.on ? settings.eq.high : 0;
    graph.fader.gain.value = settings.gain;
  }

  function replaceReverbProcessor(graph, sg) {
    if (!graph?.sends?.reverb) return;
    const settings = busSettings(sg).reverb;
    const bus = graph.sends.reverb;
    try { bus.input.disconnect(); } catch {}
    try { bus.processor?.out?.disconnect(); } catch {}
    attachReverbProcessor(graph.context, bus, settings);
  }

  function applyBusParams(graph, sg, { rebuildReverb = false } = {}) {
    if (!graph?.sends) return;
    const settings = busSettings(sg);
    const rv = graph.sends.reverb;
    if (rebuildReverb && rv.signature !== reverbSignature(settings.reverb)) {
      replaceReverbProcessor(graph, sg);
    }
    rv.returnGain.gain.value = settings.reverb.on ? settings.reverb.return : 0;

    const delay = graph.sends.delay;
    const seconds = Math.max(0.02, Math.min(2.4, settings.delay.time * (60 / (sg?.bpm || 120))));
    for (const node of delay.processor.delays || []) node.delayTime.value = seconds;
    for (const node of delay.processor.fbGains || []) node.gain.value = settings.delay.feedback;
    for (const node of delay.processor.tone || []) node.frequency.value = settings.delay.tone;
    delay.returnGain.gain.value = settings.delay.on ? settings.delay.return : 0;
  }

  function ensureCtx() {
    if (ctx) return ctx;
    ctx = getCtx();
    const destination = getOutput?.() || ctx.destination;
    liveMix = buildMixGraph(ctx, destination, song(), { meters: true });
    master = liveMix.input;
    glue = liveMix.glue;
    meterTap = liveMix.meter;
    // Metronome/count-in clicks go straight to the output: they are a timing
    // reference, not program material for the master EQ/glue/fader to shape.
    clickBus = ctx.createGain();
    clickBus.connect(destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    noise.getChannelData(0).set(noiseData(ctx.sampleRate, 1));
    return ctx;
  }

  function makeDistortionCurve(drive = 0.2) {
    const k = Math.max(0, Math.min(0.99, Number(drive) || 0)) * 50;
    const n = 44100;
    const curve = new Float32Array(n);
    const deg = Math.PI / 180;
    for (let i = 0; i < n; ++i) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  /* ---------------- per-track chain ----------------
   * input → Distortion → HPF → peaking → LPF → Compressor → panner →
   * fader → mute → master, with post-fader taps feeding the one shared
   * reverb and one shared delay bus.
   */
  function buildTrackChain(c, track, mixGraph, sharedNoise, { forceAudible = false, meters = true } = {}) {
    const input = c.createGain();

    const distDry = c.createGain();
    const distWet = c.createGain();
    const shaper = c.createWaveShaper ? c.createWaveShaper() : null;
    if (shaper) {
      input.connect(distDry);
      input.connect(shaper);
      shaper.connect(distWet);
    }

    const hpf = c.createBiquadFilter(); hpf.type = "highpass";
    const peak = c.createBiquadFilter(); peak.type = "peaking";
    const lpf = c.createBiquadFilter(); lpf.type = "lowpass";

    if (shaper) {
      distDry.connect(hpf);
      distWet.connect(hpf);
    } else {
      input.connect(hpf);
    }
    hpf.connect(peak); peak.connect(lpf);

    const comp = c.createDynamicsCompressor ? c.createDynamicsCompressor() : null;
    if (comp) {
      lpf.connect(comp);
    }

    const postComp = comp || lpf;
    const pan = c.createStereoPanner ? c.createStereoPanner() : null;
    const fader = c.createGain();
    const muteGain = c.createGain();
    const meter = meters ? c.createAnalyser() : null;
    if (meter) meter.fftSize = 1024;
    if (pan) { postComp.connect(pan); pan.connect(fader); }
    else postComp.connect(fader);
    fader.connect(muteGain);
    if (meter) { muteGain.connect(meter); meter.connect(mixGraph.input); }
    else muteGain.connect(mixGraph.input);

    const reverbSend = c.createGain();
    const delaySend = c.createGain();
    muteGain.connect(reverbSend); reverbSend.connect(mixGraph.sends.reverb.input);
    muteGain.connect(delaySend); delaySend.connect(mixGraph.sends.delay.input);

    const chain = {
      input, distDry, distWet, shaper, hpf, peak, lpf,
      comp, pan, fader, gain: fader, muteGain, meter,
      reverbSend, delaySend, noise: sharedNoise,
      meterState: { rms: 0, peak: 0 },
      meterBuffer: meter ? new Float32Array(meter.fftSize) : null,
      automationCurves: {
        gain: new Float32Array(AUTOMATION_CURVE_SAMPLES),
        pan: new Float32Array(AUTOMATION_CURVE_SAMPLES),
        reverb: new Float32Array(AUTOMATION_CURVE_SAMPLES),
        delay: new Float32Array(AUTOMATION_CURVE_SAMPLES),
      },
    };
    applyTrackParams(chain, track, songSoloActive(), forceAudible);
    return chain;
  }

  function songSoloActive() {
    return (song().tracks || []).some((t) => t.solo);
  }

  function applyTrackParams(chain, track, soloActive, forceAudible = false) {
    const fx = track.fx || {};
    const eq = fx.eq || {};
    const comp = fx.compressor || {};
    const dist = fx.distortion || {};
    const bypass = fx.bypass === true || fx.on === false;

    const eqOn = !bypass && eq.on !== false;
    chain.hpf.frequency.value = eqOn ? Math.max(20, Math.min(1000, eq.hp ?? 20)) : 20;
    chain.peak.frequency.value = Math.max(80, Math.min(12000, eq.peakF ?? 1000));
    chain.peak.gain.value = eqOn ? Math.max(-18, Math.min(18, eq.peakG ?? 0)) : 0;
    chain.peak.Q.value = Math.max(0.2, Math.min(8, eq.peakQ ?? 0.9));
    chain.lpf.frequency.value = eqOn ? Math.max(400, Math.min(20000, eq.lp ?? 20000)) : 20000;

    if (chain.comp) {
      const compOn = !bypass && comp.on !== false;
      chain.comp.threshold.value = compOn ? Math.max(-60, Math.min(0, comp.thresh ?? -24)) : 0;
      chain.comp.ratio.value = compOn ? Math.max(1, Math.min(20, comp.ratio ?? 4)) : 1;
      chain.comp.attack.value = compOn ? Math.max(0.001, Math.min(0.5, comp.attack ?? 0.01)) : 0.01;
      chain.comp.release.value = compOn ? Math.max(0.01, Math.min(1, comp.release ?? 0.25)) : 0.25;
    }

    if (chain.shaper) {
      const distOn = !bypass && dist.on !== false && (dist.drive ?? 0) > 0;
      chain.distWet.gain.value = distOn ? Math.max(0, Math.min(1, dist.mix ?? 0.5)) : 0;
      chain.distDry.gain.value = distOn ? 1 - chain.distWet.gain.value * 0.5 : 1;
      chain.shaper.curve = makeDistortionCurve(dist.drive ?? 0.2);
    }

    // While the transport runs, populated automation lanes OWN their params:
    // writing .value into an active setValueCurveAtTime region throws
    // NotSupportedError in Chrome, which would abort this refresh mid-loop
    // (mute/solo silently failing on later tracks). Automation wins during
    // playback; the static value returns on stop/seek via resetTrackAutomation.
    const autoOwned = (key) => playing && automationPoints(track, key).length > 0;
    const write = (param, v) => { if (param) { try { param.value = v; } catch {} } };
    if (chain.pan && !autoOwned("pan")) write(chain.pan.pan, Math.max(-1, Math.min(1, track.pan || 0)));
    const silent = !forceAudible && (!!track.mute || (soloActive && !track.solo));
    if (!autoOwned("gain")) write(chain.fader.gain, Math.max(0, Math.min(1.4, track.gain ?? 0.9)));
    write(chain.muteGain.gain, silent ? 0 : 1);
    const sends = trackSendSettings(track);
    if (!autoOwned("reverb")) write(chain.reverbSend.gain, sends.reverb * REVERB_SEND_SCALE);
    if (!autoOwned("delay")) write(chain.delaySend.gain, sends.delay * DELAY_SEND_SCALE);
  }

  /** Re-apply mute/solo/fader/pan/inserts/sends live (no rebuild). */
  function refreshTrackParams() {
    const solo = songSoloActive();
    for (const t of song().tracks || []) {
      const b = buses.get(t.id);
      if (b) applyTrackParams(b, t, solo);
    }
  }

  function refreshMixParams({ rebuildReverb = false } = {}) {
    ensureCtx();
    applyMasterParams(liveMix, song());
    applyBusParams(liveMix, song(), { rebuildReverb });
  }

  function rebuildReverbBus() {
    refreshMixParams({ rebuildReverb: true });
  }

  function disposeTrackChain(chain) {
    if (!chain) return;
    for (const node of [
      chain.input, chain.fader, chain.muteGain, chain.meter,
      chain.reverbSend, chain.delaySend,
    ]) {
      try { node?.disconnect(); } catch {}
    }
  }

  /** Rebuild one track's inserts/send taps, or remove it when deleted. */
  function rebuildTrack(trackId) {
    ensureCtx();
    const old = buses.get(trackId);
    disposeTrackChain(old);
    const t = (song().tracks || []).find((x) => x.id === trackId);
    if (!t) {
      buses.delete(trackId);
      const session = sessions.get(trackId);
      try { session?.disconnect(); } catch {}
      sessions.delete(trackId);
      return;
    }
    buses.set(trackId, buildTrackChain(ctx, t, liveMix, noise));
    const s = sessions.get(trackId);
    if (s) { try { s.disconnect(); } catch {} s.connect(buses.get(trackId).input); }
    // Compatibility with the pre-v3 UI, whose room controls debounce through
    // rebuildTrack. In v3 this rebuilds at most the one global convolver.
    refreshMixParams({ rebuildReverb: true });
  }

  function syncGraph() {
    ensureCtx();
    const tracks = song().tracks || [];
    const liveIds = new Set(tracks.map((track) => track.id));
    for (const [id, chain] of buses) {
      if (liveIds.has(id)) continue;
      disposeTrackChain(chain);
      buses.delete(id);
      const session = sessions.get(id);
      try { session?.disconnect(); } catch {}
      sessions.delete(id);
    }
    for (const track of tracks) {
      if (!buses.has(track.id)) buses.set(track.id, buildTrackChain(ctx, track, liveMix, noise));
    }
    refreshTrackParams();
    refreshMixParams({ rebuildReverb: true });
  }

  function busFor(track) {
    ensureCtx();
    if (!buses.has(track.id)) buses.set(track.id, buildTrackChain(ctx, track, liveMix, noise));
    return buses.get(track.id);
  }

  /** Per-play session node — lets stop() cut scheduled tails cleanly. */
  function sessionFor(track) {
    if (!sessions.has(track.id)) {
      const g = ctx.createGain();
      g.connect(busFor(track).input);
      sessions.set(track.id, g);
    }
    return sessions.get(track.id);
  }

  function staticAutomationValue(track, key) {
    if (key === "gain") return clamp(track?.gain, 0, 1.4, 0.9);
    if (key === "pan") return clamp(track?.pan, -1, 1, 0);
    return trackSendSettings(track)[key] || 0;
  }

  function scheduleTrackAutomation(chain, track, fromBeat, toBeat, timeAt) {
    if (!chain) return;
    chain.autoWas ||= {};
    const lane = (key, param, scale, curve) => {
      const points = automationPoints(track, key);
      if (points.length) {
        scheduleAutomationParam(param, points, staticAutomationValue(track, key), fromBeat, toBeat, timeAt, { scale, curve });
        chain.autoWas[key] = true;
      } else if (chain.autoWas[key]) {
        // The lane was emptied while playing: without this reset the param
        // stays frozen at the last curve sample indefinitely.
        resetAutomationParam(param, staticAutomationValue(track, key) * scale, timeAt(fromBeat));
        chain.autoWas[key] = false;
      }
    };
    lane("gain", chain.fader?.gain, 1, chain.automationCurves?.gain);
    lane("pan", chain.pan?.pan, 1, chain.automationCurves?.pan);
    lane("reverb", chain.reverbSend?.gain, REVERB_SEND_SCALE, chain.automationCurves?.reverb);
    lane("delay", chain.delaySend?.gain, DELAY_SEND_SCALE, chain.automationCurves?.delay);
  }

  function resetAutomationParam(param, value, at) {
    if (!param) return;
    try {
      if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(at);
      else param.cancelScheduledValues?.(at);
      if (typeof param.setValueAtTime === "function") param.setValueAtTime(value, at);
      else param.value = value;
    } catch {
      try { param.value = value; } catch {}
    }
  }

  function resetTrackAutomation(chain, track, atBeat, atTime) {
    if (!chain) return;
    const value = (key) => {
      const points = automationPoints(track, key);
      return points.length
        ? automationValueAt(points, atBeat, staticAutomationValue(track, key))
        : staticAutomationValue(track, key);
    };
    resetAutomationParam(chain.fader?.gain, value("gain"), atTime);
    resetAutomationParam(chain.pan?.pan, value("pan"), atTime);
    resetAutomationParam(chain.reverbSend?.gain, value("reverb") * REVERB_SEND_SCALE, atTime);
    resetAutomationParam(chain.delaySend?.gain, value("delay") * DELAY_SEND_SCALE, atTime);
  }

  function resetAllTrackAutomation(atBeat, atTime) {
    for (const track of song().tracks || []) {
      resetTrackAutomation(buses.get(track.id), track, atBeat, atTime);
    }
  }

  /* ---------------- event scheduling ----------------
   * scheduleWindow walks every track's regions and commits events whose
   * absolute beat lies in [fromBeat, toBeat) at time
   * base + beatsToSec(beat - beat0). Loop wrapping is handled by the caller
   * splitting the window, never in here.
   */
  function scheduleWindow(c, out, fromBeat, toBeat, timeAt, sharedNoise, opts = {}) {
    const sg = song();
    const solo = (sg.tracks || []).some((t) => t.solo);
    for (const track of sg.tracks || []) {
      // Stem renders isolate one track WITHOUT touching the live mute/solo
      // flags (mutating them mid-async corrupted state if the user edited).
      if (opts.onlyTrackId != null ? track.id !== opts.onlyTrackId
        : (track.mute || (solo && !track.solo))) continue;
      const dest = out(track);
      if (!dest) continue;
      scheduleTrackAutomation(opts.chainFor?.(track), track, fromBeat, toBeat, timeAt);
      for (const r of track.regions || []) {
        if (r.takeActive === false) continue;
        const rEnd = r.start + r.len;
        if (rEnd <= fromBeat || r.start >= toBeat) continue;
        if (track.kind === "audio") {
          scheduleAudioRegion(c, dest, track, r, fromBeat, toBeat, timeAt, opts);
        } else if (track.kind === "drums") {
          for (const h of r.hits || []) {
            const ab = r.start + h.b;
            if (ab < fromBeat || ab >= toBeat || h.b >= r.len) continue;
            playDrumHit(c, dest, track.kit || "acoustic", h.k, timeAt(ab), h.v ?? 1, (h.b * 7) & 3);
          }
        } else {
          const patch = resolvePatch(track.family, track.sound, track.patch);
          for (const n of r.notes || []) {
            const ab = r.start + n.b;
            if (ab < fromBeat || ab >= toBeat || n.b >= r.len) continue;
            const boundary = Number.isFinite(opts.loopEndBeat) ? opts.loopEndBeat - ab : Infinity;
            const durBeats = Math.min(n.d || 0.25, r.len - n.b, boundary);
            if (!(durBeats > 0)) continue;
            const dur = beatsToSec(durBeats);
            playInstrument(track.family, track.sound, c, dest, n.m, timeAt(ab), dur, n.v ?? 1, { noise: sharedNoise, patch, step: Math.round(n.b * 4) });
          }
        }
      }
    }
    if (metronomeOn && !opts.offline) {
      const num = sg.ts?.num || 4;
      for (let b = Math.ceil(fromBeat - 1e-6); b < toBeat; b++) {
        click(c, clickBus || master, timeAt(b), b % num === 0);
      }
    }
  }

  function scheduleAudioRegion(c, dest, track, r, fromBeat, toBeat, timeAt, opts) {
    const clip = getClip(r.clipId);
    if (!clip) return;
    const entry = Math.max(r.start, fromBeat);
    const started = opts.startedAudio || null;
    if (started && started.has(r.id)) return;
    if (r.start >= fromBeat && r.start < toBeat) {
      startClip(c, dest, clip, r, r.start, timeAt(r.start), opts);
    } else if (r.start < fromBeat && entry === fromBeat && opts.firstWindow) {
      startClip(c, dest, clip, r, fromBeat, timeAt(fromBeat), opts);
    } else {
      return;
    }
    if (started) started.add(r.id);
  }

  function startClip(c, dest, clip, r, playBeat, at, opts) {
    const targetBpm = clamp(song().bpm, 40, 240, 120);
    const sourceBpm = clamp(r.sourceBpm, 40, 240, targetBpm);
    const repitch = r.tempoMode === "repitch";
    const playbackRate = repitch ? targetBpm / sourceBpm : 1;
    // audioRegionSlice works in source-buffer seconds. Repitch consumes one
    // source beat at source tempo, then playbackRate maps it onto the current
    // song beat in wall-clock time.
    const sourceSecondsPerBeat = repitch ? 60 / sourceBpm : 60 / targetBpm;
    const slice = audioRegionSlice(
      r,
      playBeat,
      sourceSecondsPerBeat,
      opts.loopEndBeat ?? Infinity,
      clip.duration,
    );
    if (!slice) return;
    const src = c.createBufferSource();
    src.buffer = clip;
    const g = c.createGain();
    const baseGain = Math.max(0, r.gain ?? 1);
    const startTime = Math.max(at, c.currentTime ?? 0);
    const outputDuration = slice.durationSec / playbackRate;
    const elapsedSource = Math.max(0, playBeat - r.start) * sourceSecondsPerBeat;
    src.playbackRate.value = playbackRate;
    g.gain.setValueAtTime(baseGain, startTime);

    if (slice.fadeInSec > 0 && elapsedSource < slice.fadeInSec) {
      const remFadeIn = (slice.fadeInSec - elapsedSource) / playbackRate;
      // Entering mid-fade (seek/loop re-entry) resumes at the interpolated
      // envelope level — restarting from silence would audibly duck.
      const entryLevel = Math.max(0.0001, baseGain * (elapsedSource / slice.fadeInSec));
      g.gain.setValueAtTime(entryLevel, startTime);
      g.gain.linearRampToValueAtTime(baseGain, startTime + Math.min(outputDuration, remFadeIn));
    }
    if (slice.fadeOutSec > 0) {
      const fadeOutDuration = slice.fadeOutSec / playbackRate;
      const fadeOutStart = startTime + Math.max(0, outputDuration - fadeOutDuration);
      // Entering INSIDE the fade-out (seek/loop wrap): resume at the
      // interpolated level, not full gain, or every pass starts with a jump.
      const startLevel = outputDuration >= fadeOutDuration
        ? baseGain
        : Math.max(0.0001, baseGain * (outputDuration / fadeOutDuration));
      g.gain.setValueAtTime(startLevel, fadeOutStart);
      g.gain.linearRampToValueAtTime(0.0001, startTime + outputDuration);
    }

    src.connect(g); g.connect(dest);
    try {
      src.start(
        startTime,
        Math.min(slice.offsetSec, clip.duration),
        slice.durationSec,
      );
    } catch {}
    if (!opts.offline) {
      audioSrcs.push(src);
      // Self-prune, or a long session accumulates every source ever started.
      src.onended = () => { const i = audioSrcs.indexOf(src); if (i >= 0) audioSrcs.splice(i, 1); };
    }
  }

  function click(c, dest, at, accent) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.value = accent ? 1568 : 1046;
    g.gain.setValueAtTime(accent ? 0.24 : 0.14, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
    o.connect(g); g.connect(dest);
    o.start(at); o.stop(at + 0.06);
    return o;
  }

  /* ---------------- transport ---------------- */

  function engineBeatNow() {
    if (!playing || !ctx) return beat0;
    return beat0 + (ctx.currentTime - t0) / secPerBeat();
  }

  function beatNow() {
    const b = engineBeatNow();
    const lp = song().loop;
    return lp?.on && lp.b > lp.a ? wrapBeat(b, lp.a, lp.b) : b;
  }

  function play(fromBeat = 0) {
    ensureCtx();
    if (playing) stop();
    syncGraph();
    playing = true;
    beat0 = Math.max(0, fromBeat);
    t0 = ctx.currentTime + 0.06;
    scheduledTo = beat0;
    resetAllTrackAutomation(beat0, ctx.currentTime);
    let firstWindow = true;
    const startedAudio = new Set();

    const tick = () => {
      if (!playing) return;
      const horizonBeat = beat0 + (ctx.currentTime + HORIZON_SEC - t0) / secPerBeat();
      const lp = song().loop;
      // Map the monotone "engine beat" range onto timeline beats, splitting at
      // loop wraps so scheduleWindow never sees a wrapped interval.
      while (scheduledTo < horizonBeat) {
        let from = scheduledTo;
        let to = horizonBeat;
        let tlFrom = from, wrapAt = null;
        if (lp?.on && lp.b > lp.a) {
          // Translate engine beats → timeline beats within the loop.
          const span = lp.b - lp.a;
          const tl = (b) => (b < lp.b ? b : lp.a + ((b - lp.a) % span));
          tlFrom = tl(from);
          // Schedule up to the next wrap boundary only.
          const nextWrap = from < lp.b ? lp.b : from + (span - ((from - lp.a) % span));
          to = Math.min(to, nextWrap);
          wrapAt = nextWrap;
          const timeAt = (ab) => t0 + beatsToSec(from - beat0) + beatsToSec(ab - tlFrom);
          const loopEntry = firstWindow || (from >= lp.b && Math.abs(tlFrom - lp.a) < 1e-7);
          scheduleWindow(ctx, (tr) => sessionFor(tr), tlFrom, tlFrom + (to - from), timeAt, noise, {
            firstWindow: loopEntry,
            loopEndBeat: lp.b,
            startedAudio,
            chainFor: busFor,
          });
        } else {
          const timeAt = (ab) => t0 + beatsToSec(ab - beat0);
          scheduleWindow(ctx, (tr) => sessionFor(tr), from, to, timeAt, noise, {
            firstWindow,
            startedAudio,
            chainFor: busFor,
          });
        }
        firstWindow = false;
        // Audio regions may re-enter after a loop wrap — allow them again.
        if (wrapAt != null && to >= wrapAt) startedAudio.clear();
        scheduledTo = to;
        if (to >= horizonBeat) break;
      }
      onPlayhead?.(beatNow());
    };
    tick();
    timer = setInterval(tick, LOOKAHEAD_MS);
  }

  function stop() {
    if (!playing) { onPlayhead?.(beat0); return beat0; }
    const atBeat = beatNow();
    playing = false;
    clearInterval(timer); timer = null;
    resetAllTrackAutomation(atBeat, ctx.currentTime);
    // Fade each session out, then rebuild it fresh for the next play.
    for (const [id, g] of sessions) {
      try {
        g.gain.setTargetAtTime(0, ctx.currentTime, STOP_RAMP / 3);
        setTimeout(() => { try { g.disconnect(); } catch {} }, STOP_RAMP * 1000 + 60);
      } catch {}
    }
    sessions = new Map();
    for (const s of audioSrcs) { try { s.stop(ctx.currentTime + STOP_RAMP); } catch {} }
    audioSrcs = [];
    beat0 = atBeat;
    onPlayhead?.(beat0);
    return atBeat;
  }

  function seek(beat) {
    if (rec || recPending) {
      onRecordFail?.("Stop recording before moving the playhead.");
      return beatNow();
    }
    const was = playing;
    if (was) stop();
    beat0 = Math.max(0, beat);
    if (ctx) {
      syncGraph();
      resetAllTrackAutomation(beat0, ctx.currentTime);
    }
    onPlayhead?.(beat0);
    if (was) play(beat0);
  }

  /* ---------------- live thru (virtual keyboard / hardware MIDI) ---------- */

  const liveActiveVoices = new Map();

  function noteOn(track, midi, vel = 1) {
    ensureCtx();
    const at = ctx.currentTime + 0.005;
    if (track.kind === "drums") {
      const k = DRUM_KEYS[midi % DRUM_KEYS.length];
      playDrumHit(ctx, busFor(track).input, track.kit || "acoustic", k, at, vel);
      recordNote(track, { k, v: vel });
      return;
    }
    noteOff(track, midi);
    const patch = resolvePatch(track.family, track.sound, track.patch);
    const handle = playInstrument(track.family, track.sound, ctx, busFor(track).input, midi, at, 15, vel, { noise, patch });
    if (handle && handle.env) {
      liveActiveVoices.set(`${track.id}:${midi}`, handle);
    }
    recordNote(track, { m: midi, v: vel });
  }

  function noteOff(track, midi) {
    const key = `${track.id}:${midi}`;
    const handle = liveActiveVoices.get(key);
    if (handle) {
      liveActiveVoices.delete(key);
      const relAt = ctx.currentTime + 0.002;
      const releaseSec = Math.max(0.02, handle.patch?.params?.release || 0.25);
      try {
        if (handle.env && handle.env.gain) {
          handle.env.gain.cancelScheduledValues(relAt);
          handle.env.gain.setTargetAtTime(0.0001, relAt, Math.max(0.008, releaseSec / 4));
        }
      } catch (e) {}
    }

    if (!rec || rec.kind !== "midi" || rec.trackId !== track.id || !rec.activeNotes) return;
    const note = rec.activeNotes.get(midi);
    if (!note) return;
    finishRecordedNote(rec, note, engineBeatNow());
    rec.activeNotes.delete(midi);
  }

  function finishRecordedNote(recording, note, endedAt) {
    const duration = Math.max(0.125, endedAt - note.startedAt);
    const base = { m: note.m, v: note.v };
    if (recording.loop) {
      for (const part of partitionLoopRecording(
        recording.startBeat,
        duration,
        recording.loop,
        note.elapsed,
      )) {
        recording.notes.push({
          ...base,
          b: part.localStart,
          d: part.duration,
          _pass: part.pass,
        });
      }
    } else {
      recording.notes.push({ ...base, b: note.b, d: duration });
    }
  }

  function recordNote(track, ev) {
    if (!rec || rec.kind !== "midi" || rec.trackId !== track.id || !playing) return;
    const now = engineBeatNow();
    const elapsed = Math.max(0, now - rec.startEngineBeat);
    const position = loopRecordingPosition(elapsed, rec.startBeat, rec.loop);
    if ("k" in ev) {
      rec.hits.push({
        b: position.beat,
        k: ev.k,
        v: ev.v,
        ...(rec.loop ? { _pass: position.pass } : {}),
      });
    }
    else {
      const previous = rec.activeNotes?.get(ev.m);
      if (previous) finishRecordedNote(rec, previous, now);
      rec.activeNotes?.set(ev.m, {
        b: position.beat,
        elapsed,
        m: ev.m,
        v: ev.v,
        startedAt: Math.max(rec.startEngineBeat, now),
      });
    }
  }

  /* ---------------- audio input recording ---------------- */

  const CAP_WORKLET = `
class SxCap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufs = [];
    this.len = 0;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        this.flush();
        this.port.postMessage({ flushed: true });
      }
    };
  }
  flush() {
    if (this.bufs.length) this.port.postMessage({ blocks: this.bufs });
    this.bufs = [];
    this.len = 0;
  }
  process(inputs, outputs) {
    const ch = inputs[0];
    const out = outputs[0];
    if (ch && out) {
      for (let c = 0; c < out.length; c++) {
        const source = ch[Math.min(c, ch.length - 1)];
        if (source) out[c].set(source);
      }
    }
    if (ch && ch.length && ch[0].length) {
      this.bufs.push(ch.map((c) => c.slice(0)));
      this.len += ch[0].length;
      if (this.len >= 8192) this.flush();
    }
    return true;
  }
}
registerProcessor("sx-cap", SxCap);`;
  let capModuleReady = null;

  async function startAudioRecording(track, deviceId) {
    ensureCtx();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        },
      });
    } catch (e) {
      onRecordFail?.("Microphone access was blocked — allow it in the browser and try again.");
      return null;
    }
    const source = ctx.createMediaStreamSource(stream);
    const chunks = [];   // arrays of per-channel Float32Arrays
    let node = null, isWorklet = false;
    try {
      if (!capModuleReady) {
        capModuleReady = ctx.audioWorklet.addModule(
          URL.createObjectURL(new Blob([CAP_WORKLET], { type: "text/javascript" }))
        );
      }
      await capModuleReady;
      node = new AudioWorkletNode(ctx, "sx-cap", { numberOfOutputs: 1 });
      let flushResolve = null;
      node.port.onmessage = (e) => {
        if (Array.isArray(e.data)) {
          for (const blk of e.data) chunks.push(blk);
        } else if (Array.isArray(e.data?.blocks)) {
          for (const blk of e.data.blocks) chunks.push(blk);
        }
        if (e.data?.flushed) flushResolve?.();
      };
      node.flush = () => new Promise((resolve) => {
        flushResolve = resolve;
        node.port.postMessage("flush");
        setTimeout(resolve, 120);
      });
      isWorklet = true;
    } catch {
      // ScriptProcessor fallback (deprecated but universal).
      node = ctx.createScriptProcessor(4096, 2, 1);
      node.onaudioprocess = (e) => {
        const chs = [];
        for (let c = 0; c < e.inputBuffer.numberOfChannels; c++) chs.push(e.inputBuffer.getChannelData(c).slice(0));
        chunks.push(chs);
        for (let c = 0; c < e.outputBuffer.numberOfChannels; c++) {
          const source = e.inputBuffer.getChannelData(Math.min(c, e.inputBuffer.numberOfChannels - 1));
          e.outputBuffer.getChannelData(c).set(source);
        }
      };
    }
    source.connect(node);
    // Live input monitoring toggle or silent sink
    const sink = ctx.createGain();
    if (track.monitor) {
      sink.gain.value = 0.9;
      node.connect(sink);
      sink.connect(busFor(track).input);
    } else {
      sink.gain.value = 0;
      node.connect(sink);
      sink.connect(ctx.destination);
    }
    return { stream, source, node, sink, chunks, isWorklet };
  }

  async function finishAudioRecording(cap) {
    if (cap.isWorklet && cap.node.flush) await cap.node.flush();
    try { cap.source.disconnect(); cap.node.disconnect(); cap.sink.disconnect(); } catch {}
    try { cap.stream.getTracks().forEach((t) => t.stop()); } catch {}
    const chunks = cap.chunks;
    if (!chunks.length) return null;
    const nCh = Math.max(1, chunks[0].length);
    const total = chunks.reduce((a, c) => a + c[0].length, 0);
    if (!total) return null;
    const buf = ctx.createBuffer(nCh, total, ctx.sampleRate);
    for (let c = 0; c < nCh; c++) {
      const out = buf.getChannelData(c);
      let off = 0;
      for (const blk of chunks) { out.set(blk[Math.min(c, blk.length - 1)], off); off += blk[0].length; }
    }
    return buf;
  }

  function getRecordingLatencySec(c) {
    const base = c.baseLatency || 0.005;
    const out = c.outputLatency || 0.015;
    const cap = 0.045;
    return base + out + cap;
  }

  /**
   * Start recording. Audio tracks capture the selected input; MIDI/drum tracks
   * capture live keyboard/MIDI events. Playback runs from the current playhead
   * so the other tracks are audible for overdubbing.
   */
  async function record(track, { deviceId } = {}) {
    ensureCtx();
    if (rec || recPending) return false;
    // The pending token covers EVERY await before rec exists (count-in AND
    // the getUserMedia prompt) — otherwise a second ● in that window would
    // pass the re-entry guard and start a parallel recording.
    const token = { cancelled: false, voices: [] };
    recPending = token;
    try {
      if (countInBars > 0) {
        const spb = secPerBeat();
        const bpb = (song().ts?.num || 4);
        const countBeats = countInBars * bpb;
        const startAt = ctx.currentTime + 0.05;
        for (let b = 0; b < countBeats; b++) {
          token.voices.push(click(ctx, clickBus || master, startAt + b * spb, b % bpb === 0));
        }
        await new Promise((resolve) => setTimeout(resolve, countBeats * spb * 1000));
        // A second ● during the count-in cancels; stopRecord already cleaned up.
        if (token.cancelled) return false;
      }

      if (track.kind === "audio") {
        const cap = await startAudioRecording(track, deviceId);
        if (token.cancelled) {
          try { cap?.stream.getTracks().forEach((t) => t.stop()); } catch {}
          return false;
        }
        if (!cap) return false;
        const startBeat = beatNow();
        const lp = song().loop;
        const loop = lp?.on && lp.b > lp.a && startBeat >= lp.a && startBeat < lp.b ? { a: lp.a, b: lp.b } : null;
        rec = { kind: "audio", trackId: track.id, startBeat, startEngineBeat: startBeat, loop, cap };
        play(startBeat);
      } else {
        const startBeat = beatNow();
        const lp = song().loop;
        const loop = lp?.on && lp.b > lp.a && startBeat >= lp.a && startBeat < lp.b ? { a: lp.a, b: lp.b } : null;
        rec = {
          kind: "midi",
          trackId: track.id,
          startBeat,
          startEngineBeat: startBeat,
          loop,
          notes: [],
          hits: [],
          activeNotes: new Map(),
        };
        play(startBeat);
      }
      return true;
    } finally {
      if (recPending === token) recPending = null;
    }
  }

  /** Stop recording AND transport; returns what was captured (or null). */
  async function stopRecord() {
    if (recPending) {
      recPending.cancelled = true;
      for (const v of recPending.voices) { try { v.stop(); } catch {} }
      recPending = null;
      stop();
      return null;
    }
    if (!rec) { stop(); return null; }
    const r = rec; rec = null;
    const endEngineBeat = engineBeatNow();
    const recordedBeats = Math.max(0, endEngineBeat - r.startEngineBeat);
    stop();
    const lenBeats = r.loop
      ? r.loop.b - r.loop.a
      : Math.max(0.25, recordedBeats);
    const passSegments = r.loop
      ? partitionLoopRecording(r.startBeat, recordedBeats, r.loop)
      : null;
    if (r.kind === "audio") {
      const buffer = await finishAudioRecording(r.cap);
      if (!buffer || buffer.duration < 0.05) return null;
      const lat = getRecordingLatencySec(ctx);
      return {
        kind: "audio",
        trackId: r.trackId,
        startBeat: r.startBeat,
        lenBeats,
        loop: r.loop,
        passes: passSegments,
        recordedBeats,
        buffer,
        latencySec: lat,
      };
    }
    for (const note of r.activeNotes?.values() || []) {
      finishRecordedNote(r, note, endEngineBeat);
    }
    if (!r.notes.length && !r.hits.length) return null;
    const withoutPass = (event) => {
      const { _pass, ...copy } = event;
      return copy;
    };
    const passes = passSegments?.map((pass) => ({
      ...pass,
      notes: r.notes.filter((note) => note._pass === pass.pass).map(withoutPass),
      hits: r.hits.filter((hit) => hit._pass === pass.pass).map(withoutPass),
    }));
    return {
      kind: "midi",
      trackId: r.trackId,
      startBeat: r.startBeat,
      lenBeats,
      loop: r.loop,
      passes,
      recordedBeats,
      notes: r.notes.map(withoutPass),
      hits: r.hits.map(withoutPass),
    };
  }

  /* ---------------- offline bounce ---------------- */

  /**
   * Render [fromBeat, toBeat) offline. `onlyTrackId` isolates one track (its
   * mute/solo flags are ignored — a muted track still yields its stem).
   * `finalize:false` skips limiting; normalization is an explicit opt-in
   * because the live signal path never normalizes program material.
   */
  async function renderOffline(fromBeat, toBeat, {
    onlyTrackId = null,
    finalize = true,
    normalize = false,
  } = {}) {
    ensureCtx();
    const sr = ctx.sampleRate;
    const sg = song();
    const renderLead = RENDER_LEAD_SEC;
    const tail = offlineTailSeconds(sg);
    const totalSec = renderLead + beatsToSec(toBeat - fromBeat) + tail;
    const oc = new OfflineAudioContext(2, Math.max(1, Math.ceil(totalSec * sr)), sr);
    const offlineMix = buildMixGraph(oc, oc.destination, sg, { meters: false });
    const onoise = oc.createBuffer(1, sr, sr);
    onoise.getChannelData(0).set(noiseData(sr, 1));
    const offlineBuses = new Map();
    const out = (track) => {
      if (!offlineBuses.has(track.id)) {
        offlineBuses.set(track.id, buildTrackChain(oc, track, offlineMix, onoise, {
          forceAudible: onlyTrackId != null && track.id === onlyTrackId,
          meters: false,
        }));
      }
      return offlineBuses.get(track.id).input;
    };
    const timeAt = (ab) => renderLead + beatsToSec(ab - fromBeat);
    const startedAudio = new Set();
    let cursor = fromBeat;
    let firstWindow = true;
    while (cursor < toBeat - 1e-8) {
      const limit = Math.min(toBeat, cursor + OFFLINE_AUTOMATION_WINDOW_BEATS);
      const windowEnd = nextOfflineAutomationBoundary(sg, cursor, limit);
      scheduleWindow(oc, out, cursor, windowEnd, timeAt, onoise, {
        offline: true,
        firstWindow,
        startedAudio,
        onlyTrackId,
        chainFor: (track) => offlineBuses.get(track.id),
      });
      firstWindow = false;
      cursor = windowEnd;
    }
    const buffer = await oc.startRendering();
    if (finalize) {
      const chans = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
      masterFinalize(chans, sr, normalize ? {} : { maxBoost: 1, maxCut: 1 });
    }
    return buffer;
  }

  /**
   * One stem per track. All stems share ONE gain, measured on their sum —
   * per-stem normalization would destroy the relative balance of the mix.
   */
  async function renderOfflineStems(fromBeat, toBeat) {
    ensureCtx();
    const stems = new Map();
    for (const t of song().tracks || []) {
      stems.set(t.id, await renderOffline(fromBeat, toBeat, { onlyTrackId: t.id, finalize: false }));
    }
    if (!stems.size) return stems;
    // The master bounce is NOT loudness-normalized (unity gain + limiter), so
    // stems must not be either — any other gain and they cannot sum back to
    // the mix. maxBoost === maxCut === 1 pins the gain and keeps the limiter.
    for (const buf of stems.values()) {
      const chans = [];
      for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
      masterFinalize(chans, buf.sampleRate, { maxBoost: 1, maxCut: 1 });
    }
    return stems;
  }

  const meterState = {
    master: { rms: 0, peak: 0 },
    tracks: new Map(),
  };
  let masterMeterBuffer = null;

  function readMeter(analyser, buffer, state) {
    if (!analyser || !buffer || typeof analyser.getFloatTimeDomainData !== "function") {
      state.rms = 0;
      state.peak = 0;
      return;
    }
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0, peak = 0;
    for (let i = 0; i < buffer.length; i++) {
      const value = Number.isFinite(buffer[i]) ? buffer[i] : 0;
      sum += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    state.rms = Math.sqrt(sum / buffer.length);
    state.peak = peak;
  }

  /**
   * Stable, allocation-free-after-warmup meter snapshot. The returned object,
   * map and level records are reused so animation-frame painting creates no
   * garbage; callers must treat them as read-only until the next call.
   */
  function meterSnapshot() {
    if (meterTap) {
      if (!masterMeterBuffer || masterMeterBuffer.length !== meterTap.fftSize) {
        masterMeterBuffer = new Float32Array(meterTap.fftSize);
      }
      readMeter(meterTap, masterMeterBuffer, meterState.master);
    } else {
      meterState.master.rms = 0;
      meterState.master.peak = 0;
    }

    const tracks = song().tracks || [];
    for (const track of tracks) {
      const chain = buses.get(track.id);
      let state = chain?.meterState || meterState.tracks.get(track.id);
      if (!state) state = { rms: 0, peak: 0 };
      if (chain?.meter) readMeter(chain.meter, chain.meterBuffer, state);
      else { state.rms = 0; state.peak = 0; }
      meterState.tracks.set(track.id, state);
    }
    for (const id of meterState.tracks.keys()) {
      if (!tracks.some((track) => track.id === id)) meterState.tracks.delete(id);
    }
    return meterState;
  }

  /** Legacy normalized RMS seam retained for the compact transport meter. */
  function masterLevel() {
    return Math.min(1, meterSnapshot().master.rms * 3);
  }

  /** Small diagnostic seam used to assert that effects stay shared. */
  function graphStats() {
    return {
      tracks: buses.size,
      reverbBuses: liveMix?.sends?.reverb ? 1 : 0,
      delayBuses: liveMix?.sends?.delay ? 1 : 0,
    };
  }

  let countInBars = 0;

  return {
    get playing() { return playing; },
    get recording() { return !!rec || !!recPending; },
    get pendingRecord() { return !!recPending; },
    get rec() { return rec; },
    beatNow, play, stop, seek,
    noteOn, noteOff, record, stopRecord,
    refreshTrackParams, refreshMixParams, rebuildTrack, rebuildReverbBus, syncGraph,
    renderOffline, renderOfflineStems, masterLevel, meterSnapshot, graphStats,
    setMetronome(on) { metronomeOn = !!on; },
    get metronome() { return metronomeOn; },
    setCountIn(bars) { countInBars = Math.max(0, Math.min(2, Number(bars) || 0)); },
    get countIn() { return countInBars; },
    previewTrack(track, midi, vel) { noteOn(track, midi, vel); },
  };
}
