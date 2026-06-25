// Shared waveform rendering — pure given a 2D context and a state snapshot.
// Used by the main-thread Waveform (fallback) and by the OffscreenCanvas worker,
// so the pixels are identical whichever thread draws them.
//
// state: { w, h, bg, color, dim, peaks:Float32Array|null, peakCount, position,
//          pixelsPerPeak, cues:[{pos,color,label}], loop:{start,end}|null }

const xAt = (s, pos) => s.w / 2 + (pos - s.position) * s.peakCount * s.pixelsPerPeak;

export function drawWaveform(ctx, s) {
  const w = s.w, h = s.h, mid = h / 2;
  ctx.clearRect(0, 0, w, h);

  if (s.bg && s.bg !== "transparent") { ctx.fillStyle = s.bg; ctx.fillRect(0, 0, w, h); }

  // center line
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

  if (s.peaks && s.peakCount) {
    const pps = s.pixelsPerPeak;
    const centerPeak = s.position * s.peakCount;
    const centerX = w / 2;
    const firstPeak = Math.floor(centerPeak - centerX / pps);
    const lastPeak = Math.ceil(centerPeak + centerX / pps);
    for (let p = firstPeak; p <= lastPeak; p++) {
      if (p < 0 || p >= s.peakCount) continue;
      const x = centerX + (p - centerPeak) * pps;
      const min = s.peaks[p * 2], max = s.peaks[p * 2 + 1];
      const y1 = mid - max * (mid - 2);
      const y2 = mid - min * (mid - 2);
      // played portion brighter than the upcoming portion
      ctx.strokeStyle = x <= centerX ? s.dim : s.color;
      ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2 + 0.5); ctx.stroke();
    }

    // loop region
    if (s.loop) {
      const x1 = xAt(s, s.loop.start), x2 = xAt(s, s.loop.end);
      ctx.fillStyle = "rgba(108,123,255,0.16)";
      ctx.fillRect(x1, 0, x2 - x1, h);
      ctx.strokeStyle = "rgba(108,123,255,0.7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x1, 0); ctx.lineTo(x1, h);
      ctx.moveTo(x2, 0); ctx.lineTo(x2, h);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // hot cues
    for (const cue of s.cues || []) {
      const x = xAt(s, cue.pos);
      if (x < -10 || x > w + 10) continue;
      ctx.fillStyle = cue.color || "#ffd23f";
      ctx.fillRect(x - 1, 0, 2, h);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 12, 0); ctx.lineTo(x, 12); ctx.closePath(); ctx.fill();
      if (cue.label != null) {
        ctx.fillStyle = "#06070b";
        ctx.font = "bold 8px Inter, sans-serif";
        ctx.fillText(String(cue.label), x + 1.5, 8);
      }
    }
  }

  // fixed playhead at center
  const px = w / 2;
  ctx.strokeStyle = "#ff2d55";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  ctx.lineWidth = 1;
}
