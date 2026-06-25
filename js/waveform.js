// Sxratch waveform display.
// Precomputes min/max peaks from the decoded buffer, then draws a centered
// waveform that scrolls under a fixed playhead in the middle.
//
// Rendering runs on a Web Worker via OffscreenCanvas when supported, so the
// per-frame stroking never competes with input handling on the main thread.
// The main thread keeps the peak data + geometry (for pointer interaction) and
// streams the worker position/cue/loop updates. Falls back to main-thread 2D
// drawing when OffscreenCanvas / module workers aren't available.

import { drawWaveform } from "./waveform-draw.js";

export class Waveform {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { color, bg, playhead }
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.color = opts.color || "#37e6c8";
    this.dim = opts.dim || "rgba(255,255,255,0.18)";
    this.bg = opts.bg || "transparent";
    this.peaks = null;       // Float32Array of [min,max] pairs (kept for geometry)
    this.peakCount = 0;
    this.position = 0;       // 0..1
    this.duration = 0;       // seconds
    this.pixelsPerPeak = 1;  // horizontal zoom (samples view)
    this.cues = [];          // [{ pos, color, label }]
    this.loop = null;        // { start, end } in 0..1, or null
    this.dirty = true;       // set by state changes; the app's RAF loop flushes it
    this.w = 1;
    this.h = 1;
    this.worker = null;      // OffscreenCanvas render worker (preferred)
    this.ctx = null;         // main-thread 2D context (fallback)

    if (typeof OffscreenCanvas !== "undefined" && typeof Worker !== "undefined" &&
        typeof canvas.transferControlToOffscreen === "function") {
      try {
        this.worker = new Worker("/js/waveform-worker.js", { type: "module" });
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        this.w = Math.max(1, Math.floor(rect.width));
        this.h = Math.max(1, Math.floor(rect.height));
        const off = canvas.transferControlToOffscreen();
        this.worker.postMessage(
          { type: "init", canvas: off, color: this.color, dim: this.dim, bg: this.bg, w: this.w, h: this.h, dpr },
          [off]
        );
      } catch (e) {
        if (this.worker) { try { this.worker.terminate(); } catch {} }
        this.worker = null;
      }
    }
    if (!this.worker) {
      this.ctx = canvas.getContext("2d");
      this.resize();
    }
  }

  _state() {
    return {
      w: this.w, h: this.h, bg: this.bg, color: this.color, dim: this.dim,
      peaks: this.peaks, peakCount: this.peakCount, position: this.position,
      pixelsPerPeak: this.pixelsPerPeak, cues: this.cues, loop: this.loop,
    };
  }

  draw() {
    if (this.worker) {
      this.worker.postMessage({
        type: "draw", position: this.position, pixelsPerPeak: this.pixelsPerPeak,
        cues: this.cues, loop: this.loop,
      });
    } else if (this.ctx) {
      drawWaveform(this.ctx, this._state());
    }
  }

  /** Draw at most once per animation frame, only when something changed. */
  renderIfDirty() {
    if (this.dirty) { this.dirty = false; this.draw(); }
  }

  /** Seconds of audio represented by one on-screen pixel (for 1:1 scrubbing). */
  secondsPerPixel() {
    if (!this.peakCount || !this.duration) return 0;
    return this.duration / (this.peakCount * this.pixelsPerPeak);
  }

  /** Convert a canvas-relative x (px) to a track position (0..1). */
  positionAtX(x) {
    if (!this.peakCount) return 0;
    const offsetPeaks = (x - this.w / 2) / this.pixelsPerPeak;
    const pos = this.position + offsetPeaks / this.peakCount;
    return Math.max(0, Math.min(1, pos));
  }

  /** Pixel x for a given position (0..1), in canvas coords. */
  xAtPosition(pos) {
    return this.w / 2 + (pos - this.position) * this.peakCount * this.pixelsPerPeak;
  }

  /** Index of a cue near canvas x (within tol px), or -1. */
  cueAt(x, tol = 9) {
    for (let i = 0; i < this.cues.length; i++) {
      if (Math.abs(this.xAtPosition(this.cues[i].pos) - x) <= tol) return i;
    }
    return -1;
  }

  setCues(cues) { this.cues = cues || []; this.dirty = true; }

  setLoop(loop) {
    const next = loop && loop.active ? { start: loop.start, end: loop.end } : null;
    const cur = this.loop;
    // avoid redraw spam when nothing changed
    if ((!next && !cur) || (next && cur && next.start === cur.start && next.end === cur.end)) return;
    this.loop = next;
    this.dirty = true;
  }

  zoomBy(factor) {
    this.pixelsPerPeak = Math.max(0.25, Math.min(16, this.pixelsPerPeak * factor));
    this.dirty = true;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.floor(rect.width));
    this.h = Math.max(1, Math.floor(rect.height));
    if (this.worker) {
      this.worker.postMessage({ type: "resize", w: this.w, h: this.h, dpr });
    } else if (this.ctx) {
      this.canvas.width = this.w * dpr;
      this.canvas.height = this.h * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.dirty = true;
  }

  /** Build ~4000 peaks/track regardless of length; cheap to scroll. */
  setBuffer(audioBuffer) {
    this.duration = audioBuffer.duration;
    const targetPeaks = 4000;
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
    const total = ch0.length;
    const block = Math.max(1, Math.floor(total / targetPeaks));
    const count = Math.ceil(total / block);
    const peaks = new Float32Array(count * 2);
    for (let p = 0; p < count; p++) {
      let min = 1, max = -1;
      const start = p * block;
      const end = Math.min(total, start + block);
      for (let i = start; i < end; i++) {
        const v = (ch0[i] + ch1[i]) * 0.5;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      peaks[p * 2] = min;
      peaks[p * 2 + 1] = max;
    }
    this.peaks = peaks;
    this.peakCount = count;
    if (this.worker) {
      const copy = peaks.slice();
      this.worker.postMessage({ type: "peaks", peaks: copy.buffer, peakCount: count }, [copy.buffer]);
    }
    this.dirty = true;
  }

  setPosition(pos) {
    if (pos === this.position) return; // gate: idle decks never mark dirty
    this.position = pos;
    this.dirty = true;
  }

  clear() {
    this.peaks = null;
    this.peakCount = 0;
    this.position = 0;
    this.duration = 0;
    this.cues = [];
    if (this.worker) this.worker.postMessage({ type: "peaks", peaks: null, peakCount: 0 });
    this.dirty = true;
  }
}
