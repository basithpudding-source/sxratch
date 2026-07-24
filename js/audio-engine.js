// Sxratch audio engine (main thread).
//
// Signal path per deck:
//   ScratchWorklet -> EQ (low shelf -> mid peak -> high shelf) -> volume gain
//     -> crossfade gain -> master bus
//
// Master bus -> limiter (compressor) -> destination, so two hot decks summed
// together don't clip harshly.

import { crossfadeGains } from "./theory.js";
import { makeReverbIR } from "./synth.js";

export class Deck {
  /**
   * @param {AudioEngine} engine
   * @param {"A"|"B"} id
   */
  constructor(engine, id) {
    this.engine = engine;
    this.id = id;
    const ctx = engine.ctx;

    this.node = new AudioWorkletNode(ctx, "scratch-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    // Input trim (gain stage before EQ)
    this.trim = ctx.createGain();

    // 3-band EQ
    this.low = ctx.createBiquadFilter();
    this.low.type = "lowshelf";
    this.low.frequency.value = 200;

    this.mid = ctx.createBiquadFilter();
    this.mid.type = "peaking";
    this.mid.frequency.value = 1000;
    this.mid.Q.value = 0.9;

    this.high = ctx.createBiquadFilter();
    this.high.type = "highshelf";
    this.high.frequency.value = 3500;

    // Single-knob DJ filter: a low-pass and a high-pass in series. At centre both
    // are wide open (no effect); turn left to sweep the LPF down, right to sweep
    // the HPF up.
    this.lpf = ctx.createBiquadFilter();
    this.lpf.type = "lowpass";
    this.lpf.frequency.value = 22000;
    this.lpf.Q.value = 0.7;
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = "highpass";
    this.hpf.frequency.value = 20;
    this.hpf.Q.value = 0.7;

    this.volume = ctx.createGain();
    this.fx = new BeatFX(ctx);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 128;
    this.crossGain = ctx.createGain();

    this.node.connect(this.trim);
    this.trim.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.lpf);
    this.lpf.connect(this.hpf);
    this.hpf.connect(this.volume);
    this.volume.connect(this.fx.input);
    this.fx.output.connect(this.analyser);
    this.analyser.connect(this.crossGain);
    this.crossGain.connect(engine.masterBus);

    // State
    this.buffer = null;       // decoded AudioBuffer (kept for waveform peaks)
    this.duration = 0;
    this.name = "";
    this.position = 0;        // 0..1
    this.playing = false;
    this.cuePoint = 0;        // 0..1
    this.tempo = 0;           // -8..+8 percent
    this.bpm = 120;           // used for auto-loop length (set on load when known)
    this.loop = { active: false, start: -1, end: -1 };

    this.onPosition = null;   // callback(position, playing, rate)
    this.onLoaded = null;     // callback()

    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "pos") {
        this.position = m.position;
        this.playing = m.playing;
        this.loop = { active: m.loopActive, start: m.loopStart, end: m.loopEnd };
        if (this.onPosition) this.onPosition(m.position, m.playing, m.rate, this.loop);
      } else if (m.type === "loaded") {
        if (this.onLoaded) this.onLoaded();
      }
    };

    // Lock-free jog channel: when the page is cross-origin isolated, scratch
    // velocity travels over a SharedArrayBuffer (polled by the worklet every
    // render block) instead of postMessage — lower latency and no queue jitter.
    // f32[0] = velocity, i32[1] = generation counter.
    this.useSAB = false;
    if (typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated) {
      try {
        this.sab = new SharedArrayBuffer(8);
        this.controlF = new Float32Array(this.sab);
        this.controlI = new Int32Array(this.sab);
        this.node.port.postMessage({ type: "control", buffer: this.sab });
        this.useSAB = true;
      } catch { this.useSAB = false; }
    }
  }

  /** Load a decoded AudioBuffer; channel data is transferred to the worklet. */
  loadBuffer(audioBuffer, name = "") {
    this.buffer = audioBuffer;
    this.duration = audioBuffer.duration;
    this.name = name;
    this.position = 0;
    this.playing = false;
    this.cuePoint = 0;

    const channels = [];
    const transfer = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      // Copy so we own a transferable ArrayBuffer (getChannelData is live).
      const src = audioBuffer.getChannelData(c);
      const copy = new Float32Array(src.length);
      copy.set(src);
      channels.push(copy.buffer);
      transfer.push(copy.buffer);
    }
    this.node.port.postMessage({ type: "load", channels }, transfer);
  }

  play() { this.node.port.postMessage({ type: "play" }); this.playing = true; }
  pause() { this.node.port.postMessage({ type: "pause" }); this.playing = false; }
  toggle() { this.node.port.postMessage({ type: "toggle" }); }
  seek(position) { this.node.port.postMessage({ type: "seek", position }); this.position = position; }

  setCue() { this.cuePoint = this.position; this.node.port.postMessage({ type: "cue", position: this.position }); }
  goToCue() { this.node.port.postMessage({ type: "seek", position: this.cuePoint }); this.position = this.cuePoint; }

  touchStart() { this.node.port.postMessage({ type: "touchStart" }); }
  touchEnd() { this.node.port.postMessage({ type: "touchEnd" }); }
  jog(velocity) {
    if (this.useSAB) {
      this.controlF[0] = velocity;
      Atomics.add(this.controlI, 1, 1); // bump generation (also a memory barrier)
    } else {
      this.node.port.postMessage({ type: "jog", velocity });
    }
    // Practice instrumentation must never be able to break audio.
    if (this.engine.onJog) { try { this.engine.onJog(this.id, velocity); } catch {} }
  }

  // --- Loops ---
  loopIn() { this.node.port.postMessage({ type: "loopIn" }); }
  loopOut() { this.node.port.postMessage({ type: "loopOut" }); }
  loopExit() { this.node.port.postMessage({ type: "loopExit" }); }
  loopHalve() { this.node.port.postMessage({ type: "loopHalve" }); }
  loopDouble() { this.node.port.postMessage({ type: "loopDouble" }); }
  /** Auto-loop of `beats` beats, using this deck's BPM (and current tempo). */
  autoLoop(beats = 4) {
    if (!this.buffer) return;
    const sr = this.engine.ctx.sampleRate;
    const effBpm = this.bpm * (1 + this.tempo / 100);
    const samples = Math.round((beats * 60 / effBpm) * sr);
    this.node.port.postMessage({ type: "loopAuto", samples });
  }

  // --- Transport FX ---
  brake(on) { this.node.port.postMessage({ type: "brake", on: !!on }); }
  backspin() { this.node.port.postMessage({ type: "backspin" }); }

  /** Set the track BPM and keep tempo-synced FX (echo) on the beat. */
  setBpm(bpm) {
    this.bpm = bpm;
    this.fx.setBpm(this.bpm * (1 + this.tempo / 100));
  }

  /** tempo in percent, e.g. -8..+8 */
  setTempo(percent) {
    this.tempo = percent;
    this.node.port.postMessage({ type: "rate", value: 1 + percent / 100 });
    this.fx.setBpm(this.bpm * (1 + this.tempo / 100));
  }

  setVolume(v) { // 0..1
    this.volume.gain.setTargetAtTime(v, this.engine.ctx.currentTime, 0.01);
  }

  /** Trim / input gain. value 0..1, ~unity at 0.67. */
  setTrim(value) {
    this.trim.gain.setTargetAtTime(value * 1.5, this.engine.ctx.currentTime, 0.02);
  }

  /** Single-knob filter. value 0..1, 0.5 = bypass; <0.5 low-pass, >0.5 high-pass. */
  setFilter(value) {
    const t = this.engine.ctx.currentTime;
    if (Math.abs(value - 0.5) < 0.02) {
      this.lpf.frequency.setTargetAtTime(22000, t, 0.02);
      this.hpf.frequency.setTargetAtTime(20, t, 0.02);
    } else if (value < 0.5) {
      const f = 130 * Math.pow(22000 / 130, value / 0.5); // 130 Hz .. 22 kHz
      this.lpf.frequency.setTargetAtTime(f, t, 0.02);
      this.hpf.frequency.setTargetAtTime(20, t, 0.02);
    } else {
      const f = 20 * Math.pow(9000 / 20, (value - 0.5) / 0.5); // 20 Hz .. 9 kHz
      this.hpf.frequency.setTargetAtTime(f, t, 0.02);
      this.lpf.frequency.setTargetAtTime(22000, t, 0.02);
    }
  }

  /** band: "low"|"mid"|"high", value: 0..1 (0.5 = neutral) */
  setEQ(band, value) {
    // Map 0..1 to -26..+6 dB, with a full "kill" toward the bottom.
    const db = value <= 0.5
      ? (value / 0.5) * 26 - 26  // 0 -> -26, 0.5 -> 0
      : (value - 0.5) / 0.5 * 6; // 0.5 -> 0, 1 -> +6
    const node = band === "low" ? this.low : band === "mid" ? this.mid : this.high;
    node.gain.setTargetAtTime(db, this.engine.ctx.currentTime, 0.01);
  }
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.decks = {};
    this.crossfade = 0.5; // 0 = full A, 1 = full B
    this.ready = false;
    this.crossfadeCurve = "power"; // "linear" | "power" | "cut"
    this.hamster = false; // hamster reverse mode
  }

  /** Must be called from a user gesture (click/touch). */
  async init() {
    if (this.ready) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive",
    });

    await this.ctx.audioWorklet.addModule("js/scratch-processor.js");
    // Look-ahead brickwall limiter (own worklet); fall back to a compressor if
    // the module can't load.
    let limiterReady = false;
    try { await this.ctx.audioWorklet.addModule("js/limiter-processor.js"); limiterReady = true; } catch {}

    this.masterBus = this.ctx.createGain();
    this.master = this.ctx.createGain();

    if (limiterReady) {
      this.limiter = new AudioWorkletNode(this.ctx, "limiter-processor", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      });
    } else {
      // Fallback: brickwall-ish compressor to tame summed peaks.
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -3;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.12;
    }

    this.masterBus.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);

    this.decks.A = new Deck(this, "A");
    this.decks.B = new Deck(this, "B");

    this.setCrossfade(0.5);
    this.ready = true;
  }

  async resume() {
    if (this.ctx && this.ctx.state !== "running") await this.ctx.resume();
  }

  setMasterVolume(v) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  /** Equal-power crossfade. x: 0 (A) .. 1 (B). */
  setCrossfade(x) {
    this.crossfade = x;
    const [a, b] = crossfadeGains(x, this.crossfadeCurve, this.hamster);
    const t = this.ctx.currentTime;
    this.decks.A.crossGain.gain.setTargetAtTime(a, t, 0.008);
    this.decks.B.crossGain.gain.setTargetAtTime(b, t, 0.008);
    if (this.onCrossfade) { try { this.onCrossfade(x); } catch {} } // never break audio
  }

  /** Decode an ArrayBuffer of encoded audio into an AudioBuffer. */
  decode(arrayBuffer) {
    return this.ctx.decodeAudioData(arrayBuffer);
  }
}

