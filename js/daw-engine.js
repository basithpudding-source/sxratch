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
  makeReverbSend, glueCompressor, masterFinalize,
} from "./synth.js";
import {
  audioRegionSlice,
  recordedBeat,
  splitLoopedNote,
  wrapBeat,
} from "./daw-model.js";

const LOOKAHEAD_MS = 30;      // scheduler tick
const HORIZON_SEC = 0.18;     // how far ahead events are committed to WebAudio
const STOP_RAMP = 0.04;       // fade applied to a session bus on stop

export const DRUM_KEYS = ["crash", "hat", "open", "snare", "tomH", "tomM", "tomL", "kick"];

export function createDawEngine({ getCtx, getOutput, getSong, getClip, onPlayhead, onRecordFail }) {
  let ctx = null;
  let master = null, glue = null, meterTap = null;
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

  function ensureCtx() {
    if (ctx) return ctx;
    ctx = getCtx();
    master = ctx.createGain();
    master.gain.value = 0.9;
    glue = glueCompressor(ctx);
    meterTap = ctx.createAnalyser();
    meterTap.fftSize = 256;
    master.connect(glue);
    glue.connect(meterTap);
    meterTap.connect(getOutput?.() || ctx.destination);
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
   * input → Distortion → HPF → peaking → LPF → Compressor → Delay → panner → gain → dest,
   * with a reverb send tapped post-gain.
   */
  function buildTrackChain(c, track, dest, sharedNoise, { forceAudible = false } = {}) {
    const fx = track.fx || {};
    const rv = fx.reverb || {};
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
    const delayNode = c.createDelay ? c.createDelay(2.0) : null;
    const delayFeedback = c.createGain ? c.createGain() : null;
    const delayWet = c.createGain ? c.createGain() : null;

    if (delayNode && delayFeedback && delayWet) {
      postComp.connect(delayNode);
      delayNode.connect(delayFeedback);
      delayFeedback.connect(delayNode);
      delayNode.connect(delayWet);
    }

    const pan = c.createStereoPanner ? c.createStereoPanner() : null;
    const gain = c.createGain();

    if (pan) {
      postComp.connect(pan);
      if (delayWet) delayWet.connect(pan);
      pan.connect(gain);
    } else {
      postComp.connect(gain);
      if (delayWet) delayWet.connect(gain);
    }
    gain.connect(dest);

    // Reverb send
    const verb = makeReverbSend(c, {
      seconds: 0.8 + (rv.size ?? 0.4) * 2.4,
      decay: 2.2 + (1 - (rv.damp ?? 0.5)) * 1.6,
      predelay: 0.016,
      damp: rv.damp ?? 0.5,
    });
    const wet = c.createGain();
    gain.connect(verb.in);
    verb.out.connect(wet);
    wet.connect(dest);

    const chain = {
      input, distDry, distWet, shaper, hpf, peak, lpf,
      comp, delayNode, delayFeedback, delayWet, pan, gain, wet, noise: sharedNoise,
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
    const rv = fx.reverb || {};
    const comp = fx.compressor || {};
    const del = fx.delay || {};
    const dist = fx.distortion || {};

    chain.hpf.frequency.value = eq.on === false ? 20 : Math.max(20, Math.min(1000, eq.hp ?? 20));
    chain.peak.frequency.value = Math.max(80, Math.min(12000, eq.peakF ?? 1000));
    chain.peak.gain.value = eq.on === false ? 0 : Math.max(-18, Math.min(18, eq.peakG ?? 0));
    chain.peak.Q.value = Math.max(0.2, Math.min(8, eq.peakQ ?? 0.9));
    chain.lpf.frequency.value = eq.on === false ? 20000 : Math.max(400, Math.min(20000, eq.lp ?? 20000));

    if (chain.comp) {
      const compOn = comp.on !== false;
      chain.comp.threshold.value = compOn ? Math.max(-60, Math.min(0, comp.thresh ?? -24)) : 0;
      chain.comp.ratio.value = compOn ? Math.max(1, Math.min(20, comp.ratio ?? 4)) : 1;
      chain.comp.attack.value = compOn ? Math.max(0.001, Math.min(0.5, comp.attack ?? 0.01)) : 0.01;
      chain.comp.release.value = compOn ? Math.max(0.01, Math.min(1, comp.release ?? 0.25)) : 0.25;
    }

    if (chain.delayNode) {
      const delOn = del.on !== false;
      const spb = secPerBeat();
      const delayTimeSec = Math.max(0.02, Math.min(2, (del.time ?? 0.25) * spb));
      chain.delayNode.delayTime.value = delayTimeSec;
      chain.delayFeedback.gain.value = delOn ? Math.max(0, Math.min(0.88, del.feedback ?? 0.3)) : 0;
      chain.delayWet.gain.value = delOn ? Math.max(0, Math.min(1, del.mix ?? 0)) * 0.5 : 0;
    }

    if (chain.shaper) {
      const distOn = dist.on !== false && (dist.drive ?? 0) > 0;
      chain.distWet.gain.value = distOn ? Math.max(0, Math.min(1, dist.mix ?? 0.5)) : 0;
      chain.distDry.gain.value = distOn ? 1 - chain.distWet.gain.value * 0.5 : 1;
      chain.shaper.curve = makeDistortionCurve(dist.drive ?? 0.2);
    }

    if (chain.pan) chain.pan.pan.value = Math.max(-1, Math.min(1, track.pan || 0));
    const silent = !forceAudible && (!!track.mute || (soloActive && !track.solo));
    chain.gain.gain.value = silent ? 0 : Math.max(0, Math.min(1.4, track.gain ?? 0.9));
    chain.wet.gain.value = silent || rv.on === false ? 0 : (rv.mix ?? 0) * 0.4;
  }

  /** Re-apply mute/solo/gain/pan/EQ/verb-mix live (no rebuild). */
  function refreshTrackParams() {
    const solo = songSoloActive();
    for (const t of song().tracks || []) {
      const b = buses.get(t.id);
      if (b) applyTrackParams(b, t, solo);
    }
  }

  /** Rebuild one track's chain (verb size/damp changed, or track added). */
  function rebuildTrack(trackId) {
    ensureCtx();
    const old = buses.get(trackId);
    if (old) { try { old.input.disconnect(); old.gain.disconnect(); old.wet.disconnect(); } catch {} }
    const t = (song().tracks || []).find((x) => x.id === trackId);
    if (!t) { buses.delete(trackId); sessions.delete(trackId); return; }
    buses.set(trackId, buildTrackChain(ctx, t, master, noise));
    const s = sessions.get(trackId);
    if (s) { try { s.disconnect(); } catch {} s.connect(buses.get(trackId).input); }
  }

  function busFor(track) {
    ensureCtx();
    if (!buses.has(track.id)) buses.set(track.id, buildTrackChain(ctx, track, master, noise));
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
      for (const r of track.regions || []) {
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
        click(c, master, timeAt(b), b % num === 0);
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
    const slice = audioRegionSlice(
      r,
      playBeat,
      secPerBeat(),
      opts.loopEndBeat ?? Infinity,
      clip.duration,
    );
    if (!slice) return;
    const src = c.createBufferSource();
    src.buffer = clip;
    const g = c.createGain();
    const baseGain = Math.max(0, r.gain ?? 1);
    const startTime = Math.max(at, c.currentTime ?? 0);
    g.gain.setValueAtTime(baseGain, startTime);

    if (slice.fadeInSec > 0 && slice.offsetSec < slice.fadeInSec) {
      const remFadeIn = slice.fadeInSec - slice.offsetSec;
      g.gain.setValueAtTime(0.0001, startTime);
      g.gain.linearRampToValueAtTime(baseGain, startTime + Math.min(slice.durationSec, remFadeIn));
    }
    if (slice.fadeOutSec > 0) {
      const fadeOutStart = startTime + Math.max(0, slice.durationSec - slice.fadeOutSec);
      g.gain.setValueAtTime(baseGain, fadeOutStart);
      g.gain.linearRampToValueAtTime(0.0001, startTime + slice.durationSec);
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
    playing = true;
    beat0 = Math.max(0, fromBeat);
    t0 = ctx.currentTime + 0.06;
    scheduledTo = beat0;
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
          });
        } else {
          const timeAt = (ab) => t0 + beatsToSec(ab - beat0);
          scheduleWindow(ctx, (tr) => sessionFor(tr), from, to, timeAt, noise, { firstWindow, startedAudio });
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
      for (const part of splitLoopedNote(note.b, duration, recording.loop.b - recording.loop.a)) {
        recording.notes.push({ ...base, ...part });
      }
    } else {
      recording.notes.push({ ...base, b: note.b, d: duration });
    }
  }

  function recordNote(track, ev) {
    if (!rec || rec.kind !== "midi" || rec.trackId !== track.id || !playing) return;
    const now = engineBeatNow();
    const elapsed = Math.max(0, now - rec.startEngineBeat);
    const b = recordedBeat(elapsed, rec.startBeat, rec.loop);
    if ("k" in ev) rec.hits.push({ b, k: ev.k, v: ev.v });
    else {
      const previous = rec.activeNotes?.get(ev.m);
      if (previous) finishRecordedNote(rec, previous, now);
      rec.activeNotes?.set(ev.m, {
        b,
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
  process(inputs) {
    const ch = inputs[0];
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
          token.voices.push(click(ctx, master, startAt + b * spb, b % bpb === 0));
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
    stop();
    const lenBeats = r.loop
      ? r.loop.b - r.loop.a
      : Math.max(0.25, endEngineBeat - r.startEngineBeat);
    if (r.kind === "audio") {
      const buffer = await finishAudioRecording(r.cap);
      if (!buffer || buffer.duration < 0.05) return null;
      const lat = getRecordingLatencySec(ctx);
      return { kind: "audio", trackId: r.trackId, startBeat: r.startBeat, lenBeats, loop: r.loop, buffer, latencySec: lat };
    }
    for (const note of r.activeNotes?.values() || []) {
      finishRecordedNote(r, note, endEngineBeat);
    }
    if (!r.notes.length && !r.hits.length) return null;
    return {
      kind: "midi",
      trackId: r.trackId,
      startBeat: r.startBeat,
      lenBeats,
      loop: r.loop,
      notes: r.notes,
      hits: r.hits,
    };
  }

  /* ---------------- offline bounce ---------------- */

  /**
   * Render [fromBeat, toBeat) offline. `onlyTrackId` isolates one track (its
   * mute/solo flags are ignored — a muted track still yields its stem);
   * `finalize:false` skips loudness-normalize + limiting so callers control it.
   */
  async function renderOffline(fromBeat, toBeat, { onlyTrackId = null, finalize = true } = {}) {
    ensureCtx();
    const sr = ctx.sampleRate;
    const tail = 2.0;
    const totalSec = beatsToSec(toBeat - fromBeat) + tail;
    const oc = new OfflineAudioContext(2, Math.max(1, Math.ceil(totalSec * sr)), sr);
    const om = oc.createGain(); om.gain.value = 0.9;
    const og = glueCompressor(oc); om.connect(og); og.connect(oc.destination);
    const onoise = oc.createBuffer(1, sr, sr);
    onoise.getChannelData(0).set(noiseData(sr, 1));
    const offlineBuses = new Map();
    const out = (track) => {
      if (!offlineBuses.has(track.id)) {
        offlineBuses.set(track.id, buildTrackChain(oc, track, om, onoise, {
          forceAudible: onlyTrackId != null && track.id === onlyTrackId,
        }));
      }
      return offlineBuses.get(track.id).input;
    };
    const timeAt = (ab) => 0.03 + beatsToSec(ab - fromBeat);
    scheduleWindow(oc, out, fromBeat, toBeat, timeAt, onoise, { offline: true, firstWindow: true, startedAudio: new Set(), onlyTrackId });
    const buffer = await oc.startRendering();
    if (finalize) {
      const chans = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
      masterFinalize(chans, sr);
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
    const first = stems.values().next().value;
    const sr = first.sampleRate, len = first.length;
    const sum = [new Float32Array(len), new Float32Array(len)];
    for (const buf of stems.values()) {
      // Clamp per stem: a bpm/length edit between the sequential renders can
      // change buffer sizes, and reading past the end would NaN-poison the sum.
      const n = Math.min(len, buf.length);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
        const s = sum[c];
        for (let i = 0; i < n; i++) s[i] += d[i];
      }
    }
    const { gain } = masterFinalize(sum, sr);   // measure on the throwaway sum
    for (const buf of stems.values()) {
      const chans = [];
      for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
      // maxBoost === maxCut pins masterFinalize's gain to exactly `gain`,
      // so this applies the shared gain plus the true-peak limiter only.
      masterFinalize(chans, sr, { maxBoost: gain, maxCut: gain });
    }
    return stems;
  }

  /** RMS 0..1 for the master meter. */
  let meterBuf = null;        // reused — this runs every animation frame
  function masterLevel() {
    if (!meterTap) return 0;
    if (!meterBuf || meterBuf.length !== meterTap.fftSize) meterBuf = new Float32Array(meterTap.fftSize);
    meterTap.getFloatTimeDomainData(meterBuf);
    let sum = 0;
    for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
    return Math.min(1, Math.sqrt(sum / meterBuf.length) * 3);
  }

  let countInBars = 0;

  return {
    get playing() { return playing; },
    get recording() { return !!rec || !!recPending; },
    get pendingRecord() { return !!recPending; },
    get rec() { return rec; },
    beatNow, play, stop, seek,
    noteOn, noteOff, record, stopRecord,
    refreshTrackParams, rebuildTrack,
    renderOffline, renderOfflineStems, masterLevel,
    setMetronome(on) { metronomeOn = !!on; },
    get metronome() { return metronomeOn; },
    setCountIn(bars) { countInBars = Math.max(0, Math.min(2, Number(bars) || 0)); },
    get countIn() { return countInBars; },
    previewTrack(track, midi, vel) { noteOn(track, midi, vel); },
  };
}

