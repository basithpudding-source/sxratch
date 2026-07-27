// Shared metronome — Web-Audio-clock click scheduler used by Practice mode's
// timing drills and the PAD composer's count-in / click-along.
//
// Scheduling model: a short setTimeout loop keeps ~250 ms of clicks scheduled
// ahead on the audio clock, so timing is sample-accurate regardless of main-
// thread jank.

/**
 * @param {AudioContext} ctx
 * @param {AudioNode} destination where clicks are routed
 */
export function createMetronome(ctx, destination) {
  let state = null; // { bpm, beatsPerBar, t0, next, beat, timer, maxBeats }

  const click = (time, accent) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1050;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.32, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(g); g.connect(destination);
    osc.start(time); osc.stop(time + 0.06);
  };

  return {
    /**
     * Start clicking. `startAt` (audio-clock time) defaults to "now"+0.12.
     * `maxBeats` limits the run (e.g. a 1-bar count-in); omit for endless.
     */
    start({ bpm, beatsPerBar = 4, startAt, maxBeats } = {}) {
      this.stop();
      const period = 60 / bpm;
      const t0 = startAt ?? ctx.currentTime + 0.12;
      state = { bpm, beatsPerBar, t0, next: t0, beat: 0, timer: null, maxBeats };
      const schedule = () => {
        while (state && state.next < ctx.currentTime + 0.25) {
          if (state.maxBeats != null && state.beat >= state.maxBeats) { this.stop(); return; }
          click(state.next, state.beat % state.beatsPerBar === 0);
          state.next += period;
          state.beat++;
        }
        if (state) state.timer = setTimeout(schedule, 50);
      };
      schedule();
      return t0;
    },
    stop() {
      if (state) { clearTimeout(state.timer); state = null; }
    },
    /** The audio-clock time of the first beat, or null when stopped. */
    get t0() { return state ? state.t0 : null; },
    get running() { return !!state; },
  };
}