/**
 * Master Beat FX unit — a wet/dry insert with a few selectable effects and a
 * single Depth control. Echo / Reverb / Flanger / Phaser.
 */
export class BeatFX {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.wet.connect(this.output);
    this.wet.gain.value = 0;

    this.effects = {};
    this._buildEcho();
    this._buildReverb();
    this._buildFlanger();
    this._buildPhaser();

    this.on = false;
    this.depth = 0.5;
    this.current = "echo";
    this.input.connect(this.effects.echo.in);
    this.effects.echo.out.connect(this.wet);
  }

  _buildEcho() {
    const ctx = this.ctx;
    const inGain = ctx.createGain();
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.375; // re-synced to the deck BPM via setBpm()
    const fb = ctx.createGain();
    fb.gain.value = 0.4;
    // Filter the feedback loop so repeats darken like an analog delay
    // instead of accumulating hiss. Butterworth Q (0.707) keeps the corners
    // flat — the default Q=1 adds ~1 dB resonance that, inside the loop,
    // makes max-depth repeats ring for far longer than the feedback implies.
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2600;
    lp.Q.value = 0.707;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 170;
    hp.Q.value = 0.707;
    const out = ctx.createGain();
    inGain.connect(delay);
    delay.connect(lp);
    lp.connect(hp);
    hp.connect(fb);
    fb.connect(delay);
    delay.connect(out);
    this.effects.echo = { in: inGain, out, delay, fb };
  }
  _buildReverb() {
    const ctx = this.ctx;
    const inGain = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = makeReverbIR(ctx, { seconds: 2.1, decay: 2.8, predelay: 0.02, damp: 0.45 });
    const out = ctx.createGain();
    inGain.connect(conv);
    conv.connect(out);
    this.effects.reverb = { in: inGain, out };
  }
  _buildFlanger() {
    const ctx = this.ctx;
    const inGain = ctx.createGain();
    const delay = ctx.createDelay(0.02);
    // Base 8 ms: the delay is in a feedback cycle, so its effective time floors
    // at one render quantum (~2.9 ms); with max modulation depth 4 ms the sweep
    // stays in 4–12 ms and never crosses that floor or goes negative.
    delay.delayTime.value = 0.008;
    const fb = ctx.createGain();
    fb.gain.value = 0.5;
    const out = ctx.createGain();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.25;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.003;
    lfo.connect(lfoGain);
    lfoGain.connect(delay.delayTime);
    lfo.start();
    inGain.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    inGain.connect(out);
    delay.connect(out);
    this.effects.flanger = { in: inGain, out, lfoGain, fb };
  }
  _buildPhaser() {
    const ctx = this.ctx;
    const inGain = ctx.createGain();
    const out = ctx.createGain();
    const aps = [];
    let prev = inGain;
    for (let i = 0; i < 4; i++) {
      const ap = ctx.createBiquadFilter();
      ap.type = "allpass";
      ap.frequency.value = 300 * (i + 1);
      prev.connect(ap);
      aps.push(ap);
      prev = ap;
    }
    prev.connect(out);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.35;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 280;
    aps.forEach((ap) => lfoGain.connect(ap.frequency));
    lfo.connect(lfoGain);
    lfo.start();
    this.effects.phaser = { in: inGain, out, lfoGain };
  }
  /** Beat-sync the echo to a deck's effective BPM (dotted-eighth repeats). */
  setBpm(bpm) {
    if (!bpm || !isFinite(bpm) || bpm <= 0) return;
    const t = Math.max(0.05, Math.min(1.9, (60 / bpm) * 0.75));
    this.effects.echo.delay.delayTime.setTargetAtTime(t, this.ctx.currentTime, 0.08);
  }

  select(name) {
    if (!this.effects[name] || name === this.current) { this.current = name; this.setDepth(this.depth); return; }
    const old = this.effects[this.current];
    try { this.input.disconnect(old.in); } catch {}
    try { old.out.disconnect(this.wet); } catch {}
    this.current = name;
    const fx = this.effects[name];
    this.input.connect(fx.in);
    fx.out.connect(this.wet);
    this.setDepth(this.depth);
  }
  setOn(on) {
    this.on = on;
    const t = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(on ? this.depth : 0, t, 0.02);
    this.dry.gain.setTargetAtTime(on && this.current === "reverb" ? 0.75 : 0.9, t, 0.02);
  }
  setDepth(d) {
    this.depth = d;
    const t = this.ctx.currentTime;
    if (this.on) this.wet.gain.setTargetAtTime(d, t, 0.02);
    this.effects.echo.fb.gain.setTargetAtTime(0.2 + 0.55 * d, t, 0.02);
    this.effects.flanger.fb.gain.setTargetAtTime(0.3 + 0.45 * d, t, 0.02);
    this.effects.flanger.lfoGain.gain.value = 0.001 + 0.003 * d; // ≤4 ms swing (see _buildFlanger)
    this.effects.phaser.lfoGain.gain.value = 150 + 500 * d;
  }
}

