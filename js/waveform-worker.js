// Sxratch waveform worker — owns a transferred OffscreenCanvas and does all the
// per-frame stroking off the main thread. The main thread keeps the peak data
// for geometry/interaction and just streams it position/cue/loop/grid updates.

import { drawWaveform } from "./waveform-draw.js";

let ctx = null;
const s = {
  w: 1, h: 1, bg: "transparent", color: "#48ddd3", dim: "rgba(255,255,255,0.18)",
  levels: null, baseCount: 0, duration: 0, grid: null,
  position: 0, pixelsPerPeak: 1, cues: [], loop: null,
};

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case "init": {
      const canvas = m.canvas;
      ctx = canvas.getContext("2d");
      s.color = m.color; s.dim = m.dim; s.bg = m.bg;
      resize(canvas, m.w, m.h, m.dpr);
      break;
    }
    case "resize":
      if (ctx) resize(ctx.canvas, m.w, m.h, m.dpr);
      break;
    case "peaks":
      s.levels = m.levels
        ? m.levels.map((L) => ({ count: L.count, total: new Float32Array(L.total), low: new Float32Array(L.low) }))
        : null;
      s.baseCount = m.baseCount || 0;
      s.duration = m.duration || 0;
      draw();
      break;
    case "grid":
      s.grid = m.grid || null;
      if (m.duration != null) s.duration = m.duration;
      draw();
      break;
    case "draw":
      s.position = m.position;
      s.pixelsPerPeak = m.pixelsPerPeak;
      s.cues = m.cues || [];
      s.loop = m.loop || null;
      draw();
      break;
  }
};

function resize(canvas, w, h, dpr) {
  s.w = Math.max(1, w | 0);
  s.h = Math.max(1, h | 0);
  canvas.width = s.w * dpr;
  canvas.height = s.h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function draw() { if (ctx) drawWaveform(ctx, s); }
