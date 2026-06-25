// Sxratch synthesized audio presets.
// Zero external assets/dependencies: all sounds generated mathematically on client boot.

export function generateScratchPreset(ctx) {
  const sr = ctx.sampleRate;
  const dur = 6.0;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);

  // Helper to add audio elements to the buffer
  const add = (startSec, durSec, func) => {
    const startIdx = Math.floor(startSec * sr);
    const endIdx = Math.floor((startSec + durSec) * sr);
    for (let i = startIdx; i < endIdx && i < len; i++) {
      const t = (i - startIdx) / sr;
      const progress = (i - startIdx) / (endIdx - startIdx);
      const val = func(t, progress);
      L[i] += val;
      R[i] += val;
    }
  };

  // 1. Kick/Snare beat (0.0s - 1.2s)
  // Let's create a classic kick-snare-kick-snare scratch break!
  const kick = (t) => Math.sin(2 * Math.PI * (45 + 120 * Math.exp(-t * 28)) * t) * Math.exp(-t * 8) * 0.8;
  const snare = (t) => {
    const noise = (Math.random() * 2 - 1) * Math.exp(-t * 12) * 0.45;
    const tone = Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 18) * 0.25;
    return noise + tone;
  };

  add(0.0, 0.3, kick);
  add(0.3, 0.3, snare);
  add(0.6, 0.3, kick);
  add(0.9, 0.3, snare);

  // 2. Vowel "Ahhh" (1.5s - 3.2s)
  // Harmonic / formant vocal synthesizer for "Ah"
  // Formants for /a/: F1 = 730 Hz, F2 = 1090 Hz, F3 = 2440 Hz
  add(1.5, 1.7, (t, progress) => {
    const env = progress < 0.15 ? progress / 0.15 : progress > 0.85 ? (1 - progress) / 0.15 : 1;
    const f0 = 130 + 3.5 * Math.sin(2 * Math.PI * 5.5 * t); // Fundamental frequency with vibrato
    
    let val = 0;
    const numHarmonics = 30;
    for (let h = 1; h <= numHarmonics; h++) {
      const f = h * f0;
      if (f > 4000) break;
      const a1 = Math.exp(-Math.pow((f - 730) / 150, 2)) * 1.0;
      const a2 = Math.exp(-Math.pow((f - 1090) / 150, 2)) * 0.8;
      const a3 = Math.exp(-Math.pow((f - 2440) / 250, 2)) * 0.4;
      const amp = (a1 + a2 + a3) / h;
      val += amp * Math.sin(2 * Math.PI * f * t);
    }
    return Math.tanh(val * 1.6) * env * 0.42;
  });

  // 3. Vowel "Fresh" (3.5s - 5.0s)
  // Vowel synthesis for "Fresh": noise transient "Fr" + vowel "ee" + sibilant noise "sh"
  add(3.5, 1.5, (t, progress) => {
    const env = progress < 0.05 ? progress / 0.05 : progress > 0.8 ? (1 - progress) / 0.2 : 1;
    if (t < 0.15) {
      // "Fr" noise transient
      const noise = Math.random() * 2 - 1;
      return noise * 0.22 * Math.exp(-t * 20) * env;
    } else if (t < 0.6) {
      // "ee" vowel formants: F1 = 270 Hz, F2 = 2290 Hz, F3 = 3010 Hz
      const vt = t - 0.15;
      const f0 = 140 + 3 * Math.sin(2 * Math.PI * 6 * vt);
      let val = 0;
      for (let h = 1; h <= 25; h++) {
        const f = h * f0;
        if (f > 4200) break;
        const a1 = Math.exp(-Math.pow((f - 270) / 100, 2)) * 1.0;
        const a2 = Math.exp(-Math.pow((f - 2290) / 200, 2)) * 0.7;
        const a3 = Math.exp(-Math.pow((f - 3010) / 250, 2)) * 0.4;
        const amp = (a1 + a2 + a3) / h;
        val += amp * Math.sin(2 * Math.PI * f * vt);
      }
      return Math.tanh(val * 1.5) * env * 0.4;
    } else {
      // "sh" high-frequency sibilance
      const st = t - 0.6;
      let noise = 0;
      // High-passed noise approximation: difference of adjacent random samples
      for (let k = 0; k < 4; k++) noise += Math.random() * 2 - 1;
      noise /= 4;
      return noise * 0.2 * Math.exp(-st * 4.5) * env;
    }
  });

  // 4. Laser pitch sweeps (5.2s - 6.0s)
  add(5.2, 0.8, (t, progress) => {
    const f0 = 2200;
    const f1 = 120;
    const r = f1 / f0;
    const phase = 2 * Math.PI * f0 * (Math.pow(r, t) - 1) / Math.log(r);
    const env = Math.exp(-t * 4.5) * (1 - progress);
    return Math.sin(phase) * env * 0.45;
  });

  // Saturation limiting on entire output
  for (let i = 0; i < len; i++) {
    L[i] = Math.tanh(L[i] * 1.1);
    R[i] = Math.tanh(R[i] * 1.1);
  }

  return buf;
}

export function generateLaserPreset(ctx) {
  const sr = ctx.sampleRate;
  const dur = 2.0;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);

  const sweep = (t, dur, f0, f1, decay) => {
    const progress = t / dur;
    const r = f1 / f0;
    const phase = 2 * Math.PI * f0 * (Math.pow(r, t) - 1) / Math.log(r);
    return Math.sin(phase) * Math.exp(-t * decay);
  };

  const addLaser = (startSec, durSec, f0, f1, dec) => {
    const startIdx = Math.floor(startSec * sr);
    const endIdx = Math.floor((startSec + durSec) * sr);
    for (let i = startIdx; i < endIdx && i < len; i++) {
      const t = (i - startIdx) / sr;
      const val = sweep(t, durSec, f0, f1, dec);
      L[i] += val * 0.35;
      R[i] += val * 0.35;
    }
  };

  addLaser(0.0, 0.5, 1800, 100, 6.0);
  addLaser(0.6, 0.5, 2400, 200, 7.0);
  addLaser(1.2, 0.5, 1200, 80, 5.0);

  for (let i = 0; i < len; i++) {
    L[i] = Math.tanh(L[i]);
    R[i] = Math.tanh(R[i]);
  }
  return buf;
}