/** A small one-shot sample player — load sounds into pads and trigger them. */
export class Sampler {
  constructor(engine, slots = 8) {
    this.engine = engine;
    this.gain = engine.ctx.createGain();
    this.gain.gain.value = 0.9;
    this.gain.connect(engine.masterBus);
    this.slots = new Array(slots).fill(null); // each: { buffer, name }
    this.active = new Array(slots).fill(null); // currently-playing BufferSource per slot
    this.onChange = null; // (i) => void — fired when a pad starts/stops
  }

  setVolume(v) {
    this.gain.gain.setTargetAtTime(v, this.engine.ctx.currentTime, 0.01);
  }

  async load(i, file) {
    const audio = await this.engine.decode(await file.arrayBuffer());
    this.slots[i] = { buffer: audio, name: file.name.replace(/\.[^.]+$/, "") };
    return this.slots[i];
  }

  setBuffer(i, buffer, name) {
    this.slots[i] = { buffer, name };
  }

  /** Fire a pad. Returns true if a sample played. Restarts cleanly on re-hit. */
  trigger(i) {
    const slot = this.slots[i];
    if (!slot) return false;
    this.stop(i);
    const src = this.engine.ctx.createBufferSource();
    src.buffer = slot.buffer;
    src.connect(this.gain);
    src.onended = () => { if (this.active[i] === src) { this.active[i] = null; this.onChange?.(i); } };
    src.start();
    this.active[i] = src;
    this.onChange?.(i);
    return true;
  }

  /** Stop a pad's playback immediately. */
  stop(i) {
    const src = this.active[i];
    if (!src) return;
    src.onended = null;
    try { src.stop(); } catch {}
    this.active[i] = null;
    this.onChange?.(i);
  }
  stopAll() { for (let i = 0; i < this.active.length; i++) this.stop(i); }
  isPlaying(i) { return !!this.active[i]; }

  clear(i) { this.stop(i); this.slots[i] = null; }
}
