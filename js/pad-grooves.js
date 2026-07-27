// Hand-authored drum grooves — pure functions of the section's meter.
//
// Every section used to be seeded by one deterministic pattern, so a six-part
// song opened with six identical beats. The app was not empty (which is good —
// you hear music on first open) but it was monotonous, and monotony reads as
// "the tool only does one thing".
//
// Values are the sequencer's own 0/1/2/3 scale: off / hit / accent / ghost.

export const GROOVES = ["sparse", "backbeat", "build", "four", "halftime", "ride"];

/** Which groove suits which section type — the shape of a normal arrangement. */
export const GROOVE_FOR_TYPE = {
  Intro: "sparse",
  Verse: "backbeat",
  "Pre-Chorus": "build",
  Chorus: "four",
  Bridge: "halftime",
  Outro: "ride",
};

const HIT = 1, ACCENT = 2, GHOST = 3;

/**
 * @param {object} m  { bars, beatsPerBar, subdiv }  subdiv = steps per beat
 * @param {string} groove
 * @returns {object} { kick, snare, hat, open, crash, tomH, tomM, tomL } step arrays
 */
export function buildGroove(groove, { bars, beatsPerBar, subdiv }) {
  const spb = beatsPerBar * subdiv;          // steps per bar
  const total = spb * bars;
  const d = {};
  for (const k of ["kick", "snare", "hat", "open", "crash", "tomH", "tomM", "tomL"]) d[k] = new Array(total).fill(0);

  const beat = (bar, b) => bar * spb + b * subdiv;
  const off = (bar, b, frac) => bar * spb + Math.round((b + frac) * subdiv);
  const backbeats = beatsPerBar >= 4 ? [1, 3] : [Math.floor(beatsPerBar / 2)];
  const last = bars - 1;

  for (let bar = 0; bar < bars; bar++) {
    const lastBar = bar === last;
    switch (groove) {
      case "sparse":
        // Room to breathe: downbeat kick, backbeat snare, half-note hats.
        d.kick[beat(bar, 0)] = ACCENT;
        backbeats.forEach((b) => { d.snare[beat(bar, b)] = HIT; });
        for (let b = 0; b < beatsPerBar; b += 2) d.hat[beat(bar, b)] = HIT;
        break;

      case "backbeat":
        // The default rock/pop feel: 1 and the "and of 3", 8th hats.
        d.kick[beat(bar, 0)] = ACCENT;
        if (beatsPerBar >= 4) d.kick[off(bar, 2, 0.5)] = HIT;
        backbeats.forEach((b) => { d.snare[beat(bar, b)] = HIT; });
        for (let b = 0; b < beatsPerBar; b++) {
          d.hat[beat(bar, b)] = HIT;
          if (subdiv >= 2) d.hat[off(bar, b, 0.5)] = GHOST;
        }
        break;

      case "build":
        // Rising tension: 16th hats and a snare roll into the next section.
        d.kick[beat(bar, 0)] = ACCENT;
        backbeats.forEach((b) => { d.snare[beat(bar, b)] = HIT; });
        for (let st = 0; st < spb; st++) d.hat[bar * spb + st] = st % subdiv === 0 ? HIT : GHOST;
        if (lastBar) {
          for (let st = Math.floor(spb / 2); st < spb; st++) {
            d.snare[bar * spb + st] = st >= spb - subdiv ? ACCENT : GHOST;
          }
        }
        break;

      case "four":
        // Four on the floor, open hat on the off-beats — the chorus lift.
        for (let b = 0; b < beatsPerBar; b++) d.kick[beat(bar, b)] = b === 0 ? ACCENT : HIT;
        backbeats.forEach((b) => { d.snare[beat(bar, b)] = ACCENT; });
        for (let b = 0; b < beatsPerBar; b++) {
          d.hat[beat(bar, b)] = HIT;
          if (subdiv >= 2) d.open[off(bar, b, 0.5)] = HIT;
        }
        break;

      case "halftime":
        // Everything twice as wide: snare on 3 only, sparse kick.
        d.kick[beat(bar, 0)] = ACCENT;
        d.snare[beat(bar, Math.min(beatsPerBar - 1, 2))] = ACCENT;
        for (let b = 0; b < beatsPerBar; b++) d.hat[beat(bar, b)] = b % 2 ? GHOST : HIT;
        if (lastBar && beatsPerBar >= 4) {
          d.tomM[off(bar, beatsPerBar - 1, 0)] = HIT;
          d.tomL[off(bar, beatsPerBar - 1, 0.5)] = HIT;
        }
        break;

      case "ride":
      default:
        // Wind-down: ride-ish open hat on every beat, snare backbeat, no crash.
        d.kick[beat(bar, 0)] = HIT;
        backbeats.forEach((b) => { d.snare[beat(bar, b)] = GHOST; });
        for (let b = 0; b < beatsPerBar; b++) d.open[beat(bar, b)] = b === 0 ? HIT : GHOST;
        break;
    }
  }

  // A crash marks an arrival, so only where a section is meant to land.
  if (groove === "four" || groove === "build" || groove === "backbeat") d.crash[0] = HIT;
  return d;
}
