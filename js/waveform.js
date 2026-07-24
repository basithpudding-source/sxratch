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
    this.peaks = null;       // level-0 full-range peaks (kept for geometry + thumbnails)
    this.peakCount = 0;      // level-0 count — all geometry is expressed against this
    this.levels = null;      // [{count, total, low}] coarse→fine, for zoomable two-band drawing
    this.grid = null;        // { bpm, offset, anchored } — real beat grid, or null
    this.position = 0;       // 0..1
    this.duration = 0;       // seconds
    this.pixelsPerPeak = 1;  // horizontal zoom (pixels per level-0 peak)
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
        // Resolve relative to this module so it works from any base path
        // (dev, dist bundle, or subpath hosting) — esbuild keeps import.meta.url in ESM output.
        this.worker = new Worker(new URL("./waveform-worker.js", import.meta.url), { type: "module" });
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
      levels: this.levels, baseCount: this.peakCount, position: this.position,
      pixelsPerPeak: this.pixelsPerPeak, cues: this.cues, loop: this.loop,
      grid: this.grid, duration: this.duration,
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
    // Finer peak levels back the higher zooms, so 64 px/peak stays detailed.
    this.pixelsPerPeak = Math.max(0.25, Math.min(64, this.pixelsPerPeak * factor));
    this.dirty = true;
  }

  /**
   * Real beat grid drawn under the waveform. `bpm` in track time (the grid
   * belongs to the file, so the tempo fader does not move it), `offset` =
   * first-downbeat seconds, `anchored` = the downbeat is actually known
   * (PAD renders / presets) — bar numbers only show when it is.
   */
  setBeatGrid(grid) {
    this.grid = grid && grid.bpm ? {
      bpm: grid.bpm,
      offset: grid.offset || 0,
      anchored: !!grid.anchored,
    } : null;
    if (this.worker) this.worker.postMessage({ type: "grid", grid: this.grid, duration: this.duration });
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

  /**
   * Build a 3-level peak pyramid (~4k / 16k / 64k peaks) in two bands:
   * full-range and low-band (one-pole LPF ≈ 180 Hz), one pass over the samples.
   * Level 0 backs all geometry; the draw routine picks the finest level the
   * current zoom needs, so high zooms stay detailed instead of blocky.
   */
  setBuffer(audioBuffer) {
    this.duration = audioBuffer.duration;
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
    const total = ch0.length;
    const sr = audioBuffer.sampleRate || 44100;

    // Finest level first (≤ 64k peaks), then reduce ×4 twice.
    const fineTarget = Math.min(total, 64000);
    const block = Math.max(1, Math.floor(total / fineTarget));
    const fineCount = Math.ceil(total / block);
    const fineTotal = new Float32Array(fineCount * 2);
    const fineLow = new Float32Array(fineCount * 2);
    const a = 1 - Math.exp((-2 * Math.PI * 180) / sr); // low-band one-pole coefficient
    let lp = 0;
    for (let p = 0; p < fineCount; p++) {
      let min = 1, max = -1, lmin = 1, lmax = -1;
      const start = p * block;
      const end = Math.min(total, start + block);
      for (let i = start; i < end; i++) {
        const v = (ch0[i] + ch1[i]) * 0.5;
        lp += a * (v - lp);
        if (v < min) min = v;
        if (v > max) max = v;
        if (lp < lmin) lmin = lp;
        if (lp > lmax) lmax = lp;
      }
      fineTotal[p * 2] = min; fineTotal[p * 2 + 1] = max;
      fineLow[p * 2] = lmin;  fineLow[p * 2 + 1] = lmax;
    }

    const reduce = (src, count) => {
      const outCount = Math.ceil(count / 4);
      const out = new Float32Array(outCount * 2);
      for (let p = 0; p < outCount; p++) {
        let min = 1, max = -1;
        for (let k = p * 4; k < Math.min(count, p * 4 + 4); k++) {
          if (src[k * 2] < min) min = src[k * 2];
          if (src[k * 2 + 1] > max) max = src[k * 2 + 1];
        }
        out[p * 2] = min; out[p * 2 + 1] = max;
      }
      return { out, outCount };
    };
    const t1 = reduce(fineTotal, fineCount), l1 = reduce(fineLow, fineCount);
    const t0 = reduce(t1.out, t1.outCount), l0 = reduce(l1.out, l1.outCount);

    this.levels = [
      { count: t0.outCount, total: t0.out, low: l0.out },
      { count: t1.outCount, total: t1.out, low: l1.out },
      { count: fineCount, total: fineTotal, low: fineLow },
    ];
    this.peaks = t0.out;        // compat: geometry + album-art thumbnails
    this.peakCount = t0.outCount;

    if (this.worker) {
      const transfer = [];
      const payload = this.levels.map((L) => {
        const total2 = L.total.slice(), low2 = L.low.slice();
        transfer.push(total2.buffer, low2.buffer);
        return { count: L.count, total: total2.buffer, low: low2.buffer };
      });
      this.worker.postMessage(
        { type: "peaks", levels: payload, baseCount: this.peakCount, duration: this.duration },
        transfer
      );
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
    this.levels = null;
    this.grid = null;
    this.position = 0;
    this.duration = 0;
    this.cues = [];
    if (this.worker) this.worker.postMessage({ type: "peaks", levels: null, baseCount: 0, duration: 0 });
    this.dirty = true;
  }
}
// Worker URL resolves via import.meta.url so subpath hosting works (see ctor).
