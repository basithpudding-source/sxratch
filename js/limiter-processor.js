// Sxratch master limiter — a look-ahead brickwall limiter on the audio thread.
//
// Thin shell over the shared kernel in js/limiter-kernel.js: the sliding-
// window-minimum look-ahead algorithm (with hard ceiling clamp) is the SAME
// code the offline mastering pass uses, and the same code the node test suite
// exercises — what ships live is what's tested. Gain is channel-linked to
// keep the stereo image intact.

import { createLimiterKernel } from "./limiter-kernel.js";

class LimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "ceiling", defaultValue: 0.97, minValue: 0.05, maxValue: 1, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    this.kernel = createLimiterKernel(sampleRate); // 3 ms look-ahead, 120 ms release
    this.inRefs = [];                              // reused per block — no audio-thread allocation
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const chCount = output.length;
    const frames = output[0].length;

    if (!input || input.length === 0) {
      for (let c = 0; c < chCount; c++) output[c].fill(0);
      return true;
    }

    // Map input channels onto the output channel count (mono input feeds both).
    if (this.inRefs.length !== chCount) this.inRefs.length = chCount;
    for (let c = 0; c < chCount; c++) this.inRefs[c] = input[c] || input[0];

    const ceilParam = parameters.ceiling;
    this.kernel.process(this.inRefs, output, 0, frames, ceilParam[0]);
    return true;
  }
}

registerProcessor("limiter-processor", LimiterProcessor);
