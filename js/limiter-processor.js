// Sxratch master limiter — a look-ahead brickwall limiter on the audio thread.
//
// The master bus previously used a DynamicsCompressor as a crude limiter. A true
// look-ahead limiter detects peaks on the *incoming* signal and applies the gain
// reduction to a short *delayed* copy, so the reduction has already ramped in by
// the time a transient reaches the output — no overshoot, cleaner and louder than
// a compressor. Gain is channel-linked to keep the stereo image intact.

class LimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "ceiling", defaultValue: 0.97, minValue: 0.05, maxValue: 1, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    this.lookahead = Math.max(1, Math.round(0.003 * sampleRate)); // 3 ms look-ahead
    this.delay = [new Float32Array(this.lookahead), new Float32Array(this.lookahead)];
    this.dpos = 0;
    this.gain = 1;
    this.attack = 1 - Math.exp(-1 / (0.0015 * sampleRate)); // ~1.5 ms to clamp a peak
    this.release = 1 - Math.exp(-1 / (0.12 * sampleRate));  // ~120 ms recovery
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const chCount = output.length;
    const frames = output[0].length;
    const ceilParam = parameters.ceiling;

    if (!input || input.length === 0) {
      for (let c = 0; c < chCount; c++) output[c].fill(0);
      return true;
    }

    for (let i = 0; i < frames; i++) {
      const ceil = ceilParam.length > 1 ? ceilParam[i] : ceilParam[0];

      // Peak of the *incoming* frame across channels.
      let peak = 0;
      for (let c = 0; c < input.length; c++) { const a = Math.abs(input[c][i]); if (a > peak) peak = a; }
      const desired = peak > ceil ? ceil / peak : 1;

      // Fast attack toward a needed reduction, slow release back to unity.
      this.gain += (desired - this.gain) * (desired < this.gain ? this.attack : this.release);

      // Apply the (already ramping) gain to the delayed signal.
      for (let c = 0; c < chCount; c++) {
        const inCh = input[c] || input[0];
        const d = this.delay[c] || this.delay[0];
        const delayed = d[this.dpos];
        d[this.dpos] = inCh ? inCh[i] : 0;
        output[c][i] = delayed * this.gain;
      }
      if (++this.dpos >= this.lookahead) this.dpos = 0;
    }
    return true;
  }
}

registerProcessor("limiter-processor", LimiterProcessor);
