// Sxratch waveform worker — owns a transferred OffscreenCanvas and does all the
// per-frame stroking off the main thread. The main thread keeps the peak data
// for geometry/interaction and just streams it position/cue/loop/grid updates.

import { drawWaveform } from "./waveform-draw.js";

let ctx = null;
const s = {
  // color fallback = tokens.css --sx-brand-a (dark); real values arrive via init/theme messages
  w: 1, h: 1, bg: "transparent", color: "#48ddd3",
  levels: null, baseCount: 0, duration: 0, grid: null,
  position: 0, pixelsPerPeak: 1, cues: [], loop: null,
  ink: null,   // theme colours; null = drawWaveform's dark defaults
};

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case "init": {
      const canvas = m.canvas;
      ctx = canvas.getContext("2d");
      s.color = m.color; s.bg = m.bg;
      if (m.ink) s.ink = m.ink;
      resize(canvas, m.w, m.h, m.dpr);
      break;
    }
    // The canvas is transferred, so the main thread can never repaint it
    // directly — a theme change HAS to arrive as a message.
    case "theme":
      if (m.color) s.color = m.color;
      if (m.bg != null) s.bg = m.bg;
      s.ink = m.ink || null;
      draw();
      break;
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
