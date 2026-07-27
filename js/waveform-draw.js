// Shared waveform rendering — pure given a 2D context and a state snapshot.
// Used by the main-thread Waveform (fallback) and by the OffscreenCanvas worker,
// so the pixels are identical whichever thread draws them.
//
// state: { w, h, bg, color,
//          levels: [{count, total:Float32Array, low:Float32Array}] | null,
//          baseCount, position, pixelsPerPeak, duration,
//          grid: {bpm, offset, anchored} | null,
//          cues: [{pos,color,label}], loop: {start,end} | null,
//          ink: {body, gridBeat, gridBar, label, centre, playhead, cueInk} }
//
// `ink` carries the theme. It must be PASSED IN, not read from the DOM: this
// module also runs inside a Web Worker that owns a transferred OffscreenCanvas
// and has no `getComputedStyle`. THEME_INK below is the dark-theme default so
// the module is still correct if nobody supplies one.
//
// Rendering model (Serato-style two-band): the full-range peaks draw as a pale
// body and the low-band (≈ <180 Hz) peaks overlay in the deck colour, so kicks
// and basslines read at a glance. Multiple peak resolutions keep high zooms
// detailed instead of blocky. A real beat grid (from the deck's BPM) replaces
// any decorative ruler — bar numbers only appear when the grid is anchored
// (PAD renders / presets), never for merely-detected tempos.

const xAt = (s, pos) => s.w / 2 + (pos - s.position) * s.baseCount * s.pixelsPerPeak;

/** Dark-theme defaults — every value is overridable through `state.ink`. */
export const THEME_INK = {
  body: "#eef4f8",
  gridBeat: "rgba(255,255,255,0.28)",
  gridBar: "rgba(255,255,255,0.10)",
  label: "rgba(255,255,255,0.55)",
  centre: "rgba(255,255,255,0.08)",
  playhead: "#ff2d55",
  cueInk: "#06070b",
  cueFallback: "#ffd23f",
};
const ink = (s) => (s.ink ? { ...THEME_INK, ...s.ink } : THEME_INK);

/** Choose the finest peak level that still has ≥ ~1 peak per 2.5 px. */
function pickLevel(s) {
  const ls = s.levels;
  if (!ls || !ls.length || !s.baseCount) return null;
  let k = 0;
  while (k < ls.length - 1 && s.pixelsPerPeak / (ls[k].count / s.baseCount) > 2.5) k++;
  return ls[k];
}

function drawBeatGrid(ctx, s) {
  const g = s.grid;
  if (!g || !g.bpm || !s.duration || !s.baseCount) return;
  const pxPerSec = (s.baseCount * s.pixelsPerPeak) / s.duration;
  const beatSec = 60 / g.bpm;
  if (beatSec * pxPerSec < 6) return; // too dense to be useful
  const centerX = s.w / 2;
  const posSec = s.position * s.duration;
  const off = g.offset || 0;
  const k = ink(s);
  const first = Math.max(0, Math.ceil((posSec - centerX / pxPerSec - off) / beatSec));
  const last = Math.floor((posSec + centerX / pxPerSec - off) / beatSec);
  ctx.lineWidth = 1;
  for (let b = first; b <= last; b++) {
    const t = off + b * beatSec;
    if (t > s.duration) break;
    const x = Math.round(centerX + (t - posSec) * pxPerSec) + 0.5;
    const bar = b % 4 === 0;
    ctx.strokeStyle = bar ? k.gridBeat : k.gridBar;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, s.h); ctx.stroke();
    if (bar && g.anchored && beatSec * 4 * pxPerSec > 34) {
      ctx.fillStyle = k.label;
      ctx.font = "bold 8px ui-monospace, monospace";
      ctx.fillText(String(b / 4 + 1), x + 3, 9);
    }
  }
}

export function drawWaveform(ctx, s) {
  const w = s.w, h = s.h, mid = h / 2;
  const k = ink(s);
  ctx.clearRect(0, 0, w, h);

  if (s.bg && s.bg !== "transparent") { ctx.fillStyle = s.bg; ctx.fillRect(0, 0, w, h); }

  // center line
  ctx.strokeStyle = k.centre;
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

  drawBeatGrid(ctx, s);

  const L = pickLevel(s);
  if (L) {
    const ratio = L.count / s.baseCount;             // this level's peaks per base peak
    const pps = s.pixelsPerPeak / ratio;             // pixels per peak at this level
    const centerPeak = s.position * L.count;
    const centerX = w / 2;
    const firstPeak = Math.floor(centerPeak - centerX / pps);
    const lastPeak = Math.ceil(centerPeak + centerX / pps);
    const bw = Math.max(1, pps);                     // bar width
    const scale = mid - 2;

    for (let p = firstPeak; p <= lastPeak; p++) {
      if (p < 0 || p >= L.count) continue;
      const x = centerX + (p - centerPeak) * pps;
      const played = x <= centerX;

      // full-range body (reads as the hi/mid content) — pale
      let max = L.total[p * 2 + 1], min = L.total[p * 2];
      ctx.globalAlpha = played ? 0.14 : 0.34;
      ctx.fillStyle = k.body;
      ctx.fillRect(x, mid - max * scale, bw, (max - min) * scale + 0.5);

      // low band — deck colour, the beat you steer by
      max = L.low[p * 2 + 1]; min = L.low[p * 2];
      ctx.globalAlpha = played ? 0.42 : 0.95;
      ctx.fillStyle = s.color;
      ctx.fillRect(x, mid - max * scale, bw, (max - min) * scale + 0.5);
    }
    ctx.globalAlpha = 1;

    // loop region — tinted in the deck's own colour (not a foreign accent)
    if (s.loop) {
      const x1 = xAt(s, s.loop.start), x2 = xAt(s, s.loop.end);
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = s.color;
      ctx.fillRect(x1, 0, x2 - x1, h);
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x1, 0); ctx.lineTo(x1, h);
      ctx.moveTo(x2, 0); ctx.lineTo(x2, h);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.globalAlpha = 1;
    }

    // hot cues
    for (const cue of s.cues || []) {
      const x = xAt(s, cue.pos);
      if (x < -10 || x > w + 10) continue;
      ctx.fillStyle = cue.color || k.cueFallback;
      ctx.fillRect(x - 1, 0, 2, h);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 12, 0); ctx.lineTo(x, 12); ctx.closePath(); ctx.fill();
      if (cue.label != null) {
        ctx.fillStyle = k.cueInk;
        ctx.font = "bold 8px Inter, sans-serif";
        ctx.fillText(String(cue.label), x + 1.5, 8);
      }
    }
  }

  // fixed playhead at center
  const px = w / 2;
  ctx.strokeStyle = k.playhead;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  ctx.lineWidth = 1;
}
