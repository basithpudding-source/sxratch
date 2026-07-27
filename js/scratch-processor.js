// Sxratch scratch engine — runs on the audio thread (AudioWorkletGlobalScope).
//
// Why a custom processor instead of AudioBufferSourceNode?
//   A standard buffer source can only play forward at a positive rate. Real
//   scratching needs to play BACKWARD and at an arbitrary, hand-driven speed
//   that changes sample-by-sample. So we keep our own floating-point playhead
//   and read the track with linear interpolation at whatever rate the hand (or
//   the "motor") dictates.
//
// Control model (a virtual turntable):
//   - When the user is "touching" the platter, the hand fully drives the speed.
//     The main thread sends instantaneous jog velocity on each pointer move; we
//     decay it toward zero between messages so that a still finger = a stopped
//     record (audio holds), while continuous motion stays smooth.
//   - When not touching, a "motor" eases the rate toward the base rate (if
//     playing) or toward zero (if paused) — giving turntable-like spin-up and
//     brake inertia.
//
// Interpolation + loop-seam handling live in js/scratch-kernel.js (pure,
// node-tested; inlined into this file by the production bundle).

import { readClamped, createSeamState, seamStart, seamTick } from "./scratch-kernel.js";

class ScratchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.channels = null;     // Array<Float32Array>, one per channel
    this.numChannels = 0;
    this.length = 0;          // length in samples

    this.playhead = 0;        // floating-point sample index
    this.playing = false;     // motor on/off
    this.touching = false;    // finger on platter

    this.baseRate = 1;        // tempo/pitch base (1 = normal)
    this.currentRate = 0;     // smoothed actual rate
    this.jogTarget = 0;       // hand-driven instantaneous rate

    // Per-sample smoothing coefficients, derived from the real sample rate.
    // Motor inertia: how fast the rate eases to its target when not touching.
    this.inertia = 1 - Math.exp(-1 / (0.09 * sampleRate));
    // Jog decay: how fast hand velocity bleeds toward zero between pointer
    // moves. ~35 ms half-life: stays smooth between 60 Hz move events, but a
    // finger held still settles to a stop within ~100 ms.
    this.jogDecay = Math.pow(0.5, 1 / (0.035 * sampleRate));

    // Loop points (samples) and transport FX
    this.loopActive = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.braking = false;   // vinyl brake — slow to a stop
    this.spinning = false;  // back-spin — flick the record backward
    this.brakeInertia = 1 - Math.exp(-1 / (0.5 * sampleRate));  // ~0.5 s to stop
    this.spinInertia = 1 - Math.exp(-1 / (0.4 * sampleRate));   // ~0.4 s to recover

    this.reportInterval = Math.floor(sampleRate * 0.04); // ~25 fps position posts
    this.sinceReport = 0;

    // Loop-seam crossfade (~5 ms): blends the post-wrap audio with the ghost
    // continuation of the pre-wrap trajectory so loop wraps don't click.
    this.seam = createSeamState(Math.max(32, Math.round(sampleRate * 0.005)));

    // Optional lock-free jog channel (SharedArrayBuffer). When present, the main
    // thread writes jog velocity here and bumps a generation counter; we poll it
    // once per render block instead of waiting on postMessage. f32[0] = velocity,
    // i32[1] = generation. Falls back to the "jog" message when absent.
    this.controlF = null;
    this.controlI = null;
    this.lastGen = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    switch (msg.type) {
      case "load":
        this.channels = msg.channels.map((b) => new Float32Array(b));
        this.numChannels = this.channels.length;
        this.length = this.channels[0] ? this.channels[0].length : 0;
        this.playhead = 0;
        this.currentRate = 0;
        this.jogTarget = 0;
        this.playing = false;
        this.touching = false;
        this.loopActive = false;
        this.braking = false;
        this.spinning = false;
        this.port.postMessage({ type: "loaded", length: this.length });
        break;
      case "play":
        if (this.length > 0) {
          if (this.playhead >= this.length - 1) this.playhead = 0;
          this.playing = true;
        }
        break;
      case "pause":
        this.playing = false;
        break;
      case "toggle":
        this.playing = this.length > 0 ? !this.playing : false;
        if (this.playing && this.playhead >= this.length - 1) this.playhead = 0;
        break;
      case "seek": // position in [0,1]
        this.playhead = Math.max(0, Math.min(this.length - 1, msg.position * this.length));
        break;
      case "cue":
        this.cuePoint = Math.max(0, Math.min(this.length - 1, (msg.position ?? 0) * this.length));
        this.playhead = this.cuePoint;
        break;
      case "touchStart":
        this.touching = true;
        this.jogTarget = 0;
        break;
      case "touchEnd":
        this.touching = false;
        break;
      case "jog":
        // Instantaneous hand velocity in rate units (1 = normal speed forward).
        this.jogTarget = msg.velocity;
        this.touching = true;
        break;
      case "rate":
        this.baseRate = msg.value;
        break;
      case "loopIn":
        this.loopStart = this.playhead;
        break;
      case "loopOut":
        this.loopEnd = this.playhead;
        this.loopActive = this.loopEnd > this.loopStart + 1;
        break;
      case "loopAuto": // msg.samples = loop length
        this.loopStart = this.playhead;
        this.loopEnd = Math.min(this.length - 1, this.playhead + msg.samples);
        this.loopActive = this.loopEnd > this.loopStart + 1;
        break;
      case "loopExit":
        this.loopActive = false;
        break;
      case "loopHalve":
        if (this.loopActive) this.loopEnd = this.loopStart + (this.loopEnd - this.loopStart) / 2;
        break;
      case "loopDouble":
        if (this.loopActive) this.loopEnd = Math.min(this.length - 1, this.loopStart + (this.loopEnd - this.loopStart) * 2);
        break;
      case "brake":
        this.braking = !!msg.on;
        break;
      case "backspin":
        this.spinning = true;
        this.currentRate = -12;
        break;
      case "control": // SharedArrayBuffer jog channel from the main thread
        this.controlF = new Float32Array(msg.buffer);
        this.controlI = new Int32Array(msg.buffer);
        this.lastGen = Atomics.load(this.controlI, 1);
        break;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const chCount = out.length;
    const frames = out[0].length;

    // Poll the lock-free jog channel once per block: a new generation means a
    // fresh hand-driven velocity, equivalent to receiving a "jog" message.
    if (this.controlI) {
      const gen = Atomics.load(this.controlI, 1);
      if (gen !== this.lastGen) {
        this.lastGen = gen;
        this.jogTarget = this.controlF[0];
        this.touching = true;
      }
    }

    if (!this.channels || this.length === 0) {
      for (let c = 0; c < chCount; c++) out[c].fill(0);
      return true;
    }

    const len = this.length;
    const last = len - 1;

    for (let i = 0; i < frames; i++) {
      // --- update rate ---
      if (this.touching) {
        this.jogTarget *= this.jogDecay;
        this.currentRate = this.jogTarget;
      } else if (this.spinning) {
        const target = this.playing ? this.baseRate : 0;
        this.currentRate += (target - this.currentRate) * this.spinInertia;
        if (Math.abs(this.currentRate - target) < 0.01) { this.currentRate = target; this.spinning = false; }
      } else if (this.braking) {
        this.currentRate += (0 - this.currentRate) * this.brakeInertia;
      } else {
        const target = this.playing ? this.baseRate : 0;
        this.currentRate += (target - this.currentRate) * this.inertia;
        if (Math.abs(this.currentRate) < 1e-5) this.currentRate = target === 0 ? 0 : this.currentRate;
      }

      // --- read interpolated sample at the playhead ---
      // 4-point Catmull-Rom cubic (js/scratch-kernel.js): smoother and lower-
      // aliasing than linear under hard hand-driven rates. During a loop-wrap
      // crossfade, the post-wrap audio blends with a "ghost" continuation of
      // the pre-wrap trajectory so the seam doesn't click.
      const ph = this.playhead;
      const seam = this.seam;
      for (let c = 0; c < chCount; c++) {
        const data = this.channels[c] || this.channels[0];
        let v = readClamped(data, ph, last);
        if (seam.active) v = v * seam.wMain + readClamped(data, seam.ph, last) * seam.wGhost;
        out[c][i] = v;
      }
      if (seam.active) seamTick(seam, this.currentRate, last);

      // --- advance the playhead (with loop wrap + seam crossfade) ---
      this.playhead += this.currentRate;
      if (this.loopActive && this.loopEnd > this.loopStart + 1) {
        const loopLen = this.loopEnd - this.loopStart;
        if (this.playhead >= this.loopEnd) {
          seamStart(seam, this.playhead, loopLen);
          this.playhead -= loopLen;
        } else if (this.playhead < this.loopStart) {
          seamStart(seam, this.playhead, loopLen);
          this.playhead += loopLen;
        }
      } else if (this.playhead <= 0) {
        this.playhead = 0;
        if (this.currentRate < 0 && !this.touching) this.currentRate = 0;
      } else if (this.playhead >= last) {
        this.playhead = last;
        this.currentRate = 0;
        this.playing = false;
      }
    }

    // --- throttled position report to the main thread ---
    this.sinceReport += frames;
    if (this.sinceReport >= this.reportInterval) {
      this.sinceReport = 0;
      this.port.postMessage({
        type: "pos",
        position: len > 1 ? this.playhead / last : 0,
        playing: this.playing,
        rate: this.currentRate,
        loopActive: this.loopActive,
        loopStart: (this.loopEnd > this.loopStart && len > 1) ? this.loopStart / last : -1,
        loopEnd: (this.loopEnd > this.loopStart && len > 1) ? this.loopEnd / last : -1,
      });
    }

    return true;
  }
}

registerProcessor("scratch-processor", ScratchProcessor);
